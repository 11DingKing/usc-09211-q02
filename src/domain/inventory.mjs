/**
 * 库存纯函数：lot 池、两类预留竞争下的 FIFO 全量分配、召回闭包。
 * 本模块不产生事件，只回答“给定当前状态，能分到什么、哪些被召回”。
 */

export const OWNED_LOT_KINDS = new Set(["inbound", "returned", "retained"]);

/** 批次备料可钉用的 lot：自有三类 + 借入尚未归还的 lot。 */
export const RESERVABLE_LOT_KINDS = new Set([...OWNED_LOT_KINDS, "borrowed"]);

/** 某 lot 已被批次预留钉死的数量（仅活跃预留生效）。 */
export function pinnedQty(state, lotId) {
  let total = 0;
  for (const batch of state.batches.values()) {
    if (!batch.reservationActive) continue;
    for (const hold of batch.holds) {
      if (hold.lotId === lotId) total += hold.qty;
    }
  }
  return total;
}

/**
 * 按请求先后（Map 插入序）把材料级预留钳制到实际可分容量：
 * 后到借用单的超额请求只能形成 min(请求, 剩余) 的有效预留，
 * 不得用虚高预留反超并饿死先到的借用单。返回 Map<borrowId, 有效预留>。
 */
export function effectiveBorrowHolds(state, schoolId, materialId, lotFree) {
  const holds = new Map();
  let remaining = lotFree;
  for (const borrow of state.borrows.values()) {
    if (borrow.fromSchoolId !== schoolId || borrow.status !== "requested") continue;
    const line = borrow.lines.get(materialId);
    if (!line) continue;
    const granted = Math.max(0, Math.min(line.requested, remaining));
    holds.set(borrow.borrowId, granted);
    remaining -= granted;
  }
  return holds;
}

/** 生效中的召回（半开区间：closedAt 当期时刻恰好到达即视为已关闭）。 */
export function activeRecalls(state, nowMs) {
  return [...state.recalls.values()].filter((recall) => {
    if (nowMs < recall.issuedAtMs) return false;
    if (recall.closedAtMs !== null && nowMs >= recall.closedAtMs) return false;
    return true;
  });
}

/**
 * 计算被召回污染的 lot 集合：
 * - ITEM 召回：命中该料号的全部 lot；
 * - LOT 召回：命中 lot 本身，并沿 originLotIds 做传递闭包
 *   （多跳借用、退料 lot、留存 lot 均在链上）。
 */
export function recallFootprint(state, nowMs) {
  const recalls = activeRecalls(state, nowMs);
  const itemMaterials = new Set();
  const rootLotIds = new Set();
  for (const recall of recalls) {
    if (recall.scope === "ITEM") itemMaterials.add(recall.materialId);
    if (recall.scope === "LOT") rootLotIds.add(recall.lotId);
  }
  const childrenByOrigin = new Map();
  for (const lot of state.lots.values()) {
    for (const origin of lot.originLotIds) {
      const list = childrenByOrigin.get(origin);
      if (list) list.push(lot.lotId);
      else childrenByOrigin.set(origin, [lot.lotId]);
    }
  }
  const tainted = new Set();
  const stack = [...rootLotIds];
  while (stack.length > 0) {
    const current = stack.pop();
    if (tainted.has(current)) continue;
    tainted.add(current);
    for (const child of childrenByOrigin.get(current) ?? []) stack.push(child);
  }
  return {
    itemMaterials,
    taintedLotIds: tainted,
    roots: [...recalls].map((recall) => ({
      recallId: recall.recallId,
      scope: recall.scope,
      materialId: recall.materialId ?? null,
      lotId: recall.lotId ?? null,
    })),
  };
}

export function isLotRecalled(lot, footprint) {
  return footprint.itemMaterials.has(lot.materialId) || footprint.taintedLotIds.has(lot.lotId);
}

function lotFreeQty(state, lot) {
  return Math.max(0, lot.qty - pinnedQty(state, lot.lotId));
}

/** 某校某料号、对指定 lot 类别开放的可分 lot（FIFO 顺序），排除召回。 */
export function candidateLots(state, schoolId, materialId, { kinds, footprint }) {
  const result = [];
  for (const lotId of state.lotOrder) {
    const lot = state.lots.get(lotId);
    if (lot.schoolId !== schoolId || lot.materialId !== materialId) continue;
    if (!kinds.has(lot.kind)) continue;
    if (isLotRecalled(lot, footprint)) continue;
    const free = lotFreeQty(state, lot);
    if (free > 0) result.push({ lot, free });
  }
  return result;
}

/**
 * 材料池总量 = Σ 非召回 lot 可分量 − 各借用单的有效材料级预留（FIFO 钳制）。
 * 批次 lot 级钉量已经通过 lotFreeQty 扣除。
 */
export function materialPool(state, schoolId, materialId, { kinds, footprint }) {
  const lots = candidateLots(state, schoolId, materialId, { kinds, footprint });
  let lotFree = 0;
  for (const { free } of lots) lotFree += free;
  const holds = effectiveBorrowHolds(state, schoolId, materialId, lotFree);
  let borrowHold = 0;
  for (const granted of holds.values()) borrowHold += granted;
  return { lotFree, borrowHold, available: lotFree - borrowHold };
}

/**
 * 为批次试算预留：按需求顺序，主选料号不足时依次使用版本白名单内的
 * 替代物；任一需求无法全量满足则整体失败（all-or-nothing，不产生
 * 任何钉量）。同一命令内对同一 lot/料号的占用会被即时扣减。
 */
export function planReservation(state, schoolId, requirements, footprint, kinds = RESERVABLE_LOT_KINDS) {
  const holds = [];
  const consumedLot = new Map();
  const consumedMaterial = new Map();
  const shortfalls = [];

  const freeOnLot = (lot) =>
    lotFreeQty(state, lot) - (consumedLot.get(lot.lotId) ?? 0);
  const freeOfMaterial = (materialId) => {
    const pool = materialPool(state, schoolId, materialId, {
      kinds,
      footprint,
    });
    return pool.available - (consumedMaterial.get(materialId) ?? 0);
  };

  for (const requirement of requirements) {
    const candidates = [requirement.materialId, ...(requirement.allowedSubstituteMaterialIds ?? [])];
    let need = requirement.qty;
    const tried = [];
    for (const materialId of candidates) {
      if (need === 0) break;
      const cap = Math.min(need, freeOfMaterial(materialId));
      let taking = 0;
      if (cap > 0) {
        for (const { lot } of candidateLots(state, schoolId, materialId, { kinds, footprint })) {
          const available = Math.min(cap - taking, freeOnLot(lot));
          if (available <= 0) continue;
          holds.push({ lotId: lot.lotId, requirementId: requirement.requirementId, materialId, qty: available });
          consumedLot.set(lot.lotId, (consumedLot.get(lot.lotId) ?? 0) + available);
          consumedMaterial.set(materialId, (consumedMaterial.get(materialId) ?? 0) + available);
          taking += available;
          if (taking === cap) break;
        }
      }
      tried.push({ materialId, used: taking });
      need -= taking;
    }
    if (need > 0) {
      shortfalls.push({ requirementId: requirement.requirementId, shortBy: need, tried });
    }
  }
  return { ok: shortfalls.length === 0, holds, shortfalls };
}

/**
 * 借用发货/退料/留存时从指定学校按料号 FIFO 选 lot。
 * kinds 控制可见类别；必须跳过召回 lot；可发总量还要扣除其他
 * 「已请求未发货」借用单的材料级预留（excludeBorrowId 自身的预留除外）。
 * 同样是全量或失败。
 */
export function pickLots(state, schoolId, materialId, qty, { kinds, footprint, excludeBorrowId = null }) {
  // 可发量 = 候选 lot 的可分量之和 − 其他「已请求未发货」借用单的有效材料级预留。
  let lotFree = 0;
  for (const { free } of candidateLots(state, schoolId, materialId, { kinds, footprint })) {
    lotFree += free;
  }
  const holds = effectiveBorrowHolds(state, schoolId, materialId, lotFree);
  let otherHold = 0;
  for (const [borrowId, granted] of holds) {
    if (borrowId !== excludeBorrowId) otherHold += granted;
  }
  const available = Math.max(0, lotFree - otherHold);
  const picks = [];
  let need = Math.min(qty, available);
  for (const { lot, free } of candidateLots(state, schoolId, materialId, { kinds, footprint })) {
    if (need === 0) break;
    const take = Math.min(free, need);
    picks.push({ lotId: lot.lotId, qty: take, originLotIds: [...lot.originLotIds] });
    need -= take;
  }
  const picked = picks.reduce((sum, p) => sum + p.qty, 0);
  return picked >= qty ? { ok: true, picks, shortBy: 0 } : { ok: false, picks, shortBy: qty - picked };
}
