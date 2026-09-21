# 太空实验材料链

面向多机构（香港、澳门、空间站端）协作的微重力实验材料管理服务，贯通实验方案从**提案 → 风险复核 → 备料 → 地面预演 → 上行确认 → 签收**的全过程。

## 运行

```bash
npm test          # 运行全部行为测试
npm start         # 启动服务（默认 127.0.0.1:8000，数据目录 ./data）
PORT=9000 DATA_DIR=/var/lib/smc npm start
```

## 设计要点

- **事件溯源**：所有状态变化以仅追加事件写入 `data/events.jsonl`，事件永不覆盖；服务重启后重放日志恢复状态，未完成流程继续推进，停机期间过期的审批在重启清扫中补记。
- **不可覆盖版本**：每次修订生成新版本，旧版本与旧安全说明仍可读取；修订使旧审批失效、作废旧预留并释放库存，受影响批次写入 `EXPERIMENT_REVISED` 事件供联调各方追踪。
- **并发安全**：命令在单写者队列中串行执行，库存「检查-扣减」原子完成；`Idempotency-Key` 防止重试重复扣减；`expectedRevision` 提供乐观并发控制。
- **阻断机制**：审批过期（`APPROVAL_EXPIRED`）与批次召回（`EXPERIMENT_BLOCKED`）阻断预留、备料、预演、上行确认与签收；释放召回批次预留后自动解除阻断。
- **确定性边界处理**：跨校借用需出借校审批；部分退料累计不得超过预留量；超时签收必须给出延迟原因并记录在案。
- **审计复原**：`GET /experiments/:id/audit` 返回原始事件流（事件时间与接收时间分离），`GET /experiments/:id/clearance` 按门控节点复原一套材料为何获准进入课堂。

## 接口概览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/experiments` | 提案（固化第 1 版清单与安全说明） |
| POST | `/experiments/:id/versions` | 修订（生成新版本，作废旧预留） |
| POST | `/experiments/:id/risk-review` | 风险复核（批准须含有效期） |
| POST | `/experiments/:id/reservations` | 库存预留（支持幂等键） |
| POST | `/experiments/:id/prepare` | 备料（校验清单足额覆盖） |
| POST | `/experiments/:id/rehearsal` | 地面预演（PASS/FAIL） |
| POST | `/experiments/:id/uplink-confirm` | 上行确认（复核审批有效性） |
| POST | `/experiments/:id/signoff` | 签收（超时须给 `lateReason`） |
| POST | `/experiments/:id/returns` | 部分退料 |
| POST | `/experiments/:id/release` | 释放预留 |
| POST | `/experiments/:id/borrows` | 跨校借用申请 |
| POST | `/borrows/:id/decision` | 借用审批（仅出借校） |
| POST | `/batches` / `/batches/:id/recall` | 批次登记 / 召回 |
| GET | `/experiments/:id` `/versions/:n` `/audit` `/clearance` | 状态、历史版本、审计流、准入链 |
| GET | `/batches/:id` `/borrows/:id` `/health` | 批次、借用单、健康检查 |

请求体可携带 `occurredAt`（业务事件时间）与 `actor`；响应中的错误均为确定性结构 `{ error: { code, message } }`。
