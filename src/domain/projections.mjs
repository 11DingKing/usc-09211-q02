import { borrowLineSettlement } from "./reducers.mjs";
import { gateSnapshot, approvalStatus, versionStatus, recallStatus, settlementStatus } from "./gates.mjs";
import { recallFootprint } from "./inventory.mjs";

/** 批次的对外只读视图。 */
export function batchView(state, batchId, nowMs) {
  const batch = state.batches.get(batchId);
  if (!batch) return null;
  const plan = state.plans.get(batch.planId);
  const version = plan.versions.get(batch.versionId);
  const approval = batch.approvalId ? state.approvals.get(batch.approvalId) : null;
  const holdsQty = batch.holds.reduce((sum, h) => sum + h.qty, 0);
  return {
    batchId: batch.batchId,
    schoolId: batch.schoolId,
    planId: batch.planId,
    versionId: batch.versionId,
    stage: batch.stage,
    safetyHold: batch.safetyHold,
    rehearsed: batch.rehearsed,
    requirements: batch.requirements,
    approval: approval
      ? {
          approvalId: approval.approvalId,
          reviewerId: approval.reviewerId,
          validFrom: new Date(approval.validFromMs).toISOString(),
          validUntil: new Date(approval.validUntilMs).toISOString(),
          revokedAt: approval.revokedAtMs ? new Date(approval.revokedAtMs).toISOString() : null,
          status: approvalStatus(state, batch, nowMs).code,
        }
      : null,
    versionStatus: versionStatus(state, batch).code,
    reservationActive: batch.reservationActive,
    outstandingHoldQty: holdsQty,
    holds: batch.holds,
    usages: batch.usages,
    relatedBorrowIds: [...(batch.relatedBorrowIds ?? [])],
    archives: (batch.archived ?? []).map((a) => ({
      fromVersionId: a.fromVersionId,
      relatedBorrowIds: a.relatedBorrowIds,
      usageQty: (a.usages ?? []).reduce((sum, u) => sum + u.qtyUsed, 0),
    })),
    rejection: batch.rejection,
  };
}

export function borrowView(state, borrowId) {
  const borrow = state.borrows.get(borrowId);
  if (!borrow) return null;
  const lines = [...borrow.lines.values()].map((line) => {
    const s = borrowLineSettlement(line);
    return {
      materialId: line.materialId,
      requested: line.requested,
      dispatched: line.dispatched,
      received: line.received,
      lostOutbound: line.lostOutbound,
      unfulfilled: line.unfulfilled,
      returnDispatched: line.returnDispatched,
      returnReceived: line.returnReceived,
      lostReturn: line.lostReturn,
      lostHeld: line.lostHeld,
      retained: line.retained,
      inTransitOut: s.inTransitOut,
      onHand: s.onHand,
      inTransitReturn: s.inTransitReturn,
      settled: s.settled,
    };
  });
  return {
    borrowId: borrow.borrowId,
    fromSchoolId: borrow.fromSchoolId,
    toSchoolId: borrow.toSchoolId,
    purpose: borrow.purpose,
    status: borrow.status,
    settled: lines.every((line) => line.settled),
    lines,
  };
}

/**
 * 决策记录：审核人员据此复原“这套材料为何获准进入课堂”。
 * 六类证据全部指向审计信封坐标（seq/eventId/recordedAt/hash），
 * 可与 GET /audit 的原始记录逐条对照。
 */
export function decisionRecord(wal, state, batchId, nowMs) {
  const batch = state.batches.get(batchId);
  if (!batch) return null;
  const plan = state.plans.get(batch.planId);
  const relatedBorrowIds = new Set(batch.relatedBorrowIds ?? []);
  // 归档版本可能关联过的借用单也纳入（rebase 前的在途借用）。
  for (const archive of batch.archived ?? []) {
    for (const borrowId of archive.relatedBorrowIds ?? []) relatedBorrowIds.add(borrowId);
  }

  // 命中本批次物料足迹的召回（含已关闭的，历史阻断也要可复原）。
  const batchMaterialIds = new Set();
  const batchLotIds = new Set();
  const collectRefs = (holds, usages) => {
    for (const hold of holds ?? []) batchLotIds.add(hold.lotId);
    for (const usage of usages ?? []) batchLotIds.add(usage.lotId);
  };
  collectRefs(batch.holds, batch.usages);
  for (const archive of batch.archived ?? []) collectRefs(archive.holds, archive.usages);
  for (const requirement of batch.requirements) {
    batchMaterialIds.add(requirement.materialId);
    for (const sub of requirement.allowedSubstituteMaterialIds ?? []) batchMaterialIds.add(sub);
  }
  for (const lotId of batchLotIds) {
    const lot = state.lots.get(lotId);
    if (lot) batchMaterialIds.add(lot.materialId);
  }
  // 沿 originLotIds 向上做传递闭包（多跳借用/退料/留存的祖先 lot 也算足迹）。
  let grew = true;
  while (grew) {
    grew = false;
    for (const lotId of [...batchLotIds]) {
      const lot = state.lots.get(lotId);
      for (const origin of lot?.originLotIds ?? []) {
        if (!batchLotIds.has(origin)) {
          batchLotIds.add(origin);
          grew = true;
        }
      }
    }
  }
  const relevantRecallIds = new Set();
  for (const recall of state.recalls.values()) {
    if ((recall.scope === "ITEM" && batchMaterialIds.has(recall.materialId)) ||
        (recall.scope === "LOT" && batchLotIds.has(recall.lotId))) {
      relevantRecallIds.add(recall.recallId);
    }
  }

  // 与本批次相关的审批号（含 rebase 前已作废的）通过审计流之外无法直接枚举，
  // 因此在扫描时按 approvalId -> batchId 反查（payload 不直接带 batchId 的撤销命令）。
  const approvalOwners = new Map();
  for (const envelope of wal.envelopes) {
    if (envelope.commandType === "riskDecision" && envelope.payload?.batchId) {
      if (envelope.payload.approvalId) approvalOwners.set(envelope.payload.approvalId, envelope.payload.batchId);
    }
  }

  const timeline = [];
  const attemptRefs = [];
  const touchesBatch = (envelope) => {
    const p = envelope.payload ?? {};
    if (p.batchId === batchId) return true;
    if (envelope.commandType === "revokeApproval" && approvalOwners.get(p.approvalId) === batchId) return true;
    if (p.borrowId && relatedBorrowIds.has(p.borrowId)) return true;
    if ((envelope.commandType === "issueRecall" || envelope.commandType === "closeRecall") && relevantRecallIds.has(p.recallId)) return true;
    return false;
  };

  for (const envelope of wal.envelopes) {
    if (!touchesBatch(envelope)) continue;
    const ref = {
      seq: envelope.seq,
      commandId: envelope.commandId,
      commandType: envelope.commandType,
      actor: envelope.actor,
      occurredAt: envelope.occurredAt,
      recordedAt: envelope.recordedAt,
      accepted: envelope.result.accepted,
      hash: envelope.hash,
    };
    if (!envelope.result.accepted) {
      ref.rejection = {
        code: envelope.result.code,
        message: envelope.result.message,
        blockers: envelope.result.details?.blockers ?? null,
        gateSnapshot: envelope.result.details?.gateSnapshot ?? null,
      };
      attemptRefs.push(ref);
    }
    timeline.push(ref);
  }

  const version = plan.versions.get(batch.versionId);
  const lineage = [];
  for (const v of plan.versions.values()) {
    lineage.push({
      versionId: v.versionId,
      parentVersionId: v.parentVersionId,
      revisionType: v.revisionType,
      contentHash: v.contentHash,
      supersededByVersionId: v.supersededByVersionId,
      pinnedByThisBatch: v.versionId === batch.versionId,
    });
  }

  const lotProvenance = [];
  const seen = new Set();
  const collectLot = (lotId) => {
    if (!lotId || seen.has(lotId)) return;
    seen.add(lotId);
    const lot = state.lots.get(lotId);
    if (!lot) return;
    lotProvenance.push({
      lotId: lot.lotId,
      schoolId: lot.schoolId,
      materialId: lot.materialId,
      qtyOnHand: lot.qty,
      kind: lot.kind,
      sourceBorrowId: lot.sourceBorrowId,
      originLotIds: lot.originLotIds,
    });
    for (const origin of lot.originLotIds) collectLot(origin);
  };
  for (const hold of batch.holds) collectLot(hold.lotId);
  for (const usage of batch.usages) collectLot(usage.lotId);
  for (const archive of batch.archived ?? []) {
    for (const hold of archive.holds ?? []) collectLot(hold.lotId);
    for (const usage of archive.usages ?? []) collectLot(usage.lotId);
  }

  const relatedBorrows = [...(batch.relatedBorrowIds ?? [])].map((borrowId) => borrowView(state, borrowId));
  const footprint = recallFootprint(state, nowMs);
  const recall = recallStatus(state, batch, nowMs);

  return {
    batchId: batch.batchId,
    generatedAt: new Date(nowMs).toISOString(),
    conclusion: {
      stage: batch.stage,
      allowedIntoClassroom: batch.stage === "uplinked",
      safetyHold: batch.safetyHold,
    },
    evidence: {
      plan: {
        planId: plan.planId,
        pinnedVersion: {
          versionId: version.versionId,
          revisionType: version.revisionType,
          contentHash: version.contentHash,
          content: version.content,
        },
        versionLineage: lineage,
      },
      approval: batch.approvalId
        ? (() => {
            const a = state.approvals.get(batch.approvalId);
            return {
              approvalId: a.approvalId,
              reviewerId: a.reviewerId,
              planVersionId: a.planVersionId,
              validFrom: new Date(a.validFromMs).toISOString(),
              validUntil: new Date(a.validUntilMs).toISOString(),
              revokedAt: a.revokedAtMs ? new Date(a.revokedAtMs).toISOString() : null,
              statusAt: approvalStatus(state, batch, nowMs),
            };
          })()
        : null,
      currentGateSnapshot: gateSnapshot(state, batch, nowMs),
      recalls: { status: recall.code, hits: recall.code === "RECALL_ACTIVE" ? { hitLotIds: recall.hitLotIds, hitMaterials: recall.hitMaterials } : null, active: footprint.roots },
      lotProvenance,
      relatedBorrows,
      archives: (batch.archived ?? []).map((archive) => ({
        fromVersionId: archive.fromVersionId,
        holds: archive.holds,
        usages: archive.usages,
        relatedBorrowIds: archive.relatedBorrowIds,
        rehearsed: archive.rehearsed,
      })),
      settlement: settlementStatus(state, batch),
    },
    audit: {
      timeline,
      rejectedAttempts: attemptRefs,
      chainTip: { seq: wal.envelopes.length, hash: wal.lastHash },
      verifyPath: "/audit/verify",
    },
  };
}
