import assert from "node:assert/strict";
import test from "node:test";
import { Harness, seedApprovedBatch, inbound, uniqueId } from "./helpers.mjs";

test("完整主线：提案→复核→备料→预演→上行，决策记录可复原", async () => {
  const h = new Harness();
  await h.start();
  try {
    const seed = await seedApprovedBatch(h);
    await inbound(h, { lotId: "lot_a1", schoolId: seed.schoolId, materialId: "MAT_A", qty: 5 }, seed.actor);

    let r = await h.command("POST", `/batches/${seed.batchId}/reserve`, { batchId: seed.batchId }, { actor: seed.actor });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.reply.stage, "reserved");
    assert.equal(r.body.reply.holds[0].lotId, "lot_a1");
    assert.equal(r.body.reply.holds[0].qty, 3);

    r = await h.command("POST", `/batches/${seed.batchId}/rehearse`, { batchId: seed.batchId, evidenceHash: "sha256:abc" }, { actor: seed.actor });
    assert.equal(r.status, 200);

    // 领用 3、归还 3，再释放（此处无剩余预留），结清后上行。
    r = await h.command("POST", `/batches/${seed.batchId}/use`, {
      batchId: seed.batchId,
      picks: [{ requirementId: "r1", lotId: "lot_a1", qty: 3 }],
    }, { actor: seed.actor });
    assert.equal(r.status, 200, JSON.stringify(r.body));

    r = await h.command("POST", `/batches/${seed.batchId}/returns`, {
      batchId: seed.batchId,
      picks: [{ requirementId: "r1", lotId: "lot_a1", qty: 3 }],
    }, { actor: seed.actor });
    assert.equal(r.status, 200);

    r = await h.command("POST", `/batches/${seed.batchId}/release-unused`, { batchId: seed.batchId }, { actor: seed.actor });
    assert.equal(r.status, 200);

    r = await h.command("POST", `/batches/${seed.batchId}/uplink`, { batchId: seed.batchId }, { actor: seed.actor });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.reply.stage, "uplinked");

    const dr = await h.get(`/batches/${seed.batchId}/decision-record`);
    assert.equal(dr.status, 200);
    assert.equal(dr.body.conclusion.allowedIntoClassroom, true);
    assert.equal(dr.body.evidence.plan.pinnedVersion.content.requirements[0].materialId, "MAT_A");
    assert.equal(dr.body.evidence.approval.reviewerId, "reviewer_li");
    assert.ok(dr.body.evidence.lotProvenance.some((l) => l.lotId === "lot_a1"));
    assert.ok(dr.body.audit.timeline.length >= 6);

    const verify = await h.get("/audit/verify");
    assert.equal(verify.body.ok, true);
  } finally {
    await h.stop();
    h.cleanup();
  }
});

test("SAFETY 修订取代旧版：在途批次三门被阻断，rebase 后须重新审批", async () => {
  const h = new Harness();
  await h.start();
  try {
    const seed = await seedApprovedBatch(h);
    await inbound(h, { lotId: "lot_a1", schoolId: seed.schoolId, materialId: "MAT_A", qty: 5 }, seed.actor);
    let r = await h.command("POST", `/batches/${seed.batchId}/reserve`, { batchId: seed.batchId }, { actor: seed.actor });
    assert.equal(r.status, 200);

    // 教研组发布安全修订（安全说明变更）。
    r = await h.command("POST", `/plans/${seed.planId}/revisions`, {
      id: seed.planId, versionId: "v2", revisionType: "SAFETY", changeSummary: "更新安全说明",
      title: "水滴微重力演示", safetyNotes: "必须戴护目镜并保持通风",
      requirements: [{ requirementId: "r1", materialId: "MAT_A", qty: 3, unit: "件", allowedSubstituteMaterialIds: ["MAT_B"] }],
    }, { actor: { actorId: "reviewer_li", orgId: seed.schoolId } });
    assert.equal(r.status, 200);

    r = await h.command("POST", `/batches/${seed.batchId}/rehearse`, { batchId: seed.batchId }, { actor: seed.actor });
    assert.equal(r.status, 422);
    assert.ok(r.body.error.details.blockers.some((b) => b.code === "VERSION_SUPERSEDED"));

    // EDITORIAL 之外，重新备料也被阻断。
    r = await h.command("POST", `/batches/${seed.batchId}/rebase`, { batchId: seed.batchId, targetVersionId: "v2" }, { actor: seed.actor });
    assert.equal(r.status, 200, JSON.stringify(r.body));

    const batch = await h.get(`/batches/${seed.batchId}`);
    assert.equal(batch.body.stage, "reviewPending");
    assert.equal(batch.body.approval, null);
    assert.equal(batch.body.reservationActive, false);

    // 未重新审批直接备料 -> APPROVAL_MISSING。
    r = await h.command("POST", `/batches/${seed.batchId}/reserve`, { batchId: seed.batchId }, { actor: seed.actor });
    assert.equal(r.status, 422);
    assert.ok(r.body.error.details.blockers.some((b) => b.code === "APPROVAL_MISSING"));
  } finally {
    await h.stop();
    h.cleanup();
  }
});

test("EDITORIAL 修订不阻断流程，仅在版本状态中提示", async () => {
  const h = new Harness();
  await h.start();
  try {
    const seed = await seedApprovedBatch(h);
    await inbound(h, { lotId: "lot_a1", schoolId: seed.schoolId, materialId: "MAT_A", qty: 5 }, seed.actor);
    await h.command("POST", `/batches/${seed.batchId}/reserve`, { batchId: seed.batchId }, { actor: seed.actor });
    const r = await h.command("POST", `/plans/${seed.planId}/revisions`, {
      id: seed.planId, versionId: "v1e", revisionType: "EDITORIAL", changeSummary: "错别字",
      title: "水滴微重力演示（改）", safetyNotes: "戴护目镜",
      requirements: [{ requirementId: "r1", materialId: "MAT_A", qty: 3, unit: "件", allowedSubstituteMaterialIds: ["MAT_B"] }],
    }, { actor: { actorId: "reviewer_li", orgId: seed.schoolId } });
    assert.equal(r.status, 200);

    const rehearse = await h.command("POST", `/batches/${seed.batchId}/rehearse`, { batchId: seed.batchId }, { actor: seed.actor });
    assert.equal(rehearse.status, 200, JSON.stringify(rehearse.body));

    const batch = await h.get(`/batches/${seed.batchId}`);
    assert.equal(batch.body.versionStatus, "OK_VERSION_BEHIND_EDITORIAL");
  } finally {
    await h.stop();
    h.cleanup();
  }
});

test("审批过期阻断后续节点；时间基只认服务端，回拨 occurredAt 无效", async () => {
  const h = new Harness();
  await h.start();
  try {
    const seed = await seedApprovedBatch(h);
    await inbound(h, { lotId: "lot_a1", schoolId: seed.schoolId, materialId: "MAT_A", qty: 5 }, seed.actor);
    // 把服务端时钟推到审批过期之后。
    h.tick(31 * 86400_000);
    const r = await h.command("POST", `/batches/${seed.batchId}/reserve`, { batchId: seed.batchId }, { actor: seed.actor });
    assert.equal(r.status, 422);
    assert.ok(r.body.error.details.blockers.some((b) => b.code === "APPROVAL_EXPIRED"));

    // 试图把 occurredAt 回拨到有效期内，结论不应改变。
    const r2 = await h.command("POST", `/batches/${seed.batchId}/reserve`, { batchId: seed.batchId }, {
      actor: seed.actor, at: "2026-09-05T00:00:00.000Z", commandId: uniqueId("cmd"),
    });
    assert.equal(r2.status, 422);
    assert.ok(r2.body.error.details.blockers.some((b) => b.code === "APPROVAL_EXPIRED"));
  } finally {
    await h.stop();
    h.cleanup();
  }
});

test("审批撤销即时生效并阻断", async () => {
  const h = new Harness();
  await h.start();
  try {
    const seed = await seedApprovedBatch(h);
    await inbound(h, { lotId: "lot_a1", schoolId: seed.schoolId, materialId: "MAT_A", qty: 5 }, seed.actor);
    const r = await h.command("POST", `/approvals/${seed.approvalId}/revoke`, {
      id: seed.approvalId, reason: "复核人资格问题",
    }, { actor: { actorId: "reviewer_li", orgId: seed.schoolId } });
    assert.equal(r.status, 200);
    const reserve = await h.command("POST", `/batches/${seed.batchId}/reserve`, { batchId: seed.batchId }, { actor: seed.actor });
    assert.equal(reserve.status, 422);
    assert.ok(reserve.body.error.details.blockers.some((b) => b.code === "APPROVAL_REVOKED"));
  } finally {
    await h.stop();
    h.cleanup();
  }
});

test("备料不足整体失败：不产生任何预留，另一批次仍可占用全部库存", async () => {
  const h = new Harness();
  await h.start();
  try {
    const s1 = await seedApprovedBatch(h, { batchId: "b_need5" });
    const s2 = await seedApprovedBatch(h, { batchId: "b_need3", planId: s1.planId + "_x" });
    await inbound(h, { lotId: "lot_a1", schoolId: s1.schoolId, materialId: "MAT_A", qty: 4 }, s1.actor);

    // 需要 3 的批次先占 3。
    let r = await h.command("POST", `/batches/${s2.batchId}/reserve`, { batchId: s2.batchId }, { actor: s2.actor });
    assert.equal(r.status, 200);

    // 需要 3 的另一个批次只剩 1，全量失败且不留部分预留。
    r = await h.command("POST", `/batches/${s1.batchId}/reserve`, { batchId: s1.batchId }, { actor: s1.actor });
    assert.equal(r.status, 422);
    assert.ok(r.body.error.details.blockers.some((b) => b.code === "MATERIALS_NOT_READY"));

    const batch = await h.get(`/batches/${s1.batchId}`);
    assert.equal(batch.body.reservationActive, false);
    assert.equal(batch.body.outstandingHoldQty, 0);
  } finally {
    await h.stop();
    h.cleanup();
  }
});

test("并发重复占用：同一 commandId 重试只预留一次（幂等）", async () => {
  const h = new Harness();
  await h.start();
  try {
    const seed = await seedApprovedBatch(h);
    await inbound(h, { lotId: "lot_a1", schoolId: seed.schoolId, materialId: "MAT_A", qty: 5 }, seed.actor);
    const commandId = uniqueId("cmd");
    const payload = {
      commandId,
      occurredAt: h.iso(),
      actor: seed.actor,
      batchId: seed.batchId,
    };
    const [r1, r2] = await Promise.all([
      fetch(`${h.baseUrl}/batches/${seed.batchId}/reserve`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }).then(async (x) => ({ status: x.status, replay: x.headers.get("idempotent-replay"), body: await x.json() })),
      fetch(`${h.baseUrl}/batches/${seed.batchId}/reserve`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }).then(async (x) => ({ status: x.status, replay: x.headers.get("idempotent-replay"), body: await x.json() })),
    ]);
    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);
    const flags = [r1.replay, r2.replay].filter(Boolean);
    assert.equal(flags.length, 1, "恰有一次是幂等重放");
    assert.deepEqual(r1.body.seq, r2.body.seq);

    // 预留是“钉量”而非出库：实物仍为 5，但只钉了一组合计 3 的 hold。
    const batch = await h.get(`/batches/${seed.batchId}`);
    assert.equal(batch.body.holds.reduce((sum, x) => sum + x.qty, 0), 3);

    // 第二个批次只能分到剩余可钉量 2：要 3 必须整体失败，证明没有重复占用。
    const other = await seedApprovedBatch(h, { batchId: "b_concurrent_other" });
    const blocked = await h.command("POST", `/batches/${other.batchId}/reserve`, { batchId: other.batchId }, { actor: other.actor });
    assert.equal(blocked.status, 422);
    assert.ok(blocked.body.error.details.blockers.some((b) => b.code === "MATERIALS_NOT_READY"));
  } finally {
    await h.stop();
    h.cleanup();
  }
});

test("同 commandId 不同请求体返回 409", async () => {
  const h = new Harness();
  await h.start();
  try {
    const seed = await seedApprovedBatch(h);
    await inbound(h, { lotId: "lot_a1", schoolId: seed.schoolId, materialId: "MAT_A", qty: 5 }, seed.actor);
    const commandId = uniqueId("cmd");
    const r1 = await h.command("POST", `/batches/${seed.batchId}/reserve`, { batchId: seed.batchId }, { actor: seed.actor, commandId });
    assert.equal(r1.status, 200);
    const r2 = await h.command("POST", `/batches/${seed.batchId}/reserve`, { batchId: seed.batchId, extra: 1 }, { actor: seed.actor, commandId });
    assert.equal(r2.status, 409);
  } finally {
    await h.stop();
    h.cleanup();
  }
});

test("服务重启后续跑：状态与幂等结论一致，被拒命令仍被拒", async () => {
  const h = new Harness();
  await h.start();
  try {
    const seed = await seedApprovedBatch(h);
    await inbound(h, { lotId: "lot_a1", schoolId: seed.schoolId, materialId: "MAT_A", qty: 5 }, seed.actor);
    // 先制造一次被拒命令：提案后未经风险复核即尝试备料（缺审批）。
    const rejectedId = uniqueId("cmd");
    const raw = await h.command("POST", "/batches", {
      batchId: "b_noappr", schoolId: seed.schoolId, planId: seed.planId,
    }, { actor: seed.actor });
    assert.equal(raw.status, 200);
    const rejected = await h.command("POST", "/batches/b_noappr/reserve", { batchId: "b_noappr" }, { actor: seed.actor, commandId: rejectedId });
    assert.equal(rejected.status, 422);
    assert.ok(rejected.body.error.details.blockers.some((b) => b.code === "WRONG_STAGE"));

    await h.command("POST", `/batches/${seed.batchId}/reserve`, { batchId: seed.batchId }, { actor: seed.actor });

    await h.restart();

    // 同一 commandId 重放：仍然是同一个拒绝。
    const replayRejected = await h.command("POST", "/batches/b_noappr/reserve", { batchId: "b_noappr" }, { actor: seed.actor, commandId: rejectedId });
    assert.equal(replayRejected.status, 422);
    assert.equal(replayRejected.headers.get("idempotent-replay"), "true");

    const batch = await h.get(`/batches/${seed.batchId}`);
    assert.equal(batch.body.stage, "reserved");
    const verify = await h.get("/audit/verify");
    assert.equal(verify.body.ok, true);
  } finally {
    await h.stop();
    h.cleanup();
  }
});
