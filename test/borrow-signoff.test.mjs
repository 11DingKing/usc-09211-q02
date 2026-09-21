import assert from "node:assert/strict";
import test from "node:test";
import { proposeAndApprove, registerBatch, startServer, T } from "./helpers.mjs";

test("跨校借用：出借校批准后生成借入预留，库存只扣减一次", async () => {
  const api = await startServer();
  try {
    await registerBatch(api, { id: "batch-mo", school: "澳门校", quantity: 4 });
    await proposeAndApprove(api, { id: "exp-hk", school: "香港校" });

    const requested = await api.post("/experiments/exp-hk/borrows", { batchId: "batch-mo", quantity: 2, note: "联调借用", occurredAt: T.t1 });
    assert.equal(requested.status, 200);
    assert.equal(requested.body.status, "PENDING");
    assert.equal(requested.body.fromSchool, "澳门校");
    const borrowId = requested.body.id;

    // 借入校自己不能审批
    const forbidden = await api.post(`/borrows/${borrowId}/decision`, { decision: "APPROVED", actorSchool: "香港校", occurredAt: T.t1 });
    assert.equal(forbidden.status, 403);

    // 出借校批准
    const approved = await api.post(`/borrows/${borrowId}/decision`, { decision: "APPROVED", actorSchool: "澳门校", actor: "澳门校库管", occurredAt: T.t1 });
    assert.equal(approved.status, 200);
    assert.equal(approved.body.status, "APPROVED");

    const batch = await api.get("/batches/batch-mo");
    assert.equal(batch.body.quantityAvailable, 2);
    assert.equal(batch.body.reservations.length, 1);
    assert.equal(batch.body.reservations[0].borrowedFrom, "澳门校");
    assert.equal(batch.body.reservations[0].school, "香港校");

    // 借入预留可用于备料
    const prepared = await api.post("/experiments/exp-hk/prepare", { occurredAt: T.t1 });
    assert.equal(prepared.status, 200);

    // 已决借用单不可重复处理
    const again = await api.post(`/borrows/${borrowId}/decision`, { decision: "APPROVED", actorSchool: "澳门校", occurredAt: T.t1 });
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, "BORROW_ALREADY_DECIDED");
  } finally {
    await api.close();
  }
});

test("跨校借用：出借校拒绝后不产生预留", async () => {
  const api = await startServer();
  try {
    await registerBatch(api, { id: "batch-mo", school: "澳门校", quantity: 4 });
    await proposeAndApprove(api, { id: "exp-hk", school: "香港校" });
    const requested = await api.post("/experiments/exp-hk/borrows", { batchId: "batch-mo", quantity: 2, occurredAt: T.t1 });
    const rejected = await api.post(`/borrows/${requested.body.id}/decision`, { decision: "REJECTED", actorSchool: "澳门校", reason: "本校自用", occurredAt: T.t1 });
    assert.equal(rejected.body.status, "REJECTED");
    const batch = await api.get("/batches/batch-mo");
    assert.equal(batch.body.quantityAvailable, 4);
    assert.equal(batch.body.reservations.length, 0);
  } finally {
    await api.close();
  }
});

test("同校批次不得走借用流程", async () => {
  const api = await startServer();
  try {
    await registerBatch(api, { id: "batch-hk", school: "香港校", quantity: 4 });
    await proposeAndApprove(api, { id: "exp-hk", school: "香港校" });
    const res = await api.post("/experiments/exp-hk/borrows", { batchId: "batch-hk", quantity: 1, occurredAt: T.t1 });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, "BORROW_SAME_SCHOOL");
  } finally {
    await api.close();
  }
});

test("延迟签收：超时必须给出原因，原因确定地记录在案", async () => {
  const api = await startServer();
  try {
    await registerBatch(api, { quantity: 5 });
    await proposeAndApprove(api);
    await api.post("/experiments/exp-1/reservations", { batchId: "batch-1", quantity: 2, occurredAt: T.t1 });
    await api.post("/experiments/exp-1/prepare", { occurredAt: T.t1 });
    await api.post("/experiments/exp-1/rehearsal", { result: "PASS", occurredAt: T.t1 });
    await api.post("/experiments/exp-1/uplink-confirm", { confirmer: "调度", signoffDeadline: T.t3, occurredAt: T.t2 });

    // 超时且无原因：拒绝
    const noReason = await api.post("/experiments/exp-1/signoff", { signedBy: "教师", occurredAt: T.t4 });
    assert.equal(noReason.status, 409);
    assert.equal(noReason.body.error.code, "LATE_SIGNOFF_REQUIRES_REASON");

    // 给出延迟原因：放行，事件记录 late=true 与原因
    const signed = await api.post("/experiments/exp-1/signoff", { signedBy: "教师", lateReason: "船运延误", occurredAt: T.t4 });
    assert.equal(signed.status, 200);
    assert.equal(signed.body.signoff.late, true);
    assert.equal(signed.body.signoff.lateReason, "船运延误");

    const audit = await api.get("/experiments/exp-1/audit");
    const signoffEvent = audit.body.find((e) => e.type === "SIGNOFF_RECORDED");
    assert.equal(signoffEvent.payload.late, true);
    assert.equal(signoffEvent.payload.lateReason, "船运延误");
  } finally {
    await api.close();
  }
});
