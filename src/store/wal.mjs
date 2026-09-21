import fs from "node:fs";
import path from "node:path";
import { contentHash } from "../util/canonical.mjs";

/**
 * 单写者锁：纯内置模块下没有可靠的多进程互斥，第二实例直接拒启。
 * 崩溃残留的 lock 文件需人工确认后删除（README 已说明）。
 */
export function acquireSingleWriterLock(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const lockPath = path.join(dataDir, "lock");
  let fd;
  try {
    fd = fs.openSync(lockPath, "wx");
  } catch (error) {
    if (error.code === "EEXIST") {
      throw new Error(`数据目录 ${dataDir} 已被另一个实例锁定（lock 文件存在）；如确认无进程运行，请人工删除后重启`);
    }
    throw error;
  }
  fs.writeSync(fd, `${process.pid}\n`);
  fs.fsyncSync(fd);
  return function release() {
    try {
      fs.closeSync(fd);
    } finally {
      fs.rmSync(lockPath, { force: true });
    }
  };
}

/**
 * 只追加事件日志。每条命令占一行不可变信封并以哈希与前一条相连：
 *
 *   { v, seq, prevHash, commandId, commandType, actor,
 *     occurredAt, recordedAt, payload, payloadHash,
 *     result: { accepted: true,  events:[{id,type,data}], reply }
 *           | { accepted: false, code, message, details },
 *     hash }
 *
 * 被拒绝的命令同样入链：审计必须保留“曾被拦下”的事实，且重启后
 * 对同一 commandId 的重试要得到同一个拒绝，而不是可能变成成功。
 * 提交顺序固定为 writeSync → fsyncSync，响应只能在落盘之后发出；
 * 末行损坏（torn tail）或链断裂一律 fail-closed 拒启动，绝不截断修复。
 */
export class WriteAheadLog {
  constructor(logPath) {
    this.logPath = logPath;
    this.envelopes = [];
    this.fd = null;
    this.lastHash = "0".repeat(64);
  }

  load() {
    fs.mkdirSync(path.dirname(this.logPath), { recursive: true });
    const existed = fs.existsSync(this.logPath);
    if (!existed) {
      this.fd = fs.openSync(this.logPath, "a");
      fs.fsyncSync(fs.openSync(path.dirname(this.logPath), "r"));
      return { replayed: 0 };
    }
    const text = fs.readFileSync(this.logPath, "utf8");
    const lines = text.split("\n");
    const tail = lines.pop();
    if (tail !== "") {
      throw new Error("事件日志末条记录缺少换行或写入中断（torn tail），拒绝启动以保护审计完整性");
    }
    let prevHash = "0".repeat(64);
    for (const [index, line] of lines.entries()) {
      if (line === "") throw new Error(`事件日志第 ${index + 1} 行为空，记录格式被破坏`);
      let envelope;
      try {
        envelope = JSON.parse(line);
      } catch (error) {
        throw new Error(`事件日志第 ${index + 1} 行无法解析：${error.message}`);
      }
      const { hash, ...unsigned } = envelope;
      const expected = contentHash(unsigned);
      if (
        envelope.seq !== index + 1 ||
        envelope.prevHash !== prevHash ||
        typeof hash !== "string" ||
        hash !== expected
      ) {
        throw new Error(
          `事件日志第 ${index + 1} 行哈希链校验失败（最后完好序号 ${index}），审计记录可能已被篡改或损坏`,
        );
      }
      this.envelopes.push(envelope);
      prevHash = hash;
    }
    this.lastHash = prevHash;
    this.fd = fs.openSync(this.logPath, "a");
    return { replayed: lines.length };
  }

  /** 原子追加一条已组装好（但未签名）的信封，返回带 seq/hash 的定稿。 */
  append(record) {
    const seq = this.envelopes.length + 1;
    let result = record.result;
    if (result.accepted) {
      result = {
        ...result,
        events: result.events.map((event, index) => ({ id: `evt_${seq}_${index}`, ...event })),
      };
    }
    const envelope = { ...record, result, seq, prevHash: this.lastHash };
    const { hash, ...unsigned } = envelope;
    envelope.hash = contentHash(unsigned);

    fs.writeSync(this.fd, `${JSON.stringify(envelope)}\n`);
    fs.fsyncSync(this.fd);

    this.envelopes.push(envelope);
    this.lastHash = envelope.hash;
    return envelope;
  }

  /** 摊平已接受事件，附带其信封坐标，供重放投影。 */
  *acceptedEvents() {
    for (const envelope of this.envelopes) {
      if (!envelope.result.accepted) continue;
      for (const [index, event] of envelope.result.events.entries()) {
        yield {
          id: event.id,
          type: event.type,
          data: event.data,
          seq: envelope.seq,
          commandId: envelope.commandId,
          commandType: envelope.commandType,
          actor: envelope.actor,
          occurredAt: envelope.occurredAt,
          recordedAt: envelope.recordedAt,
          index,
        };
      }
    }
  }

  verifyChain() {
    let prevHash = "0".repeat(64);
    for (const [index, envelope] of this.envelopes.entries()) {
      const { hash, ...unsigned } = envelope;
      const expected = contentHash(unsigned);
      if (envelope.seq !== index + 1 || envelope.prevHash !== prevHash || hash !== expected) {
        return { ok: false, failedAt: index + 1, tipSeq: index, tipHash: prevHash };
      }
      prevHash = hash;
    }
    return { ok: true, tipSeq: this.envelopes.length, tipHash: this.lastHash };
  }
}
