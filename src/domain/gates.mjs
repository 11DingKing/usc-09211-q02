import { borrowLineSettlement } from "./reducers.mjs";
import { OWNED_LOT_KINDS, planReservation, recallFootprint } from "./inventory.mjs";

/**
 * 门检是纯函数：同一状态、同一服务端时刻，结论确定。
 * 所有有效期判定只用服务端时刻（nowMs 来自 recordedAt，由时钟注入），
 * 绝不使用调用方的 occurredAt——否则回拨客户端时钟即可延长审批。
 */

export function approvalStatus(state, batch, nowMs) {
  const approval = batch.approvalId ? state.approvals.get(batch.approvalId) : null;
  if (!approval) return { code: "APPROVAL_MISSING", approvalId: null };
  if (approval.planVersionId !== batch.versionId) {
    return { code: "APPROVAL_MISSING", approvalId: approval.approvalId, reason: "审批绑定的是旧版本，rebase 后须重新复核" };
  }
  if (approval.revokedAtMs !== null && nowMs >= approval.revokedAtMs) {
    return { code: "APPROVAL_REVOKED", approvalId: approval.approvalId, revokedAtMs: approval.revokedAtMs };
  }
  // 半开区间 [validFrom, validUntil)：nowMs 恰好等于 validUntil 即过期。
  if (nowMs < approval.validFromMs) return { code: "APPROVAL_NOT_YET_VALID", approvalId: approval.approvalId };
  if (nowMs >= approval.validUntilMs) {
    return { code: "APPROVAL_EXPIRED", approvalId: approval.approvalId, validUntilMs: approval.validUntilMs };
  }
  return { code: "OK", approvalId: approval.approvalId, validUntilMs: approval.validUntilMs };
}

export function versionStatus(state, batch) {
  const plan = state.plans.get(batch.planId);
  const version = plan.versions.get(batch.versionId);
  if (version.supersededByVersionId) {
    const superseder = plan.versions.get(version.supersededByVersionId);
    if (superseder && superseder.revisionType === "SAFETY") {
      return {
        code: "VERSION_SUPERSEDED",
        versionId: version.versionId,
        supersededByVersionId: superseder.versionId,
      };
    }
    return { code: "OK_VERSION_BEHIND_EDITORIAL", versionId: version.versionId, note: "存在措辞类新版，不阻断流程" };
  }
  return { code: "OK", versionId: version.versionId };
}

/** 批次的物料足迹：钉定 lot、已领用 lot，以及关联借用派生出的 lot 与来源 lot。 */
function batchLotFootprint(state, batch) {
  const lotIds = new Set();
  const materialIds = new Set();
  for (const requirement of batch.requirements) {
    materialIds.add(requirement.materialId);
    for (const sub of requirement.allowedSubstituteMaterialIds ?? []) materialIds.add(sub);
  }
  for (const hold of batch.holds) lotIds.add(hold.lotId);
  for (const usage of batch.usages) lotIds.add(usage.lotId);
  for (const borrowId of batch.relatedBorrowIds ?? []) {
    const borrow = state.borrows.get(borrowId);
    if (!borrow) continue;
    for (const materialId of borrow.lines.keys()) materialIds.add(materialId);
    for (const lot of state.lots.values()) {
      if (lot.sourceBorrowId === borrowId) {
        lotIds.add(lot.lotId);
        for (const origin of lot.originLotIds) lotIds.add(origin);
      }
    }
  }
  return { lotIds, materialIds };
}

export function recallStatus(state, batch, nowMs) {
  const footprint = recallFootprint(state, nowMs);
  const { lotIds, materialIds } = batchLotFootprint(state, batch);
  const hitLotIds = [...lotIds].filter((lotId) => footprint.taintedLotIds.has(lotId));
  const hitMaterials = [...materialIds].filter((materialId) => footprint.itemMaterials.has(materialId));
  if (hitLotIds.length > 0 || hitMaterials.length > 0) {
    return { code: "RECALL_ACTIVE", hitLotIds, hitMaterials, activeRecalls: footprint.roots };
  }
  return { code: "OK", activeRecalls: footprint.roots };
}

/**
 * 备料就绪度：以当前状态重新试算 FIFO 全量分配（白名单含替代物）。
 * 预留前批次尚无 hold 足迹，因此若“忽略召回后反而能配齐”，
 * 说明短缺正是召回造成的，报 RECALL_ACTIVE 而非普通缺货。
 */
export function readinessStatus(state, batch, nowMs) {
  const footprint = recallFootprint(state, nowMs);
  const result = planReservation(state, batch.schoolId, batch.requirements, footprint);
  if (result.ok) return { code: "OK", plannedHolds: result.holds };
  const noRecall = { itemMaterials: new Set(), taintedLotIds: new Set(), roots: footprint.roots };
  const relaxed = planReservation(state, batch.schoolId, batch.requirements, noRecall);
  if (relaxed.ok) {
    const taintedHolds = relaxed.holds.filter(
      (hold) => footprint.taintedLotIds.has(hold.lotId) || footprint.itemMaterials.has(hold.materialId),
    );
    return {
      code: "RECALL_ACTIVE",
      reason: "唯一可配的 lot 处于召回中；放开召回过滤虽可配齐，但禁止放行",
      hitLotIds: [...new Set(taintedHolds.map((h) => h.lotId))],
      hitMaterials: [...new Set(taintedHolds.map((h) => h.materialId))],
      activeRecalls: footprint.roots,
      shortfalls: result.shortfalls,
    };
  }
  return { code: "MATERIALS_NOT_READY", shortfalls: result.shortfalls };
}

/**
 * 上行前结清：预留必须全部结算（领用或显式释放）；领用必须归还；
 * 关联借用的每条物料腿必须闭合（在途为零、在手为零，丢失/留存已确认）。
 */
export function settlementStatus(state, batch) {
  const problems = [];
  if (batch.reservationActive && batch.holds.some((hold) => hold.qty > 0)) {
    problems.push({ code: "RESERVATION_OUTSTANDING", holds: batch.holds.filter((h) => h.qty > 0) });
  }
  const consumableReq = new Set(batch.requirements.filter((r) => r.consumable).map((r) => r.requirementId));
  const unreturned = batch.usages
    .map((usage) => ({ ...usage, outstanding: usage.qtyUsed - usage.qtyReturned }))
    // 消耗品（试剂等）领用即消耗，不要求归还；非消耗品（器具）必须全部归还。
    .filter((usage) => usage.outstanding > 0 && !consumableReq.has(usage.requirementId));
  if (unreturned.length > 0) problems.push({ code: "MATERIAL_NOT_RETURNED", usages: unreturned });
  for (const borrowId of batch.relatedBorrowIds ?? []) {
    const borrow = state.borrows.get(borrowId);
    if (!borrow) continue;
    for (const line of borrow.lines.values()) {
      const s = borrowLineSettlement(line);
      if (!s.settled) problems.push({ code: "BORROW_UNSETTLED", borrowId, materialId: line.materialId, ...s });
    }
  }
  return problems.length === 0 ? { code: "OK" } : { code: "MATERIALS_UNSETTLED", problems };
}

/**
 * 汇总门检快照。成功与被拒命令都会把它写入审计信封，
 * 使审核人员能复原“那一刻系统看到了什么”。
 */
export function gateSnapshot(state, batch, nowMs) {
  const approval = approvalStatus(state, batch, nowMs);
  const version = versionStatus(state, batch);
  const recall = recallStatus(state, batch, nowMs);
  const settlement = settlementStatus(state, batch);
  return {
    atMs: nowMs,
    stage: batch.stage,
    safetyHold: batch.safetyHold,
    checks: { approval, version, recall, settlement },
  };
}

const APPLICABILITY = {
  reserve: {
    requireStage: ["reviewed"],
    checks: ["approval", "version", "recall", "readiness", "safetyHold"],
  },
  rehearse: {
    requireStage: ["reserved"],
    checks: ["approval", "version", "recall", "safetyHold"],
  },
  uplink: {
    requireStage: ["rehearsed"],
    checks: ["approval", "version", "recall", "settlement", "safetyHold"],
  },
};

/**
 * 返回阻断列表；空数组表示放行。readiness 只在 reserve 时计算，
 * settlement 只在 uplink 时计算。
 */
export function blockersFor(state, batch, action, nowMs) {
  const rule = APPLICABILITY[action];
  const blockers = [];
  if (!rule.requireStage.includes(batch.stage)) {
    blockers.push({ code: "WRONG_STAGE", expected: rule.requireStage, actual: batch.stage });
  }
  if (rule.checks.includes("safetyHold") && batch.safetyHold) {
    blockers.push({ code: "SAFETY_HOLD_ACTIVE" });
  }
  if (rule.checks.includes("approval")) {
    const approval = approvalStatus(state, batch, nowMs);
    if (approval.code !== "OK" && approval.code !== "OK_VERSION_BEHIND_EDITORIAL") blockers.push(approval);
  }
  if (rule.checks.includes("version")) {
    const version = versionStatus(state, batch);
    if (version.code === "VERSION_SUPERSEDED") blockers.push(version);
  }
  if (rule.checks.includes("recall")) {
    const recall = recallStatus(state, batch, nowMs);
    if (recall.code === "RECALL_ACTIVE") blockers.push(recall);
  }
  if (rule.checks.includes("readiness")) {
    const readiness = readinessStatus(state, batch, nowMs);
    if (readiness.code !== "OK") blockers.push(readiness);
  }
  if (rule.checks.includes("settlement")) {
    const settlement = settlementStatus(state, batch);
    if (settlement.code !== "OK") blockers.push(settlement);
  }
  return blockers;
}
