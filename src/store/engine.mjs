import path from "node:path";
import { contentHash } from "../util/canonical.mjs";
import { WriteAheadLog, acquireSingleWriterLock } from "./wal.mjs";
import { applyEvent, assertBorrowConservation } from "../domain/reducers.mjs";
import { createInitialState } from "../domain/state.mjs";
import { DomainError, ErrorCode, fail } from "../domain/errors.mjs";
import { handlers, validateOccurredAt } from "../domain/commands.mjs";
/**
 * 命令执行引擎。全部命令在单进程内同步串行处理：
 * 读请求体（唯一的异步阶段）之后，校验/门检 → WAL fsync → 内存投影
 * 全部同步完成才返回，因此“落盘与投影之间”不存在交错窗口。
 */
export class Engine {
  constructor({ dataDir, clock = () => Date.now() }) {
    this.dataDir = dataDir;
    this.clock = clock;
    this.releaseLock = null;
    this.wal = null;
    this.state = createInitialState();
    this.commandIndex = new Map(); // commandId -> envelope
  }

  start() {
    this.releaseLock = acquireSingleWriterLock(this.dataDir);
    try {
      this.wal = new WriteAheadLog(path.join(this.dataDir, "events.log"));
      const { replayed } = this.wal.load();
      for (const event of this.wal.acceptedEvents()) {
        applyEvent(this.state, event);
      }
      for (const envelope of this.wal.envelopes) {
        this.commandIndex.set(envelope.commandId, envelope);
      }
      assertBorrowConservation(this.state);
      return { replayed };
    } catch (error) {
      // 启动期校验失败（非运行中崩溃）：释放锁后原样抛出，便于修复后重启。
      this.releaseLock?.();
      this.releaseLock = null;
      throw error;
    }
  }

  stop() {
    this.releaseLock?.();
    this.releaseLock = null;
  }

  /**
   * @returns {{status:"accepted"|"rejected"|"replay", envelope, reply?}}
   * 拒绝与成功都可能是 replay；replay 逐字节复用原信封里的结论。
   */
  execute(commandType, payload, meta = {}) {
    const commandId = meta.commandId;
    if (typeof commandId !== "string" || commandId.length === 0) {
      throw fail(ErrorCode.VALIDATION, "commandId 不能为空（调用方提供的稳定幂等标识）");
    }
    const actor = normalizeActor(meta.actor);
    const nowMs = this.clock();
    const occurredAt = validateOccurredAt(meta.occurredAt, nowMs);
    const payloadHash = contentHash(payload);

    const existing = this.commandIndex.get(commandId);
    if (existing) {
      if (existing.commandType !== commandType || existing.payloadHash !== payloadHash) {
        throw fail(ErrorCode.CONFLICT, `commandId ${commandId} 已用于不同命令（同键异体），拒绝执行`, {
          commandId,
          existingCommandType: existing.commandType,
          existingPayloadHash: existing.payloadHash,
        });
      }
      return { status: "replay", envelope: existing, reply: existing.result.reply ?? null };
    }

    const handler = handlers[commandType];
    if (!handler) throw fail(ErrorCode.VALIDATION, `未知命令类型：${commandType}`);

    const base = {
      v: 1,
      commandId,
      commandType,
      actor,
      occurredAt,
      recordedAt: new Date(nowMs).toISOString(),
      payload,
      payloadHash,
    };

    let outcome;
    try {
      outcome = handler(this.state, payload, { nowMs, actor, occurredAt });
    } catch (error) {
      if (error instanceof DomainError) {
        const envelope = this.wal.append({
          ...base,
          result: { accepted: false, code: error.code, message: error.message, details: error.details },
        });
        this.commandIndex.set(commandId, envelope);
        return { status: "rejected", envelope };
      }
      throw error;
    }

    const envelope = this.wal.append({
      ...base,
      result: { accepted: true, events: outcome.events, reply: outcome.reply ?? null },
    });
    // 先落盘后投影：投影只接受已带着 evt id 的定稿事件。
    for (const event of envelope.result.events) {
      applyEvent(this.state, { type: event.type, data: event.data, recordedAt: envelope.recordedAt });
    }
    assertBorrowConservation(this.state);
    this.commandIndex.set(commandId, envelope);
    return { status: "accepted", envelope, reply: envelope.result.reply };
  }

  verify() {
    const chain = this.wal.verifyChain();
    // 重放得到的状态结构无规范序列化必要；链校验 + 守恒断言即审计校验核心。
    assertBorrowConservation(this.state);
    return { ...chain, commandsChecked: this.wal.envelopes.length };
  }
}

function normalizeActor(actor) {
  if (!actor || typeof actor !== "object") throw fail(ErrorCode.VALIDATION, "actor 必须包含 actorId 与 orgId");
  const actorId = actor.actorId;
  const orgId = actor.orgId;
  if (typeof actorId !== "string" || actorId.trim() === "") throw fail(ErrorCode.VALIDATION, "actor.actorId 必须为非空字符串");
  if (typeof orgId !== "string" || orgId.trim() === "") throw fail(ErrorCode.VALIDATION, "actor.orgId 必须为非空字符串");
  return { actorId, orgId, role: typeof actor.role === "string" ? actor.role : null };
}
