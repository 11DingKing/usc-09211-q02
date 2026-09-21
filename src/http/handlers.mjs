import { DomainError, ErrorCode } from "../domain/errors.mjs";
import { batchView, borrowView, decisionRecord } from "../domain/projections.mjs";

/**
 * 命令类路由统一入口：从请求体取出信封元数据（commandId/occurredAt/actor），
 * 路径参数并入 payload，执行后按 accepted / replay / rejected 映射状态码。
 * 被门检拦下的命令返回 422，body 内含 blockers 与 gateSnapshot。
 */
function makeCommandHandler(engine, commandType) {
  return ({ body, params }) => {
    const { commandId, occurredAt, actor, ...payload } = body ?? {};
    // 路由占位符与命令字段同名（planId/batchId/approvalId/borrowId/recallId），
    // 直接并入 payload；请求体同名字段不得与路径冲突。
    for (const [key, value] of Object.entries(params)) {
      if (payload[key] !== undefined && payload[key] !== value) {
        throw new DomainError(ErrorCode.VALIDATION, `路径参数 ${key} 与请求体取值不一致`);
      }
      payload[key] = value;
    }
    const outcome = engine.execute(commandType, payload, { commandId, occurredAt, actor });
    if (outcome.status === "rejected" || (outcome.status === "replay" && !outcome.envelope.result.accepted)) {
      const result = outcome.envelope.result;
      throw new DomainError(result.code, result.message, result.details,
        outcome.status === "replay" ? { "Idempotent-Replay": "true" } : {},
      );
    }
    return {
      status: 200,
      headers: outcome.status === "replay" ? { "Idempotent-Replay": "true" } : {},
      body: {
        status: outcome.status,
        commandId: outcome.envelope.commandId,
        seq: outcome.envelope.seq,
        recordedAt: outcome.envelope.recordedAt,
        payloadHash: outcome.envelope.payloadHash,
        events: outcome.envelope.result.accepted
          ? outcome.envelope.result.events.map((event) => ({ eventId: event.id, type: event.type }))
          : [],
        reply: outcome.envelope.result.reply ?? null,
      },
    };
  };
}

export function buildRoutes(engine, clock) {
  const cmd = (commandType, paramKeys) => makeCommandHandler(engine, commandType, paramKeys);
  const now = () => clock();

  const routes = [
    { method: "POST", pattern: "/plans", handler: cmd("createPlan") },
    { method: "POST", pattern: "/plans/:planId/revisions", handler: cmd("publishRevision") },
    { method: "POST", pattern: "/batches", handler: cmd("proposeBatch") },
    { method: "POST", pattern: "/batches/:batchId/risk-decisions", handler: cmd("riskDecision") },
    { method: "POST", pattern: "/approvals/:approvalId/revoke", handler: cmd("revokeApproval") },
    { method: "POST", pattern: "/inventory/inbound", handler: cmd("inbound") },
    { method: "POST", pattern: "/batches/:batchId/reserve", handler: cmd("reserve") },
    { method: "POST", pattern: "/batches/:batchId/use", handler: cmd("use") },
    { method: "POST", pattern: "/batches/:batchId/returns", handler: cmd("returnMaterials") },
    { method: "POST", pattern: "/batches/:batchId/release-unused", handler: cmd("releaseUnused") },
    { method: "POST", pattern: "/batches/:batchId/rehearse", handler: cmd("rehearse") },
    { method: "POST", pattern: "/batches/:batchId/uplink", handler: cmd("uplink") },
    { method: "POST", pattern: "/batches/:batchId/rebase", handler: cmd("rebase") },
    { method: "POST", pattern: "/batches/:batchId/cancel", handler: cmd("cancelBatch") },
    { method: "POST", pattern: "/batches/:batchId/safety-hold", handler: cmd("safetyHold") },
    { method: "POST", pattern: "/batches/:batchId/safety-hold-clear", handler: cmd("safetyHoldClear") },
    { method: "POST", pattern: "/borrows", handler: cmd("requestBorrow") },
    { method: "POST", pattern: "/borrows/:borrowId/cancel", handler: cmd("cancelBorrow") },
    { method: "POST", pattern: "/borrows/:borrowId/dispatch", handler: cmd("dispatchBorrow") },
    { method: "POST", pattern: "/borrows/:borrowId/short-ship", handler: cmd("shortShipBorrow") },
    { method: "POST", pattern: "/borrows/:borrowId/receipts", handler: cmd("receiveBorrow") },
    { method: "POST", pattern: "/borrows/:borrowId/returns", handler: cmd("returnDispatchBorrow") },
    { method: "POST", pattern: "/borrows/:borrowId/return-receipts", handler: cmd("returnReceiveBorrow") },
    { method: "POST", pattern: "/borrows/:borrowId/loss", handler: cmd("acknowledgeLoss") },
    { method: "POST", pattern: "/borrows/:borrowId/retain", handler: cmd("retainBorrow") },
    { method: "POST", pattern: "/recalls", handler: cmd("issueRecall") },
    { method: "POST", pattern: "/recalls/:recallId/close", handler: cmd("closeRecall") },

    /* ---------------- 查询 ---------------- */

    {
      method: "GET",
      pattern: "/plans/:id",
      handler: ({ params }) => {
        const plan = engine.state.plans.get(params.id);
        if (!plan) throw new DomainError(ErrorCode.NOT_FOUND, `方案不存在：${params.id}`);
        return {
          body: {
            planId: plan.planId,
            ownerSchoolId: plan.ownerSchoolId,
            title: plan.title,
            headVersionId: plan.headVersionId,
            versions: [...plan.versions.values()].map((v) => ({
              versionId: v.versionId,
              parentVersionId: v.parentVersionId,
              revisionType: v.revisionType,
              contentHash: v.contentHash,
              supersededByVersionId: v.supersededByVersionId,
            })),
          },
        };
      },
    },
    {
      method: "GET",
      pattern: "/plans/:id/versions/:versionId",
      handler: ({ params }) => {
        const plan = engine.state.plans.get(params.id);
        if (!plan) throw new DomainError(ErrorCode.NOT_FOUND, `方案不存在：${params.id}`);
        const version = plan.versions.get(params.versionId);
        if (!version) throw new DomainError(ErrorCode.NOT_FOUND, `版本不存在：${params.versionId}`);
        return {
          body: {
            planId: plan.planId,
            versionId: version.versionId,
            parentVersionId: version.parentVersionId,
            revisionType: version.revisionType,
            contentHash: version.contentHash,
            supersededByVersionId: version.supersededByVersionId,
            content: version.content,
          },
        };
      },
    },
    {
      method: "GET",
      pattern: "/batches/:id",
      handler: ({ params }) => {
        const view = batchView(engine.state, params.id, now());
        if (!view) throw new DomainError(ErrorCode.NOT_FOUND, `批次不存在：${params.id}`);
        return { body: view };
      },
    },
    {
      method: "GET",
      pattern: "/batches/:id/decision-record",
      handler: ({ params }) => {
        if (!engine.state.batches.has(params.id)) {
          throw new DomainError(ErrorCode.NOT_FOUND, `批次不存在：${params.id}`);
        }
        return { body: decisionRecord(engine.wal, engine.state, params.id, now()) };
      },
    },
    {
      method: "GET",
      pattern: "/inventory",
      handler: ({ query }) => {
        const schoolId = query.get("schoolId");
        const materialId = query.get("materialId");
        const lots = [...engine.state.lots.values()]
          .filter((lot) => (!schoolId || lot.schoolId === schoolId) && (!materialId || lot.materialId === materialId))
          .map((lot) => ({
            lotId: lot.lotId,
            schoolId: lot.schoolId,
            materialId: lot.materialId,
            qtyOnHand: lot.qty,
            kind: lot.kind,
            originLotIds: lot.originLotIds,
            sourceBorrowId: lot.sourceBorrowId,
          }));
        return { body: { lots } };
      },
    },
    {
      method: "GET",
      pattern: "/lots/:id",
      handler: ({ params }) => {
        const lot = engine.state.lots.get(params.id);
        if (!lot) throw new DomainError(ErrorCode.NOT_FOUND, `lot 不存在：${params.id}`);
        return {
          body: {
            lotId: lot.lotId,
            schoolId: lot.schoolId,
            materialId: lot.materialId,
            qtyOnHand: lot.qty,
            kind: lot.kind,
            originLotIds: lot.originLotIds,
            sourceBorrowId: lot.sourceBorrowId,
          },
        };
      },
    },
    {
      method: "GET",
      pattern: "/borrows/:id",
      handler: ({ params }) => {
        const view = borrowView(engine.state, params.id);
        if (!view) throw new DomainError(ErrorCode.NOT_FOUND, `借用单不存在：${params.id}`);
        return { body: view };
      },
    },
    {
      method: "GET",
      pattern: "/recalls",
      handler: () => ({
        body: {
          recalls: [...engine.state.recalls.values()].map((recall) => ({
            ...recall,
            issuedAt: new Date(recall.issuedAtMs).toISOString(),
            closedAt: recall.closedAtMs ? new Date(recall.closedAtMs).toISOString() : null,
          })),
        },
      }),
    },
    {
      method: "GET",
      pattern: "/audit/verify",
      handler: () => ({ body: engine.verify() }),
    },
    {
      method: "GET",
      pattern: "/audit",
      handler: ({ query }) => {
        const afterSeq = Number.parseInt(query.get("afterSeq") ?? "0", 10);
        const limit = Math.min(200, Math.max(1, Number.parseInt(query.get("limit") ?? "50", 10) || 50));
        const slice = engine.wal.envelopes.filter((e) => e.seq > afterSeq).slice(0, limit);
        return {
          body: {
            envelopes: slice,
            nextAfterSeq: slice.length === limit ? slice[slice.length - 1].seq : null,
            tipSeq: engine.wal.envelopes.length,
            tipHash: engine.wal.lastHash,
          },
        };
      },
    },
  ];

  return routes;
}
