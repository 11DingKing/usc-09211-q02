# 太空实验材料链领域约定

服务采用事件时间与接收时间分离的记录方式：每个事件同时携带 `occurredAt`（业务发生时间，调用方可指定）与 `recordedAt`（服务接收落盘时间）。所有业务身份由调用方提供的稳定标识表示，审计记录不得以覆盖方式修改——状态变化只能以新事件追加，方案修订只能以新版本追加。

## 阶段机

```
PROPOSED → RISK_APPROVED → PREPARED → REHEARSED → UPLINK_CONFIRMED → SIGNED_OFF
```

- 修订方案：回到 `PROPOSED`，旧版本审批失效，旧预留作废（`SUPERSEDED`）并释放库存，受影响批次写入修订事件。上行确认后方案冻结，不得修订。
- 风险复核：批准必须给出有效期，且只针对当前版本；审批到期由清扫补记 `APPROVAL_EXPIRED`，过期审批阻断预留、备料与上行确认。
- 备料：当前版本清单中的每种材料须被有效预留足额覆盖（扣除已退量）。
- 预演：`PASS` 进入 `REHEARSED`，`FAIL` 留在 `PREPARED` 可重演。
- 签收：超过 `signoffDeadline` 必须提供 `lateReason`，延迟事实确定地记录在事件中。

## 库存与批次

- 预留的「检查-扣减」在单写者命令队列中原子完成，并发重复占用以 `INSUFFICIENT_STOCK` 拒绝；`Idempotency-Key` 保证重试安全。
- 部分退料累计不得超过预留量（`RETURN_EXCEEDS_RESERVED`）；退回数量归还可用库存，召回批次的退回量进入隔离量。
- 批次召回：剩余可用量转入隔离，所有持有该批次有效预留的方案被阻断（`EXPERIMENT_BLOCKED`）；释放或退净召回批次预留后自动解除阻断（`EXPERIMENT_UNBLOCKED`）。
- 跨校借用：借入校须已获有效审批且材料在其当前版本清单内；仅出借校可审批；批准后生成带 `borrowedFrom` 标记的借入预留。

## 恢复与审计

- 事件仅追加写入 `events.jsonl`；服务重启后重放全部事件恢复状态，并补记停机期间过期的审批，未完成流程可继续推进。
- 审核人员可通过 `/experiments/:id/audit`（原始事件流）与 `/experiments/:id/clearance`（按门控节点汇总的准入链）复原一套材料获准进入课堂的完整依据。
