import assert from "node:assert/strict";
import test from "node:test";
import { proposeAndApprove, registerBatch, startServer, T } from "./helpers.mjs";

// 任何修订生成不可覆盖的新版本，旧版本仍可读取；
// 修订使旧审批失效、作废旧预留并释放库存，受影响批次写入事件供追踪。
test("修订形成不可覆盖版本并追踪受影响批次", async () => {
  const api = await startServer();
  try {
    await registerBatch(api, { quantity: 10 });
    await proposeAndApprove(api);
    await api.post("/experiments/exp-1/reservations", { batchId: "batch-1", quantity: 2, occurredAt: T.t1 });

    const revised = await api.post("/experiments/exp-1/versions", {
      materials: [{ materialId: "mat-水", quantity: 3 }],
      safetyNotes: "护目镜 + 手套",
      changeReason: "安全说明更新",
      occurredAt: T.t2,
    });
    assert.equal(revised.status, 200);
    assert.equal(revised.body.currentVersion, 2);
    assert.equal(revised.body.stage, "PROPOSED"); // 回到待复核
    assert.equal(revised.body.approval, null); // 旧审批失效
    assert.equal(revised.body.reservations[0].status, "SUPERSEDED"); // 旧预留作废

    // 旧版本未被覆盖，仍可读取
    const v1 = await api.get("/experiments/exp-1/versions/1");
    assert.equal(v1.status, 200);
    assert.equal(v1.body.safetyNotes, "佩戴护目镜");
    assert.equal(v1.body.materials[0].quantity, 2);
    const v2 = await api.get("/experiments/exp-1/versions/2");
    assert.equal(v2.body.safetyNotes, "护目镜 + 手套");

    // 库存已释放
    const batch = await api.get("/batches/batch-1");
    assert.equal(batch.body.quantityAvailable, 10);

    // 修订事件记录了受影响批次
    const audit = await api.get("/experiments/exp-1/audit");
    const reviseEvent = audit.body.find((e) => e.type === "EXPERIMENT_REVISED");
    assert.deepEqual(reviseEvent.payload.affectedBatches, ["batch-1"]);
    assert.equal(reviseEvent.payload.supersededVersionNo, 1);
    assert.ok(audit.body.some((e) => e.type === "RESERVATION_SUPERSEDED"));

    // 修订后旧审批不再放行：直接备料被拒绝，须重新复核
    const prepare = await api.post("/experiments/exp-1/prepare", { occurredAt: T.t2 });
    assert.equal(prepare.status, 409);
  } finally {
    await api.close();
  }
});

test("上行确认后方案冻结，不得再修订", async () => {
  const api = await startServer();
  try {
    await registerBatch(api, { quantity: 5 });
    await proposeAndApprove(api);
    await api.post("/experiments/exp-1/reservations", { batchId: "batch-1", quantity: 2, occurredAt: T.t1 });
    await api.post("/experiments/exp-1/prepare", { occurredAt: T.t1 });
    await api.post("/experiments/exp-1/rehearsal", { result: "PASS", occurredAt: T.t2 });
    await api.post("/experiments/exp-1/uplink-confirm", { confirmer: "调度", signoffDeadline: T.far, occurredAt: T.t3 });

    const revised = await api.post("/experiments/exp-1/versions", {
      materials: [{ materialId: "mat-水", quantity: 1 }],
      changeReason: "试图修改",
      occurredAt: T.t3,
    });
    assert.equal(revised.status, 409);
    assert.equal(revised.body.error.code, "REVISION_NOT_ALLOWED");
  } finally {
    await api.close();
  }
});
