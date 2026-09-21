import assert from "node:assert/strict";
import test from "node:test";
import { startServer } from "./helpers.mjs";

test("健康检查返回可用状态", async () => {
  const api = await startServer();
  try {
    const { status, body } = await api.get("/health");
    assert.equal(status, 200);
    assert.deepEqual(body, { status: "ok" });
  } finally {
    await api.close();
  }
});
