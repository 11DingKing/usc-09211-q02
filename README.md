# 太空实验材料链

面向香港、澳门学校与空间站端协同备课场景的**可独立运行**服务：贯通一套实验材料从
**提案 → 风险复核 → 备料 → 地面预演 → 上行确认**的全过程，解决“同一实验在各端使用的
材料版本不一致、直到联调才发现安全说明或替代物已变更”的问题。

纯 Node.js 内置模块实现（`node:http` / `node:fs` / `node:crypto`），无第三方运行时依赖，
数据落在本地只追加事件日志，重启即可续跑。

## 运行

```bash
npm start          # 默认 127.0.0.1:8000，数据目录 ./data（可用 DATA_DIR / PORT 覆盖）
npm test           # 运行全部场景测试（node --test）
```

健康检查：`GET /health` → `{"status":"ok"}`。

## 这套系统保证什么

- **修订不可覆盖、批次可追踪受影响版本。** 方案内容（含安全说明与替代物白名单）经规范化
  哈希得到 `contentHash`；每次修订生成新版本（`SAFETY` 安全类 / `EDITORIAL` 措辞类），
  旧版本永不删除。批次钉定创建时的版本；一旦出现新的 **SAFETY** 版本，在途批次在备料、
  预演、上行三个节点都会被 `VERSION_SUPERSEDED` 阻断，需 `rebase` 到新版并重新风险复核。
  措辞类修订不阻断，只在版本状态中提示“落后于措辞新版”。
- **过期审批与召回阻断后续节点。** 审批绑定具体方案版本与有效期（半开区间
  `[validFrom, validUntil)`），可被撤销；门检只使用**服务端落盘时刻**，回拨客户端
  `occurredAt` 无法延长审批。召回分料号级（ITEM）与批次级（LOT），LOT 召回沿
  `originLotIds` 传递闭包传播到多跳借用、退料与留存 lot。
- **库存预留防并发重复占用。** 命令全局串行；每个命令由调用方提供稳定 `commandId`，
  同键同体重放得到逐字节一致的原结论，同键异体返回 409。备料按 lot FIFO 全量分配，
  任一需求无法满足则整体失败、不产生任何部分预留；替代物只能取自版本白名单。
- **重启后续跑未完成流程。** 所有状态都是事件日志的投影；启动时校验哈希链并全量重放。
  被拒绝的命令同样入链，因此重启后对同一命令的重试仍是同一个拒绝。
- **跨校借用、部分退料、延迟签收有确定处理。** 借用遵循三腿守恒恒等式，未闭合（在途、
  在手未退、退料未被贷方签收）会以 `BORROW_UNSETTLED` 阻断相关批次上行；通过
  丢失确认与“同意留存/消耗留存”两个显式终态才能机械判定结清。
- **审核可复原。** `GET /batches/:id/decision-record` 聚合六类证据：钉定版本全文与哈希、
  审批链、历次门检快照（成功与被拒都留存）、命中召回与闭包路径、每个 lot 的溯源链、
  按序号排列的完整审计时间线。每条证据都带 `seq/hash/recordedAt`，可与 `GET /audit`
  的原始信封逐条对照；`GET /audit/verify` 独立复算整条哈希链。

## 阶段与门检

```
proposed ──风险复核通过──▶ reviewed ──备料──▶ reserved ──地面预演──▶ rehearsed ──上行──▶ uplinked
   │                          ▲                                      │
   └─风险驳回→ rejected        └──────── rebase 到新版 → reviewPending ┘
cancelled（取消，释放预留）   safetyHold=true 时三个节点全部阻断
```

阻断码（422 响应体 `details.blockers`，同时附完整 `gateSnapshot`）：
`WRONG_STAGE`、`APPROVAL_MISSING/EXPIRED/REVOKED/NOT_YET_VALID`、
`VERSION_SUPERSEDED`、`RECALL_ACTIVE`、`MATERIALS_NOT_READY`、
`MATERIALS_UNSETTLED`（含 `RESERVATION_OUTSTANDING`、`MATERIAL_NOT_RETURNED`、
`BORROW_UNSETTLED`）、`SAFETY_HOLD_ACTIVE`。

## 命令与查询

命令均为 `POST`，请求体顶层携带 `commandId`、`occurredAt`、`actor{actorId,orgId}`；
成功/幂等重放返回 200（重放带响应头 `Idempotent-Replay: true`），门检阻断 422，
阶段冲突/同键异体 409，结构错误 400，资源不存在 404。

方案与版本：`POST /plans`、`POST /plans/:planId/revisions`
批次：`POST /batches`、`.../risk-decisions`、`.../reserve`、`.../rehearse`、`.../uplink`、
`.../rebase`、`.../cancel`、`.../safety-hold(-clear)`、`.../use`、`.../returns`、
`.../release-unused`
审批：`POST /approvals/:approvalId/revoke`
库存：`POST /inventory/inbound`
借用：`POST /borrows`、`.../cancel`、`.../dispatch`、`.../short-ship`、`.../receipts`、
`.../returns`、`.../return-receipts`、`.../loss`、`.../retain`
召回：`POST /recalls`、`POST /recalls/:recallId/close`

查询：`GET /plans/:id`、`/plans/:id/versions/:versionId`、`/batches/:id`、
`/batches/:id/decision-record`、`/inventory`、`/lots/:id`、`/borrows/:id`、`/recalls`、
`/audit`（按 `afterSeq/limit` 分页）、`/audit/verify`。

完整字段与语义见 [docs/domain.md](docs/domain.md)，端到端用法见 `test/` 各场景。

## 运维边界（请知悉）

- **单写者**：`data/lock` 阻止同目录启动第二个实例；进程异常退出残留锁需人工确认后删除。
  当前版本不支持水平扩容。
- **篡改可检测、不可阻止有权限者整体重写**：哈希链能发现任何对历史行的改动或末行截断
  （启动 fail-closed），但持链服务本身被攻破时可被整体重写。跨机构强信任需要外部锚点或
  只读副本，列为后续工作。
- 命令处理同步串行并在 fsync 后才响应，吞吐以可证明的持久性换取，非高并发设计。
