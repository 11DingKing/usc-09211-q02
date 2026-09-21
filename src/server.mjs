// HTTP 接口层：把请求映射为领域命令，查询直接读取重放后的状态。
// 审核人员可通过 /experiments/:id/audit（原始事件流）与
// /experiments/:id/clearance（按阶段复原的准入链）复原一套材料为何获准进入课堂。

import http from "node:http";
import { Store } from "./store.mjs";
import { batchView, DomainError, experimentView } from "./domain.mjs";

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new DomainError("INVALID_JSON", "请求体不是合法 JSON", 400);
  }
}

function experimentEvents(store, experimentId) {
  return store.events.filter((e) => e.payload && e.payload.experimentId === experimentId);
}

// 准入链复原：按门控节点汇总「何时、何人、依据哪个版本与哪份审批」
function clearanceView(store, experimentId) {
  const exp = store.state.experiments.get(experimentId);
  if (!exp) return null;
  const related = experimentEvents(store, experimentId);
  const ofType = (type) =>
    related
      .filter((e) => e.type === type)
      .map((e) => ({ seq: e.seq, at: e.occurredAt, actor: e.actor, ...e.payload }));
  const batchIds = [...new Set(exp.reservations.map((r) => r.batchId))];
  const recalls = store.events
    .filter((e) => e.type === "BATCH_RECALLED" && batchIds.includes(e.payload.batchId))
    .map((e) => ({ seq: e.seq, at: e.occurredAt, actor: e.actor, ...e.payload }));
  return {
    experimentId: exp.id,
    school: exp.school,
    title: exp.title,
    stage: exp.stage,
    admittedToClassroom: exp.stage === "SIGNED_OFF",
    currentVersion: exp.currentVersion,
    versionHistory: exp.versions,
    approval: exp.approval,
    gates: {
      proposed: ofType("EXPERIMENT_PROPOSED"),
      revisions: ofType("EXPERIMENT_REVISED"),
      riskReviews: ofType("RISK_REVIEW_RECORDED"),
      approvalExpiries: ofType("APPROVAL_EXPIRED"),
      reservations: ofType("RESERVATION_PLACED"),
      supersededReservations: ofType("RESERVATION_SUPERSEDED"),
      returns: ofType("RETURN_RECORDED"),
      prepared: ofType("PREPARATION_RECORDED"),
      rehearsals: ofType("REHEARSAL_RECORDED"),
      uplinkConfirmed: ofType("UPLINK_CONFIRMED"),
      signoff: ofType("SIGNOFF_RECORDED"),
      blocks: ofType("EXPERIMENT_BLOCKED"),
      unblocks: ofType("EXPERIMENT_UNBLOCKED"),
    },
    batches: exp.reservations.map((r) => {
      const batch = store.state.batches.get(r.batchId);
      return {
        ...r,
        batch: batch
          ? { lot: batch.lot, materialId: batch.materialId, ownerSchool: batch.school, status: batch.status, expiresAt: batch.expiresAt }
          : null,
      };
    }),
    recalls,
  };
}

async function dispatchRoute(store, req, res, type, input) {
  const meta = {
    actor: input.actor ?? req.headers["x-actor"] ?? null,
    occurredAt: input.occurredAt,
    idempotencyKey: req.headers["idempotency-key"] ?? undefined,
  };
  const { status, body } = await store.dispatch(type, input, meta);
  send(res, status, body);
}

async function handle(store, req, res) {
  const url = new URL(req.url, "http://localhost");
  const seg = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const method = req.method;

  if (method === "GET" && seg.length === 1 && seg[0] === "health") {
    send(res, 200, { status: "ok" });
    return;
  }

  if (method === "GET" && seg.length === 1 && seg[0] === "experiments") {
    send(res, 200, [...store.state.experiments.values()].map(experimentView));
    return;
  }
  if (method === "POST" && seg.length === 1 && seg[0] === "experiments") {
    await dispatchRoute(store, req, res, "experiment.propose", await readBody(req));
    return;
  }

  if (seg.length >= 2 && seg[0] === "experiments") {
    const id = seg[1];
    const sub = seg[2];
    if (method === "GET" && seg.length === 2) {
      const exp = store.state.experiments.get(id);
      if (!exp) throw new DomainError("EXPERIMENT_NOT_FOUND", `实验方案不存在: ${id}`, 404);
      send(res, 200, experimentView(exp));
      return;
    }
    if (sub === "versions" && method === "POST" && seg.length === 3) {
      await dispatchRoute(store, req, res, "experiment.revise", { ...(await readBody(req)), experimentId: id });
      return;
    }
    if (sub === "versions" && method === "GET" && seg.length === 4) {
      const exp = store.state.experiments.get(id);
      const version = exp?.versions.find((v) => v.versionNo === Number(seg[3]));
      if (!version) throw new DomainError("VERSION_NOT_FOUND", `版本不存在: ${id}@${seg[3]}`, 404);
      send(res, 200, version);
      return;
    }
    if (sub === "audit" && method === "GET" && seg.length === 3) {
      if (!store.state.experiments.has(id)) throw new DomainError("EXPERIMENT_NOT_FOUND", `实验方案不存在: ${id}`, 404);
      send(res, 200, experimentEvents(store, id));
      return;
    }
    if (sub === "clearance" && method === "GET" && seg.length === 3) {
      const view = clearanceView(store, id);
      if (!view) throw new DomainError("EXPERIMENT_NOT_FOUND", `实验方案不存在: ${id}`, 404);
      send(res, 200, view);
      return;
    }
    if (method === "POST" && seg.length === 3) {
      const commandByRoute = {
        "risk-review": "experiment.riskReview",
        reservations: "experiment.reserve",
        prepare: "experiment.prepare",
        rehearsal: "experiment.rehearse",
        "uplink-confirm": "experiment.uplinkConfirm",
        signoff: "experiment.signoff",
        returns: "experiment.return",
        release: "experiment.release",
        borrows: "borrow.request",
      };
      const type = commandByRoute[sub];
      if (type) {
        await dispatchRoute(store, req, res, type, { ...(await readBody(req)), experimentId: id });
        return;
      }
    }
  }

  if (seg[0] === "batches") {
    if (method === "POST" && seg.length === 1) {
      await dispatchRoute(store, req, res, "batch.register", await readBody(req));
      return;
    }
    if (method === "GET" && seg.length === 1) {
      send(res, 200, [...store.state.batches.values()].map((b) => batchView(store.state, b)));
      return;
    }
    if (method === "GET" && seg.length === 2) {
      const batch = store.state.batches.get(seg[1]);
      if (!batch) throw new DomainError("BATCH_NOT_FOUND", `材料批次不存在: ${seg[1]}`, 404);
      send(res, 200, batchView(store.state, batch));
      return;
    }
    if (method === "POST" && seg.length === 3 && seg[2] === "recall") {
      await dispatchRoute(store, req, res, "batch.recall", { ...(await readBody(req)), batchId: seg[1] });
      return;
    }
  }

  if (seg[0] === "borrows" && seg.length >= 2) {
    if (method === "GET" && seg.length === 2) {
      const borrow = store.state.borrows.get(seg[1]);
      if (!borrow) throw new DomainError("BORROW_NOT_FOUND", `借用单不存在: ${seg[1]}`, 404);
      send(res, 200, borrow);
      return;
    }
    if (method === "POST" && seg.length === 3 && seg[2] === "decision") {
      await dispatchRoute(store, req, res, "borrow.decide", { ...(await readBody(req)), borrowId: seg[1] });
      return;
    }
  }

  throw new DomainError("NOT_FOUND", `路由不存在: ${method} ${url.pathname}`, 404);
}

export function createServer(store) {
  return http.createServer(async (req, res) => {
    try {
      await handle(store, req, res);
    } catch (err) {
      if (err instanceof DomainError) {
        send(res, err.status, { error: { code: err.code, message: err.message } });
      } else {
        console.error(err);
        send(res, 500, { error: { code: "INTERNAL", message: "内部错误" } });
      }
    }
  });
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const store = await Store.open(process.env.DATA_DIR ?? "data");
  const port = Number(process.env.PORT ?? 8000);
  createServer(store).listen(port, "127.0.0.1", () => {
    console.log(`太空实验材料链服务已启动: http://127.0.0.1:${port}`);
  });
}
