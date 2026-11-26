# 批次 A 设计：可诊断的 400、skill 交换自愈、已投递水位

- 日期：2026-11-26
- 状态：已评审（v2，已纳入 Codex 只读评审意见与自核修订，见 §3.6 与 §7）
- 分支：`feat/batch-a-correctness`（从 `upstream/master` 起）
- 相关文档：
  - `docs/research/2026-11-25-optimization-final-plan.md` §二·批次 A（范围与验收口径）
  - `docs/research/2026-11-25-upgrade-robustness-idempotency-audit.md` §5.1（G1）、§5.2（G8）、§5.3（G9）
  - `docs/research/2026-11-25-client-server-throttle-audit.md` §4.8（重试与退避层次）

## 0. 一句话

三项互不依赖的 P1 正确性修复，不改上传协议主路径、不依赖 D1 优化：

- **A1**：服务端 400 附行级 `error.details`；客户端据此隔离坏行（保留 pending、不 ack），退避计数按来源分键。
- **A2**：skill 目录交换获得「skillDir 之外」的启动前恢复，归档路径改 staging+rename，升级子进程补超时。
- **A3**：按来源持久化「最后已投递水位」，自动 since 起点在停机超过默认窗口后仍覆盖中断期。

## 1. 设计原则（三项共同遵守）

1. **宽化先行、收紧后置**：新字段/新入口先部署并让旧版本兼容，再让新版本依赖；任何一项都可在只部署服务端或只用新客户端时不产生新故障。
2. **不静默降级、不吞错**：坏行进 `details` 与日志，但绝不用退出码或 ack 删除「将来可能可上传」的行。
3. **跨端协议一处定义、两侧对照**：凡改动 `upload-backoff.json`、`scheduled-sync-state.json` 等共享文件形状，Go 与 TS 同步实现，并加跨端形状测试（对齐 `clients/go/internal/state/crosslanguage_posix_test.go` 的做法）。
4. **每个 PR 只装一项**：A1、A2、A3 三个独立 PR，可分别上线；A2 单 PR 内再分两步发版（见 §3.3）。

---

## 2. A1：可诊断的 400 与按来源退避

### 2.1 现状（事实）

- 服务端 `apps/web/app/lib/http.ts:49-51` 把 `ZodError` 折叠为固定 `{error:{code:'BAD_REQUEST',message:'Invalid request'}}`，`error.issues` 被丢弃；`apps/web/app/lib/errors.ts` 的 `ApiError` 无 `details` 字段。
- ingest 与 check 两个入口都在路由内 `parse` 后交给 `jsonError`（`apps/web/app/routes/api/v1/ingest.ts:29`、`apps/web/app/routes/api/v1/ingest/check.ts:19`）。
- 客户端两侧都不读错误体：Go `clients/go/internal/upload/upload.go:317-331`（只按状态码）、`546-549`（排空响应体）；TS `packages/collector/src/upload.ts:241-247` 同样只按状态码。
- 退避状态 `upload-backoff.json` 单文件、按 stateDir 共享（Go `upload.go:551-656`，TS `packages/collector/src/upload-backoff.ts:15-104`）；一个来源的持续 400 会把整机所有来源一起暂停 24h。第三个消费者是 `skills/tokenboard/scripts/status.mjs:310-323`（只读 `pausedUntil`/`consecutiveFailures`）。
- 400 不可重试（Go `upload.go:460-468`；TS `upload.ts:261-298`），请求内即失败，`RecordFailure` 计入 24h 暂停。
- 现有测试对错误体做整体断言：`apps/web/app/routes/api/v1/ingest.test.ts:105-108`、`apps/web/app/lib/http.test.ts:45-80`；TS 侧有精确 message 断言 `packages/collector/src/upload-resilience.test.ts:32-39`；`transient-error.test.ts:29` 明确把 `Upload failed with status 400` 归为硬失败。

### 2.2 服务端：`error.details` 契约（增量、限量、不含输入值）

**响应形状**（仅在 ingest / check 的 Zod 校验失败时出现）：

```json
{
  "error": {
    "code": "BAD_REQUEST",
    "message": "Invalid request",
    "details": [
      { "index": 3, "path": "snapshots.3.usageDate", "code": "usage-date-too-far-future" },
      { "index": 7, "path": "snapshots.7.costUsd", "code": "cost-unavailable-source" }
    ]
  }
}
```

- `code` 与 `message` 保持现值不变（旧测试只在这两个字段上精确断言的部分无需改；整体 `toEqual` 的用例改为断言含 `details` 的新形状，并保留一条「非 Zod 的 400（非法 JSON）仍为通用体」的用例）。
- `details` 最多 **32** 条；超出截断并在 `error` 对象内、与 `details` 同级补 `"truncated": true`（`truncated` 只在为真时出现，空 `details` 时整个 `details` 字段也不出现，保持旧响应体形状）。
- 每条只含三个白名单字段：`index`（数组下标，仅 `snapshots.N.*` / `keys.N.*` 形式才有）、`path`（白名单路径）、`code`（稳定 code）。**不序列化 `issue.message`，不序列化任何输入值**——Zod v4 的默认 message 会带 received 值。
- 路径白名单：
  - `snapshots.<n>.<field>`，`field ∈ {source, usageDate, timezone, model, inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens, totalTokens, costUsd, sessionCount, collectedAt, correction}`；
  - **元素级** `snapshots.<n>`（无 field 段）：数组元素本身不是对象（`null`/字符串/数字）时 Zod 只给 `["snapshots", n]`，实测确认（zod 4.3.6 探针：`invalid_type`，path 两段）。若白名单只认三段路径，客户端拿不到下标，整个批会被当作无详情 400 并最终触发 24h 暂停——恰好是 A1 要消除的故障。元素级一律映射到 `invalid-type`，客户端必须把两段路径视为「整行坏」并隔离；
  - `keys.<n>.<field>`，`field ∈ {source, usageDate, model}`，以及元素级 `keys.<n>`；
  - 请求级 `snapshots` / `keys`（数组长度类 issue）。
- **下标必须由 `path[1]` 解析**：客户端只认「`path[0] ∈ {snapshots, keys}` 且 `path[1]` 是非负整数」的路径取下标，不依赖路径段的固定长度。
- 稳定 code 白名单（新增 `apps/web/app/features/ingest/error-details.ts` 做映射，不污染 `http.ts`）：

| 来源 issue | 稳定 code |
| --- | --- |
| invalid_type / required | `invalid-type` |
| invalid_value / invalid_enum_value / invalid_union | `invalid-value` |
| too_small（数组） | `array-too-small` |
| too_big（数组） | `array-too-big` |
| 数值类 too_small/too_big | `token-out-of-range` |
| `Invalid ISO date` | `invalid-date` |
| `usageDate too far in the future` | `usage-date-too-far-future` |
| `usageDate before the supported history window` | `usage-date-before-window` |
| `cacheReadTokens` 超过 `totalTokens` | `cache-read-exceeds-total` |
| costUnavailable 来源带 `costUsd > 0` | `cost-unavailable-source` |
| 其它 custom issue | `invalid-value`（兜底） |

**实现落点**：

1. `apps/web/app/lib/errors.ts`：`ApiError` 增加可选第五参 `details?: ApiErrorDetail[]`。
2. `apps/web/app/lib/http.ts`：`ApiError` 分支在 `details` 存在且非空时把它塞进响应体；其余分支不变。
3. `apps/web/app/features/ingest/error-details.ts`（新文件）：`toIngestErrorDetails(error: ZodError): { details, truncated }` —— **不需要 kind 参数**：白名单按 `path[0] ∈ {snapshots, keys}` 判定根，两个 schema 的路径根互斥；白名单过滤、稳定 code 映射、去重（同一路径的多条约束 issue 合并成一条）、32 条截断。code 映射额外覆盖实测发现的 `invalid_format`（`collectedAt` 非法 datetime）→ `invalid-value`。
4. `apps/web/app/routes/api/v1/ingest.ts`、`.../ingest/check.ts`：把 `schema.parse(...)` 改为 `safeParse`；失败时 `throw new ApiError('BAD_REQUEST', 'Invalid request', 400, undefined, toIngestErrorDetails(...))`。非 Zod 错误路径完全不变。
   **同时保留 `jsonError` 的 ZodError 兜底不变**（`http.ts:49-51`）。`safeParse` 只覆盖这两个路由自己的校验；任何经 HonoX 中间件或未来新增路由抛出的 `ZodError` 仍走通用 400。客户端因此必须能同时处理「有 details」与「无 details」两种 400（§2.3 第 3 条），这条兼容路径不能省。
5. 测试：路由测试断言 `details` 形状、下标正确、**响应 JSON 里不出现输入值**（用一个含特殊字符串的坏行做哨兵）；check 路由新增 400 用例（当前只有限流测试）。

**兼容性**：`details` 是可选增量字段；旧 Go/TS 客户端只读状态码，不受影响。部署顺序：服务端先。

### 2.3 客户端：行级隔离（只隔离、不 ack）

两侧（Go `internal/upload` + `internal/cli`，TS `upload.ts` + `cli.ts`）同一语义：

1. **收到 400 时先读错误体**（上限 64 KiB，超出按无详情处理）。解析 `error.details`，取 `path ^snapshots\.(\d+)\.` 的下标集合。
2. **有可用下标**：把这些下标从当前批剔除（保留 pending、不进 `Delivered`/`Rejected`），对剩余行按幂等 upsert 重发一次；重发仍 400 且有新下标时再剔除一轮，**最多 2 轮**（防止服务端行为异常造成循环）。被剔除的行进入新的结果集合 `Blocked []BlockedSnapshot{Snapshot, Reason}`（Reason 取稳定 code），run 结束打印一条聚合告警（`N snapshot(s) blocked by server validation: <code>x<count>, ...`，不含原始值）。
3. **400 无可用详情**（旧服务端 / 非法 JSON / 请求级错误）：按现状整体失败（非瞬态、记退避），**保留二分诊断**但只在本地日志标记，不做自动重发——二分隔离需要服务端细节才安全，旧服务端下盲目重发会把请求量放大且无收益（审计 §5.1 的 v1 错误正是因为「二分后 ack」；本次连重发都不做）。
4. **ack 集合**：`Delivered ∪ Rejected（invalid / before-history-window）`，`Blocked` **不进 ack**（与现有 cursor 规则一致；Codex 文件级 ack 在存在 blocked 行时同样跳过整文件，复用 `too-far-future` 的既有处理模式 `cli.go:1166-1171`）。
5. **/check 的隔离**：check 返回 400 且有 `keys.N.*` 详情时，剔除坏 key 后重发 check；坏 key 视为「不存在」，随后的 ingest 由第 2 步隔离。check 无详情时按现状整体失败（它只是优化，失败会退化为全量上传由调用方决定——现状即如此）。

**Blocked 必须独立于 Rejected（不得复用）**：现有 `Rejected []RejectedSnapshot`（Go `upload.go:81-86`）只在本地日期窗口过滤时构造（`upload.go:126-134`，`Issue ∈ {invalid, too-far-future, before-history-window}`），其语义是「永久不可上传」。ack 规则在 `cli.go:1173` 把「非 too-far-future 的 Rejected」一律当作已确认；若把服务端拒绝的坏行塞进 `Rejected`，它们会被 ack 掉并在下次扫描时被 cursor 当作已处理——正是设计要避免的。因此 `Blocked` 是新字段，且 `acknowledgeUploadCursors` 只读 `Delivered` 与 `Rejected`，不读 `Blocked`；Codex 文件级确认的跳过条件从 `codexFutureRejected` 扩展为 `codexFutureRejected || len(result.Blocked) > 0`。TS 侧 `UploadResult` 同构。

**结果结构变化**：Go `upload.Result` 增加 `Blocked []BlockedSnapshot`；TS `UploadResult` 增加 `blocked`。退出码：只要还有 blocked 行但其余已送达，run 视为「部分成功」——退出码保持 0（数据没有丢，pending 还在），告警写 stderr。

### 2.4 退避按来源分键

**文件**：仍为 `<stateDir>/upload-backoff.json`，形状升级为 v2：

```json
{
  "version": 2,
  "sources": {
    "claude-code": { "consecutiveFailures": 2, "lastErrorSummary": "status 400", "pausedUntil": "2026-11-27T03:00:00.000Z" }
  }
}
```

- **读取兼容**：遇到 v1 形状（无 `version`、平铺 `consecutiveFailures`）时，视为「对所有来源生效的遗留条目」：任何来源的暂停检查都把 v1 的 `pausedUntil` 纳入判断（取「当前来源 v2 条目」与「v1 遗留」两边的最大值）；`consecutiveFailures` 只用于展示，不参与任何来源的计数累加——旧计数无法归属来源，借给任一来源都可能让该来源提前暂停。
- **写入**：只写当前来源的条目；`pausedUntil` 只暂停该来源。`RecordSuccess(source)` 只清该来源条目。
- **v1 的退场（保守，不做归属猜测）**：首次写入 v2 时**保留**平铺字段原样不动，同时写入该来源的 v2 条目；此后只有当**全部**暂停检查都看不到活动中的 v1 暂停（`pausedUntil` 已过期或不存在）时，才在一次成功写入里删除平铺字段。这样：a) 旧计数不会被错归到「升级后第一个写入者」；b) v1 暂停在有效期内继续对全机生效（与现状语义一致，不会因为升级而意外解除暂停）；c) 平铺字段最终会被清理，不会永久残留。若升级后所有来源都成功，第一个 `RecordSuccess` 看到 v1 暂停已过期，就直接清理。
- **status.mjs**：同时读 v1/v2，输出按来源列出暂停状态（脱敏不变）。
- **调用点**：Go `cli.go:294-302` 的 `RecordFailure` 传入当前 source；暂停检查（`cli.go:274`）只查当前 source 的条目；TS 对齐（`cli.ts:188-203, 233`）。
- **签名与调用方全量清单**（改契约必须同步改这些，漏一处就是编译错或静默写平铺老形状）：Go `upload.IsPaused(stateDir, now)`（`upload.go:602`）、`upload.RecordFailure(stateDir, err, now)`（`:619`）、`upload.RecordSuccess(stateDir)`（`:635`，当前是直接 `os.Remove` 整个文件——分键后必须改为只删该来源条目）；TS `loadUploadBackoff` / `isUploadPaused` / `recordUploadFailure` / `recordUploadSuccess`（`upload-backoff.ts:22,40,48,66`）；skill `status.mjs:306-323` 的 `readUploadBackoff`（只读，需同时认 v1/v2）。
- **配置作用域**：键取**本次运行的 source**（`options.Source`；调度运行的 `all` 就是 `all`，hook 运行是它自己的那个来源）。一次上传是一个混合批次，失败无法归属到批内的某一来源，所以不按批内来源拆分；hook 运行逐来源隔离，调度 `all` 运行仍是一把键——与今天的行为一致，只是多了按运行来源隔离的能力。
- **跨端形状测试**：Go 与 TS 各加一条「v2 文件可被对端解析」的固定 JSON 用例（放各自测试里，JSON 常量相同），防漂移。

### 2.5 验收

- 路由测试断言 `details` 形状且响应体不含输入值哨兵；`http.test.ts` 的通用 400 断言保留一条（非法 JSON 路径）。
- Go/TS 各一组测试：混合好坏行 → 好行 `Delivered`、坏行 `Blocked` 且不在 ack 集合；两轮剔除上限生效；旧服务端（400 无 details）整体失败且仍计一次退避。
- **hook 模式用例**：`classifyFailure`（`cli.go:386-391`）对 hook 运行的任何失败都返回 `ExitFailure`，hook 不会被调度器重试，因此 400 在 hook 下是「每次事件都重扫全量并失败」。测试要钉住：有 details 时 hook 运行把坏行隔离、好行送达、退出码为 0（不再整体失败）；无 details 时保持现状失败，行为不回退。
- 退避分键测试：来源 A 连续 5 次失败暂停，来源 B 仍能上传；成功只清 B。status.mjs 能读 v1 与 v2。
- **v1 迁移测试**：v1 文件含活动 `pausedUntil` + 来源 B 首次写入 → 平铺字段仍在、全机仍暂停；v1 暂停过期后 B 成功 → 平铺字段被清除；v1 的 `consecutiveFailures` 从不累加到任一来源。
- **元素级路径测试**：`snapshots: [null]` / `[42]` / `["x"]` 的 400 响应含 `index: 0` 且客户端隔离第 0 行（用 zod 4.3.6 探针已确认 path 形状，测试按此固定）。
- 不触碰生产；服务端改动先发布（`details` 对旧客户端无感），客户端改动随后。

---

## 3. A2：skill 目录交换的启动前恢复

### 3.1 现状（事实）

- 调度入口在安装时写死为 `<node> <skillDir>/scripts/sync.mjs --mode sync --scheduled`（`skills/tokenboard/scripts/install-schedule.mjs:25`；三种调度器分别在 `schedule.mjs:149-157`、`:199`、`:83`）。
- hook 外层命令在 `<configDir>/bin/notify.cjs`，但它 spawn 的真实脚本是 `<skillDir>/scripts/notify.mjs`（`hooks.mjs:58,236-244,359`）。
- git 路径交换两跳 rename：`skillDir → <skillDir>.tokenboard-upgrade-backup-<pid>`、`staging → skillDir`（`upgrade-utils.mjs:142,148`）；第二跳失败有回滚（`:150-170`），但两跳之间被杀会留下「skillDir 缺失 + 完整 backup + staging 残留」。git 路径的 `pnpm install` 在交换**之后**才跑（`upgrade.mjs:128-139`），失败无回滚点。
- 归档路径用 `copy` 直接合并写 skillDir（`upgrade-archive.mjs:92-98`），中途被杀留下「存在但残缺」的 skill；`recoverOrphanedBackup` 只认 **collector** 备份（`upgrade-archive.mjs:173-207`），skill 的 backup/staging 从未被扫描。
- **git 路径的 skill 交换已经是 staging→replace 两跳**（`upgrade.mjs:120-133`：copy 到 `<skillDir>.tokenboard-upgrade-staging-<pid>` → `replace` 两跳 rename + 回滚），且 `pnpm install` 在**交换之后**对 `collectorDir` 执行（`upgrade.mjs:135-139`）。归档路径的 `pnpm install` 反而在交换前、在解包目录里跑（`upgrade-archive.mjs:61-64`）。所以第二步「staging+rename」只针对归档路径，「install 前置」只针对 git 路径——两处修正方向相反，不要合并成一句笼统描述。
- `movePath` 只处理 EXDEV，不重试 EPERM/EBUSY（`upgrade-utils.mjs:101-126`）；对比 binary 路径已有 50/150/400ms 重试（`client-binary.mjs:706-737`）与 Go `renameatomic`。
- 升级链路所有 `spawnSync` 无 timeout（`upgrade-utils.mjs:16-41`、`upgrade-archive.mjs:292-313`），`curl` 无 `--max-time`。
- 锁：自动/计划同步持 `<stateDir>/sync.lock`（`sync.mjs:866-886` 的 `runWithSyncLock`，`coordinator-lock.mjs`）；hook 运行同样经 `runWithSyncLock` 持同一把锁（`sync.mjs:874` 无模式区分），由 coordinator 以 `TOKENBOARD_COORDINATOR_LOCK_HELD` 让子进程复用；等待预算由 `runtime.lockTimeoutMs` 决定（`coordinator-lock.mjs:34`）。**手动 `upgrade.mjs` 完全不加锁**。

### 3.2 决策：恢复宿主 = configDir 下的稳定启动器

三个候选里选「configDir 下的启动器」：

- Go `repair` 子命令：git 客户端的调度入口是 Node，且二进制不一定存在，覆盖不全。
- 改调度命令指向稳定入口：等价于本方案，但只解决调度、不解决 hook，且没有回收逻辑。
- **选中**：`<configDir>/bin/tokenboard-launcher.mjs`（新文件，由 skill 脚本生成；configDir 在 skillDir 之外，天然满足「宿主必须在 skillDir 之外」）。调度器与 hook 都改为经由它执行。

**启动器行为**：

1. 解析配置/状态目录（复用 `sync.mjs:978-980` 的三级回退）；读取参数：`<launcher> <skill-relative-script> [...args]`。
2. 健康检查：`<skillDir>/<script>` 存在，且（有完成标记 `<skillDir>/.tokenboard-skill-complete` 或**旧安装无标记**）视为健康。
3. 健康 → 直接 `spawnSync(process.execPath, [script, ...args], { stdio: 'inherit' })`，透传退出码与信号；不持有同步锁（保持现状）。
4. 不健康 → 取 `sync.lock`（与升级同一把，`coordinator-lock.mjs`，等待预算 1500ms，超时按 transient 退出）：恢复优先取**最新**的 `<skillDir>.tokenboard-upgrade-backup-*`（backup 由完整目录 rename 产生，天然完整）rename 回 skillDir；没有 backup 时取带 `READY` 标记的 `<skillDir>.tokenboard-upgrade-staging-*` 提升；两者都无 → 打印可诊断错误并退出 transient（hook 与调度各自既有 transient 码）。
   **锁的生命周期（必须写死，否则会死锁）**：
   - 持锁 → **重新检查** skillDir 健康（锁外观察到的不健康可能已被前一个 launcher 修复）→ 已健康则跳过恢复；仍不健康才做恢复 → 清理过期残留 → **释放锁** → 再执行第 3 步。
   - **绝不持锁 spawn 子脚本**：子脚本是 sync/hook，它们自己会经 `runWithSyncLock` 争同一把锁（`sync.mjs:866-886`），持锁 spawn 会自锁到 60 秒默认超时（`sync.mjs:41` 的 `defaultSyncLockTimeoutMs`）。
   - 恢复阶段的锁等待预算独立于 60 秒：`stateLockRuntime({ lockTimeoutMs: 1500 })`；与「另一进程正在长同步」并发时，恢复让路并 transient 退出，下一个事件/下一次 tick 重试——不留半恢复状态。
   - 第二个 launcher 在锁内复查后会发现已健康，不会按旧观察去找已删除的 backup。
5. 恢复完成后清理过期 staging/backup（仅当 skillDir 健康时），再执行第 3 步（此时不持锁）。
6. 所有 rename 走忙重试（见 3.4）。
7. **手动升级补锁**：`upgrade.mjs` 目前完全不加锁，与 launcher 恢复可能并发交换。第二步要求 `upgrade.mjs` 用 `runWithSyncLock` 包裹整个交换阶段；它本身在 coordinator 的子进程内运行时已继承锁所有权（`TOKENBOARD_COORDINATOR_LOCK_HELD`），`isCoordinatorLockHeld` 会直接放行，不会重入死锁。

**入口迁移**：

- `install-schedule.mjs`：三种调度器统一写 `node <configDir>/bin/tokenboard-launcher.mjs scripts/sync.mjs --mode sync --scheduled`（`scriptPath` 参数保留为测试钩子）。
- `hooks.mjs`：`notify.cjs` 由安装时**内嵌生成**（`hooks.mjs:236-244`），头部的 `STATE_DIR` / `NOTIFY_SCRIPT` / `NODE_PATH` / `SELF_PATH` 都是安装时写死的绝对路径常量（`hooks.mjs:256,276,279,287`），spawn 目标是 `NOTIFY_SCRIPT`（`:359`）；`uninstall` 对 handler 的识别依赖命令行里含 `notify.cjs` 字样（`:977`）。launcher 化后，`NOTIFY_SCRIPT` 应指向 launcher，且 `SELF_PATH` 识别不得因包了一层而失效。Antigravity statusline 同样经 launcher。
- 迁移存量安装：`upgrade.mjs` 与 `setup.mjs` 增加幂等步骤 `ensureLauncher()`（写 launcher 文件）+ `migrateEntrypoints()`（重写当前存在的调度与 hook 条目，仅当条目仍指向 `<skillDir>/scripts/*` 时改写，避免覆盖用户自定义）。`sync.mjs --scheduled` 首行也调用一次（旧调度入口在升级窗口期先完成迁移，下个 tick 起走 launcher）。
- `uninstall.mjs` 清理 launcher 与残留 staging/backup。

### 3.3 发版顺序（两步）

1. **第一步（本次 PR 上线即完成）**：launcher + 入口迁移 + 恢复逻辑（恢复只用 backup）。存量安装在第一次自动/手动升级后改为走 launcher；从这一刻起，两跳交换被中断可由 launcher 自愈。
2. **第二步（随后一个改动）**：归档路径改 staging+rename、git 路径的 `pnpm install` 前置到交换之前、忙重试与超时启用。第二步不改变第一步的行为契约，可独立回滚。

> 设计取舍：为什么不把 launcher 做成「总是持锁、统一入口」——hook 每次事件都会经过，持 `sync.lock` 会与长同步互相阻塞，改变现有并发语义；只在恢复时持锁影响面最小。

### 3.4 交换加固（第二步内容）

- **归档路径**：先 `copy(collectorSkillDir → <skillDir>.tokenboard-upgrade-staging-<pid>)`，写 `READY` 标记，再走 `replaceDirectory` 两跳；中断只会留下 staging（无标记则不被恢复提升）。
- **git 路径**：`pnpm install` 移到 skill 交换**之前**，在 `collectorDir`（完整 workspace）里执行；安装失败时 skillDir 尚未被动过。
- **忙重试**：`movePath` 在 `rename` 抛 `EPERM`/`EBUSY`/`EACCES`（Windows 占用）时按 50/150/400ms 重试 3 次，与 `client-binary.mjs:706-737` 一致；回滚的 rename 同样走重试。
- **超时**：`spawnSync` 统一加 timeout——归档下载 300s（curl 加 `--max-time 300`）、解包 120s、`pnpm install` 600s、`git fetch/clone` 300s；超时按步骤失败处理，走既有回滚。
- **完成标记**：交换成功后写 `<skillDir>/.tokenboard-skill-complete`（内容：版本 + 时间戳）；`ensureLauncher` 也校验标记。

### 3.5 验收

- 单测/集成测试（`upgrade.test.mjs`、新增 `launcher.test.mjs`）：
  - **第一跳之后强制终止**（skillDir 已 rename 为 backup、staging 尚未提升），跑 launcher → skillDir 恢复、后续脚本正常执行。只注入第二跳 rename 抛错的用例保留，但不能替代本条。
  - 归档复制中断（staging 无 READY）→ launcher 不提升残缺 staging，回退 backup。
  - 目标缺失且无 backup → launcher 报可诊断错误并以 transient 退出。
  - launcher 与升级并发：升级持 `sync.lock` 时 launcher 等待后让路，不并发交换。
  - 忙重试：注入一次 EBUSY 后成功；持续 EBUSY 超预算后按失败处理。
- 手工验证（本机）：`node <configDir>/bin/tokenboard-launcher.mjs scripts/sync.mjs --mode sync --dry-run` 等价物存在时必须与直接执行一致（stdout/退出码）。
- 锁生命周期：launcher 恢复期间持锁、恢复后释放再 spawn——用一个「子脚本内尝试取 sync.lock」的桩断言它在 launcher 已释放后拿到锁；另一进程持锁时 launcher 在 1500ms 内 transient 退出且 skillDir 未被改动；两个 launcher 并发、skillDir 已损坏 → 恰好一次恢复，第二个在锁内复查后直接执行。

### 3.6 评审记录（2026-11-26 Codex 只读评审）

Codex 对 9 条 file:line 事实全部核对为「相符」。采纳并修订的 4 条缺陷：

| 严重度 | 意见 | 处理 |
| --- | --- | --- |
| P1 | 30 天上限会让超长停机数据漏计，设计不应声称「永不跳过任何来源」 | 采纳：§4.4 增加「边界声明」，措辞改为「恢复窗口 7→30 天」，并更正我初稿里把边界误写成 `before-history-window` 的错误（真实边界是 `minUploadIsoDate = 2023-01-01`） |
| P2 | launcher 恢复的锁持有范围、释放时机、锁内复查、手动升级接锁都未定义 | 采纳：§3.2 第 4 条写死「恢复前持锁→复查→恢复→释放→再 spawn」，明确禁止持锁 spawn（会与子脚本的 `runWithSyncLock` 自锁 60s）；§3.2 第 7 条给 `upgrade.mjs` 补锁并用 coordinator 所有权避免重入 |
| P2 | 整行非对象时 Zod path 只有两段，白名单拿不到下标 | 采纳并**实测确认**（zod 4.3.6 探针）：`["snapshots", 0]` 为两段；§2.2 白名单增加元素级路径，客户端按 `path[1]` 取下标 |
| P2 | v1→v2 迁移可能把旧计数错归来源并提前清全局暂停 | 采纳：§2.4 改为「v1 计数不归任何来源；v1 暂停在有效期内仍全局生效；到期后某次成功写入才清理平铺字段」 |

Codex 的三个重点回答：(a) 按严格白名单实现不会泄漏输入值——与我实测的 `received string` 一致，`issue.message` 必须禁止序列化；(b) 现稿锁语义不完整——已补齐；(c) 跨源最小水位会造成不必要重扫（已接受，上限 30 天），**不会**让较新来源少采。Codex 未运行测试，除元素级 path 外其结论均为静态阅读；元素级 path 已由我的探针证实。

---

## 4. A3：按来源的「最后已投递水位」

### 4.1 现状（事实）

- 自动窗口只存在于 skill：`skills/tokenboard/scripts/sync-options.mjs:1` 的 `DEFAULT_LOOKBACK_DAYS = 7`，`readSince`（`:3-14`）按 `--since` → `TOKENBOARD_SINCE` → `config.since` → 默认回退；`sync.mjs:750,789-790` 解析一次后同时导出 `TOKENBOARD_SINCE` 与 `TOKENBOARD_DEFAULT_SINCE`，Go（`cli.go:804-807`）与 TS（`cli.ts:362`）只做回退，自身没有默认窗口。
- 一个进程只有一个 `since`（`cli.go:62-63`、`sync.mjs:746-750`），定时任务不传 `--source`（`schedule.mjs:74-76`），一次 `all` 运行共用它。
- 上传暂停时非 hook 运行返回 `ExitOK`（`cli.go:288`；TS `cli.ts:202`），因此「按退出码推进水位」会在停机期把水位推空——必须按 `Result.Delivered` 推进。
- 已投递集合在 ack 之前可得：Go `upload.Result.Delivered`（`upload.go:64-78`）、TS 同构；ack 在 `cli.go:323-328`、`cli.ts:258-270`。
- 状态文件命名惯例按来源分键：`<source>-cursor.json`、`scheduled-sync-state.<source>.json`、`scheduled-sync-retry.<hex>.json`（见 `cursor.go:564-577`、`scheduled-sync-state.mjs:10-17`、`scheduled-retry.mjs:316-340`）。
- 没有任何文件记录「已投递日期」。

### 4.2 状态文件

新增 `<stateDir>/delivered-watermark.json`（Go `internal/state/watermark.go`，TS `packages/collector/src/delivered-watermark.ts`，两侧同格式）：

```json
{
  "schemaVersion": "tokenboard-delivered-watermark/v1",
  "sources": {
    "claude-code": {
      "usageDate": "2026-11-24",
      "endpoint": "https://tokenboard.chaosyn.com",
      "deviceId": "dev_xxx",
      "updatedAt": "2026-11-25T03:17:00.000Z"
    }
  }
}
```

- 原子写（tmp + rename，0600），与 `upload-backoff` 同风格。
- `endpoint`/`deviceId` 与当前配置不一致的条目视为「无水位」（换服务器或重配对后不继承旧水位）。
- 损坏（JSON 解析失败 / 非法日期）→ 整体按无水位处理并打一次告警；**不删除文件**，下次成功写入时覆盖。

### 4.3 写入（只在该来源真正投递后推进）

- 位置：Go `cli.go` 在 `acknowledgeUploadCursors` 之后、`warmHookCursors` 之前；TS `cli.ts` 同一位置。
- 规则（按来源）：
  - 取该来源本次 `Delivered ∪ 永久不可上传（invalid / before-history-window）` 的 `usageDate` 最大值作为候选；
  - **只要该来源本次还有 `Blocked`（A1）或 `too-far-future` 未决行，就整源不推进**（存在未投递的日期，推进可能跳过它）；
  - 上传暂停或上传失败时不写；
  - 候选日期夹到「不晚于今天」（使用与采集相同的配置时区），防止时钟回拨把水位写到未来。
- 不参与 ack、不影响 cursor；hook 运行同样写入（hook 走 cursor 增量，但水位对后续 `--source <s>` 的补采仍有用）。

### 4.4 读取（自动起点）

- `sync-options.mjs`：`readSince`（`sync-options.mjs:3-14`）目前只有一个返回值，无法区分来源。改为返回 `{ since, auto }`（`auto = true` 当且仅当走的是 `buildDefaultSince` 分支），`sync.mjs` 据此在 `sharedEnv`（`sync.mjs:789-790` 附近）额外导出 `TOKENBOARD_SINCE_AUTO=1`，同时仍导出今天的 7 天默认值（旧 collector 行为不变）。**`TOKENBOARD_SINCE_AUTO` 必须与 `TOKENBOARD_SINCE` 走同一处 `sharedEnv` 组装**，否则 coordinator 派发的子进程收不到该标志。
- Go `cli.go:804-807` / TS `cli.ts:362`：当 `TOKENBOARD_SINCE_AUTO=1` 时，忽略注入的具体日期，按水位计算：
  `effective(source) = max(today-30, min(today-7, watermark(source)-1))`；
  本次要采集的来源集合取**最早**的 `effective` 作为进程级 since（`all` 运行时是所有来源的最小值）。
- 显式 `--since`/`TOKENBOARD_SINCE`/`config.since` 仍优先，且不设置 AUTO。
- **实现落点（顺序很关键）**：`options.Since` 在 `parseOptions` 里先于来源扩展解析（Go `cli.go:807`；`expandSources` 在 `:447` 才被调用）。因此不能把水位计算塞进 `flagOrEnvChain` 那个表达式。做法：保留现有表达式得到「注入值」，并在其后新增一步——仅当 `TOKENBOARD_SINCE_AUTO=1` 且来源解析成功时，把 `options.Since` 替换为按水位算出的进程级最小值；来源解析失败时（用法错误）保持原值让既有错误路径先报。TS 侧在 `cli.ts:362` 之后做同样的两步。
- 损坏/未来/跨 endpoint/跨 device 的水位按缺失处理，退回「今天的 7 天默认」并打印一条可诊断告警。
- `--until`、hook 模式、`warm-hooks` 语义完全不变（AUTO 只影响默认起点）。

**设计取舍（需要评审确认）**：本次保持「一个进程一个 since」，用所有待采来源水位的**最小值**聚合，而不是逐来源 spawn 或给 provider 增加逐源 since。
理由：a) 正确性上取最小值永不跳过任何来源；b) 不触碰 21 个 provider 自读 env 的既有契约（`claudecode.go:99-109`、`codex/provider.go:278-283`），改动面最小；c) 代价只在「某个来源长时间失败」时出现——其它来源会跟着多扫（最多 30 天），而扫多扫少不影响正确性。
后续若读量成为问题，可在批次 C 之后把定时同步改为逐源 spawn（复用 `notify.mjs:101-121` 的既有模式）实现逐源起点。

**边界声明（不可含糊）**：`max(today-30, …)` 的上限意味着**停机超过 30 天仍然会丢更早的数据**。A3 相比现状（固定 7 天窗口，停机超 7 天即永久漏计）是覆盖范围扩大，不是「任意中断期都能恢复」。原因不在服务端：`before-history-window` 的边界是 `minUploadIsoDate = '2023-01-01'`（`packages/usage-core/src/dates.ts:46`，Go `contract.UploadIsoDateIssue` 同值），30 天以前的日期服务端会接受；丢数据的机制是「水位只推进到本次已投递的最晚日期，而本次扫描起点被夹在 30 天前」——落在窗口外的会话行从未被扫描、从未进 cursor，水位越过它们之后也不会再被默认同步覆盖。对外说法必须是「恢复窗口从 7 天扩大到 30 天」。要真正覆盖更早中断期，需要独立补采通道（显式 `--since` 或导出本地历史重新导入），不在批次 A。

### 4.5 验收

- 单来源：水位改到 9 天前 → 默认运行重读 10 天前的快照；改为 40 天前 → 起点被夹在 30 天前；文件损坏/未来日期 → 回退 7 天并告警。
- 双来源：来源 A 连续失败 9 天（水位不动），来源 B 正常推进；A 恢复后覆盖中断期，B 的水位不受影响。
- 暂停语义：模拟上传暂停（`pausedUntil` 在未来）跑一次 → 水位不推进；hook 运行不产生暂停时的 transient 语义不变（`cli.go:285-286`）。
- 跨端：Go 写入的文件能被 TS 读取并正确计算，反之亦然（固定 JSON 用例）。
- 端到端：把水位文件与 `--since` 组合，断言 `since` 优先级（显式 > 环境 > 配置 > 水位自动 > 默认）。

---

## 5. 发布顺序与风险边界

| 步骤 | 内容 | 可独立回滚 | 依赖 |
| --- | --- | --- | --- |
| 1 | A1 服务端 `error.details`（旧客户端无感） | 是（回滚 Worker） | 无 |
| 2 | A1 客户端行级隔离 + 退避分键（Go/TS 同版发布；`upload-backoff.json` v2 兼容 v1） | 是（旧版继续读 v1） | 步骤 1 |
| 3 | A2 第一步：launcher + 入口迁移 + backup 恢复 | 是（launcher 无恢复也不破坏现状） | 无 |
| 4 | A3 水位（读 AUTO + 写文件；缺文件时行为与现状一致） | 是 | 无 |
| 5 | A2 第二步：归档 staging+rename、git 路径 install 前置、manual upgrade 补锁、忙重试、超时 | 是 | 步骤 3 |

**明确不做**（与最终方案一致）：

- 不把 400 的二分用于 ack；不给「坏行」自动设置退出码失败（pending 保留，run 视为部分成功）。
- 不引入客户端持久待传队列；不把水位放进 cursor（range 模式故意不 ack，无法代表已投递）。
- 不改 `--until`、hook 增量、warm-hooks 的任何语义。
- 不把定时同步改成逐源 spawn（本次用最小水位聚合，逐源起点留待读量需要时再做）。

## 6. 测试与验证总览

| 项 | 单元/集成 | 端到端 |
| --- | --- | --- |
| A1 服务端 | 路由测试（details 形状、无输入值哨兵、非法 JSON 仍通用体）；check 路由 400 用例 | 私有环境部署后旧客户端上传不回归（只读验证） |
| A1 客户端 | Go/TS：混合好坏行、两轮上限、旧服务端整体失败、退避分键、status.mjs v1/v2 | — |
| A2 | launcher 恢复（第一跳后终止）、归档残缺不提升、忙重试、锁并发；已有 upgrade 测试全绿 | 本机临时 HOME 模拟两跳中断后跑 launcher |
| A3 | 水位读写、9 天/40 天/损坏/未来、双来源隔离、跨端格式 | 本机把水位改旧后跑 `--scheduled` 观察 since |

**未覆盖 / 待观察**：Windows 上 launcher 经 schtasks wrapper 的实测（真机验证排在实现 PR 的 CI 之外）；水位在「设备重配对」后的继承行为按设计是「不继承」，需要一次真机确认不会引起额外全量重扫超过 30 天上限。

## 7. 自核修订记录（v1 → v2）

写稿后逐条回读代码核对 file:line，发现并修正了以下问题（与 §3.6 的 Codex 意见分开记录）：

| 位置 | v1 错误/缺口 | v2 |
| --- | --- | --- |
| §2.3 | 未说明 `Blocked` 与现有 `Rejected` 的关系 | `Rejected` 只在本地日期窗口过滤时构造（`upload.go:126-134`），语义是「永久不可上传」，ack 会把非 `too-far-future` 的 Rejected 一律确认（`cli.go:1173`）；`Blocked` 必须是独立字段且不参与 ack，Codex 文件级确认跳过条件扩为 `codexFutureRejected \|\| len(Blocked) > 0` |
| §2.2 实现落点 4 | 只改两个路由的 `parse` | 补明 `jsonError` 的 ZodError 兜底（`http.ts:49-51`）保留，客户端必须同时处理有无 details 的 400 |
| §2.4 | 只说「传入当前 source」 | 补全签名与调用方清单：Go `IsPaused/RecordFailure/RecordSuccess`（`upload.go:602/619/635`，其中 RecordSuccess 现为删整个文件）、TS 四个函数、skill `status.mjs:306-323` |
| §2.5 | 无 hook 路径用例 | 补：`classifyFailure`（`cli.go:386-391`）对 hook 失败一律 `ExitFailure` 且不重试，400 在 hook 下每次重扫，需钉住隔离后退出码 0 |
| §3.1 | 说「归档与 git 路径都要 staging」 | git 路径**早已**是 staging→replace（`upgrade.mjs:120-133`），归档才是 copy 直写（`upgrade-archive.mjs:92-98`）；「install 前置」只针对 git 路径（`upgrade.mjs:135-139` 在交换后），归档路径本就在交换前（`upgrade-archive.mjs:61-64`）。两处方向相反 |
| §3.1 锁 | 「hook 与调度共用同一把锁的持有者机制」表述含糊 | `runWithSyncLock` 对所有运行成立（`sync.mjs:874` 无模式区分），hook 也持锁；默认等待 60s（`sync.mjs:41`） |
| §3.2 入口迁移 | 只说 notify.cjs 改 spawn launcher | `notify.cjs` 由安装时内嵌生成，`STATE_DIR/NOTIFY_SCRIPT/NODE_PATH/SELF_PATH` 是写死的绝对路径常量（`hooks.mjs:256,276,279,287`），uninstall 靠命令行含 `notify.cjs` 识别（`:977`）；迁移要同时改生成模板与识别逻辑 |
| §4.4 读取 | 「since 来自默认回退时导出 AUTO」 | `readSince`（`sync-options.mjs:3-14`）只有一个返回值，需改为 `{since, auto}`；AUTO 必须与 `TOKENBOARD_SINCE` 同一处 `sharedEnv` 组装（`sync.mjs:789-790`），否则 coordinator 子进程收不到 |
| §4.4 实现落点 | 「按来源集合取最小值」但没写在哪算 | `options.Since` 在 `parseOptions` 先于 `expandSources`（`cli.go:807` vs `:447`）解析，不能塞进 `flagOrEnvChain`；需在其后新增一步替换 |
