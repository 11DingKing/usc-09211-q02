import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store.mjs";
import { createServer } from "../src/server.mjs";

// 统一的业务时间线，避免测试依赖真实时钟
export const T = {
  t0: "2026-10-01T00:00:00.000Z",
  t1: "2026-10-02T00:00:00.000Z",
  t2: "2026-10-03T00:00:00.000Z",
  t3: "2026-10-04T00:00:00.000Z",
  t4: "2026-10-05T00:00:00.000Z",
  far: "2026-12-31T00:00:00.000Z",
};

export async function startServer(dir) {
  const dataDir = dir ?? (await fs.mkdtemp(path.join(os.tmpdir(), "smc-")));
  const store = await Store.open(dataDir);
  const server = createServer(store);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    dir: dataDir,
    store,
    server,
    async post(p, body = {}, headers = {}) {
      const res = await fetch(base + p, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    },
    async get(p) {
      const res = await fetch(base + p);
      return { status: res.status, body: await res.json().catch(() => null) };
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

// 常用流程：提案 + 风险批准
export async function proposeAndApprove(api, { id = "exp-1", school = "香港校", materials, expiresAt = T.far } = {}) {
  const proposed = await api.post("/experiments", {
    experimentId: id,
    school,
    title: "微重力毛细演示",
    materials: materials ?? [{ materialId: "mat-水", quantity: 2 }],
    safetyNotes: "佩戴护目镜",
    occurredAt: T.t0,
  });
  const reviewed = await api.post(`/experiments/${id}/risk-review`, {
    decision: "APPROVED",
    approver: "风控员甲",
    expiresAt,
    occurredAt: T.t0,
  });
  return { proposed, reviewed };
}

export async function registerBatch(api, { id = "batch-1", materialId = "mat-水", school = "香港校", quantity = 10, expiresAt = T.far } = {}) {
  return api.post("/batches", {
    batchId: id,
    materialId,
    lot: "L2026-09",
    school,
    quantity,
    expiresAt,
    occurredAt: T.t0,
  });
}
