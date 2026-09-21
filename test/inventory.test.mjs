import assert from "node:assert/strict";
import test from "node:test";
import { proposeAndApprove, registerBatch, startServer, T } from "./helpers.mjs";

test("并发预留：库存不足时仅一个请求成功，绝不重复占用", async () => {
  const api = await startServer();
  try {
    await registerBatch(api, { quantity: 5 });
    await proposeAndApprove(api);

    const [a, b] = await Promise.all([
      api.post("/experiments/exp-1/reservations", { batchId: "batch-1", quantity: 4, occurredAt: T.t1 }),
      api.post("/experiments/exp-1/reservations", { batchId: "batch-1", quantity: 4, occurredAt: T.t1 }),
    ]);
    const statuses = [a.status, b.status].sort();
    assert.deepEqual(statuses, [200, 409]);
    const failed = a.status === 409 ? a : b;
    assert.equal(failed.body.error.code, "INSUFFICIENT_STOCK");

    const batch = await api.get("/batches/batch-1");
    assert.equal(batch.body.quantityAvailable, 1);
    assert.equal(batch.body.reservations.length, 1);
  } finally {
    await api.close();
  }
});

test("幂等键：重试同一预留请求不会重复扣减库存", async () => {
  const api = await startServer();
  try {
    await registerBatch(api, { quantity: 5 });
    await proposeAndApprove(api);

    const headers = { "idempotency-key": "reserve-exp-1-001" };
    const first = await api.post("/experiments/exp-1/reservations", { batchId: "batch-1", quantity: 3, occurredAt: T.t1 }, headers);
    const second = await api.post("/experiments/exp-1/reservations", { batchId: "batch-1", quantity: 3, occurredAt: T.t1 }, headers);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.deepEqual(second.body, first.body);

    const batch = await api.get("/batches/batch-1");
    assert.equal(batch.body.quantityAvailable, 2);
    assert.equal(batch.body.reservations.length, 1);
  } finally {
    await api.close();
  }
});

test("部分退料：可多次退，累计不得超过预留量", async () => {
  const api = await startServer();
  try {
    await registerBatch(api, { quantity: 10 });
    await proposeAndApprove(api);
    await api.post("/experiments/exp-1/reservations", { batchId: "batch-1", quantity: 6, occurredAt: T.t1 });

    const r1 = await api.post("/experiments/exp-1/returns", { reservationId: "exp-1-rsv-1", quantity: 2, reason: "损耗", occurredAt: T.t2 });
    assert.equal(r1.status, 200);
    const r2 = await api.post("/experiments/exp-1/returns", { reservationId: "exp-1-rsv-1", quantity: 2, reason: "剩余", occurredAt: T.t2 });
    assert.equal(r2.status, 200);

    // 累计退 4，再退 3 超过余量 2，确定性地拒绝
    const r3 = await api.post("/experiments/exp-1/returns", { reservationId: "exp-1-rsv-1", quantity: 3, occurredAt: T.t2 });
    assert.equal(r3.status, 409);
    assert.equal(r3.body.error.code, "RETURN_EXCEEDS_RESERVED");

    let batch = await api.get("/batches/batch-1");
    assert.equal(batch.body.quantityAvailable, 8); // 10 - 6 + 4

    // 退完全部余量后预留单关闭
    const r4 = await api.post("/experiments/exp-1/returns", { reservationId: "exp-1-rsv-1", quantity: 2, occurredAt: T.t3 });
    assert.equal(r4.body.reservations[0].status, "RETURNED");
    batch = await api.get("/batches/batch-1");
    assert.equal(batch.body.quantityAvailable, 10);
  } finally {
    await api.close();
  }
});

test("备料校验：清单内材料未被足额预留时拒绝备料", async () => {
  const api = await startServer();
  try {
    await registerBatch(api, { quantity: 10 });
    await proposeAndApprove(api); // 需要 mat-水 x2
    await api.post("/experiments/exp-1/reservations", { batchId: "batch-1", quantity: 1, occurredAt: T.t1 });
    const prepare = await api.post("/experiments/exp-1/prepare", { occurredAt: T.t1 });
    assert.equal(prepare.status, 409);
    assert.equal(prepare.body.error.code, "MATERIAL_SHORTAGE");
  } finally {
    await api.close();
  }
});
