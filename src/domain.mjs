// 领域核心：实验方案从提案、风险复核、备料、地面预演、上行确认到签收的全流程。
// 本模块只包含纯函数：命令处理器根据当前状态产出事件，归约器把事件应用到状态。
// 所有状态变化都以不可覆盖的事件形式落盘，任何修订都会生成新版本并记录受影响批次。

export class DomainError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.status = status;
  }
}

export const STAGES = Object.freeze([
  "PROPOSED",
  "RISK_APPROVED",
  "PREPARED",
  "REHEARSED",
  "UPLINK_CONFIRMED",
  "SIGNED_OFF",
]);

// 上行确认后方案内容冻结，不得再修订
const FROZEN_STAGES = new Set(["UPLINK_CONFIRMED", "SIGNED_OFF"]);

export function createState() {
  return {
    experiments: new Map(), // experimentId -> 方案
    batches: new Map(), // batchId -> 库存批次
    borrows: new Map(), // borrowId -> 跨校借用单
    idempotency: new Map(), // 幂等键 -> 已返回的响应
  };
}

function mustExperiment(state, id) {
  const exp = state.experiments.get(id);
  if (!exp) throw new DomainError("EXPERIMENT_NOT_FOUND", `实验方案不存在: ${id}`, 404);
  return exp;
}

function mustBatch(state, id) {
  const batch = state.batches.get(id);
  if (!batch) throw new DomainError("BATCH_NOT_FOUND", `材料批次不存在: ${id}`, 404);
  return batch;
}

function mustBorrow(state, id) {
  const borrow = state.borrows.get(id);
  if (!borrow) throw new DomainError("BORROW_NOT_FOUND", `借用单不存在: ${id}`, 404);
  return borrow;
}

function currentVersion(exp) {
  return exp.versions[exp.versions.length - 1];
}

// 审批仅在「批准未过期 + 对应当前版本」时有效；修订方案会使旧审批自动失效
function approvalValid(exp, now) {
  return Boolean(
    exp.approval &&
      exp.approval.status === "APPROVED" &&
      exp.approval.versionNo === exp.currentVersion &&
      exp.approval.expiresAt > now,
  );
}

function ensureNotBlocked(exp) {
  if (exp.blocked) {
    throw new DomainError("EXPERIMENT_BLOCKED", `方案已被阻断（${exp.blocked.reason}），须先解除阻断`, 409);
  }
}

function ensurePositiveQuantity(quantity) {
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new DomainError("INVALID_QUANTITY", "数量必须为正整数", 400);
  }
}

function validateMaterials(materials) {
  if (!Array.isArray(materials) || materials.length === 0) {
    throw new DomainError("INVALID_MATERIALS", "方案必须包含至少一种材料", 400);
  }
  const seen = new Set();
  for (const item of materials) {
    if (!item || typeof item.materialId !== "string" || item.materialId.length === 0) {
      throw new DomainError("INVALID_MATERIALS", "材料条目缺少 materialId", 400);
    }
    ensurePositiveQuantity(item.quantity);
    if (seen.has(item.materialId)) {
      throw new DomainError("DUPLICATE_MATERIAL", `材料清单存在重复项: ${item.materialId}`, 400);
    }
    seen.add(item.materialId);
  }
}

function mustReservation(exp, reservationId) {
  const reservation = exp.reservations.find((r) => r.id === reservationId);
  if (!reservation) {
    throw new DomainError("RESERVATION_NOT_FOUND", `预留单不存在: ${reservationId}`, 404);
  }
  return reservation;
}

// 解除阻断判定：方案不再持有任何已召回批次的有效预留时，发出解除事件
function unblockEventsIfClear(state, exp, ignoreReservationId) {
  if (!exp.blocked) return [];
  const stillHeld = exp.reservations.some((r) => {
    if (r.id === ignoreReservationId || r.status !== "ACTIVE") return false;
    return state.batches.get(r.batchId)?.status === "RECALLED";
  });
  if (stillHeld) return [];
  return [
    {
      type: "EXPERIMENT_UNBLOCKED",
      payload: { experimentId: exp.id, reason: "已解除对召回批次的所有预留" },
    },
  ];
}

// ---------------------------------------------------------------------------
// 命令处理器：(state, input, ctx) -> { events, result }
// result 为函数时，会在事件应用之后以最新状态求值。
// ---------------------------------------------------------------------------

export const COMMANDS = {
  // 提案：创建方案并固化第 1 版材料清单与安全说明
  "experiment.propose"(state, input, ctx) {
    const { experimentId, school, title, materials, safetyNotes } = input;
    if (!experimentId || !school || !title) {
      throw new DomainError("INVALID_INPUT", "experimentId、school、title 均为必填", 400);
    }
    if (state.experiments.has(experimentId)) {
      throw new DomainError("EXPERIMENT_EXISTS", `实验方案已存在: ${experimentId}`, 409);
    }
    validateMaterials(materials);
    const version = {
      versionNo: 1,
      materials,
      safetyNotes: safetyNotes ?? "",
      changeReason: null,
      createdAt: ctx.now,
    };
    return {
      events: [
        { type: "EXPERIMENT_PROPOSED", payload: { experimentId, school, title, version } },
      ],
      result: (s) => experimentView(mustExperiment(s, experimentId)),
    };
  },

  // 修订：生成不可覆盖的新版本；旧版本的审批失效，相关预留作废并释放库存，
  // 受影响批次写入事件，供联调各方追踪。
  "experiment.revise"(state, input, ctx) {
    const exp = mustExperiment(state, input.experimentId);
    if (FROZEN_STAGES.has(exp.stage)) {
      throw new DomainError("REVISION_NOT_ALLOWED", `方案已进入 ${exp.stage}，内容冻结，不得修订`, 409);
    }
    validateMaterials(input.materials);
    const versionNo = exp.currentVersion + 1;
    const active = exp.reservations.filter((r) => r.status === "ACTIVE");
    const affectedBatches = [...new Set(active.map((r) => r.batchId))];
    const events = [
      {
        type: "EXPERIMENT_REVISED",
        payload: {
          experimentId: exp.id,
          version: {
            versionNo,
            materials: input.materials,
            safetyNotes: input.safetyNotes ?? "",
            changeReason: input.changeReason ?? "",
            createdAt: ctx.now,
          },
          supersededVersionNo: exp.currentVersion,
          affectedBatches,
        },
      },
    ];
    for (const r of active) {
      events.push({
        type: "RESERVATION_SUPERSEDED",
        payload: { experimentId: exp.id, reservationId: r.id, batchId: r.batchId, versionNo },
      });
    }
    return { events, result: (s) => experimentView(mustExperiment(s, exp.id)) };
  },

  // 风险复核：批准必须给出有效期；批准只针对当前版本
  "experiment.riskReview"(state, input, ctx) {
    const exp = mustExperiment(state, input.experimentId);
    const { decision, approver, expiresAt, notes } = input;
    if (decision !== "APPROVED" && decision !== "REJECTED") {
      throw new DomainError("INVALID_DECISION", "decision 必须为 APPROVED 或 REJECTED", 400);
    }
    if (!approver) throw new DomainError("INVALID_INPUT", "approver 必填", 400);
    if (decision === "APPROVED") {
      if (!expiresAt) throw new DomainError("INVALID_INPUT", "批准必须给出有效期 expiresAt", 400);
      if (expiresAt <= ctx.now) {
        throw new DomainError("APPROVAL_ALREADY_EXPIRED", "批准有效期必须晚于当前时间", 400);
      }
    }
    return {
      events: [
        {
          type: "RISK_REVIEW_RECORDED",
          payload: {
            experimentId: exp.id,
            versionNo: exp.currentVersion,
            decision,
            approver,
            expiresAt: expiresAt ?? null,
            notes: notes ?? "",
          },
        },
      ],
      result: (s) => experimentView(mustExperiment(s, exp.id)),
    };
  },

  // 登记材料批次
  "batch.register"(state, input, ctx) {
    const { batchId, materialId, lot, school, quantity, expiresAt } = input;
    if (!batchId || !materialId || !school) {
      throw new DomainError("INVALID_INPUT", "batchId、materialId、school 均为必填", 400);
    }
    if (state.batches.has(batchId)) {
      throw new DomainError("BATCH_EXISTS", `批次已存在: ${batchId}`, 409);
    }
    ensurePositiveQuantity(quantity);
    if (!expiresAt || expiresAt <= ctx.now) {
      throw new DomainError("BATCH_EXPIRED", "批次有效期必须晚于当前时间", 400);
    }
    return {
      events: [
        {
          type: "BATCH_REGISTERED",
          payload: { batchId, materialId, lot: lot ?? "", school, quantity, expiresAt },
        },
      ],
      result: (s) => batchView(s, mustBatch(s, batchId)),
    };
  },

  // 库存预留：检查与扣减在串行队列中原子完成，并发重复占用会被拒绝
  "experiment.reserve"(state, input, ctx) {
    const exp = mustExperiment(state, input.experimentId);
    ensureNotBlocked(exp);
    if (!["RISK_APPROVED", "PREPARED", "REHEARSED"].includes(exp.stage)) {
      throw new DomainError("INVALID_STAGE", `当前阶段 ${exp.stage} 不可预留库存`, 409);
    }
    if (!approvalValid(exp, ctx.now)) {
      throw new DomainError("APPROVAL_MISSING_OR_EXPIRED", "风险审批缺失或已过期，禁止预留", 409);
    }
    const batch = mustBatch(state, input.batchId);
    if (batch.status === "RECALLED") throw new DomainError("BATCH_RECALLED", "批次已召回，禁止预留", 409);
    if (batch.expiresAt <= ctx.now) throw new DomainError("BATCH_EXPIRED", "批次已过有效期", 409);
    const version = currentVersion(exp);
    if (!version.materials.some((m) => m.materialId === batch.materialId)) {
      throw new DomainError(
        "MATERIAL_NOT_IN_VERSION",
        `批次材料 ${batch.materialId} 不在版本 ${exp.currentVersion} 的清单内`,
        409,
      );
    }
    ensurePositiveQuantity(input.quantity);
    if (batch.quantityAvailable < input.quantity) {
      throw new DomainError(
        "INSUFFICIENT_STOCK",
        `批次可用量 ${batch.quantityAvailable} 不足以满足 ${input.quantity}`,
        409,
      );
    }
    const reservationId = input.reservationId ?? `${exp.id}-rsv-${exp.reservations.length + 1}`;
    if (exp.reservations.some((r) => r.id === reservationId)) {
      throw new DomainError("RESERVATION_EXISTS", `预留单已存在: ${reservationId}`, 409);
    }
    return {
      events: [
        {
          type: "RESERVATION_PLACED",
          payload: {
            experimentId: exp.id,
            reservationId,
            batchId: batch.id,
            materialId: batch.materialId,
            school: exp.school,
            quantity: input.quantity,
            versionNo: exp.currentVersion,
            borrowedFrom: null,
            borrowId: null,
          },
        },
      ],
      result: (s) => experimentView(mustExperiment(s, exp.id)),
    };
  },

  // 备料完成：要求当前版本清单中的每种材料都被有效预留足额覆盖
  "experiment.prepare"(state, input, ctx) {
    const exp = mustExperiment(state, input.experimentId);
    ensureNotBlocked(exp);
    if (exp.stage !== "RISK_APPROVED") {
      throw new DomainError("INVALID_STAGE", `当前阶段 ${exp.stage} 不可备料`, 409);
    }
    if (!approvalValid(exp, ctx.now)) {
      throw new DomainError("APPROVAL_MISSING_OR_EXPIRED", "风险审批缺失或已过期，禁止备料", 409);
    }
    const shortage = [];
    for (const line of currentVersion(exp).materials) {
      const reserved = exp.reservations
        .filter((r) => r.status === "ACTIVE" && r.materialId === line.materialId)
        .reduce((sum, r) => sum + (r.quantity - r.returnedQty), 0);
      if (reserved < line.quantity) {
        shortage.push({ materialId: line.materialId, required: line.quantity, reserved });
      }
    }
    if (shortage.length > 0) {
      throw new DomainError("MATERIAL_SHORTAGE", `备料不足: ${JSON.stringify(shortage)}`, 409);
    }
    return {
      events: [
        { type: "PREPARATION_RECORDED", payload: { experimentId: exp.id, versionNo: exp.currentVersion } },
      ],
      result: (s) => experimentView(mustExperiment(s, exp.id)),
    };
  },

  // 地面预演：PASS 进入 REHEARSED；FAIL 留在 PREPARED 可重演
  "experiment.rehearse"(state, input, ctx) {
    const exp = mustExperiment(state, input.experimentId);
    ensureNotBlocked(exp);
    if (exp.stage !== "PREPARED") {
      throw new DomainError("INVALID_STAGE", `当前阶段 ${exp.stage} 不可预演`, 409);
    }
    if (input.result !== "PASS" && input.result !== "FAIL") {
      throw new DomainError("INVALID_INPUT", "result 必须为 PASS 或 FAIL", 400);
    }
    return {
      events: [
        {
          type: "REHEARSAL_RECORDED",
          payload: { experimentId: exp.id, result: input.result, notes: input.notes ?? "" },
        },
      ],
      result: (s) => experimentView(mustExperiment(s, exp.id)),
    };
  },

  // 上行确认：再次校验审批未过期（过期审批阻断后续节点）
  "experiment.uplinkConfirm"(state, input, ctx) {
    const exp = mustExperiment(state, input.experimentId);
    ensureNotBlocked(exp);
    if (exp.stage !== "REHEARSED") {
      throw new DomainError("INVALID_STAGE", `当前阶段 ${exp.stage} 不可上行确认`, 409);
    }
    if (!approvalValid(exp, ctx.now)) {
      throw new DomainError("APPROVAL_MISSING_OR_EXPIRED", "风险审批已过期，须重新复核后才能上行", 409);
    }
    if (!input.signoffDeadline || input.signoffDeadline <= ctx.now) {
      throw new DomainError("INVALID_INPUT", "signoffDeadline 必填且须晚于当前时间", 400);
    }
    return {
      events: [
        {
          type: "UPLINK_CONFIRMED",
          payload: { experimentId: exp.id, confirmer: input.confirmer ?? null, signoffDeadline: input.signoffDeadline },
        },
      ],
      result: (s) => experimentView(mustExperiment(s, exp.id)),
    };
  },

  // 签收：超过签收时限必须给出延迟原因，处理结果确定地记录在事件中
  "experiment.signoff"(state, input, ctx) {
    const exp = mustExperiment(state, input.experimentId);
    ensureNotBlocked(exp);
    if (exp.stage !== "UPLINK_CONFIRMED") {
      throw new DomainError("INVALID_STAGE", `当前阶段 ${exp.stage} 不可签收`, 409);
    }
    const late = ctx.now > exp.signoffDeadline;
    if (late && !input.lateReason) {
      throw new DomainError("LATE_SIGNOFF_REQUIRES_REASON", "签收已超过时限，必须提供 lateReason", 409);
    }
    return {
      events: [
        {
          type: "SIGNOFF_RECORDED",
          payload: {
            experimentId: exp.id,
            signedBy: input.signedBy ?? null,
            late,
            lateReason: input.lateReason ?? null,
          },
        },
      ],
      result: (s) => experimentView(mustExperiment(s, exp.id)),
    };
  },

  // 部分退料：累计退料不得超过预留量；退回数量归还可用库存（召回批次则隔离）
  "experiment.return"(state, input, ctx) {
    const exp = mustExperiment(state, input.experimentId);
    const reservation = mustReservation(exp, input.reservationId);
    if (reservation.status !== "ACTIVE") {
      throw new DomainError("RESERVATION_NOT_ACTIVE", `预留单状态为 ${reservation.status}，不可退料`, 409);
    }
    ensurePositiveQuantity(input.quantity);
    const remaining = reservation.quantity - reservation.returnedQty;
    if (input.quantity > remaining) {
      throw new DomainError("RETURN_EXCEEDS_RESERVED", `退料量 ${input.quantity} 超过可退余量 ${remaining}`, 409);
    }
    const batch = mustBatch(state, reservation.batchId);
    const events = [
      {
        type: "RETURN_RECORDED",
        payload: {
          experimentId: exp.id,
          reservationId: reservation.id,
          batchId: reservation.batchId,
          quantity: input.quantity,
          reason: input.reason ?? "",
        },
      },
    ];
    // 若本次退料清空了召回批次的预留，尝试解除阻断
    const fullyReturned = reservation.returnedQty + input.quantity === reservation.quantity;
    if (fullyReturned && batch.status === "RECALLED") {
      events.push(...unblockEventsIfClear(state, exp, reservation.id));
    }
    return { events, result: (s) => experimentView(mustExperiment(s, exp.id)) };
  },

  // 释放预留：归还库存；若释放的是召回批次且已无其他召回预留，则解除阻断
  "experiment.release"(state, input, ctx) {
    const exp = mustExperiment(state, input.experimentId);
    const reservation = mustReservation(exp, input.reservationId);
    if (reservation.status !== "ACTIVE") {
      throw new DomainError("RESERVATION_NOT_ACTIVE", `预留单状态为 ${reservation.status}，不可释放`, 409);
    }
    const events = [
      {
        type: "RESERVATION_RELEASED",
        payload: {
          experimentId: exp.id,
          reservationId: reservation.id,
          batchId: reservation.batchId,
          reason: input.reason ?? "",
        },
      },
    ];
    events.push(...unblockEventsIfClear(state, exp, reservation.id));
    return { events, result: (s) => experimentView(mustExperiment(s, exp.id)) };
  },

  // 批次召回：隔离剩余库存，并阻断所有仍持有该批次有效预留的方案
  "batch.recall"(state, input, ctx) {
    const batch = mustBatch(state, input.batchId);
    if (batch.status === "RECALLED") {
      throw new DomainError("BATCH_ALREADY_RECALLED", `批次已处于召回状态: ${batch.id}`, 409);
    }
    if (!input.reason) throw new DomainError("INVALID_INPUT", "召回必须给出 reason", 400);
    const events = [
      { type: "BATCH_RECALLED", payload: { batchId: batch.id, reason: input.reason } },
    ];
    for (const exp of state.experiments.values()) {
      const held = exp.reservations.some((r) => r.status === "ACTIVE" && r.batchId === batch.id);
      if (held && !exp.blocked) {
        events.push({
          type: "EXPERIMENT_BLOCKED",
          payload: { experimentId: exp.id, reason: `批次召回: ${input.reason}`, batchId: batch.id },
        });
      }
    }
    return { events, result: (s) => batchView(s, mustBatch(s, batch.id)) };
  },

  // 跨校借用申请：借入校须已获有效审批，且材料在其当前版本清单内
  "borrow.request"(state, input, ctx) {
    const exp = mustExperiment(state, input.experimentId);
    ensureNotBlocked(exp);
    const batch = mustBatch(state, input.batchId);
    if (batch.school === exp.school) {
      throw new DomainError("BORROW_SAME_SCHOOL", "同校批次请直接预留，无需借用", 400);
    }
    if (!approvalValid(exp, ctx.now)) {
      throw new DomainError("APPROVAL_MISSING_OR_EXPIRED", "风险审批缺失或已过期，禁止借用", 409);
    }
    if (batch.status === "RECALLED") throw new DomainError("BATCH_RECALLED", "批次已召回", 409);
    ensurePositiveQuantity(input.quantity);
    if (batch.quantityAvailable < input.quantity) {
      throw new DomainError("INSUFFICIENT_STOCK", `批次可用量 ${batch.quantityAvailable} 不足`, 409);
    }
    if (!currentVersion(exp).materials.some((m) => m.materialId === batch.materialId)) {
      throw new DomainError("MATERIAL_NOT_IN_VERSION", `批次材料 ${batch.materialId} 不在当前版本清单内`, 409);
    }
    const count = [...state.borrows.values()].filter((b) => b.experimentId === exp.id).length;
    const borrowId = input.borrowId ?? `${exp.id}-brw-${count + 1}`;
    if (state.borrows.has(borrowId)) {
      throw new DomainError("BORROW_EXISTS", `借用单已存在: ${borrowId}`, 409);
    }
    return {
      events: [
        {
          type: "BORROW_REQUESTED",
          payload: {
            borrowId,
            experimentId: exp.id,
            batchId: batch.id,
            fromSchool: batch.school,
            toSchool: exp.school,
            quantity: input.quantity,
            note: input.note ?? "",
          },
        },
      ],
      result: (s) => ({ ...mustBorrow(s, borrowId) }),
    };
  },

  // 借用审批：仅出借校可决；批准时再次校验库存并生成借入预留
  "borrow.decide"(state, input, ctx) {
    const borrow = mustBorrow(state, input.borrowId);
    if (borrow.status !== "PENDING") {
      throw new DomainError("BORROW_ALREADY_DECIDED", `借用单已处理: ${borrow.status}`, 409);
    }
    if (!input.actorSchool || input.actorSchool !== borrow.fromSchool) {
      throw new DomainError("FORBIDDEN", "仅出借校有权审批该借用单", 403);
    }
    if (input.decision === "REJECTED") {
      return {
        events: [{ type: "BORROW_REJECTED", payload: { borrowId: borrow.id, reason: input.reason ?? "" } }],
        result: (s) => ({ ...mustBorrow(s, borrow.id) }),
      };
    }
    if (input.decision !== "APPROVED") {
      throw new DomainError("INVALID_DECISION", "decision 必须为 APPROVED 或 REJECTED", 400);
    }
    const batch = mustBatch(state, borrow.batchId);
    if (batch.status === "RECALLED") throw new DomainError("BATCH_RECALLED", "批次已召回，无法出借", 409);
    if (batch.quantityAvailable < borrow.quantity) {
      throw new DomainError("INSUFFICIENT_STOCK", `批次可用量 ${batch.quantityAvailable} 不足`, 409);
    }
    const exp = mustExperiment(state, borrow.experimentId);
    if (!approvalValid(exp, ctx.now)) {
      throw new DomainError("APPROVAL_MISSING_OR_EXPIRED", "借入校审批已过期，无法出借", 409);
    }
    const reservationId = `${borrow.id}-rsv`;
    return {
      events: [
        { type: "BORROW_APPROVED", payload: { borrowId: borrow.id } },
        {
          type: "RESERVATION_PLACED",
          payload: {
            experimentId: exp.id,
            reservationId,
            batchId: batch.id,
            materialId: batch.materialId,
            school: borrow.toSchool,
            quantity: borrow.quantity,
            versionNo: exp.currentVersion,
            borrowedFrom: borrow.fromSchool,
            borrowId: borrow.id,
          },
        },
      ],
      result: (s) => ({ ...mustBorrow(s, borrow.id) }),
    };
  },
};

// ---------------------------------------------------------------------------
// 过期清扫：把已到期的批准标记为 EXPIRED（每次命令前与服务重启后执行）
// ---------------------------------------------------------------------------

export function collectExpiryEvents(state, now) {
  const events = [];
  for (const exp of state.experiments.values()) {
    if (exp.approval && exp.approval.status === "APPROVED" && exp.approval.expiresAt <= now) {
      events.push({
        type: "APPROVAL_EXPIRED",
        payload: { experimentId: exp.id, versionNo: exp.approval.versionNo },
      });
    }
  }
  return events;
}

// ---------------------------------------------------------------------------
// 归约器：重放事件重建状态（服务重启后继续未完成流程的基础）
// ---------------------------------------------------------------------------

export function applyEvent(state, event) {
  const { type, payload } = event;
  switch (type) {
    case "EXPERIMENT_PROPOSED": {
      state.experiments.set(payload.experimentId, {
        id: payload.experimentId,
        school: payload.school,
        title: payload.title,
        stage: "PROPOSED",
        versions: [payload.version],
        currentVersion: 1,
        approval: null,
        reservations: [],
        blocked: null,
        blocks: [],
        rehearsal: null,
        signoff: null,
        signoffDeadline: null,
        revision: 1,
        createdAt: event.occurredAt,
      });
      break;
    }
    case "EXPERIMENT_REVISED": {
      const exp = state.experiments.get(payload.experimentId);
      exp.versions.push(payload.version);
      exp.currentVersion = payload.version.versionNo;
      exp.approval = null; // 修订使旧审批失效，须重新复核
      exp.stage = "PROPOSED";
      exp.revision += 1;
      break;
    }
    case "RISK_REVIEW_RECORDED": {
      const exp = state.experiments.get(payload.experimentId);
      exp.approval = {
        versionNo: payload.versionNo,
        status: payload.decision,
        approver: payload.approver,
        expiresAt: payload.expiresAt,
        notes: payload.notes,
        decidedAt: event.occurredAt,
      };
      if (payload.decision === "APPROVED" && exp.stage === "PROPOSED") {
        exp.stage = "RISK_APPROVED";
      }
      exp.revision += 1;
      break;
    }
    case "APPROVAL_EXPIRED": {
      const exp = state.experiments.get(payload.experimentId);
      if (exp.approval) exp.approval.status = "EXPIRED";
      exp.revision += 1;
      break;
    }
    case "BATCH_REGISTERED": {
      state.batches.set(payload.batchId, {
        id: payload.batchId,
        materialId: payload.materialId,
        lot: payload.lot,
        school: payload.school,
        quantityTotal: payload.quantity,
        quantityAvailable: payload.quantity,
        quarantined: 0,
        expiresAt: payload.expiresAt,
        status: "AVAILABLE",
        recallReason: null,
      });
      break;
    }
    case "RESERVATION_PLACED": {
      const batch = state.batches.get(payload.batchId);
      batch.quantityAvailable -= payload.quantity;
      const exp = state.experiments.get(payload.experimentId);
      exp.reservations.push({
        id: payload.reservationId,
        batchId: payload.batchId,
        materialId: payload.materialId,
        school: payload.school,
        quantity: payload.quantity,
        returnedQty: 0,
        status: "ACTIVE",
        versionNo: payload.versionNo,
        borrowedFrom: payload.borrowedFrom ?? null,
        borrowId: payload.borrowId ?? null,
        placedAt: event.occurredAt,
      });
      exp.revision += 1;
      break;
    }
    case "RESERVATION_SUPERSEDED":
    case "RESERVATION_RELEASED": {
      const exp = state.experiments.get(payload.experimentId);
      const reservation = exp.reservations.find((r) => r.id === payload.reservationId);
      reservation.status = type === "RESERVATION_SUPERSEDED" ? "SUPERSEDED" : "RELEASED";
      const batch = state.batches.get(reservation.batchId);
      const remaining = reservation.quantity - reservation.returnedQty;
      if (batch.status === "RECALLED") batch.quarantined += remaining;
      else batch.quantityAvailable += remaining;
      exp.revision += 1;
      break;
    }
    case "RETURN_RECORDED": {
      const exp = state.experiments.get(payload.experimentId);
      const reservation = exp.reservations.find((r) => r.id === payload.reservationId);
      reservation.returnedQty += payload.quantity;
      const batch = state.batches.get(payload.batchId);
      if (batch.status === "RECALLED") batch.quarantined += payload.quantity;
      else batch.quantityAvailable += payload.quantity;
      if (reservation.returnedQty === reservation.quantity) reservation.status = "RETURNED";
      exp.revision += 1;
      break;
    }
    case "PREPARATION_RECORDED": {
      const exp = state.experiments.get(payload.experimentId);
      exp.stage = "PREPARED";
      exp.revision += 1;
      break;
    }
    case "REHEARSAL_RECORDED": {
      const exp = state.experiments.get(payload.experimentId);
      exp.rehearsal = { result: payload.result, notes: payload.notes, at: event.occurredAt };
      if (payload.result === "PASS") exp.stage = "REHEARSED";
      exp.revision += 1;
      break;
    }
    case "UPLINK_CONFIRMED": {
      const exp = state.experiments.get(payload.experimentId);
      exp.stage = "UPLINK_CONFIRMED";
      exp.signoffDeadline = payload.signoffDeadline;
      exp.revision += 1;
      break;
    }
    case "SIGNOFF_RECORDED": {
      const exp = state.experiments.get(payload.experimentId);
      exp.stage = "SIGNED_OFF";
      exp.signoff = {
        signedBy: payload.signedBy,
        late: payload.late,
        lateReason: payload.lateReason,
        at: event.occurredAt,
      };
      exp.revision += 1;
      break;
    }
    case "BATCH_RECALLED": {
      const batch = state.batches.get(payload.batchId);
      batch.status = "RECALLED";
      batch.recallReason = payload.reason;
      batch.quarantined += batch.quantityAvailable;
      batch.quantityAvailable = 0;
      break;
    }
    case "EXPERIMENT_BLOCKED": {
      const exp = state.experiments.get(payload.experimentId);
      exp.blocked = { reason: payload.reason, batchId: payload.batchId, at: event.occurredAt };
      exp.blocks.push(exp.blocked);
      exp.revision += 1;
      break;
    }
    case "EXPERIMENT_UNBLOCKED": {
      const exp = state.experiments.get(payload.experimentId);
      exp.blocked = null;
      exp.revision += 1;
      break;
    }
    case "BORROW_REQUESTED": {
      state.borrows.set(payload.borrowId, {
        id: payload.borrowId,
        status: "PENDING",
        experimentId: payload.experimentId,
        batchId: payload.batchId,
        fromSchool: payload.fromSchool,
        toSchool: payload.toSchool,
        quantity: payload.quantity,
        note: payload.note,
        requestedAt: event.occurredAt,
      });
      break;
    }
    case "BORROW_APPROVED": {
      state.borrows.get(payload.borrowId).status = "APPROVED";
      break;
    }
    case "BORROW_REJECTED": {
      state.borrows.get(payload.borrowId).status = "REJECTED";
      break;
    }
    case "IDEMPOTENCY_RECORDED": {
      state.idempotency.set(payload.key, { status: payload.status, body: payload.body });
      break;
    }
    default:
      // 未知事件类型：忽略以兼容前向演进，事件本身仍保留在日志中
      break;
  }
}

// ---------------------------------------------------------------------------
// 视图
// ---------------------------------------------------------------------------

export function experimentView(exp) {
  return {
    id: exp.id,
    school: exp.school,
    title: exp.title,
    stage: exp.stage,
    currentVersion: exp.currentVersion,
    revision: exp.revision,
    versions: exp.versions,
    approval: exp.approval,
    reservations: exp.reservations,
    blocked: exp.blocked,
    blocks: exp.blocks,
    rehearsal: exp.rehearsal,
    signoff: exp.signoff,
    signoffDeadline: exp.signoffDeadline,
    createdAt: exp.createdAt,
  };
}

export function batchView(state, batch) {
  const reservations = [];
  for (const exp of state.experiments.values()) {
    for (const r of exp.reservations) {
      if (r.batchId === batch.id) reservations.push({ experimentId: exp.id, ...r });
    }
  }
  return { ...batch, reservations };
}
