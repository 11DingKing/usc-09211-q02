# 太空实验材料链领域约定

本文件是系统行为的权威说明，与 `src/` 实现和 `test/` 场景一一对应。

## 0. 三条基础约定

1. **事件时间与接收时间分离。** 每条命令记录 `occurredAt`（调用方报告的业务发生时间，
   仅作归属）与 `recordedAt`（服务端落盘时间）。一切有效期/门检判定只用服务端时间，
   `occurredAt` 只做 ±5 分钟未来偏斜校验，防止客户端时钟错误，且永不用于授权判定。
2. **业务身份由调用方提供稳定标识。** `planId / versionId / batchId / approvalId /
   lotId / borrowId / recallId / commandId` 均由调用方给定，跨重启稳定。
3. **审计记录不得以覆盖方式修改。** 命令只追加进哈希链信封，成功与被拒都入链；
   历史永不就地更新。

## 1. 持久化、幂等与并发

- 存储为单个只追加文件 `data/events.log`，每行一个信封：

  ```
  { v, seq, prevHash, commandId, commandType, actor, occurredAt, recordedAt,
    payload, payloadHash,
    result: { accepted: true,  events:[{id,type,data}], reply }
          | { accepted: false, code, message, details },
    hash }   // hash = sha256(canonical(去掉 hash 的其余字段))
  ```

  `canonical` 规则：对象键按字典序、数组保序、无多余空白。事件 id 由序号派生
  （`evt_<seq>_<index>`），因此重放结果与首次完全一致。
- 提交流程严格为 `writeSync → fsyncSync → 内存投影 → 返回响应`，全部同步串行。
  fsync 前崩溃＝命令不存在；fsync 后崩溃＝重放补齐。不存在“已响应但未落盘”。
- **幂等双键**：`commandId` 命中时再比对 `commandType + payloadHash`。同键同体返回原信封
  的确定性投影（带 `Idempotent-Replay: true`）；同键异体返回 409，绝不静默当重放。
- **拒绝也占键、也入链**：否则同一被拒命令重启后可能变成成功。
- 启动时顺序重放、校验 `seq` 连续与哈希链，并断言全部借用守恒式；末行损坏（torn tail）
  或链断裂一律 fail-closed 拒启动，不做静默截断或就地修复。
- 单写者：`data/lock` 以 `O_EXCL` 创建，阻止同目录第二实例；崩溃残留需人工处理。

## 2. 方案与版本

- 版本内容 `content = { title, protocol, safetyNotes, requirements[] }`，其中每条需求为
  `{ requirementId, materialId, qty, unit, consumable, allowedSubstituteMaterialIds[] }`。
  需求按 `requirementId` 排序、替代物去重排序后参与哈希，故键序/空白不影响 `contentHash`。
- `createPlan` 产生 `INITIAL` 版本；`publishRevision` 产生 `SAFETY` 或 `EDITORIAL` 后继，
  内容哈希与头部相同的“修订”被拒绝。版本构成一条只增的父子链。
- 批次创建时把当时版本内容**快照**进自身（`batchProposed.requirements`），版本后续变化
  不回改老批次。
- 钉定版本被 **SAFETY** 新版取代 ⇒ 批次门检 `VERSION_SUPERSEDED`（备料/预演/上行三处）。
  **EDITORIAL** 新版不阻断，投影为 `OK_VERSION_BEHIND_EDITORIAL`。

## 3. 阶段机与门检

阶段：`proposed → reviewed → reserved → rehearsed → uplinked`；旁路 `rejected`、
`cancelled`，以及 rebase 后的 `reviewPending`。

| 检查 | 含义 | reserve | rehearse | uplink |
|---|---|:--:|:--:|:--:|
| WRONG_STAGE | 前置阶段不符（reserve 需 reviewed，rehearse 需 reserved，uplink 需 rehearsed） | ✓ | ✓ | ✓ |
| 审批 | 审批须存在、绑定当前钉定版本、未撤销、处于 `[validFrom,validUntil)` | ✓ | ✓ | ✓ |
| VERSION_SUPERSEDED | 钉定版本已被 SAFETY 新版取代 | ✓ | ✓ | ✓ |
| RECALL_ACTIVE | 批次物料/lot 足迹命中生效召回（含闭包） | ✓ | ✓ | ✓ |
| MATERIALS_NOT_READY / RECALL_ACTIVE | FIFO 全量分配失败；若放开召回过滤反而能配齐则判为召回所致 | ✓ | – | – |
| MATERIALS_UNSETTLED | 预留未结清、器具未归还、关联借用未闭合 | – | – | ✓ |
| SAFETY_HOLD_ACTIVE | 批次被安全搁置 | ✓ | ✓ | ✓ |

- 审批半开区间：服务端时刻恰好等于 `validUntil` 即过期。
- `rebase` 只允许到同方案的**后继**版本；换版前非消耗品必须先归还、剩余预留先释放；
  换版后旧 hold/usage/关联借用**归档**（审计可查、不再进入门检），审批失效、排练作废，
  阶段回到 `reviewPending` 等待重新复核。
- 每次门检（无论放行与否）都计算完整 `gateSnapshot` 并随命令信封留存。

## 4. 库存与预留

- lot 分四类：`inbound`（入库）、`borrowed`（借入，所有权在贷方）、`returned`（退料回到
  贷方形成的新 lot，不写回原 lot）、`retained`（经同意留存，转借方所有）。
- 每个 lot 带 `originLotIds[]`，构成溯源链；`sourceBorrowId` 标记来源借用单。
- **两类预留**：
  - 批次 lot 级钉量：`reserve` 时 FIFO 钉到具体 lot，可钉 `inbound/returned/retained/
    borrowed`（借入 lot 被钉时把该借用单关联进批次）。
  - 借用材料级预留：借用单 `requested` 时只保料号数量；按请求先后 FIFO 把预留**钳制**到
    实际容量，后到借用单的超额请求不能用虚高预留饿死先到单。
- 备料试算：按需求顺序，主料不足时依次尝试白名单替代物；逐 lot FIFO；任一需求不足则
  **整体回滚、零钉量**。召回 lot 一律排除。
- `use` 只能领用本批已钉 lot；`returns` 只能归还已领用量；未动用的剩余预留用
  `release-unused` 显式释放。非消耗品（器具）上行前必须全部归还；`consumable` 需求领用即
  消耗，不要求归还。

## 5. 跨校借用：状态、守恒与终态

借用单按料号分行，每行维护下列累计量，任何时刻都满足守恒式（命令后与重放后均断言）：

```
出站：dispatched     = received + lostOutbound + inTransitOut
在手：received       = returnDispatched + retained + lostHeld + onHand
回程：returnDispatched = returnReceived + lostReturn + inTransitReturn
义务：dispatched + unfulfilled = requested   （unfulfilled 由 short-ship 确认短发）
```

- `requested`：材料级预留生效，可 `cancel` 释放。
- `dispatch`：可多次、部分发货；贷方 lot 减量并入在途，记录 FIFO 来源队列；选 lot 跳过召回。
- `short-ship`：确认无法补足的短发量，终结贷方发货义务。
- `receipts`（延迟/部分签收，可多次）：所有权与保管责任**自签收起**转移给借方；借方新建
  `borrowed` lot，`originLotIds` 由来源队列 FIFO 实算。超签拒绝。签收时召回已生效的，
  收货事实照常入链，但新 lot 立即处于污染状态、不可预留/领用。
- `returns`（部分退料）：从借方 `borrowed` lot FIFO 取出、减量入回程，记录回程来源队列。
- `return-receipts`（贷方延迟签收，可多次）：贷方新建 `returned` lot，不写回原 lot。
- `loss`：分 `outbound/return/held` 三腿登记丢失；`held` 需指定借方 lot 并从其库存扣减。
- `retain`（同意留存）两条路径：
  - 带 `batchId`：实验**已消耗**，只闭合借用账（校验净领用量），不动 lot；
  - 不带 `batchId`：实物**赠与**，从在手 `borrowed` lot 拆出转为借方 `retained` 新 lot。
- **结清**＝发货义务终结且三腿在途/在手全为 0。关联借用不结清，相关批次 `uplink` 被
  `BORROW_UNSETTLED` 阻断。

## 6. 召回

- `ITEM` 召回命中该料号全部 lot；`LOT` 召回命中指定 lot 并沿 `originLotIds` 做传递闭包
  （覆盖多跳借用、退料 lot、留存 lot）。
- 召回不回滚任何既有事件（已消耗不可撤销），只改变投影与门检：阻断后续节点，促使
  安全搁置/归还/rebase 到 SAFETY 新版/重新审批。
- 召回可关闭（记 `closedAt`），半开区间到期即不再生效；历史命中仍保留在审计中。

## 7. 审计复原

`GET /batches/:id/decision-record` 聚合：钉定版本全文与哈希、版本谱系、审批链（绑定版本/
有效期/撤销）、当前门检快照、命中召回与路径、lot 溯源链（含 rebase 归档）、关联借用结清
状态、以及按 `seq` 排列、含**被拒尝试与其门检快照**和命中召回事件的完整时间线。
每条记录带 `seq/hash/recordedAt`，可与 `GET /audit` 原始信封对照，并用
`GET /audit/verify` 复算全链。

## 8. 明确的能力边界

- 单进程单写者，不支持水平扩展；持久性优先于吞吐。
- 哈希链是 tamper-evident（可检测篡改/截断）而非 tamper-proof；跨机构防整体重写需外部
  锚点或只读副本，属后续工作。
- 无定时任务：审批过期、延迟签收超期等都在下一条命令/查询时惰性求值，重启后自然续跑。
