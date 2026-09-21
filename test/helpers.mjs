import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "../src/server.mjs";

let counter = 0;
export function uniqueId(prefix) {
  counter += 1;
  return `${prefix}_${Date.now().toString(36)}_${counter}`;
}

/**
 * 可重启、可控时钟的 HTTP 测试台。
 * now 可在测试中推进，用于验证审批过期等时间语义；
 * restart() 用同一 dataDir 重新创建服务，验证重启恢复。
 */
export class Harness {
  constructor(startTime = "2026-09-01T00:00:00.000Z") {
    this.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "matchain-"));
    this.nowMs = Date.parse(startTime);
    this.server = null;
    this.baseUrl = null;
    this.seenCommandIds = new Set();
  }

  start() {
    return new Promise((resolve, reject) => {
      try {
        this.server = createServer({ dataDir: this.dataDir, clock: () => this.nowMs });
      } catch (error) {
        reject(error);
        return;
      }
      this.server.listen(0, "127.0.0.1", () => {
        this.baseUrl = `http://127.0.0.1:${this.server.address().port}`;
        resolve();
      });
    });
  }

  async stop() {
    if (!this.server) return;
    await new Promise((resolve) => this.server.close(resolve));
    this.server = null;
  }

  async restart() {
    await this.stop();
    await this.start();
  }

  cleanup() {
    fs.rmSync(this.dataDir, { recursive: true, force: true });
  }

  tick(ms) {
    this.nowMs += ms;
  }

  setTime(iso) {
    this.nowMs = Date.parse(iso);
  }

  iso() {
    return new Date(this.nowMs).toISOString();
  }

  async command(method, urlPath, payload = {}, options = {}) {
    const commandId = options.commandId ?? uniqueId("cmd");
    const body = {
      commandId,
      occurredAt: options.at ?? this.iso(),
      actor: options.actor ?? { actorId: "teacher_chan", orgId: "SCHOOL_HK" },
      ...payload,
    };
    const response = await fetch(`${this.baseUrl}${urlPath}`, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    let json = null;
    const text = await response.text();
    if (text) json = JSON.parse(text);
    return { status: response.status, headers: response.headers, body: json, commandId };
  }

  async get(urlPath) {
    const response = await fetch(`${this.baseUrl}${urlPath}`);
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  }
}

/** 建方案 + 批次 + 通过风险复核 + 入库，返回各实体 id。 */
export async function seedApprovedBatch(h, options = {}) {
  const planId = options.planId ?? uniqueId("plan");
  const versionId = options.versionId ?? "v1";
  const batchId = options.batchId ?? uniqueId("batch");
  const schoolId = options.schoolId ?? "SCHOOL_HK";
  const requirements = options.requirements ?? [
    { requirementId: "r1", materialId: "MAT_A", qty: 3, unit: "件", allowedSubstituteMaterialIds: ["MAT_B"] },
  ];
  const actor = { actorId: "teacher_chan", orgId: schoolId };

  let r = await h.command("POST", "/plans", {
    planId, versionId, ownerSchoolId: schoolId,
    title: "水滴微重力演示", protocol: "步骤...", safetyNotes: "戴护目镜",
    requirements,
  }, { actor });
  if (r.status !== 200) throw new Error(`seed plan 失败：${JSON.stringify(r.body)}`);

  r = await h.command("POST", "/batches", { batchId, schoolId, planId }, { actor });
  if (r.status !== 200) throw new Error(`seed batch 失败：${JSON.stringify(r.body)}`);

  const approvalId = uniqueId("appr");
  r = await h.command("POST", `/batches/${batchId}/risk-decisions`, {
    batchId, decision: "approved", reviewerId: "reviewer_li", approvalId,
    validFrom: h.iso(),
    validUntil: new Date(h.nowMs + 30 * 86400_000).toISOString(),
  }, { actor: { actorId: "reviewer_li", orgId: schoolId } });
  if (r.status !== 200) throw new Error(`seed approval 失败：${JSON.stringify(r.body)}`);

  return { planId, versionId, batchId, schoolId, approvalId, requirements, actor };
}

export async function inbound(h, { lotId, schoolId, materialId, qty }, actor) {
  const r = await h.command("POST", "/inventory/inbound", { lotId, schoolId, materialId, qty }, { actor });
  if (r.status !== 200) throw new Error(`inbound 失败：${JSON.stringify(r.body)}`);
  return r;
}
