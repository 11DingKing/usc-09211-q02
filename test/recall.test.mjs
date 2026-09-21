import assert from "node:assert/strict";
import test from "node:test";
import { Harness, seedApprovedBatch, inbound, uniqueId } from "./helpers.mjs";

const HK = "SCHOOL_HK";
const MO = "SCHOOL_MO";
const hk = { actorId: "chan", orgId: HK };
const mo = { actorId: "ng", orgId: MO };
const reviewer = { actorId: "reviewer_li", orgId: HK };

async function reserveRehearsed(h, seed, lots) {
  for (const lot of lots) await inbound(h, lot, hk);
  let r = await h.command("POST", `/batches/${seed.batchId}/reserve`, { batchId: seed.batchId }, { actor: hk });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await h.command("POST", `/batches/${seed.batchId}/rehearse`, { batchId: seed.batchId }, { actor: hk });
  assert.equal(r.status, 200);
}

test("ITEM 召回命中料号：已排练批次上行被阻断，关闭召回后放行", async () => {
  const h = new Harness();
  await h.start();
  try {
    const seed = await seedApprovedBatch(h);
    await reserveRehearsed(h, seed, [{ lotId: "a1", schoolId: HK, materialId: "MAT_A", qty: 5 }]);

    const r = await h.command("POST", "/recalls", {
      recallId: "rc_item", scope: "ITEM", materialId: "MAT_A", reason: "厂家批次安全通告",
    }, { actor: reviewer });
    assert.equal(r.status, 200);

    const blocked = await h.command("POST", `/batches/${seed.batchId}/uplink`, { batchId: seed.batchId }, { actor: hk });
    assert.equal(blocked.status, 422);
    const blocker = blocked.body.error.details.blockers.find((b) => b.code === "RECALL_ACTIVE");
    assert.ok(blocker);
    assert.ok(blocker.hitMaterials.includes("MAT_A"));

    // 决策记录应包含命中证据。
    const dr = await h.get(`/batches/${seed.batchId}/decision-record`);
    assert.equal(dr.body.evidence.recalls.status, "RECALL_ACTIVE");

    // 召回家关闭后阻断解除；器具本次未实际动用，释放预留后即可上行。
    await h.command("POST", "/recalls/rc_item/close", { recallId: "rc_item" }, { actor: reviewer });
    await h.command("POST", `/batches/${seed.batchId}/release-unused`, { batchId: seed.batchId }, { actor: hk });
    const again = await h.command("POST", `/batches/${seed.batchId}/uplink`, { batchId: seed.batchId }, { actor: hk });
    assert.equal(again.status, 200, JSON.stringify(again.body));
  } finally {
    await h.stop();
    h.cleanup();
  }
});

test("LOT 召回沿 originLotIds 多跳闭包传播：借入校 lot 被污染，发货跳过召回 lot", async () => {
  const h = new Harness();
  await h.start();
  try {
    await inbound(h, { lotId: "root1", schoolId: HK, materialId: "MAT_F", qty: 5 }, hk);
    await inbound(h, { lotId: "root2", schoolId: HK, materialId: "MAT_F", qty: 5 }, hk);
    const borrowId = uniqueId("brw");
    await h.command("POST", "/borrows", {
      borrowId, fromSchoolId: HK, toSchoolId: MO, lines: [{ materialId: "MAT_F", qty: 3 }],
    }, { actor: mo });
    // FIFO 应从 root1 发 3。
    const dispatch = await h.command("POST", `/borrows/${borrowId}/dispatch`, {
      borrowId, lines: [{ materialId: "MAT_F", qty: 3 }],
    }, { actor: hk });
    assert.equal(dispatch.body.reply.picks[0].lotPicks[0].lotId, "root1");
    await h.command("POST", `/borrows/${borrowId}/receipts`, {
      borrowId, materialId: "MAT_F", qty: 3, lotId: "mof1",
    }, { actor: mo });

    // 对 root1 发 lot 级召回：借入校 mof1 经闭包同样被污染。
    await h.command("POST", "/recalls", {
      recallId: "rc_lot", scope: "LOT", lotId: "root1", reason: "该瓶密封异常",
    }, { actor: reviewer });

    // root2 不受影响：再借 3 件，FIFO 必须跳过被召回的 root1，从 root2 发货。
    const borrowId2 = uniqueId("brw");
    await h.command("POST", "/borrows", {
      borrowId: borrowId2, fromSchoolId: HK, toSchoolId: MO, lines: [{ materialId: "MAT_F", qty: 3 }],
    }, { actor: mo });
    const dispatch2 = await h.command("POST", `/borrows/${borrowId2}/dispatch`, {
      borrowId: borrowId2, lines: [{ materialId: "MAT_F", qty: 3 }],
    }, { actor: hk });
    assert.equal(dispatch2.status, 200);
    assert.equal(dispatch2.body.reply.picks[0].lotPicks[0].lotId, "root2");

    // 借入校用被污染的 mof1 备料应被 RECALL_ACTIVE 拦下。
    const seed = await seedApprovedBatch(h, { batchId: "b_mo", schoolId: MO, requirements: [
      { requirementId: "r1", materialId: "MAT_F", qty: 3, unit: "件", allowedSubstituteMaterialIds: [] },
    ] });
    const blocked = await h.command("POST", `/batches/${seed.batchId}/reserve`, { batchId: seed.batchId }, { actor: mo });
    assert.equal(blocked.status, 422);
    const blocker = blocked.body.error.details.blockers.find((b) => b.code === "RECALL_ACTIVE");
    assert.ok(blocker);
    assert.ok(blocker.hitLotIds.includes("mof1"));
  } finally {
    await h.stop();
    h.cleanup();
  }
});

test("召回发布于签收之后：签收照常入链，但新 lot 立即处于污染状态、禁止领用", async () => {
  const h = new Harness();
  await h.start();
  try {
    await inbound(h, { lotId: "g1", schoolId: HK, materialId: "MAT_G", qty: 4 }, hk);
    const borrowId = uniqueId("brw");
    await h.command("POST", "/borrows", {
      borrowId, fromSchoolId: HK, toSchoolId: MO, lines: [{ materialId: "MAT_G", qty: 2 }],
    }, { actor: mo });
    await h.command("POST", `/borrows/${borrowId}/dispatch`, {
      borrowId, lines: [{ materialId: "MAT_G", qty: 2 }],
    }, { actor: hk });
    await h.command("POST", `/borrows/${borrowId}/receipts`, {
      borrowId, materialId: "MAT_G", qty: 2, lotId: "mog1",
    }, { actor: mo });
    // 签收之后才召回 root lot。
    await h.command("POST", "/recalls", {
      recallId: "rc_g", scope: "LOT", lotId: "g1", reason: "滞后的安全通告",
    }, { actor: reviewer });

    const seed = await seedApprovedBatch(h, { batchId: "b_mo2", schoolId: MO, requirements: [
      { requirementId: "r1", materialId: "MAT_G", qty: 2, unit: "件", allowedSubstituteMaterialIds: [] },
    ] });
    const r = await h.command("POST", `/batches/${seed.batchId}/reserve`, { batchId: seed.batchId }, { actor: mo });
    assert.equal(r.status, 422);
    assert.ok(JSON.stringify(r.body).includes("RECALL_ACTIVE"));
  } finally {
    await h.stop();
    h.cleanup();
  }
});

test("已领用后召回：不回滚领用，但阻断上行；rebase 到 SAFETY 新版并重新审批后可恢复", async () => {
  const h = new Harness();
  await h.start();
  try {
    const seed = await seedApprovedBatch(h, { requirements: [
      { requirementId: "r1", materialId: "MAT_A", qty: 2, unit: "件", allowedSubstituteMaterialIds: ["MAT_B"] },
    ] });
    await inbound(h, { lotId: "a1", schoolId: HK, materialId: "MAT_A", qty: 2 }, hk);
    await inbound(h, { lotId: "b1", schoolId: HK, materialId: "MAT_B", qty: 2 }, hk);
    await h.command("POST", `/batches/${seed.batchId}/reserve`, { batchId: seed.batchId }, { actor: hk });
    await h.command("POST", `/batches/${seed.batchId}/use`, {
      batchId: seed.batchId, picks: [{ requirementId: "r1", lotId: "a1", qty: 2 }],
    }, { actor: hk });
    await h.command("POST", "/recalls", { recallId: "rc_a", scope: "ITEM", materialId: "MAT_A", reason: "使用中发现问题" }, { actor: reviewer });

    let r = await h.command("POST", `/batches/${seed.batchId}/uplink`, { batchId: seed.batchId }, { actor: hk });
    assert.equal(r.status, 422);
    assert.ok(JSON.stringify(r.body).includes("RECALL_ACTIVE"));

    // 先把已领用的问题器具归还（退回即回到被召回 lot 隔离），才能换版。
    r = await h.command("POST", `/batches/${seed.batchId}/returns`, {
      batchId: seed.batchId, picks: [{ requirementId: "r1", lotId: "a1", qty: 2 }],
    }, { actor: hk });
    assert.equal(r.status, 200);

    // 发布不再使用 MAT_A 的安全新版。
    r = await h.command("POST", `/plans/${seed.planId}/revisions`, {
      planId: seed.planId, versionId: "v2", revisionType: "SAFETY", changeSummary: "停用 MAT_A，改用 MAT_B",
      title: "水滴微重力演示", safetyNotes: "改用 MAT_B",
      requirements: [{ requirementId: "r1", materialId: "MAT_B", qty: 2, unit: "件", allowedSubstituteMaterialIds: [] }],
    }, { actor: reviewer });
    assert.equal(r.status, 200);

    r = await h.command("POST", `/batches/${seed.batchId}/rebase`, { batchId: seed.batchId, targetVersionId: "v2" }, { actor: hk });
    assert.equal(r.status, 200);
    assert.equal(r.body.reply.versionId, "v2");

    // 重新审批。
    r = await h.command("POST", `/batches/${seed.batchId}/risk-decisions`, {
      batchId: seed.batchId, decision: "approved", reviewerId: "reviewer_li", approvalId: uniqueId("appr"),
      validFrom: h.iso(), validUntil: new Date(h.nowMs + 30 * 86400_000).toISOString(),
    }, { actor: reviewer });
    assert.equal(r.status, 200, JSON.stringify(r.body));

    // 旧痕迹已归档：新版本只看 MAT_B，召回不再命中，可走完备料→预演→上行。
    r = await h.command("POST", `/batches/${seed.batchId}/reserve`, { batchId: seed.batchId }, { actor: hk });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.reply.holds[0].materialId, "MAT_B");
    await h.command("POST", `/batches/${seed.batchId}/rehearse`, { batchId: seed.batchId }, { actor: hk });
    r = await h.command("POST", `/batches/${seed.batchId}/use`, {
      batchId: seed.batchId, picks: [{ requirementId: "r1", lotId: "b1", qty: 2 }],
    }, { actor: hk });
    assert.equal(r.status, 200);
    await h.command("POST", `/batches/${seed.batchId}/returns`, {
      batchId: seed.batchId, picks: [{ requirementId: "r1", lotId: "b1", qty: 2 }],
    }, { actor: hk });
    await h.command("POST", `/batches/${seed.batchId}/release-unused`, { batchId: seed.batchId }, { actor: hk });
    r = await h.command("POST", `/batches/${seed.batchId}/uplink`, { batchId: seed.batchId }, { actor: hk });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.reply.stage, "uplinked");
  } finally {
    await h.stop();
    h.cleanup();
  }
});
