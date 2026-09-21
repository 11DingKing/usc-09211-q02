import { createInitialState } from "./state.mjs";

/**
 * 事件 → 内存态的纯归约。除事件外不存在任何状态变更来源；
 * 重启后对 WAL 全量折叠即可恢复，流程天然续跑。
 */
export function applyEvent(state, event) {
  const { type, data: d } = event;
  switch (type) {
    case "planCreated": {
      state.plans.set(d.planId, {
        planId: d.planId,
        ownerSchoolId: d.ownerSchoolId,
        title: d.title,
        headVersionId: d.version.versionId,
        versions: new Map([[d.version.versionId, { ...d.version, supersededByVersionId: null }]]),
      });
      break;
    }
    case "planRevisionPublished": {
      const plan = state.plans.get(d.planId);
      if (d.supersedesVersionId) {
        const old = plan.versions.get(d.supersedesVersionId);
        old.supersededByVersionId = d.versionId;
      }
      plan.versions.set(d.versionId, {
        versionId: d.versionId,
        planId: d.planId,
        parentVersionId: d.parentVersionId,
        revisionType: d.revisionType,
        content: d.content,
        contentHash: d.contentHash,
        supersededByVersionId: null,
      });
      plan.headVersionId = d.versionId;
      break;
    }
    case "batchProposed": {
      state.batches.set(d.batchId, {
        batchId: d.batchId,
        schoolId: d.schoolId,
        planId: d.planId,
        versionId: d.versionId,
        stage: "proposed",
        requirements: d.requirements,
        approvalId: null,
        reservationActive: false,
        holds: [],
        usages: [],
        relatedBorrowIds: new Set(),
        safetyHold: false,
        rehearsed: false,
        rejection: null,
      });
      break;
    }
    case "riskReviewRejected": {
      const batch = state.batches.get(d.batchId);
      batch.stage = "rejected";
      batch.rejection = { reason: d.reason, reviewerId: d.reviewerId, atMs: event.recordedAt ?? null };
      break;
    }
    case "riskApprovalGranted": {
      state.approvals.set(d.approvalId, {
        approvalId: d.approvalId,
        batchId: d.batchId,
        planId: d.planId,
        planVersionId: d.planVersionId,
        reviewerId: d.reviewerId,
        validFromMs: d.validFromMs,
        validUntilMs: d.validUntilMs,
        revokedAtMs: null,
        revokeReason: null,
      });
      const batch = state.batches.get(d.batchId);
      batch.approvalId = d.approvalId;
      batch.stage = "reviewed";
      break;
    }
    case "riskApprovalRevoked": {
      const approval = state.approvals.get(d.approvalId);
      approval.revokedAtMs = d.atMs;
      approval.revokeReason = d.reason;
      break;
    }
    case "batchReserved": {
      const batch = state.batches.get(d.batchId);
      batch.reservationActive = true;
      batch.holds = d.holds.map((hold) => ({ ...hold }));
      batch.stage = "reserved";
      for (const borrowId of d.relatedBorrowIds ?? []) batch.relatedBorrowIds.add(borrowId);
      break;
    }
    case "batchReservationReleased": {
      const batch = state.batches.get(d.batchId);
      batch.reservationActive = false;
      batch.holds = [];
      break;
    }
    case "batchRehearsed": {
      const batch = state.batches.get(d.batchId);
      batch.stage = "rehearsed";
      batch.rehearsed = true;
      batch.lastRehearsal = { evidenceHash: d.evidenceHash ?? null, atMs: event.recordedAt ?? null };
      break;
    }
    case "batchUplinked": {
      state.batches.get(d.batchId).stage = "uplinked";
      break;
    }
    case "batchRebased": {
      const batch = state.batches.get(d.batchId);
      batch.archived ??= [];
      batch.archived.push({
        fromVersionId: d.fromVersionId,
        ...d.archived,
      });
      batch.versionId = d.toVersionId;
      batch.requirements = d.requirements;
      batch.approvalId = null;
      batch.rehearsed = false;
      batch.lastRehearsal = null;
      batch.reservationActive = false;
      batch.holds = [];
      batch.usages = [];
      batch.relatedBorrowIds = new Set();
      batch.stage = "reviewPending";
      break;
    }
    case "batchCancelled": {
      const batch = state.batches.get(d.batchId);
      batch.stage = "cancelled";
      batch.reservationActive = false;
      batch.holds = [];
      break;
    }
    case "batchSafetyHoldPlaced": {
      state.batches.get(d.batchId).safetyHold = true;
      break;
    }
    case "batchSafetyHoldCleared": {
      state.batches.get(d.batchId).safetyHold = false;
      break;
    }
    case "lotInbounded": {
      putLot(state, {
        lotId: d.lotId,
        schoolId: d.schoolId,
        materialId: d.materialId,
        qty: d.qty,
        kind: "inbound",
        originLotIds: [],
        sourceBorrowId: null,
      });
      break;
    }
    case "borrowRequested": {
      state.borrows.set(d.borrowId, {
        borrowId: d.borrowId,
        fromSchoolId: d.fromSchoolId,
        toSchoolId: d.toSchoolId,
        status: "requested",
        purpose: d.purpose ?? null,
        lines: new Map(
          d.lines.map((line) => [
            line.materialId,
            {
              materialId: line.materialId,
              requested: line.qty,
              dispatched: 0,
              received: 0,
              lostOutbound: 0,
              returnDispatched: 0,
              returnReceived: 0,
              lostReturn: 0,
              lostHeld: 0,
              retained: 0,
              unfulfilled: 0,
              originQueue: [],
              returnQueue: [],
            },
          ]),
        ),
      });
      break;
    }
    case "borrowCancelled": {
      state.borrows.get(d.borrowId).status = "cancelled";
      break;
    }
    case "borrowDispatched": {
      const borrow = state.borrows.get(d.borrowId);
      borrow.status = "dispatched";
      for (const pick of d.picks) {
        const line = borrow.lines.get(pick.materialId);
        line.dispatched += pick.qty;
        for (const lotPick of pick.lotPicks) {
          const lot = state.lots.get(lotPick.lotId);
          lot.qty -= lotPick.qty;
          line.originQueue.push({ lotId: lotPick.lotId, qty: lotPick.qty });
        }
      }
      break;
    }
    case "borrowShortShipped": {
      const borrow = state.borrows.get(d.borrowId);
      for (const line2 of d.lines) borrow.lines.get(line2.materialId).unfulfilled += line2.qty;
      break;
    }
    case "borrowReceived": {
      const borrow = state.borrows.get(d.borrowId);
      const line = borrow.lines.get(d.materialId);
      line.received += d.qty;
      const origins = consumeQueue(line.originQueue, d.qty);
      assertSameOrigins(origins, d.lot.originLotIds, borrow.borrowId, d.materialId, "签收");
      putLot(state, {
        lotId: d.lot.lotId,
        schoolId: borrow.toSchoolId,
        materialId: d.materialId,
        qty: d.lot.qty,
        kind: "borrowed",
        originLotIds: d.lot.originLotIds,
        sourceBorrowId: borrow.borrowId,
      });
      break;
    }
    case "borrowReturnDispatched": {
      const borrow = state.borrows.get(d.borrowId);
      const line = borrow.lines.get(d.materialId);
      line.returnDispatched += d.qty;
      for (const lotPick of d.picks) {
        const lot = state.lots.get(lotPick.lotId);
        lot.qty -= lotPick.qty;
        line.returnQueue.push({ lotId: lotPick.lotId, qty: lotPick.qty });
      }
      break;
    }
    case "borrowReturnReceived": {
      const borrow = state.borrows.get(d.borrowId);
      const line = borrow.lines.get(d.materialId);
      line.returnReceived += d.qty;
      const origins = consumeQueue(line.returnQueue, d.qty);
      assertSameOrigins(origins, d.lot.originLotIds, borrow.borrowId, d.materialId, "退料签收");
      putLot(state, {
        lotId: d.lot.lotId,
        schoolId: borrow.fromSchoolId,
        materialId: d.materialId,
        qty: d.lot.qty,
        kind: "returned",
        originLotIds: d.lot.originLotIds,
        sourceBorrowId: borrow.borrowId,
      });
      break;
    }
    case "borrowLossAcknowledged": {
      const line = state.borrows.get(d.borrowId) && state.borrows.get(d.borrowId).lines.get(d.materialId);
      if (d.leg === "outbound") line.lostOutbound += d.qty;
      else if (d.leg === "return") line.lostReturn += d.qty;
      else {
        // 在手丢失：货物此前已入借方 lot，必须从借方库存扣减。
        line.lostHeld += d.qty;
        for (const lotPick of d.picks ?? []) state.lots.get(lotPick.lotId).qty -= lotPick.qty;
      }
      break;
    }
    case "borrowRetained": {
      const borrow = state.borrows.get(d.borrowId);
      const line = borrow.lines.get(d.materialId);
      line.retained += d.qty;
      for (const lotPick of d.picks ?? []) {
        const oldLot = state.lots.get(lotPick.lotId);
        oldLot.qty -= lotPick.qty;
        // 赠与留存：拆出的新 lot 归借入校所有，并把原 lot 也记入溯源链。
        if (lotPick.newLotId) {
          putLot(state, {
            lotId: lotPick.newLotId,
            schoolId: borrow.toSchoolId,
            materialId: d.materialId,
            qty: lotPick.qty,
            kind: "retained",
            originLotIds: lotPick.originLotIds,
            sourceBorrowId: borrow.borrowId,
          });
        }
      }
      if (d.batchId) {
        const batch = state.batches.get(d.batchId);
        batch.retainedByBorrow ??= {};
        batch.retainedByBorrow[borrow.borrowId] ??= {};
        batch.retainedByBorrow[borrow.borrowId][d.materialId] =
          (batch.retainedByBorrow[borrow.borrowId][d.materialId] ?? 0) + d.qty;
      }
      break;
    }
    case "materialUsed": {
      const batch = state.batches.get(d.batchId);
      for (const pick of d.picks) {
        const lot = state.lots.get(pick.lotId);
        lot.qty -= pick.qty;
        consumeHold(batch, pick.requirementId, pick.materialId, pick.lotId, pick.qty);
        const usage = batch.usages.find(
          (u) => u.requirementId === pick.requirementId && u.materialId === pick.materialId && u.lotId === pick.lotId,
        );
        if (usage) usage.qtyUsed += pick.qty;
        else batch.usages.push({ requirementId: pick.requirementId, materialId: pick.materialId, lotId: pick.lotId, qtyUsed: pick.qty, qtyReturned: 0 });
      }
      break;
    }
    case "materialReturned": {
      const batch = state.batches.get(d.batchId);
      for (const pick of d.picks) {
        state.lots.get(pick.lotId).qty += pick.qty;
        const usage = batch.usages.find(
          (u) => u.requirementId === pick.requirementId && u.materialId === pick.materialId && u.lotId === pick.lotId,
        );
        usage.qtyReturned += pick.qty;
      }
      break;
    }
    case "batchUnusedReleased": {
      const batch = state.batches.get(d.batchId);
      batch.reservationActive = false;
      batch.holds = [];
      break;
    }
    case "recallIssued": {
      state.recalls.set(d.recallId, {
        recallId: d.recallId,
        scope: d.scope,
        materialId: d.materialId ?? null,
        lotId: d.lotId ?? null,
        reason: d.reason,
        issuedAtMs: d.issuedAtMs,
        closedAtMs: null,
      });
      break;
    }
    case "recallClosed": {
      state.recalls.get(d.recallId).closedAtMs = d.closedAtMs;
      break;
    }
    default:
      throw new Error(`未知事件类型：${type}`);
  }
  return state;
}

function putLot(state, lot) {
  if (state.lots.has(lot.lotId)) throw new Error(`lot 身份重复：${lot.lotId}`);
  state.lots.set(lot.lotId, lot);
  state.lotOrder.push(lot.lotId);
}

/** 归约时按 FIFO 消费来源队列；命令试算阶段不得调用（保持处理器纯度）。 */
function consumeQueue(queue, qty) {
  let need = qty;
  const origins = new Set();
  while (need > 0) {
    const entry = queue[0];
    if (!entry) throw new Error("在途来源队列不足，数量账与来源账不一致");
    const take = Math.min(entry.qty, need);
    origins.add(entry.lotId);
    entry.qty -= take;
    need -= take;
    if (entry.qty === 0) queue.shift();
  }
  return [...origins].sort();
}

/** 命令时纯试算得到的来源与归约时队列实算结果必须一致，否则程序存在缺陷。 */
function assertSameOrigins(actual, expected, borrowId, materialId, label) {
  const a = [...actual].sort();
  const e = [...expected].sort();
  if (a.length !== e.length || a.some((lotId, i) => lotId !== e[i])) {
    throw new Error(`${label}来源账不一致（borrow ${borrowId} / ${materialId}）：期望 ${e.join(",")}，实得 ${a.join(",")}`);
  }
}

function consumeHold(batch, requirementId, materialId, lotId, qty) {
  let remaining = qty;
  for (const hold of batch.holds) {
    if (remaining === 0) break;
    if (hold.requirementId !== requirementId || hold.materialId !== materialId || hold.lotId !== lotId) continue;
    const take = Math.min(hold.qty, remaining);
    hold.qty -= take;
    remaining -= take;
  }
  if (remaining > 0) throw new Error("领用/归还数量超出该批次在该 lot 上的预留");
  batch.holds = batch.holds.filter((hold) => hold.qty > 0);
}

export function foldAll(events) {
  const state = createInitialState();
  for (const event of events) applyEvent(state, event);
  assertBorrowConservation(state);
  return state;
}

/**
 * 借用三腿守恒恒等式。每条命令后都成立；重放结束再断言一次，
 * 任何不闭合都说明程序或日志有缺陷，fail-closed。
 */
export function assertBorrowConservation(state) {
  for (const borrow of state.borrows.values()) {
    for (const line of borrow.lines.values()) {
      const inTransitOut = line.dispatched - line.received - line.lostOutbound;
      const onHand = line.received - line.returnDispatched - line.retained - line.lostHeld;
      const inTransitReturn = line.returnDispatched - line.returnReceived - line.lostReturn;
      for (const [name, value] of Object.entries({ inTransitOut, onHand, inTransitReturn })) {
        if (value < 0) throw new Error(`借用 ${borrow.borrowId} 料号 ${line.materialId} 的 ${name} 为负（${value}），守恒被破坏`);
      }
    }
  }
}

/** 借用行的派生量与结清判定，接口投影与门检共用。 */
export function borrowLineSettlement(line) {
  const inTransitOut = line.dispatched - line.received - line.lostOutbound;
  const onHand = line.received - line.returnDispatched - line.retained - line.lostHeld;
  const inTransitReturn = line.returnDispatched - line.returnReceived - line.lostReturn;
  // 发货量与确认短发量之和达到请求量，借出校的发货义务才告终结。
  const requestedResolved = line.dispatched + line.unfulfilled >= line.requested;
  const settled =
    requestedResolved && inTransitOut === 0 && onHand === 0 && inTransitReturn === 0;
  return { inTransitOut, onHand, inTransitReturn, requestedResolved, settled };
}
