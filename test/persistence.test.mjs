import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { Harness, inbound, seedApprovedBatch, uniqueId } from "./helpers.mjs";

test("篡改任一审计行会被哈希链检测到并拒绝启动", async () => {
  const h = new Harness();
  await h.start();
  try {
    const seed = await seedApprovedBatch(h);
    await inbound(h, { lotId: "a1", schoolId: seed.schoolId, materialId: "MAT_A", qty: 3 }, seed.actor);
    await h.command("POST", `/batches/${seed.batchId}/reserve`, { batchId: seed.batchId }, { actor: seed.actor });
    await h.stop();

    const logPath = `${h.dataDir}/events.log`;
    const lines = fs.readFileSync(logPath, "utf8").split("\n");
    // 篡改第 2 行的 payload（改一个字符）。
    lines[1] = lines[1].replace("MAT_A", "MAT_X");
    fs.writeFileSync(logPath, `${lines.join("\n")}`);

    await assert.rejects(() => h.start(), /哈希链校验失败/);
  } finally {
    h.cleanup();
  }
});

test("末行截断（torn tail）fail-closed 拒绝启动，不静默截断修复", async () => {
  const h = new Harness();
  await h.start();
  try {
    const seed = await seedApprovedBatch(h);
    await h.stop();
    const logPath = `${h.dataDir}/events.log`;
    const text = fs.readFileSync(logPath, "utf8");
    fs.writeFileSync(logPath, text.slice(0, text.length - 5)); // 去掉结尾若干字节
    await assert.rejects(() => h.start(), /torn tail|解析|校验失败/);
  } finally {
    h.cleanup();
  }
});

test("单写者锁：第二个实例使用同一数据目录会被拒绝", async () => {
  const h = new Harness();
  await h.start();
  try {
    const { createServer } = await import("../src/server.mjs");
    assert.throws(() => createServer({ dataDir: h.dataDir }), /锁定/);
  } finally {
    await h.stop();
    h.cleanup();
  }
});

test("重启后审计 verify 与决策记录一致，事件身份稳定", async () => {
  const h = new Harness();
  await h.start();
  try {
    const seed = await seedApprovedBatch(h);
    await inbound(h, { lotId: "a1", schoolId: seed.schoolId, materialId: "MAT_A", qty: 3 }, seed.actor);
    const reserved = await h.command("POST", `/batches/${seed.batchId}/reserve`, { batchId: seed.batchId }, { actor: seed.actor });
    const eventId = reserved.body.events[0].eventId;
    const seq = reserved.body.seq;

    await h.restart();

    const verify = await h.get("/audit/verify");
    assert.equal(verify.body.ok, true);
    assert.equal(verify.body.tipSeq >= seq, true);

    const audit = await h.get(`/audit?afterSeq=${seq - 1}&limit=1`);
    assert.equal(audit.body.envelopes[0].seq, seq);
    assert.equal(audit.body.envelopes[0].result.events[0].id, eventId);
  } finally {
    await h.stop();
    h.cleanup();
  }
});

test("材料级借用预留竞争：先请求的借用单占料，后一单不得超额发货", async () => {
  const h = new Harness();
  await h.start();
  try {
    const hk = { actorId: "chan", orgId: "SCHOOL_HK" };
    const mo = { actorId: "ng", orgId: "SCHOOL_MO" };
    await inbound(h, { lotId: "h1", schoolId: "SCHOOL_HK", materialId: "MAT_H", qty: 5 }, hk);

    const b1 = uniqueId("brw");
    const b2 = uniqueId("brw");
    // 第一单请求 4（材料级预留 4），第二单再请求 4：池只剩 1。
    await h.command("POST", "/borrows", { borrowId: b1, fromSchoolId: "SCHOOL_HK", toSchoolId: "SCHOOL_MO", lines: [{ materialId: "MAT_H", qty: 4 }] }, { actor: mo });
    await h.command("POST", "/borrows", { borrowId: b2, fromSchoolId: "SCHOOL_HK", toSchoolId: "SCHOOL_MO", lines: [{ materialId: "MAT_H", qty: 4 }] }, { actor: mo });

    // 第二单先尝试发货 4：只能发 1，应被拒且不产生任何出库。
    const over = await h.command("POST", `/borrows/${b2}/dispatch`, { borrowId: b2, lines: [{ materialId: "MAT_H", qty: 4 }] }, { actor: hk });
    assert.equal(over.status, 422);
    assert.ok(JSON.stringify(over.body).includes("MATERIALS_NOT_READY"));

    // 第一单可正常发 4。
    const ok = await h.command("POST", `/borrows/${b1}/dispatch`, { borrowId: b1, lines: [{ materialId: "MAT_H", qty: 4 }] }, { actor: hk });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.reply.picks[0].lotPicks.reduce((s, p) => s + p.qty, 0), 4);

    // 第一单发货后其预留转为实际出库；第二单现在面对实物 1，仍无法发 4。
    const still = await h.command("POST", `/borrows/${b2}/dispatch`, { borrowId: b2, lines: [{ materialId: "MAT_H", qty: 4 }] }, { actor: hk });
    assert.equal(still.status, 422);
  } finally {
    await h.stop();
    h.cleanup();
  }
});
