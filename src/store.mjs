// 事件存储：仅追加的 JSONL 日志 + 串行命令队列。
// - 所有事件先落盘再应用，日志永不覆盖，审计记录可完整复原；
// - 命令在单写者队列中串行执行，库存「检查-扣减」天然原子，杜绝并发重复占用；
// - 服务重启后重放日志恢复状态，并补记停机期间到期的审批，未完成流程可继续推进。

import fs from "node:fs/promises";
import path from "node:path";
import { applyEvent, COMMANDS, collectExpiryEvents, createState, DomainError } from "./domain.mjs";

export class Store {
  static async open(dir = process.env.DATA_DIR ?? "data") {
    const file = path.join(dir, "events.jsonl");
    await fs.mkdir(dir, { recursive: true });
    const store = new Store(file);
    await store.load();
    return store;
  }

  constructor(file) {
    this.file = file;
    this.state = createState();
    this.events = [];
    this.seq = 0;
    this.queue = Promise.resolve();
  }

  async load() {
    let text = "";
    try {
      text = await fs.readFile(this.file, "utf8");
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      const event = JSON.parse(line);
      this.events.push(event);
      applyEvent(this.state, event);
      this.seq = Math.max(this.seq, event.seq);
    }
    // 重启清扫：补记停机期间过期的审批，保证过期审批继续阻断后续节点
    const sweep = collectExpiryEvents(this.state, new Date().toISOString());
    if (sweep.length > 0) await this.appendAll(sweep, {});
  }

  enqueue(job) {
    const run = this.queue.then(job, job);
    this.queue = run.catch(() => {});
    return run;
  }

  async appendAll(events, meta) {
    const recordedAt = new Date().toISOString();
    const appended = [];
    const lines = [];
    for (const e of events) {
      const event = {
        seq: ++this.seq,
        type: e.type,
        payload: e.payload,
        actor: meta.actor ?? null,
        occurredAt: meta.occurredAt ?? recordedAt, // 事件时间（业务时间）
        recordedAt, // 接收时间（落盘时间）
      };
      lines.push(JSON.stringify(event) + "\n");
      appended.push(event);
    }
    if (lines.length > 0) await fs.appendFile(this.file, lines.join(""), "utf8");
    for (const event of appended) {
      this.events.push(event);
      applyEvent(this.state, event);
    }
    return appended;
  }

  // 命令入口：返回 { status, body }，领域错误转换为确定性的错误响应
  dispatch(type, input = {}, meta = {}) {
    return this.enqueue(async () => {
      const occurredAt = meta.occurredAt ?? new Date().toISOString();
      // 每次命令前先清扫过期审批
      await this.appendAll(collectExpiryEvents(this.state, occurredAt), { occurredAt });

      const idemKey = meta.idempotencyKey;
      if (idemKey && this.state.idempotency.has(idemKey)) {
        return this.state.idempotency.get(idemKey);
      }

      const handler = COMMANDS[type];
      if (!handler) throw new DomainError("UNKNOWN_COMMAND", `未知命令: ${type}`, 400);

      // 乐观并发：调用方可携带 expectedRevision 防止基于过期视图的写入
      if (input.expectedRevision != null && input.experimentId) {
        const exp = this.state.experiments.get(input.experimentId);
        if (exp && exp.revision !== input.expectedRevision) {
          throw new DomainError(
            "CONCURRENT_MODIFICATION",
            `方案已被他人修改：期望修订号 ${input.expectedRevision}，实际 ${exp.revision}`,
            409,
          );
        }
      }

      let response;
      try {
        const { events, result } = handler(this.state, input, { now: occurredAt });
        await this.appendAll(events, { occurredAt, actor: meta.actor });
        const body = typeof result === "function" ? result(this.state) : result;
        response = { status: 200, body };
      } catch (err) {
        if (!(err instanceof DomainError)) throw err;
        response = { status: err.status, body: { error: { code: err.code, message: err.message } } };
      }

      if (idemKey) {
        await this.appendAll(
          [{ type: "IDEMPOTENCY_RECORDED", payload: { key: idemKey, status: response.status, body: response.body } }],
          { occurredAt },
        );
      }
      return response;
    });
  }
}
