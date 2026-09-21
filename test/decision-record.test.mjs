import assert from "node:assert/strict";
import test from "node:test";
import { Harness, seedApprovedBatch, uniqueId } from "./helpers.mjs";

test("决策记录可复原被拒尝试、召回时间线与链坐标", async () => {
  const h = new Harness();
  await h.start();
  try {
    const seed = await seedApprovedBatch(h);
    const hk = seed.actor;
    const reviewer = { actorId: "reviewer_li", orgId: seed.schoolId };

    // 不入库直接备料 -> MATERIALS_NOT_READY 被拒，应入审计。
    const rejected = await h.command("POST", `/batches/${seed.batchId}/reserve`, { batchId: seed.batchId }, { actor: hk });
    assert.equal(rejected.status, 422);

    // 推送时间使审批过期后再被拒一次。
    h.tick(40 * 86400_000);
    const expired = await h.command("POST", `/batches/${seed.batchId}/reserve`, { batchId: seed.batchId }, { actor: hk });
    assert.equal(expired.status, 422);
    assert.ok(JSON.stringify(expired.body).includes("APPROVAL_EXPIRED"));

    const dr = await h.get(`/batches/${seed.batchId}/decision-record`);
    assert.equal(dr.status, 200);
    assert.ok(dr.body.audit.rejectedAttempts.length >= 2);
    const codes = dr.body.audit.rejectedAttempts.flatMap((a) => (a.rejection.blockers ?? []).map((b) => b.code));
    assert.ok(codes.includes("MATERIALS_NOT_READY"));
    assert.ok(codes.includes("APPROVAL_EXPIRED"));
    // 每条被拒尝试都带门检快照。
    for (const attempt of dr.body.audit.rejectedAttempts) {
      assert.ok(attempt.rejection.gateSnapshot);
      assert.ok(attempt.hash);
    }
    // 链尖坐标可与 verify 对上。
    const verify = await h.get("/audit/verify");
    assert.equal(dr.body.audit.chainTip.hash, verify.body.tipHash);
    assert.equal(dr.body.audit.chainTip.seq, verify.body.tipSeq);
  } finally {
    await h.stop();
    h.cleanup();
  }
});

test("决策记录时间线包含命中批次的召回发布事件", async () => {
  const h = new Harness();
  await h.start();
  try {
    const seed = await seedApprovedBatch(h);
    const hk = seed.actor;
    const reviewer = { actorId: "reviewer_li", orgId: seed.schoolId };
    // 直接发料号召回（即便无库存），需求料号 MAT_A 命中。
    const r = await h.command("POST", "/recalls", {
      recallId: "rc_tl", scope: "ITEM", materialId: "MAT_A", reason: "时间线测试",
    }, { actor: reviewer });
    assert.equal(r.status, 200);

    const dr = await h.get(`/batches/${seed.batchId}/decision-record`);
    const types = dr.body.audit.timeline.map((t) => t.commandType);
    assert.ok(types.includes("issueRecall"), JSON.stringify(types));
  } finally {
    await h.stop();
    h.cleanup();
  }
});
