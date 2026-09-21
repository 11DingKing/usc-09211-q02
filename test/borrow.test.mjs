import assert from "node:assert/strict";
import test from "node:test";
import { Harness, seedApprovedBatch, inbound, uniqueId } from "./helpers.mjs";

const HK = "SCHOOL_HK";
const MO = "SCHOOL_MO";
const hkActor = { actorId: "teacher_chan", orgId: HK };
const moActor = { actorId: "teacher_ng", orgId: MO };

test("借用全链：材料级预留→部分发货→延迟/部分签收→部分退料→退料签收→实物留存，最终结清", async () => {
  const h = new Harness();
  await h.start();
  try {
    await inbound(h, { lotId: "c1", schoolId: HK, materialId: "MAT_C", qty: 10 }, hkActor);

    // 香港校的一个批次想占 7 件：借用请求先形成材料级预留，只剩 6，应当失败。
    let borrowId = uniqueId("brw");
    let r = await h.command("POST", "/borrows", {
      borrowId, fromSchoolId: HK, toSchoolId: MO, purpose: "微重力演示",
      lines: [{ materialId: "MAT_C", qty: 4 }],
    }, { actor: moActor });
    assert.equal(r.status, 200);

    const hkBatch = await seedApprovedBatch(h, { batchId: "b_hk", schoolId: HK, requirements: [
      { requirementId: "r1", materialId: "MAT_C", qty: 7, unit: "件", allowedSubstituteMaterialIds: [] },
    ] });
    r = await h.command("POST", `/batches/${hkBatch.batchId}/reserve`, { batchId: hkBatch.batchId }, { actor: hkActor });
    assert.equal(r.status, 422);
    assert.ok(r.body.error.details.blockers.some((b) => b.code === "MATERIALS_NOT_READY"));

    // 部分发货 3（借出校减量，在途 3，仍欠 1）。
    r = await h.command("POST", `/borrows/${borrowId}/dispatch`, {
      borrowId, lines: [{ materialId: "MAT_C", qty: 3 }],
    }, { actor: hkActor });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.reply.picks[0].lotPicks[0].lotId, "c1");

    // 确认短发 1，借出校发货义务终结。
    r = await h.command("POST", `/borrows/${borrowId}/short-ship`, {
      borrowId, lines: [{ materialId: "MAT_C", qty: 1 }], reason: "库存盘点不足",
    }, { actor: hkActor });
    assert.equal(r.status, 200);

    // 延迟、分两次签收 2 + 1：借入校各建一个带溯源的 borrowed lot。
    h.tick(3 * 86400_000);
    r = await h.command("POST", `/borrows/${borrowId}/receipts`, {
      borrowId, materialId: "MAT_C", qty: 2, lotId: "br1",
    }, { actor: moActor });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.reply.originLotIds, ["c1"]);
    r = await h.command("POST", `/borrows/${borrowId}/receipts`, {
      borrowId, materialId: "MAT_C", qty: 1, lotId: "br2",
    }, { actor: moActor });
    assert.equal(r.status, 200);

    // 超签必须拒绝。
    r = await h.command("POST", `/borrows/${borrowId}/receipts`, {
      borrowId, materialId: "MAT_C", qty: 1, lotId: "br3",
    }, { actor: moActor });
    assert.equal(r.status, 409);

    // 借入校现在持有 3 件来源可溯的 MAT_C。
    let inv = await h.get(`/inventory?schoolId=${MO}&materialId=MAT_C`);
    assert.equal(inv.body.lots.reduce((s, l) => s + l.qtyOnHand, 0), 3);

    // 部分退料 2（从借入校 borrowed lot FIFO 取出），并由香港校延迟签收。
    r = await h.command("POST", `/borrows/${borrowId}/returns`, {
      borrowId, materialId: "MAT_C", qty: 2,
    }, { actor: moActor });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.reply.picks[0].lotId, "br1");

    h.tick(2 * 86400_000);
    r = await h.command("POST", `/borrows/${borrowId}/return-receipts`, {
      borrowId, materialId: "MAT_C", qty: 2, lotId: "rt1",
    }, { actor: hkActor });
    assert.equal(r.status, 200);
    // 退料 lot 的直接来源是借入校 lot br1，沿溯源闭包仍可回到 c1。
    assert.deepEqual(r.body.reply.originLotIds, ["br1"]);

    // 退料形成新的 returned lot，不写回原 lot。
    const rt1 = await h.get("/lots/rt1");
    assert.equal(rt1.body.kind, "returned");
    assert.equal(rt1.body.schoolId, HK);

    // 剩 1 件经贷方同意整体留存（赠与）：拆为借入校自有的 retained lot。
    r = await h.command("POST", `/borrows/${borrowId}/retain`, {
      borrowId, materialId: "MAT_C", qty: 1, reason: "澳门校教学留用，已征得同意",
      picks: [{ lotId: "br2", newLotId: "gift1", qty: 1 }],
    }, { actor: hkActor });
    assert.equal(r.status, 200, JSON.stringify(r.body));

    const view = await h.get(`/borrows/${borrowId}`);
    assert.equal(view.body.status, "dispatched");
    assert.equal(view.body.settled, true, JSON.stringify(view.body.lines));
    const line = view.body.lines[0];
    assert.equal(line.inTransitOut, 0);
    assert.equal(line.onHand, 0);
    assert.equal(line.inTransitReturn, 0);
    assert.equal(line.settled, true);

    // gift1 可被借入校当作自有材料预留（retained 在自有类别内），且溯源含 c1。
    const gift = await h.get("/lots/gift1");
    assert.equal(gift.body.kind, "retained");
    assert.deepEqual(gift.body.originLotIds, ["br2", "c1"]);
  } finally {
    await h.stop();
    h.cleanup();
  }
});

test("借用未结清时关联批次不得上行；退料全部签收后放行", async () => {
  const h = new Harness();
  await h.start();
  try {
    await inbound(h, { lotId: "d1", schoolId: HK, materialId: "MAT_D", qty: 6 }, hkActor);
    const borrowId = uniqueId("brw");
    await h.command("POST", "/borrows", {
      borrowId, fromSchoolId: HK, toSchoolId: MO,
      lines: [{ materialId: "MAT_D", qty: 2 }],
    }, { actor: moActor });
    await h.command("POST", `/borrows/${borrowId}/dispatch`, {
      borrowId, lines: [{ materialId: "MAT_D", qty: 2 }],
    }, { actor: hkActor });
    await h.command("POST", `/borrows/${borrowId}/receipts`, {
      borrowId, materialId: "MAT_D", qty: 2, lotId: "dbr1",
    }, { actor: moActor });

    // 澳门校批次使用借入 lot 完成演示（该料在演示中被消耗，标记为消耗品）。
    const seed = await seedApprovedBatch(h, { batchId: "b_mo", schoolId: MO, requirements: [
      { requirementId: "r1", materialId: "MAT_D", qty: 2, unit: "件", consumable: true, allowedSubstituteMaterialIds: [] },
    ] });
    let r = await h.command("POST", `/batches/${seed.batchId}/reserve`, { batchId: seed.batchId }, { actor: moActor });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.reply.relatedBorrowIds, [borrowId]);

    // 实验消耗 2 件，以“消耗留存”闭合借用（贷方认可已用于教学）。
    r = await h.command("POST", `/batches/${seed.batchId}/use`, {
      batchId: seed.batchId, picks: [{ requirementId: "r1", lotId: "dbr1", qty: 2 }],
    }, { actor: moActor });
    assert.equal(r.status, 200);

    await h.command("POST", `/batches/${seed.batchId}/rehearse`, { batchId: seed.batchId }, { actor: moActor });

    // 释放预留（实物已消耗，无剩余可钉）。
    await h.command("POST", `/batches/${seed.batchId}/release-unused`, { batchId: seed.batchId }, { actor: moActor });

    r = await h.command("POST", `/batches/${seed.batchId}/uplink`, { batchId: seed.batchId }, { actor: moActor });
    assert.equal(r.status, 422);
    assert.ok(JSON.stringify(r.body).includes("BORROW_UNSETTLED"));

    r = await h.command("POST", `/borrows/${borrowId}/retain`, {
      borrowId, materialId: "MAT_D", qty: 2, reason: "教学演示已消耗", batchId: seed.batchId,
    }, { actor: hkActor });
    assert.equal(r.status, 200, JSON.stringify(r.body));

    r = await h.command("POST", `/batches/${seed.batchId}/uplink`, { batchId: seed.batchId }, { actor: moActor });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.reply.stage, "uplinked");
  } finally {
    await h.stop();
    h.cleanup();
  }
});

test("出站在途丢失经确认后闭合，数量守恒不允许负数", async () => {
  const h = new Harness();
  await h.start();
  try {
    await inbound(h, { lotId: "e1", schoolId: HK, materialId: "MAT_E", qty: 3 }, hkActor);
    const borrowId = uniqueId("brw");
    await h.command("POST", "/borrows", {
      borrowId, fromSchoolId: HK, toSchoolId: MO,
      lines: [{ materialId: "MAT_E", qty: 3 }],
    }, { actor: moActor });
    await h.command("POST", `/borrows/${borrowId}/dispatch`, {
      borrowId, lines: [{ materialId: "MAT_E", qty: 3 }],
    }, { actor: hkActor });
    // 在途 3 件中 1 件丢失，2 件正常签收。
    let r = await h.command("POST", `/borrows/${borrowId}/loss`, {
      borrowId, leg: "outbound", materialId: "MAT_E", qty: 1,
    }, { actor: moActor });
    assert.equal(r.status, 200);
    r = await h.command("POST", `/borrows/${borrowId}/receipts`, {
      borrowId, materialId: "MAT_E", qty: 2, lotId: "ebr1",
    }, { actor: moActor });
    assert.equal(r.status, 200);
    // 2 件退回并签收。
    await h.command("POST", `/borrows/${borrowId}/returns`, { borrowId, materialId: "MAT_E", qty: 2 }, { actor: moActor });
    r = await h.command("POST", `/borrows/${borrowId}/return-receipts`, {
      borrowId, materialId: "MAT_E", qty: 2, lotId: "ert1",
    }, { actor: hkActor });
    assert.equal(r.status, 200);
    const view = await h.get(`/borrows/${borrowId}`);
    assert.equal(view.body.settled, true);
    assert.equal(view.body.lines[0].lostOutbound, 1);
  } finally {
    await h.stop();
    h.cleanup();
  }
});
