import { contentHash } from "../util/canonical.mjs";
import { parseTime } from "../util/time.mjs";
import { ErrorCode, fail } from "./errors.mjs";
import {
  OWNED_LOT_KINDS,
  RESERVABLE_LOT_KINDS,
  pickLots,
  planReservation,
  recallFootprint,
} from "./inventory.mjs";
import { blockersFor, gateSnapshot } from "./gates.mjs";
import { borrowLineSettlement } from "./reducers.mjs";

const SKEW_FUTURE_MS = 5 * 60 * 1000;

/* ------------------------------------------------------------------ */
/* 通用辅助                                                            */
/* ------------------------------------------------------------------ */

function need(state, map, id, label) {
  const value = state[map]?.get(id);
  if (!value) throw fail(ErrorCode.NOT_FOUND, `${label}不存在：${id}`);
  return value;
}

function nonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") throw fail(ErrorCode.VALIDATION, `${label}必须为非空字符串`);
  return value;
}

function positiveInt(value, label) {
  if (!Number.isInteger(value) || value <= 0) throw fail(ErrorCode.VALIDATION, `${label}必须为正整数`);
  return value;
}

function normalizeContent({ title, protocol, safetyNotes, requirements }) {
  if (!Array.isArray(requirements) || requirements.length === 0) {
    throw fail(ErrorCode.VALIDATION, "方案至少包含一条材料需求");
  }
  const normalized = requirements.map((raw, index) => {
    const prefix = `requirements[${index}]`;
    const requirementId = nonEmptyString(raw.requirementId, `${prefix}.requirementId`);
    const materialId = nonEmptyString(raw.materialId, `${prefix}.materialId`);
    const qty = positiveInt(raw.qty, `${prefix}.qty`);
    const unit = nonEmptyString(raw.unit ?? "件", `${prefix}.unit`);
    const substitutes = raw.allowedSubstituteMaterialIds ?? [];
    if (!Array.isArray(substitutes) || substitutes.some((s) => typeof s !== "string")) {
      throw fail(ErrorCode.VALIDATION, `${prefix}.allowedSubstituteMaterialIds 必须为字符串数组`);
    }
    if (substitutes.includes(materialId)) {
      throw fail(ErrorCode.VALIDATION, `${prefix} 的替代物白名单不得包含主料号自身`);
    }
    return {
      requirementId,
      materialId,
      qty,
      unit,
      consumable: raw.consumable === true,
      allowedSubstituteMaterialIds: [...new Set(substitutes)].sort(),
    };
  });
  const ids = new Set();
  for (const requirement of normalized) {
    if (ids.has(requirement.requirementId)) {
      throw fail(ErrorCode.VALIDATION, `需求编号重复：${requirement.requirementId}`);
    }
    ids.add(requirement.requirementId);
  }
  normalized.sort((a, b) => (a.requirementId < b.requirementId ? -1 : 1));
  return {
    title: nonEmptyString(title, "title"),
    protocol: typeof protocol === "string" ? protocol : "",
    safetyNotes: nonEmptyString(safetyNotes, "safetyNotes"),
    requirements: normalized,
  };
}

function gateOrThrow(state, batch, action, nowMs) {
  const blockers = blockersFor(state, batch, action, nowMs);
  if (blockers.length > 0) {
    throw fail(ErrorCode.BLOCKED, `阶段“${action}”被门检阻断`, {
      action,
      blockers,
      gateSnapshot: gateSnapshot(state, batch, nowMs),
    });
  }
  return gateSnapshot(state, batch, nowMs);
}

/* ------------------------------------------------------------------ */
/* 命令处理器：返回 { events, reply }，或抛 DomainError                */
/* ------------------------------------------------------------------ */

export const handlers = {
  createPlan(state, p) {
    const planId = nonEmptyString(p.planId, "planId");
    if (state.plans.has(planId)) throw fail(ErrorCode.CONFLICT, `方案已存在：${planId}`);
    const versionId = nonEmptyString(p.versionId, "versionId");
    const ownerSchoolId = nonEmptyString(p.ownerSchoolId ?? p.actor?.orgId, "ownerSchoolId");
    const content = normalizeContent(p);
    const version = {
      versionId,
      parentVersionId: null,
      revisionType: "INITIAL",
      content,
      contentHash: contentHash(content),
    };
    return {
      events: [{ type: "planCreated", data: { planId, ownerSchoolId, title: content.title, version } }],
      reply: { planId, versionId, contentHash: version.contentHash },
    };
  },

  publishRevision(state, p, ctx) {
    const plan = need(state, "plans", p.planId, "方案");
    const versionId = nonEmptyString(p.versionId, "versionId");
    const revisionType = p.revisionType;
    if (revisionType !== "SAFETY" && revisionType !== "EDITORIAL") {
      throw fail(ErrorCode.VALIDATION, "revisionType 必须为 SAFETY 或 EDITORIAL");
    }
    for (const version of plan.versions.values()) {
      if (version.versionId === versionId) throw fail(ErrorCode.CONFLICT, `版本号已存在：${versionId}`);
    }
    const content = normalizeContent(p);
    const hash = contentHash(content);
    if (hash === plan.versions.get(plan.headVersionId).contentHash) {
      throw fail(ErrorCode.VALIDATION, "新版内容与当前头部版本完全相同，不构成修订");
    }
    const supersedesVersionId = plan.headVersionId;
    return {
      events: [
        {
          type: "planRevisionPublished",
          data: {
            planId: plan.planId,
            versionId,
            parentVersionId: supersedesVersionId,
            revisionType,
            changeSummary: nonEmptyString(p.changeSummary, "changeSummary"),
            supersedesVersionId,
            content,
            contentHash: hash,
            author: ctx.actor.actorId,
          },
        },
      ],
      reply: { planId: plan.planId, versionId, revisionType, contentHash: hash, supersedesVersionId },
    };
  },

  proposeBatch(state, p) {
    const plan = need(state, "plans", p.planId, "方案");
    const batchId = nonEmptyString(p.batchId, "batchId");
    if (state.batches.has(batchId)) throw fail(ErrorCode.CONFLICT, `批次已存在：${batchId}`);
    const schoolId = nonEmptyString(p.schoolId, "schoolId");
    const versionId = p.versionId ?? plan.headVersionId;
    const version = plan.versions.get(versionId);
    if (!version) throw fail(ErrorCode.VALIDATION, `方案 ${plan.planId} 没有版本 ${versionId}`);
    return {
      events: [
        {
          type: "batchProposed",
          data: {
            batchId,
            schoolId,
            planId: plan.planId,
            versionId,
            requirements: version.content.requirements,
          },
        },
      ],
      reply: { batchId, stage: "proposed", planId: plan.planId, versionId },
    };
  },

  riskDecision(state, p, ctx) {
    const batch = need(state, "batches", p.batchId, "批次");
    if (!["proposed", "reviewPending"].includes(batch.stage)) {
      throw fail(ErrorCode.CONFLICT, `只有 proposed / reviewPending 批次可作风险结论，当前阶段：${batch.stage}`);
    }
    const reviewerId = nonEmptyString(p.reviewerId, "reviewerId");
    if (p.decision === "rejected") {
      const reason = nonEmptyString(p.reason, "驳回必须给出 reason");
      return {
        events: [{ type: "riskReviewRejected", data: { batchId: batch.batchId, reviewerId, reason } }],
        reply: { batchId: batch.batchId, stage: "rejected", reviewerId },
      };
    }
    if (p.decision !== "approved") throw fail(ErrorCode.VALIDATION, "decision 必须为 approved 或 rejected");
    const approvalId = nonEmptyString(p.approvalId, "approvalId");
    if (state.approvals.has(approvalId)) throw fail(ErrorCode.CONFLICT, `审批号已存在：${approvalId}`);
    const from = parseTime(p.validFrom, "validFrom");
    const until = parseTime(p.validUntil, "validUntil");
    if (until.ms <= from.ms) throw fail(ErrorCode.VALIDATION, "validUntil 必须晚于 validFrom");
    if (until.ms <= ctx.nowMs) throw fail(ErrorCode.VALIDATION, "不得签发签发时刻即已过期的审批");
    return {
      events: [
        {
          type: "riskApprovalGranted",
          data: {
            approvalId,
            batchId: batch.batchId,
            planId: batch.planId,
            planVersionId: batch.versionId,
            reviewerId,
            validFromMs: from.ms,
            validUntilMs: until.ms,
            reason: typeof p.reason === "string" ? p.reason : null,
          },
        },
      ],
      reply: { batchId: batch.batchId, stage: "reviewed", approvalId, validUntilMs: until.ms },
    };
  },

  revokeApproval(state, p, ctx) {
    const approval = need(state, "approvals", p.approvalId, "审批");
    if (approval.revokedAtMs !== null) throw fail(ErrorCode.CONFLICT, "审批已被撤销");
    return {
      events: [
        {
          type: "riskApprovalRevoked",
          data: { approvalId: approval.approvalId, atMs: p.atMs ? parseTime(p.atMs, "atMs").ms : ctx.nowMs, reason: nonEmptyString(p.reason, "reason") },
        },
      ],
      reply: { approvalId: approval.approvalId, revoked: true },
    };
  },

  inbound(state, p) {
    const lotId = nonEmptyString(p.lotId, "lotId");
    if (state.lots.has(lotId)) throw fail(ErrorCode.CONFLICT, `lot 已存在：${lotId}`);
    const schoolId = nonEmptyString(p.schoolId, "schoolId");
    const materialId = nonEmptyString(p.materialId, "materialId");
    const qty = positiveInt(p.qty, "qty");
    return {
      events: [{ type: "lotInbounded", data: { lotId, schoolId, materialId, qty } }],
      reply: { lotId, schoolId, materialId, qty },
    };
  },

  reserve(state, p, ctx) {
    const batch = need(state, "batches", p.batchId, "批次");
    const snapshot = gateOrThrow(state, batch, "reserve", ctx.nowMs);
    const footprint = recallFootprint(state, ctx.nowMs);
    const trial = planReservation(state, batch.schoolId, batch.requirements, footprint, RESERVABLE_LOT_KINDS);
    if (!trial.ok) {
      throw fail(ErrorCode.BLOCKED, "备料未能全量满足", {
        action: "reserve",
        blockers: [{ code: "MATERIALS_NOT_READY", shortfalls: trial.shortfalls }],
        gateSnapshot: snapshot,
      });
    }
    // 钉到借入 lot 的预留会把对应借用单纳入批次足迹：该借用不结清，批次不得上行。
    const relatedBorrowIds = [...new Set(
      trial.holds
        .map((hold) => state.lots.get(hold.lotId)?.sourceBorrowId)
        .filter((borrowId) => Boolean(borrowId)),
    )];
    return {
      events: [{ type: "batchReserved", data: { batchId: batch.batchId, holds: trial.holds, relatedBorrowIds } }],
      reply: { batchId: batch.batchId, stage: "reserved", holds: trial.holds, relatedBorrowIds },
    };
  },

  use(state, p, ctx) {
    const batch = need(state, "batches", p.batchId, "批次");
    if (!["reserved", "rehearsed"].includes(batch.stage)) {
      throw fail(ErrorCode.CONFLICT, `只有已备料批次可领用，当前阶段：${batch.stage}`);
    }
    if (!batch.reservationActive) throw fail(ErrorCode.CONFLICT, "预留已释放，不能再领用");
    const footprint = recallFootprint(state, ctx.nowMs);
    const picks = normalizePicks(p, batch, { allowOnlyHeld: true });
    for (const pick of picks) {
      const lot = state.lots.get(pick.lotId);
      if (lot.qty < pick.qty) throw fail(ErrorCode.CONFLICT, `lot ${pick.lotId} 实物库存不足`);
      if (footprint.taintedLotIds.has(pick.lotId) || footprint.itemMaterials.has(lot.materialId)) {
        throw fail(ErrorCode.BLOCKED, "召回中的 lot 禁止领用", { blockers: [{ code: "RECALL_ACTIVE", lotId: pick.lotId }] });
      }
    }
    return {
      events: [{ type: "materialUsed", data: { batchId: batch.batchId, picks } }],
      reply: { batchId: batch.batchId, used: picks },
    };
  },

  returnMaterials(state, p) {
    const batch = need(state, "batches", p.batchId, "批次");
    if (!["reserved", "rehearsed"].includes(batch.stage)) {
      throw fail(ErrorCode.CONFLICT, `批次当前阶段不允许退料：${batch.stage}`);
    }
    const picks = normalizePicks(p, batch, { againstUsage: true });
    return {
      events: [{ type: "materialReturned", data: { batchId: batch.batchId, picks } }],
      reply: { batchId: batch.batchId, returned: picks },
    };
  },

  releaseUnused(state, p) {
    const batch = need(state, "batches", p.batchId, "批次");
    if (!batch.reservationActive) throw fail(ErrorCode.CONFLICT, "批次没有活跃预留");
    return {
      events: [{ type: "batchUnusedReleased", data: { batchId: batch.batchId } }],
      reply: { batchId: batch.batchId, reservationActive: false },
    };
  },

  rehearse(state, p, ctx) {
    const batch = need(state, "batches", p.batchId, "批次");
    gateOrThrow(state, batch, "rehearse", ctx.nowMs);
    const evidenceHash = p.evidenceHash === undefined ? null : nonEmptyString(p.evidenceHash, "evidenceHash");
    return {
      events: [{ type: "batchRehearsed", data: { batchId: batch.batchId, evidenceHash } }],
      reply: { batchId: batch.batchId, stage: "rehearsed", evidenceHash },
    };
  },

  uplink(state, p, ctx) {
    const batch = need(state, "batches", p.batchId, "批次");
    const snapshot = gateOrThrow(state, batch, "uplink", ctx.nowMs);
    return {
      events: [{ type: "batchUplinked", data: { batchId: batch.batchId } }],
      reply: { batchId: batch.batchId, stage: "uplinked", gateSnapshot: snapshot },
    };
  },

  rebase(state, p) {
    const batch = need(state, "batches", p.batchId, "批次");
    if (["uplinked", "cancelled"].includes(batch.stage)) {
      throw fail(ErrorCode.CONFLICT, `阶段 ${batch.stage} 的批次不能 rebase`);
    }
    const plan = state.plans.get(batch.planId);
    const target = plan.versions.get(nonEmptyString(p.targetVersionId, "targetVersionId"));
    if (!target) throw fail(ErrorCode.VALIDATION, `目标版本不属于方案 ${batch.planId}`);
    if (target.versionId === batch.versionId) throw fail(ErrorCode.VALIDATION, "目标版本与当前版本相同");
    if (!isDescendant(plan, batch.versionId, target.versionId)) {
      throw fail(ErrorCode.VALIDATION, "只能 rebase 到当前版本的后继版本，禁止回退或跨方案");
    }
    // 旧版本下领用的器具必须先归还、剩余预留先释放：不得借换版逃避物料责任。
    // 已消耗的消耗品不阻止换版（事实不可逆，记录归档）。
    const consumableReq = new Set(batch.requirements.filter((r) => r.consumable).map((r) => r.requirementId));
    const unreturned = batch.usages
      .map((u) => ({ ...u, outstanding: u.qtyUsed - u.qtyReturned }))
      .filter((u) => u.outstanding > 0 && !consumableReq.has(u.requirementId));
    if (unreturned.length > 0) {
      throw fail(ErrorCode.CONFLICT, "存在未归还的非消耗品，rebase 前必须先归还", { usages: unreturned });
    }
    const events = [];
    if (batch.reservationActive) {
      events.push({ type: "batchReservationReleased", data: { batchId: batch.batchId } });
    }
    events.push({
      type: "batchRebased",
      data: {
        batchId: batch.batchId,
        fromVersionId: batch.versionId,
        toVersionId: target.versionId,
        requirements: target.content.requirements,
        // 旧执行痕迹随事件归档：审计可查，但不再进入新版本门检。
        archived: {
          holds: batch.holds,
          usages: batch.usages,
          relatedBorrowIds: [...(batch.relatedBorrowIds ?? [])],
          rehearsed: batch.rehearsed,
        },
      },
    });
    return {
      events,
      reply: { batchId: batch.batchId, stage: "reviewPending", versionId: target.versionId, reservationActive: false },
    };
  },

  cancelBatch(state, p) {
    const batch = need(state, "batches", p.batchId, "批次");
    if (batch.stage === "uplinked") throw fail(ErrorCode.CONFLICT, "已上行批次不能取消");
    if (batch.stage === "cancelled") throw fail(ErrorCode.CONFLICT, "批次已取消");
    return {
      events: [{ type: "batchCancelled", data: { batchId: batch.batchId, reason: nonEmptyString(p.reason, "reason") } }],
      reply: { batchId: batch.batchId, stage: "cancelled" },
    };
  },

  safetyHold(state, p) {
    const batch = need(state, "batches", p.batchId, "批次");
    if (batch.safetyHold) throw fail(ErrorCode.CONFLICT, "批次已处于安全搁置");
    return {
      events: [{ type: "batchSafetyHoldPlaced", data: { batchId: batch.batchId, reason: nonEmptyString(p.reason, "reason") } }],
      reply: { batchId: batch.batchId, safetyHold: true },
    };
  },

  safetyHoldClear(state, p) {
    const batch = need(state, "batches", p.batchId, "批次");
    if (!batch.safetyHold) throw fail(ErrorCode.CONFLICT, "批次并未安全搁置");
    return {
      events: [{ type: "batchSafetyHoldCleared", data: { batchId: batch.batchId, reason: nonEmptyString(p.reason, "reason") } }],
      reply: { batchId: batch.batchId, safetyHold: false },
    };
  },

  /* ---------------- 借用 ---------------- */

  requestBorrow(state, p) {
    const borrowId = nonEmptyString(p.borrowId, "borrowId");
    if (state.borrows.has(borrowId)) throw fail(ErrorCode.CONFLICT, `借用单已存在：${borrowId}`);
    const fromSchoolId = nonEmptyString(p.fromSchoolId, "fromSchoolId");
    const toSchoolId = nonEmptyString(p.toSchoolId, "toSchoolId");
    if (fromSchoolId === toSchoolId) throw fail(ErrorCode.VALIDATION, "借出校与借入校不能相同");
    if (!Array.isArray(p.lines) || p.lines.length === 0) throw fail(ErrorCode.VALIDATION, "lines 必须为非空数组");
    const lines = p.lines.map((line, index) => ({
      materialId: nonEmptyString(line.materialId, `lines[${index}].materialId`),
      qty: positiveInt(line.qty, `lines[${index}].qty`),
    }));
    return {
      events: [{ type: "borrowRequested", data: { borrowId, fromSchoolId, toSchoolId, purpose: p.purpose ?? null, lines } }],
      reply: { borrowId, status: "requested", lines },
    };
  },

  cancelBorrow(state, p) {
    const borrow = need(state, "borrows", p.borrowId, "借用单");
    if (borrow.status !== "requested") throw fail(ErrorCode.CONFLICT, `只有 requested 借用单可取消，当前：${borrow.status}`);
    return {
      events: [{ type: "borrowCancelled", data: { borrowId: borrow.borrowId } }],
      reply: { borrowId: borrow.borrowId, status: "cancelled" },
    };
  },

  dispatchBorrow(state, p, ctx) {
    const borrow = need(state, "borrows", p.borrowId, "借用单");
    if (!["requested", "dispatched"].includes(borrow.status)) {
      throw fail(ErrorCode.CONFLICT, `借用单当前状态 ${borrow.status} 不能发货`);
    }
    if (!Array.isArray(p.lines) || p.lines.length === 0) throw fail(ErrorCode.VALIDATION, "lines 必须为非空数组");
    const footprint = recallFootprint(state, ctx.nowMs);
    const picks = [];
    for (const line of p.lines) {
      const materialId = nonEmptyString(line.materialId, "line.materialId");
      const qty = positiveInt(line.qty, "line.qty");
      const current = borrow.lines.get(materialId);
      if (!current) throw fail(ErrorCode.VALIDATION, `借用单不含料号 ${materialId}`);
      const outstanding = current.requested - current.dispatched;
      if (qty > outstanding) throw fail(ErrorCode.CONFLICT, `料号 ${materialId} 超发：待发 ${outstanding}，本次 ${qty}`);
      const trial = pickLots(state, borrow.fromSchoolId, materialId, qty, { kinds: OWNED_LOT_KINDS, footprint, excludeBorrowId: borrow.borrowId });
      if (!trial.ok) {
        throw fail(ErrorCode.BLOCKED, `借出校 ${borrow.fromSchoolId} 料号 ${materialId} 可发库存不足（且不得发召回 lot）`, {
          blockers: [{ code: "MATERIALS_NOT_READY", materialId, shortBy: trial.shortBy }],
        });
      }
      picks.push({ materialId, qty, lotPicks: trial.picks.map((x) => ({ lotId: x.lotId, qty: x.qty })) });
    }
    return {
      events: [{ type: "borrowDispatched", data: { borrowId: borrow.borrowId, picks } }],
      reply: { borrowId: borrow.borrowId, status: "dispatched", picks },
    };
  },

  receiveBorrow(state, p) {
    const borrow = need(state, "borrows", p.borrowId, "借用单");
    if (borrow.status !== "dispatched") throw fail(ErrorCode.CONFLICT, "借用单尚未发货或已终结");
    const materialId = nonEmptyString(p.materialId, "materialId");
    const qty = positiveInt(p.qty, "qty");
    const lotId = nonEmptyString(p.lotId, "lotId");
    if (state.lots.has(lotId)) throw fail(ErrorCode.CONFLICT, `lot 已存在：${lotId}`);
    const line = borrow.lines.get(materialId);
    if (!line) throw fail(ErrorCode.VALIDATION, `借用单不含料号 ${materialId}`);
    const inTransit = line.dispatched - line.received - line.lostOutbound;
    if (qty > inTransit) throw fail(ErrorCode.CONFLICT, `料号 ${materialId} 超签：在途 ${inTransit}，本次签收 ${qty}`);
    // 纯试算（只读）：真正扣减发生在事件归约时。
    const origins = peekQueue(line.originQueue, qty);
    return {
      events: [
        { type: "borrowReceived", data: { borrowId: borrow.borrowId, materialId, qty, lot: { lotId, qty, originLotIds: origins } } },
      ],
      reply: { borrowId: borrow.borrowId, materialId, received: qty, lotId, originLotIds: origins },
    };
  },

  returnDispatchBorrow(state, p, ctx) {
    const borrow = need(state, "borrows", p.borrowId, "借用单");
    const materialId = nonEmptyString(p.materialId, "materialId");
    const qty = positiveInt(p.qty, "qty");
    const line = borrow.lines.get(materialId);
    if (!line) throw fail(ErrorCode.VALIDATION, `借用单不含料号 ${materialId}`);
    const onHand = borrowLineSettlement(line).onHand;
    if (qty > onHand) throw fail(ErrorCode.CONFLICT, `料号 ${materialId} 借方在手仅 ${onHand}，无法退 ${qty}`);
    const footprint = recallFootprint(state, ctx.nowMs);
    const trial = pickLots(state, borrow.toSchoolId, materialId, qty, {
      kinds: new Set(["borrowed"]),
      footprint: { ...footprint, itemMaterials: new Set(), taintedLotIds: new Set() },
    });
    if (!trial.ok) throw fail(ErrorCode.CONFLICT, `借入校没有 ${qty} 件借来的 ${materialId} 可退（已留存或已消耗的不能退）`);
    const picks = trial.picks.map((x) => ({ lotId: x.lotId, qty: x.qty, originLotIds: x.originLotIds }));
    return {
      events: [{ type: "borrowReturnDispatched", data: { borrowId: borrow.borrowId, materialId, qty, picks } }],
      reply: { borrowId: borrow.borrowId, materialId, returnDispatched: qty, picks },
    };
  },

  returnReceiveBorrow(state, p) {
    const borrow = need(state, "borrows", p.borrowId, "借用单");
    const materialId = nonEmptyString(p.materialId, "materialId");
    const qty = positiveInt(p.qty, "qty");
    const lotId = nonEmptyString(p.lotId, "lotId");
    if (state.lots.has(lotId)) throw fail(ErrorCode.CONFLICT, `lot 已存在：${lotId}`);
    const line = borrow.lines.get(materialId);
    if (!line) throw fail(ErrorCode.VALIDATION, `借用单不含料号 ${materialId}`);
    const inTransit = line.returnDispatched - line.returnReceived - line.lostReturn;
    if (qty > inTransit) throw fail(ErrorCode.CONFLICT, `料号 ${materialId} 回程在途仅 ${inTransit}，不能签收 ${qty}`);
    const origins = peekQueue(line.returnQueue, qty);
    return {
      events: [
        { type: "borrowReturnReceived", data: { borrowId: borrow.borrowId, materialId, qty, lot: { lotId, qty, originLotIds: origins } } },
      ],
      reply: { borrowId: borrow.borrowId, materialId, returnReceived: qty, lotId, originLotIds: origins },
    };
  },

  shortShipBorrow(state, p) {
    const borrow = need(state, "borrows", p.borrowId, "借用单");
    if (!["requested", "dispatched"].includes(borrow.status)) {
      throw fail(ErrorCode.CONFLICT, `借用单当前状态 ${borrow.status}，不能确认短发`);
    }
    if (!Array.isArray(p.lines) || p.lines.length === 0) throw fail(ErrorCode.VALIDATION, "lines 必须为非空数组");
    const lines = [];
    for (const line of p.lines) {
      const materialId = nonEmptyString(line.materialId, "line.materialId");
      const qty = positiveInt(line.qty, "line.qty");
      const current = borrow.lines.get(materialId);
      if (!current) throw fail(ErrorCode.VALIDATION, `借用单不含料号 ${materialId}`);
      const unresolved = current.requested - current.dispatched - current.unfulfilled;
      if (qty > unresolved) throw fail(ErrorCode.CONFLICT, `料号 ${materialId} 未决量仅 ${unresolved}`);
      lines.push({ materialId, qty });
    }
    return {
      events: [{ type: "borrowShortShipped", data: { borrowId: borrow.borrowId, lines, reason: nonEmptyString(p.reason, "reason") } }],
      reply: { borrowId: borrow.borrowId, shortShipped: lines },
    };
  },

  acknowledgeLoss(state, p, ctx) {
    const borrow = need(state, "borrows", p.borrowId, "借用单");
    const leg = p.leg;
    if (!["outbound", "return", "held"].includes(leg)) throw fail(ErrorCode.VALIDATION, "leg 必须为 outbound / return / held");
    const materialId = nonEmptyString(p.materialId, "materialId");
    const qty = positiveInt(p.qty, "qty");
    const line = borrow.lines.get(materialId);
    if (!line) throw fail(ErrorCode.VALIDATION, `借用单不含料号 ${materialId}`);
    const s = borrowLineSettlement(line);
    let picks;
    if (leg === "outbound") {
      if (qty > s.inTransitOut) throw fail(ErrorCode.CONFLICT, `出站在途仅 ${s.inTransitOut}`);
    } else if (leg === "return") {
      if (qty > s.inTransitReturn) throw fail(ErrorCode.CONFLICT, `回程在途仅 ${s.inTransitReturn}`);
    } else {
      if (qty > s.onHand) throw fail(ErrorCode.CONFLICT, `借方在手仅 ${s.onHand}`);
      const footprint = recallFootprint(state, ctx.nowMs);
      const trial = pickLots(state, borrow.toSchoolId, materialId, qty, {
        kinds: new Set(["borrowed"]),
        footprint: { ...footprint, itemMaterials: new Set(), taintedLotIds: new Set() },
      });
      if (!trial.ok) throw fail(ErrorCode.CONFLICT, "借入校在手 lot 不足以登记丢失");
      picks = trial.picks.map((x) => ({ lotId: x.lotId, qty: x.qty }));
    }
    return {
      events: [{ type: "borrowLossAcknowledged", data: { borrowId: borrow.borrowId, leg, materialId, qty, picks: picks ?? null } }],
      reply: { borrowId: borrow.borrowId, leg, materialId, lost: qty },
    };
  },

  retainBorrow(state, p) {
    const borrow = need(state, "borrows", p.borrowId, "借用单");
    const materialId = nonEmptyString(p.materialId, "materialId");
    const qty = positiveInt(p.qty, "qty");
    const reason = nonEmptyString(p.reason, "reason");
    const line = borrow.lines.get(materialId);
    if (!line) throw fail(ErrorCode.VALIDATION, `借用单不含料号 ${materialId}`);
    const s = borrowLineSettlement(line);
    if (qty > s.onHand) throw fail(ErrorCode.CONFLICT, `借方在手仅 ${s.onHand}，不能留存 ${qty}`);
    let batchId = null;
    let picks = null;
    if (p.batchId) {
      // 实验消耗路径：批次确曾从本借用单来源的 lot 净领用对应数量；
      // 这些实物已在 materialUsed 时出库，retain 只闭合借用账，不动 lot。
      const batch = need(state, "batches", p.batchId, "批次");
      const used = batch.usages
        .filter((u) => u.materialId === materialId && state.lots.get(u.lotId)?.sourceBorrowId === borrow.borrowId)
        .reduce((sum, u) => sum + (u.qtyUsed - u.qtyReturned), 0);
      const already = batch.retainedByBorrow?.[borrow.borrowId]?.[materialId] ?? 0;
      if (qty > used - already) {
        throw fail(ErrorCode.CONFLICT, `批次对该借用物料的净消耗为 ${Math.max(0, used - already)}，留存 ${qty} 超过消耗`);
      }
      batchId = batch.batchId;
    } else {
      // 实物赠与路径：从未消耗的借入 lot 中拆出，转为借入校自有的 retained lot。
      if (!Array.isArray(p.picks) || p.picks.length === 0) throw fail(ErrorCode.VALIDATION, "实物留存必须在 picks 中给出 lotId/newLotId/qty");
      picks = [];
      let total = 0;
      for (const pick of p.picks) {
        const lotId = nonEmptyString(pick.lotId, "pick.lotId");
        const newLotId = nonEmptyString(pick.newLotId, "pick.newLotId");
        const partQty = positiveInt(pick.qty, "pick.qty");
        if (state.lots.has(newLotId)) throw fail(ErrorCode.CONFLICT, `lot 已存在：${newLotId}`);
        const lot = state.lots.get(lotId);
        if (!lot || lot.schoolId !== borrow.toSchoolId || lot.kind !== "borrowed" || lot.sourceBorrowId !== borrow.borrowId || lot.materialId !== materialId) {
          throw fail(ErrorCode.VALIDATION, `lot ${lotId} 不是本借用单在借入校的借入 lot`);
        }
        if (partQty > lot.qty) throw fail(ErrorCode.CONFLICT, `lot ${lotId} 在手仅 ${lot.qty}`);
        picks.push({ lotId, newLotId, qty: partQty, originLotIds: [...lot.originLotIds, lotId].sort() });
        total += partQty;
      }
      if (total !== qty) throw fail(ErrorCode.VALIDATION, `picks 合计 ${total} 与留存数量 ${qty} 不一致`);
    }
    return {
      events: [
        {
          type: "borrowRetained",
          data: { borrowId: borrow.borrowId, materialId, qty, reason, batchId, picks },
        },
      ],
      reply: { borrowId: borrow.borrowId, materialId, retained: qty, batchId, picks },
    };
  },

  /* ---------------- 召回 ---------------- */

  issueRecall(state, p, ctx) {
    const recallId = nonEmptyString(p.recallId, "recallId");
    if (state.recalls.has(recallId)) throw fail(ErrorCode.CONFLICT, `召回令已存在：${recallId}`);
    const scope = p.scope;
    const reason = nonEmptyString(p.reason, "reason");
    const issuedAtMs = p.issuedAt ? parseTime(p.issuedAt, "issuedAt").ms : ctx.nowMs;
    if (scope === "ITEM") {
      const materialId = nonEmptyString(p.materialId, "materialId");
      return {
        events: [{ type: "recallIssued", data: { recallId, scope, materialId, lotId: null, reason, issuedAtMs } }],
        reply: { recallId, scope, materialId },
      };
    }
    if (scope === "LOT") {
      const lotId = nonEmptyString(p.lotId, "lotId");
      need(state, "lots", lotId, "lot");
      return {
        events: [{ type: "recallIssued", data: { recallId, scope, materialId: null, lotId, reason, issuedAtMs } }],
        reply: { recallId, scope, lotId },
      };
    }
    throw fail(ErrorCode.VALIDATION, "scope 必须为 ITEM 或 LOT");
  },

  closeRecall(state, p, ctx) {
    const recall = need(state, "recalls", p.recallId, "召回令");
    if (recall.closedAtMs !== null) throw fail(ErrorCode.CONFLICT, "召回令已关闭");
    const closedAtMs = p.closedAt ? parseTime(p.closedAt, "closedAt").ms : ctx.nowMs;
    if (closedAtMs < recall.issuedAtMs) throw fail(ErrorCode.VALIDATION, "关闭时间不得早于发布时间");
    return {
      events: [{ type: "recallClosed", data: { recallId: recall.recallId, closedAtMs } }],
      reply: { recallId: recall.recallId, closed: true },
    };
  },
};

/* ------------------------------------------------------------------ */

function normalizePicks(p, batch, { allowOnlyHeld = false, againstUsage = false }) {
  if (!Array.isArray(p.picks) || p.picks.length === 0) throw fail(ErrorCode.VALIDATION, "picks 必须为非空数组");
  const residual = new Map();
  const out = [];
  for (const pick of p.picks) {
    const requirementId = nonEmptyString(pick.requirementId, "pick.requirementId");
    const lotId = nonEmptyString(pick.lotId, "pick.lotId");
    const qty = positiveInt(pick.qty, "pick.qty");
    const requirement = batch.requirements.find((r) => r.requirementId === requirementId);
    if (!requirement) throw fail(ErrorCode.VALIDATION, `批次没有需求 ${requirementId}`);
    // 实际料号以预留/领用账为准（可能命中替代物白名单），不信任请求体自报。
    let materialId;
    if (againstUsage) {
      const usage = batch.usages.find((u) => u.requirementId === requirementId && u.lotId === lotId);
      if (!usage) throw fail(ErrorCode.CONFLICT, `需求 ${requirementId} 从未在 lot ${lotId} 上领用，无法归还`);
      materialId = usage.materialId;
      const outstanding = usage.qtyUsed - usage.qtyReturned;
      const key = `${requirementId}|${lotId}`;
      const asked = (residual.get(key) ?? 0) + qty;
      if (asked > outstanding) throw fail(ErrorCode.CONFLICT, `归还数量超过未还领用（${outstanding}）：${requirementId} / ${lotId}`);
      residual.set(key, asked);
    } else if (allowOnlyHeld) {
      const hold = batch.holds.find((h) => h.requirementId === requirementId && h.lotId === lotId);
      if (!hold) throw fail(ErrorCode.VALIDATION, `需求 ${requirementId} 在 lot ${lotId} 上没有预留，不得领用`);
      materialId = hold.materialId;
      const key = `${requirementId}|${lotId}`;
      const asked = (residual.get(key) ?? 0) + qty;
      if (asked > hold.qty) throw fail(ErrorCode.CONFLICT, `领用超出预留余量 ${hold.qty}：${requirementId} / ${lotId}`);
      residual.set(key, asked);
    } else {
      materialId = nonEmptyString(pick.materialId, "pick.materialId");
    }
    out.push({ requirementId, lotId, materialId, qty });
  }
  return out;
}

/** 只读地按 FIFO 试算 qty 命中的来源 lot 集合，不修改队列。 */
function peekQueue(queue, qty) {
  let need = qty;
  const origins = new Set();
  for (const entry of queue) {
    if (need === 0) break;
    const take = Math.min(entry.qty, need);
    origins.add(entry.lotId);
    need -= take;
  }
  if (need > 0) throw fail(ErrorCode.CONFLICT, "在途来源队列不足，数量账与来源账不一致");
  return [...origins].sort();
}

function isDescendant(plan, fromVersionId, toVersionId) {
  let current = toVersionId;
  while (current) {
    if (current === fromVersionId) return true;
    if (current === plan.versions.get(current)?.parentVersionId) return false;
    current = plan.versions.get(current)?.parentVersionId;
  }
  return false;
}

export function validateOccurredAt(occurredAt, nowMs) {
  if (typeof occurredAt !== "string") throw fail(ErrorCode.VALIDATION, "occurredAt 必须为 ISO 8601 字符串");
  const ms = Date.parse(occurredAt);
  if (Number.isNaN(ms)) throw fail(ErrorCode.VALIDATION, "occurredAt 不是合法时间");
  if (ms > nowMs + SKEW_FUTURE_MS) {
    throw fail(ErrorCode.VALIDATION, `occurredAt 比服务端时间快超过 ${SKEW_FUTURE_MS / 60000} 分钟，疑似时钟错误`);
  }
  return new Date(ms).toISOString();
}
