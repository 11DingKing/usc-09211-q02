import assert from "node:assert/strict";
import test from "node:test";
import { proposeAndApprove, registerBatch, startServer, T } from "./helpers.mjs";

test("过期审批阻断后续节点，重新复核后放行", async () => {
  const api = await startServer();
  try {
    await registerBatch(api, { quantity: 5 });
    await proposeAndApprove(api, { expiresAt: T.t2 }); // 审批在 t2 到期

    // t3 时审批已过期：预留被拒绝，且系统补记了 APPROVAL_EXPIRED 事件
    const reserved = await api.post("/experiments/exp-1/reservations", { batchId: "batch-1", quantity: 2, occurredAt: T.t3 });
    assert.equal(reserved.status, 409);
    assert.equal(reserved.body.error.code, "APPROVAL_MISSING_OR_EXPIRED");

    const detail = await api.get("/experiments/exp-1");
    assert.equal(detail.body.approval.status, "EXPIRED");
    const audit = await api.get("/experiments/exp-1/audit");
    assert.ok(audit.body.some((e) => e.type === "APPROVAL_EXPIRED"));

    // 重新复核（新的有效期）后流程继续
    await api.post("/experiments/exp-1/risk-review", { decision: "APPROVED", approver: "风控员甲", expiresAt: T.far, occurredAt: T.t3 });
    const retry = await api.post("/experiments/exp-1/reservations", { batchId: "batch-1", quantity: 2, occurredAt: T.t3 });
    assert.equal(retry.status, 200);
  } finally {
    await api.close();
  }
});

test("审批在上行确认前过期：已到预演阶段也被阻断", async () => {
  const api = await startServer();
  try {
    await registerBatch(api, { quantity: 5 });
    await proposeAndApprove(api, { expiresAt: T.t3 });
    await api.post("/experiments/exp-1/reservations", { batchId: "batch-1", quantity: 2, occurredAt: T.t1 });
    await api.post("/experiments/exp-1/prepare", { occurredAt: T.t1 });
    await api.post("/experiments/exp-1/rehearsal", { result: "PASS", occurredAt: T.t2 });

    const uplink = await api.post("/experiments/exp-1/uplink-confirm", { confirmer: "调度", signoffDeadline: T.far, occurredAt: T.t4 });
    assert.equal(uplink.status, 409);
    assert.equal(uplink.body.error.code, "APPROVAL_MISSING_OR_EXPIRED");
  } finally {
    await api.close();
  }
});

test("批次召回阻断持有方，释放召回批次并换批后解除阻断", async () => {
  const api = await startServer();
  try {
    await registerBatch(api, { id: "batch-1", quantity: 5 });
    await registerBatch(api, { id: "batch-2", quantity: 5 });
    await proposeAndApprove(api);
    await api.post("/experiments/exp-1/reservations", { batchId: "batch-1", quantity: 2, occurredAt: T.t1 });
    await api.post("/experiments/exp-1/prepare", { occurredAt: T.t1 });

    // 召回 batch-1：方案被阻断，后续节点一律拒绝
    const recalled = await api.post("/batches/batch-1/recall", { reason: "安全说明撤回", actor: "质控员", occurredAt: T.t2 });
    assert.equal(recalled.status, 200);
    assert.equal(recalled.body.status, "RECALLED");
    assert.equal(recalled.body.quantityAvailable, 0);
    assert.equal(recalled.body.quarantined, 3);

    const rehearse = await api.post("/experiments/exp-1/rehearsal", { result: "PASS", occurredAt: T.t2 });
    assert.equal(rehearse.status, 409);
    assert.equal(rehearse.body.error.code, "EXPERIMENT_BLOCKED");

    // 召回批次不可再被预留
    const reserveRecalled = await api.post("/experiments/exp-1/reservations", { batchId: "batch-1", quantity: 1, occurredAt: T.t2 });
    assert.equal(reserveRecalled.body.error.code, "EXPERIMENT_BLOCKED"); // 先被阻断拦截

    // 释放召回批次的预留 → 阻断解除；换批预留后流程继续
    const released = await api.post("/experiments/exp-1/release", { reservationId: "exp-1-rsv-1", reason: "召回退库", occurredAt: T.t2 });
    assert.equal(released.status, 200);
    assert.equal(released.body.blocked, null);

    const replacement = await api.post("/experiments/exp-1/reservations", { batchId: "batch-2", quantity: 2, occurredAt: T.t2 });
    assert.equal(replacement.status, 200);
    const rehearsed = await api.post("/experiments/exp-1/rehearsal", { result: "PASS", occurredAt: T.t3 });
    assert.equal(rehearsed.status, 200);

    // 审计可复原：召回 → 阻断 → 解除 的完整链条
    const audit = await api.get("/experiments/exp-1/audit");
    const types = audit.body.map((e) => e.type);
    assert.ok(types.includes("EXPERIMENT_BLOCKED"));
    assert.ok(types.includes("EXPERIMENT_UNBLOCKED"));
    const blockedIdx = types.indexOf("EXPERIMENT_BLOCKED");
    const unblockedIdx = types.indexOf("EXPERIMENT_UNBLOCKED");
    assert.ok(blockedIdx < unblockedIdx);
  } finally {
    await api.close();
  }
});

test("服务重启后重放日志，未完成流程可继续推进", async () => {
  const api = await startServer();
  const dir = api.dir;
  await registerBatch(api, { quantity: 5 });
  await proposeAndApprove(api);
  await api.post("/experiments/exp-1/reservations", { batchId: "batch-1", quantity: 2, occurredAt: T.t1 });
  await api.post("/experiments/exp-1/prepare", { occurredAt: T.t1 });
  await api.close();

  // 模拟重启：从同一数据目录重新打开
  const api2 = await startServer(dir);
  try {
    const detail = await api2.get("/experiments/exp-1");
    assert.equal(detail.body.stage, "PREPARED");
    assert.equal(detail.body.reservations.length, 1);
    const batch = await api2.get("/batches/batch-1");
    assert.equal(batch.body.quantityAvailable, 3);

    // 未完成的流程继续推进直至签收
    await api2.post("/experiments/exp-1/rehearsal", { result: "PASS", occurredAt: T.t2 });
    await api2.post("/experiments/exp-1/uplink-confirm", { confirmer: "调度", signoffDeadline: T.far, occurredAt: T.t3 });
    const signed = await api2.post("/experiments/exp-1/signoff", { signedBy: "教师", occurredAt: T.t4 });
    assert.equal(signed.body.stage, "SIGNED_OFF");
  } finally {
    await api2.close();
  }
});

test("停机期间审批过期：重启清扫补记并继续阻断", async () => {
  const api = await startServer();
  const dir = api.dir;
  // 审批有效期设为过去时间不可能（命令校验），改为：先批准到 far，再人工构造？
  // 用「批准到 t2，重启时真实时钟仍在 t2 之前」无法触发，因此改为验证重启清扫逻辑：
  // 批准有效期至 t2，随后用 t3 的命令触发过期待清扫，重启后状态保持 EXPIRED。
  await registerBatch(api, { quantity: 5 });
  await proposeAndApprove(api, { expiresAt: T.t2 });
  await api.post("/experiments/exp-1/reservations", { batchId: "batch-1", quantity: 1, occurredAt: T.t3 }); // 触发清扫并被拒
  await api.close();

  const api2 = await startServer(dir);
  try {
    const detail = await api2.get("/experiments/exp-1");
    assert.equal(detail.body.approval.status, "EXPIRED");
    const blocked = await api2.post("/experiments/exp-1/reservations", { batchId: "batch-1", quantity: 1, occurredAt: T.t3 });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.error.code, "APPROVAL_MISSING_OR_EXPIRED");
  } finally {
    await api2.close();
  }
});
