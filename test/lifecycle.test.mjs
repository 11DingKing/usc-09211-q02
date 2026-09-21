import assert from "node:assert/strict";
import test from "node:test";
import { proposeAndApprove, registerBatch, startServer, T } from "./helpers.mjs";

// 完整流程：提案 → 复核 → 预留 → 备料 → 预演 → 上行确认 → 签收，
// 并通过审计事件与准入链接口复原「这套材料为何获准进入课堂」。
test("全流程走通并可从审计与准入链复原", async () => {
  const api = await startServer();
  try {
    await registerBatch(api, { quantity: 5 });
    await proposeAndApprove(api);

    const reserved = await api.post("/experiments/exp-1/reservations", { batchId: "batch-1", quantity: 2, occurredAt: T.t1 });
    assert.equal(reserved.status, 200);
    assert.equal(reserved.body.reservations[0].id, "exp-1-rsv-1");

    const prepared = await api.post("/experiments/exp-1/prepare", { occurredAt: T.t1 });
    assert.equal(prepared.body.stage, "PREPARED");

    const rehearsed = await api.post("/experiments/exp-1/rehearsal", { result: "PASS", notes: "地面预演正常", occurredAt: T.t2 });
    assert.equal(rehearsed.body.stage, "REHEARSED");

    const uplinked = await api.post("/experiments/exp-1/uplink-confirm", {
      confirmer: "任务调度员",
      signoffDeadline: T.t4,
      occurredAt: T.t3,
    });
    assert.equal(uplinked.body.stage, "UPLINK_CONFIRMED");

    const signed = await api.post("/experiments/exp-1/signoff", { signedBy: "授课教师", occurredAt: T.t4 });
    assert.equal(signed.body.stage, "SIGNED_OFF");
    assert.equal(signed.body.signoff.late, false);

    // 审计流：事件按 seq 单调递增，事件时间与接收时间分离
    const audit = await api.get("/experiments/exp-1/audit");
    assert.equal(audit.status, 200);
    const types = audit.body.map((e) => e.type);
    assert.deepEqual(types, [
      "EXPERIMENT_PROPOSED",
      "RISK_REVIEW_RECORDED",
      "RESERVATION_PLACED",
      "PREPARATION_RECORDED",
      "REHEARSAL_RECORDED",
      "UPLINK_CONFIRMED",
      "SIGNOFF_RECORDED",
    ]);
    for (let i = 1; i < audit.body.length; i += 1) {
      assert.ok(audit.body[i].seq > audit.body[i - 1].seq);
    }
    for (const e of audit.body) {
      assert.ok(e.occurredAt);
      assert.ok(e.recordedAt);
    }

    // 准入链：获准进入课堂，且每个门控节点都可溯源
    const clearance = await api.get("/experiments/exp-1/clearance");
    assert.equal(clearance.body.admittedToClassroom, true);
    assert.equal(clearance.body.approval.approver, "风控员甲");
    assert.equal(clearance.body.gates.riskReviews[0].decision, "APPROVED");
    assert.equal(clearance.body.gates.reservations[0].batchId, "batch-1");
    assert.equal(clearance.body.batches[0].batch.lot, "L2026-09");
    assert.equal(clearance.body.gates.signoff[0].signedBy, "授课教师");
  } finally {
    await api.close();
  }
});

test("阶段门控：未复核不得预留，未备料不得预演", async () => {
  const api = await startServer();
  try {
    await registerBatch(api);
    await api.post("/experiments", {
      experimentId: "exp-1",
      school: "澳门校",
      title: "表面张力演示",
      materials: [{ materialId: "mat-水", quantity: 1 }],
      occurredAt: T.t0,
    });
    const earlyReserve = await api.post("/experiments/exp-1/reservations", { batchId: "batch-1", quantity: 1, occurredAt: T.t0 });
    assert.equal(earlyReserve.status, 409);
    assert.equal(earlyReserve.body.error.code, "INVALID_STAGE");

    const earlyPrepare = await api.post("/experiments/exp-1/prepare", { occurredAt: T.t0 });
    assert.equal(earlyPrepare.status, 409);

    await api.post("/experiments/exp-1/risk-review", { decision: "APPROVED", approver: "风控员乙", expiresAt: T.far, occurredAt: T.t0 });
    const earlyRehearse = await api.post("/experiments/exp-1/rehearsal", { result: "PASS", occurredAt: T.t0 });
    assert.equal(earlyRehearse.status, 409);
  } finally {
    await api.close();
  }
});

test("乐观并发：expectedRevision 不匹配时拒绝写入", async () => {
  const api = await startServer();
  try {
    await registerBatch(api);
    await proposeAndApprove(api);
    const detail = await api.get("/experiments/exp-1");
    const staleRevision = detail.body.revision - 1;
    const res = await api.post("/experiments/exp-1/reservations", {
      batchId: "batch-1",
      quantity: 1,
      expectedRevision: staleRevision,
      occurredAt: T.t1,
    });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, "CONCURRENT_MODIFICATION");
  } finally {
    await api.close();
  }
});
