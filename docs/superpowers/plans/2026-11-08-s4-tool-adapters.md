# S4a: 12 工具来源原生适配器（除 copilot）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用纯 Go 原生实现替换 11 个 ccusage 工具来源（amp、droid、codebuff、hermes、goose、kilo、gemini、kimi、qwen、zcode、openclaw）对 `ccusage <tool> daily|session --json` 子进程的调用——读取各自本地日志（JSON/JSONL/SQLite），复刻 ccusage v20.0.33 的解析、去重、日期归属与成本语义，产出与 ccusage 报表**同形状的 JSON**，经现有 `ccusage.NormalizeCcusageDailyJSON` 转 Snapshot。copilot 单列 S4b（spec D8）。

**Architecture:** 新增 `clients/go/internal/collect/adapters/tools`（共享层：根解析、文件发现、宽容字段解码、时间戳、entry→report 行、session 累加器、report_from_rows）+ 每源一文件（`amp.go`、`droid.go`…）。SQLite 源复用 `internal/collect/sqlite`。成本查表走 `internal/nativepricing`（本计划扩展 `FindExactWithFallback`、builtin context limits 三档、missingPricing 零 token 门）。`providers/ccusagetool` 保留 ccusage 旧路径，用未导出 `useNativeTools = false` 选择；12 源共用一个包（现状），逐源注册 `RegisterNative`。S2/S3 的 `native.go` 是接线样板。

**Tech Stack:** Go 1.27、`encoding/json`（`json.Decoder.UseNumber` + 手写宽容读取，不用强类型 Unmarshal）、`internal/nativepricing`、`internal/collect/{sqlite,jsonl,sessionwalk}`、`modernc.org/sqlite`（已在 go.mod）。

**Spec:** `docs/superpowers/specs/2026-11-03-native-usage-sources-design.md`（§6.1.1 产出边界、§6.1.2 定价冻结、§6.2 复用、§6.3 重接线、§8 金样本阻塞项、§8.1/S4 结转义务、§9.4.2 copilot 单列、§10.1 回滚设计）

**语义事实来源（实现时必须对照）:** ccusage v20.0.33 @ `1308c416`，`rust/adapters/<tool>/src/{paths,parser,loader,report}.rs`、`rust/adapters/common/src/{lib,jsonl,report}.rs`、`rust/crates/ccusage-core/src/{cost,date_utils,utils,agent_report,output,pricing}.rs`、`rust/crates/ccusage-cli-parser/src/parser.rs`。源码已解压至 `/tmp/ccusage-src-1308c416/ccusage-1308c416`（临时目录，过期可重下）。下列每条规则附该版本 `file:line`。

## Global Constraints

- 语义冻结在 ccusage **v20.0.33**（commit `1308c416`）；派生规则在注释里注明 `file:line`。
- 适配器产出 **ccusage 报表形状的 JSON**：`{daily|monthly|sessions: [...], totals: {...}}`，session 顶层键是 **`sessions`**、行周期键是 **`sessionId`**（`agent_report.rs:68-75`；**不存在** `"session"` 键）。不是 `contract.Snapshot`（§6.1.1）。
- 子命令集固定为 `daily|monthly|session`，**无 weekly**（`types.rs:199-203`）；缺省 report 视为 `daily`。
- 子命令名 ≠ source 名：`gemini-cli → gemini`（`parser.rs:319-325`）；两侧映射表（`schema.ts:46-59`、`contract.go:78-91`）不得合并。
- **只实现 CLI 报表路径**（`lib.rs::run` → `load_entries` → `summarize_entries` → `report_from_rows`），不移植统一报表（`ccusage-adapter-all`）路径。
- 行字段固定集：`date|week|month|sessionId`、`inputTokens`、`outputTokens`、`cacheCreationTokens`、`cacheReadTokens`、`totalTokens`、`totalCost`、`modelsUsed`、`modelBreakdowns[]`；可选 `credits`(Some 时)、`messageCount`(Some 时，仅 hermes)、`lastActivity`/`firstActivity`/`projectPath`(仅 session 行且 `include_session_metadata=true`，仅 qwen/openclaw/zcode)。`modelBreakdowns[]` 元素：`modelName/inputTokens/outputTokens/cacheCreationTokens/cacheReadTokens/cost`，`missingPricing` 仅 true 时出现，**`extraTotalTokens` 不输出**。
- 时间戳解析**按 ccusage 的长度门手写**（`date_utils.rs:111-145`：长度 20/25 且 `[19]∈{Z,+,-}`，或 24/29 且 `[19]=='.'` 恰 3 位小数），不得用 `time.RFC3339Nano`（它接受任意小数位与小写 t）。
- **u64 饱和语义**：Rust 用 `saturating_add/sub`、`checked_mul`；Go 的 `uint64` 会静默回绕，必须写显式饱和函数（既有 `saturatingAddU64`/`saturatingSubU64` 在 `adapters/codex`，上提到共享层或复用 `usage-core` 等价物）。
- 宽容字段读取必须逐字段实现（`lenient_u64`：非 u64→0；`lenient_f64`；`lenient_object`：非对象→None；`non_empty_string`：trim 后空→None），**不得用强类型 Unmarshal**（类型不符会让整行/整文件失败，与 Rust 行为分叉）。
- 逐文件解析失败 = 跳过 + 可选 debug 日志，**不是**错误；但 provider 级 runner 错误必须原样返回，不得降级为空快照或回落 ccusage（claudecode `native.go:97-101`、codex `native.go:62-64`）。
- 三平台（darwin/linux/windows × amd64/arm64）构建通过；`gofmt`/`go vet` 干净；`go test -race` 通过；成本公式若落在 `nativepricing` 包外，乘积必须经 `nativepricing.Product`/`Sum`（arm64 FMADDD 守卫，见 S3 Critical 1）。
- 过渡开关**不是用户可见环境变量**（§10.1）：包内未导出常量，默认 ccusage，翻转是独立提交。
- 只投影 token/model/timestamp/会话标识；不得读取或保存 prompt/completion/正文/本地路径（`projectPath` 是项目名或固定字面量，非绝对路径；zcode 的 `session.directory` 是例外，须裁剪为目录名并记入报告边界）。

## Review Focus

1. **每个源的「去重键」与「跨文件顺序」**：hermes 按 session_id 跨库合并、goose 按 `dbpath:session_id` 不合并、kilo 按 message id 跨库合并、gemini 仅文件内按 id 原位替换（跨文件不去重）、kimi 九元组、qwen `entry_id` 数组、openclaw `migration_id:cost` + SQLite 替换、zcode 按 `model_usage.id` 跨库 first-wins、droid 每 session 保留 timestamp 最大者、codebuff `message.id` 或 ordinal 键。逐源测试。
2. **`--since/--until` 的两种语义**：条目级是 `entry.date` 去横线字符串比较、双端闭（`date_utils.rs:196-203`）；qwen 的 session 分支例外改为按 `lastActivity` 过滤（`qwen/src/lib.rs:21-67`）。非法日期 → 不窄化。Task 1 的过滤测试 + 各源测试。
3. **成本口径逐源不同**：amp 受 `--mode` 影响；droid/codebuff 硬编码 `Calculate`（忽略 `--mode`）；hermes 自报 >0 采信否则计算；kilo 的 0 在 auto 下视为已记录；gemini/kimi/qwen/zcode 无自报；qwen/zcode `costUsd` 恒 0/缺省。成本测试逐源。
4. **`totalTokens`/`extra_total_tokens` 回填**（`utils.rs:22-38`：`total - 已知`，output 为 0 补进 output，否则进 extra）。三源语义差异：droid 的 extra 初值 = thinking、gemini 展示 extra 与计价 extra 来源不同。**`modelBreakdowns` 不输出 extra**，故行级 `totalTokens` ≠ breakdown 之和是**预期不对称**。
5. **模型名归一化与定价候选链**：droid 的 `gemini-2.5-pro → gemini-2-5-pro`；goose 的 `starts_with('o')` 会把 opus 判成 openai；hermes/kilo 的 `provider/model` 前缀候选；zcode 的 `zai/` 前缀与「未知 provider 不当作 Z.ai」；openclaw 的 `[openclaw] model` 展示名 + 裸名定价；kimi 的 k2.5/k2.6 时间切换但展示名不变。定价测试逐源。

---

### Task 1: 共享工具适配器骨架

**Files:**
- Create: `clients/go/internal/collect/adapters/tools/tools.go`（包文档 + `Entry`/`Row`/`Totals` 类型）
- Create: `clients/go/internal/collect/adapters/tools/paths.go`
- Create: `clients/go/internal/collect/adapters/tools/discover.go`
- Create: `clients/go/internal/collect/adapters/tools/lenient.go`
- Create: `clients/go/internal/collect/adapters/tools/timestamp.go`
- Create: `clients/go/internal/collect/adapters/tools/report.go`
- Create: 对应 `_test.go`

**Interfaces:**
- Produces:
  - `type Entry struct { Timestamp int64 /*epoch ms*/; Date string; Model string; Input, Output, CacheCreation, CacheRead, Extra uint64; Cost *float64; SessionID string; MessageID string; PricingModel string /*若与 Model 展示名不同*/; ProjectPath string; Version string; MessageCount *uint64; Credits *float64 }`
  - `type Options struct { Env func(string) (string, bool); HomeDir func() (string, error); Timezone string }`
  - `ResolveRoots(raw string, defaults []string, env func(string)(string,bool)) ([]string, error)`——逗号切分 + trim + 丢空 + 仅收目录 + 保序去重；**设置了 env 就不回落 defaults**（amp `paths.rs:10-21`、codebuff `paths.rs:6`、kimi `paths.rs:13-39`、qwen `paths.rs:9-30`、hermes `paths.rs:5-27`、kilo `paths.rs:9-41`、zcode `paths.rs:12-25`、openclaw `paths.rs:11-42`）
  - `CollectFilesMatching(root string, accept func(name string) bool, ext ...string) []string`——递归收集（`common/src/lib.rs:18-46`，不跟随 symlink、失败静默），按完整路径字节序排序
  - `LenientU64(v any) uint64`、`LenientF64`、`LenientObject`、`NonEmptyString`、`PickU64(vals ...any) uint64`（取第一个 >0 的 u64，codebuff `parser.rs:469-474`）、`NumberField` / `PositiveFinite`
  - `ParseTSTimestamp(s string) (millis int64, ok bool)`（严格长度门）；`FormatRFC3339Millis(millis int64) string`（`date_utils.rs:356-368`，固定 `YYYY-MM-DDTHH:MM:SS.mmmZ` UTC）；`FormatDateTZ(millis int64, tz string) string`（`date_utils.rs:300-337`）
  - `ApplyTotalFallback(u *Usage, total uint64)`（`utils.rs:22-38`）
  - `type Usage struct { Input, Output, CacheCreation, CacheRead, Extra uint64 }`；`Summarize(entries []Entry, kind ReportKind) ([]Row, Totals)`；`ReportJSON(rows []Row, totals Totals, kind ReportKind) map[string]any`（`report_from_rows` + `agent_summary_json` + `totals_json`）
  - `SessionAccumulator`（`summary.rs:126-170`：`sessionId`/`projectPath`/`lastActivity`/`firstActivity`/`version`）

**精确规则（必须照抄）:**
- 报表骨架：`rowsKey`：Daily→`"daily"`、Monthly→`"monthly"`、Session→`"sessions"`；`periodKey`：Daily→`date`、Monthly→`month`、Session→`sessionId`（`agent_report.rs:59-75`）。
- `totals` 恒存在（仅 qwen 空集为 `null`，Task 7 特判）；`totalTokens` 含 extra；`credits` 仅和 >0 输出；`unpricedModels` 仅非空输出（排序去重，`output.rs:126-145`），且 **ModeDisplay 下不产出**（S3 codex `report.go:41-46` 同款）。
- session 行把 `date` 移进 `sessionId`（`summarize_by_key` 语义，`amp/report.rs:43-53`）：基础 session 行**只有 sessionId、无任何日期字段**；rich session（qwen/openclaw/zcode）走 `SessionAccumulator`，带 `lastActivity/firstActivity/projectPath`（`lastActivity` 是 UTC RFC3339 毫秒，归属日须按 `--timezone` 再格式化）。
- `modelBreakdowns` 按 cost 降序；`modelsUsed` 按首次出现顺序。

- [ ] **Step 1: 写失败测试**（`tools_test.go`）：`TestResolveRootsSplitsEnvAndKeepsZeroOnEmpty`（`ACME_DIR=""` → 0 个，不回落默认）；`TestCollectFilesIsSortedAndSkipsSymlinks`；`TestLenientU64RejectsFloatStringNegative`（含 `PickU64` 取首个 >0）；`TestParseTSTimestampRejectsMicrosecondsAndSpaceSeparator`；`TestFormatRFC3339MillisIsFixedWidth`；`TestFormatDateTZHonoursTimezone`（含 `local` 与非法名→本地）；`TestApplyTotalFallbackAddsToOutputOrExtra`；`TestReportJSONSessionKeysAreSessionsAndSessionId`；`TestSummarizeDropsEmptyEntries`。
- [ ] **Step 2: 运行确认失败**：`cd clients/go && go test ./internal/collect/adapters/tools/ -run 'TestResolveRoots|TestCollectFiles|TestLenient|TestParseTS|TestFormat|TestApplyTotal|TestReportJSON|TestSummarize' -v` → 编译失败。
- [ ] **Step 3: 实现**上述文件。
- [ ] **Step 4: 运行确认通过**：同上 → PASS。
- [ ] **Step 5: Commit**：`feat(adapters): add the shared tool-adapter scaffolding`

---

### Task 2: amp 适配器

**Files:** Create `tools/amp.go`、`tools/amp_test.go`

**精确规则（`adapters/amp/src/{paths,parser,loader}.rs`）:**
- 根 `AMP_DATA_DIR`（默认 `~/.local/share/amp`），扫描 `<root>/threads/**/*.json`（**任意 `.json`**，README 的 `T-{uuid}` 未校验）。
- **整文件一个 JSON 对象**（`parser.rs:96`）；反序列化失败 → 整文件空；无 `id`(非空串) → 跳过。
- 两条互斥路径：`usageLedger.events` 存在且为数组 → ledger 路径（`tokens.input`/`tokens.output`/`tokens.total`，cache 按 `toMessageId == message.messageId`(整数) 关联 `messages[].usage` 的 `cacheCreationInputTokens`/`cacheReadInputTokens`）；否则 messages 路径（仅 `role=="assistant"` 且有 `usage`，取 `inputTokens/outputTokens/cacheCreationInputTokens/cacheReadInputTokens/totalTokens`）。
- 两条路径五项全 0 → 丢弃；**无自报 cost**；cost 用 `calculate_cost(&cost_data, shared.mode, pricing)`，**受 `--mode`**；计费时把 extra 加到 output；`credits` = `event.credits`/`usage.credits`（`as_f64`，缺失 None、显式 0 Some(0)）。
- `session_id` = thread `id`；**无 sessionCount**；`data.timestamp` 保存原始字符串。
- 输出独有字段：`credits`（行 + totals，仅和 >0）。

- [ ] **Step 1: 写失败测试**：`TestAmpLedgerPathPerMessageCacheJoin`、`TestAmpFallsBackToMessagesWhenLedgerAbsent`、`TestAmpDropsAllZeroEntry`、`TestAmpCostHonoursMode`（display→0）、`TestAmpCreditsOnlyWhenPositive`。用例覆盖 `usageLedger:{}` 与 `"usageLedger":"not-an-object"` 回落到 messages。
- [ ] **Step 2: 运行确认失败** → 编译失败。
- [ ] **Step 3: 实现**。
- [ ] **Step 4: 运行确认通过**。
- [ ] **Step 5: Commit**：`feat(adapters): port the amp tool adapter`

---

### Task 3: droid 适配器

**Files:** Create `tools/droid.go`、`tools/droid_test.go`

**精确规则（`adapters/droid/src/{paths,parser,loader}.rs`）:**
- 根 `DROID_SESSIONS_DIR`（默认 `~/.factory/sessions`），递归 `.json` 后过滤文件名以 `.settings.json` 结尾。
- 每文件一个 settings JSON（UTF-8 强制）；解析失败 → 跳过该文件；必须有对象 `tokenUsage` 且五项不全 0。
- 映射：`inputTokens→input`、`outputTokens→output`、`cacheCreationTokens`、`cacheReadTokens`、`thinkingTokens→`**extra 初值**（不进展示 output，但计费前并入 output，`parser.rs:147-150`）、`totalTokens→`回填。
- 模型名：`settings.model` → `normalizeDroidModelName`（去 `custom:`、剥 `[...]`、小写、`.`/空白/`-`→单个 `-`；`gemini-2.5-pro→gemini-2-5-pro`）→ 否则 sidecar `<同前缀>.jsonl` 前 500 行找 `Model:` → 否则 `<provider>-unknown`。
- 时间戳：`providerLockTimestamp` 成功 → 用它且作为 `pricing_timestamp`；否则**文件 mtime**（`pricing_timestamp=None`→静态价）。
- **强制 `CostMode::Calculate`**（忽略 `--mode`）；候选模型 = model + provider 前缀链（anthropic→`anthropic/`,`openrouter/anthropic/`…），**首个 cost>0** 胜出，全 0 → 0.0。
- 去重：文件按路径 sort → 按 timestamp 升序稳定排序 → **逆序**迭代，按 `session_id` 首次命中取胜 → **每 session 保留 timestamp 最大者**。
- `session_id` = 文件名去 `.settings.json`。无 credits、无 sessionCount。

- [ ] **Step 1: 写失败测试**：`TestDroidNormalizeModelNameCollapsesDotsAndBrackets`、`TestDroidThinkingTokensEnterExtraAndBillingOutput`、`TestDroidMtimeFallbackForcesStaticPricing`、`TestDroidDedupKeepsNewestSnapshotPerSession`、`TestDroidProviderPrefixCandidatesFirstPositiveWins`。
- [ ] **Step 2–5**：确认失败 → 实现 → 通过 → Commit `feat(adapters): port the droid tool adapter`。

---

### Task 4: codebuff 适配器

**Files:** Create `tools/codebuff.go`、`tools/codebuff_test.go`

**精确规则（`adapters/codebuff/src/{paths,parser,loader}.rs`）:**
- 根 `CODEBUFF_DATA_DIR`（默认三通道 `~/.config/{manicode,manicode-dev,manicode-staging}`），每根拼 `projects`（根本身名为 `projects` 则不拼），递归 `.json` 过滤文件名恰为 `chat-messages.json`。
- **整文件一个 JSON 数组**；元素非对象跳过；assistant 判定 `variant` 优先于 `role`，值 ∈ `{"ai","agent","assistant"}`。
- usage 抽取按序 `merge_fallback`（各字段为 0 才被覆盖）：`metadata.usage` → `metadata.codebuff.usage` → `metadata.runState.sessionState.mainAgentState.messageHistory`(倒序)中 assistant 的 `providerOptions.usage`/`providerOptions.codebuff.usage`；键名多别名；cacheRead 取两别名 max。
- 模型 `metadata.model` → usage 内 `model` → `codebuff-unknown`；时间戳 `message.timestamp`→`createdAt`→`metadata.timestamp`→chat 目录名当 ISO→文件 mtime→`UNIX_EPOCH`；数字 <1e10 视为秒×1000。
- 有效条目 = 四类 token 或 credits 非全 0；**强制 `CostMode::Calculate`**；计费 output += extra；候选 = model，若 cost==0 且 provider≠unknown 且未带 `provider/` 前缀再加 `<provider>/<model>`。
- `session_id = {channel}/{project}/{chatId}`（逐级 `unknown`，channel 兜底 `manicode`）。
- 去重：文件路径 sort 后按序入 map **后写覆盖**（last-wins）；键 `message.id` 优先，否则 `codebuff:{session}:{ts}:{model}:{ordinal}:{tokens}`。
- `credits` 仅 >0 输出。

- [ ] **Step 1: 写失败测试**：`TestCodebuffFallsBackThroughUsageSources`、`TestCodebuffSessionIDFromChannelProjectChat`、`TestCodebuffDedupLastWinsByIdThenOrdinal`、`TestCodebuffCreditsOnlyWhenPositive`、`TestCodebuffUnixEpochFallback`。
- [ ] **Step 2–5**：确认失败 → 实现 → 通过 → Commit `feat(adapters): port the codebuff tool adapter`。

---

### Task 5: gemini 适配器

**Files:** Create `tools/gemini.go`、`tools/gemini_test.go`

**精确规则（`adapters/gemini/src/{paths,parser,loader}.rs`）:**
- 根 `GEMINI_DATA_DIR`（默认 `~/.gemini/tmp`），每根递归 `.json` + `.jsonl`（**不按 `chats/` 过滤**），sort+dedup。
- 同一 `GeminiRecord` 判 JSON 与 JSONL：JSONL 逐行状态机（`sessionId`/`session_id` 更新当前 session，初值=文件 stem；`model` 同理；`type=="gemini"` 走 direct event，有 `id` 则同文件原位替换，否则追加；否则 `stats`（顶层或 `result.stats`）展开）；JSON 文件（`messages[]` 只收 `type=="gemini"` 且共用一个会话级时间戳 `startTime→lastUpdated→mtime`；否则顶层 `type=="gemini"` 单事件；否则 `stats`）。
- token 别名（允许浮点，`max(0).trunc()`）：input/output/cached/thoughts/tool/total 各一组；缓存分离两套（direct 用启发式 `normalize_session_input`，stats 恒 `input -= min(input,cached)`）；之后 `input += tool`。
- 时间戳必须过严格长度门，否则回退 mtime（缺则 1970）；模型空 → 丢；`ApplyTotalFallback(usage, thoughts, total)` 后全 0 → 丢。
- 成本：`--mode display`→0；否则定价表；候选 `google/<m>`、`gemini/<m>`、`vertex_ai/<m>`、`openrouter/google/<m>`、裸 `<m>`，首个 `find` 命中；计价 output = output + reasoning。
- 去重：**仅** JSONL 文件内按 `id` 原位替换；跨文件不去重。

- [ ] **Step 1: 写失败测试**：`TestGeminiJSONLStateMachineInheritsSessionAndModel`、`TestGeminiJSONMessagesShareSessionTimestamp`、`TestGeminiStatsPathNormalizesCachedIntoInput`、`TestGeminiDirectEventSubtractsToolFromCachedHeuristic`、`TestGeminiModelCandidatesFirstMatchWins`、`TestGeminiBadTimestampFallsBackToMtime`。
- [ ] **Step 2–5**：确认失败 → 实现 → 通过 → Commit `feat(adapters): port the gemini tool adapter`。

---

### Task 6: kimi 适配器

**Files:** Create `tools/kimi.go`、`tools/kimi_test.go`

**精确规则（`adapters/kimi/src/{paths,parser,loader}.rs`）:**
- 根 `KIMI_DATA_DIR`（默认 `~/.kimi` + `~/.kimi-code`），仅在 `<root>/sessions` 下递归 `.jsonl` 且文件名必须 `wire.jsonl`，相对 `sessions` 的普通组件数必须 **3** 或 **5**。
- 模型来自 `<root>/config.json` 的 `model`（坏文件→`kimi-for-coding`），root 按 wire 路径深度反推。
- 两种行：旧 `message.type=="StatusUpdate"`（`message.payload.token_usage{input_other,output,input_cache_creation,input_cache_read,total}`，时间 f64 秒×1000）；新 `type=="usage.record"` 且 `usageScope=="turn"`（`session` 丢弃），时间 i64 直接毫秒，模型 strip `kimi-code/`。
- 成本：display→0；否则定价表；候选：模型==`kimi-for-coding` 时先插时间戳切换的 `moonshot/kimi-k2.5`（<1776698890072）/`moonshot/kimi-k2.6`，再 `moonshot/<m>`、`kimi/<m>`、裸；**展示名不变**。
- `session_id` = 所在目录名（新布局取 `agents` 祖父），空→`unknown`。
- 去重九元组 `session:message_id:ts:model:input:output:cc:cr:extra` first-wins。

- [ ] **Step 1: 写失败测试**：`TestKimiWireDepthAcceptance`、`TestKimiOldStatusUpdateMapping`、`TestKimiNewUsageRecordSkipsSessionScope`、`TestKimiModelK25K26TimeSwitchKeepsDisplayName`、`TestKimiConfigRootDerivedFromDepth`。
- [ ] **Step 2–5**：确认失败 → 实现 → 通过 → Commit `feat(adapters): port the kimi tool adapter`。

---

### Task 7: qwen 适配器

**Files:** Create `tools/qwen.go`、`tools/qwen_test.go`

**精确规则（`adapters/qwen/src/{paths,parser,loader,report}.rs`）:**
- 根 `QWEN_DATA_DIR`（默认 `~/.qwen`），`<root>/projects` 递归 `.jsonl`，**只保留 `<root>/projects/<project>/chats/<file>.jsonl`** 三段式。
- 仅 `type=="assistant"` 且有 `usageMetadata`；`promptTokenCount→input`、`candidatesTokenCount→output`、`thoughtsTokenCount→extra`、`cachedContentTokenCount→cacheRead`、`totalTokenCount→`回填；`cacheCreation=0`。
- 时间戳 `timestamp`（严格）否则 mtime；模型缺省 `unknown`；`sessionId` 缺省 `{project}-{file_stem}`；项目名从路径窗口取，失败 `unknown`。
- **`costUsd` 恒 None**（display 不加载定价表）；定价候选 `model`→`qwen/{model}`→`alibaba/{model}`。
- 去重：`entry_id` = 数组 `[session,timestamp,model,input,output,cacheRead,extra]` 的字符串，跨文件 first-wins（文件已排序）。
- **报表特例**：空集时 `totals` 为 **`null`**（`report.rs:11-20`，四者中唯一）。
- **session 分支不过滤 entry，改按 `lastActivity` 过滤**（`lib.rs:53-67`）。

- [ ] **Step 1: 写失败测试**：`TestQwenOnlyThreeSegmentChatPath`、`TestQwenCostAlwaysUnavailable`、`TestQwenEmptyTotalsIsNull`、`TestQwenSessionFilterUsesLastActivity`、`TestQwenProjectAndSessionDefaults`。
- [ ] **Step 2–5**：确认失败 → 实现 → 通过 → Commit `feat(adapters): port the qwen tool adapter`。

---

### Task 8: nativepricing 扩展（`find_exact_with_fallback` + builtin limits + missingPricing 门）

**Files:** Modify `clients/go/internal/nativepricing/find.go`、`builtin.go`、`cost.go`；Create/Modify 测试

**精确规则:**
- `FindExactWithFallback(model string) (CorpusModel, bool)`（`pricing.rs:1496-1533`）：**无 fuzzy、无 alias、无分隔符前缀匹配**；顺序：主表精确 → exact-only id 重拼 → 规范化键索引（`normalizePricingKey` 仅换 `.`/`@`→`-`）→（offline 关闭时 models.dev live）→ 内嵌 models.dev 精确/规范化；同拼写歧义 → None。仅 hermes 用（kilo 用 `FindExact`）。
- builtin context limits 三档（`builtin.go:27-35` 的 TODO，spec 要求补齐）：ccusage 三档 limit 不被 `Corpus.ContextLimits` 单表压平。
- `missingPricing` 零 token 门（`cost.go:122-126`）：适配器须补空 usage 例外与别名解析后的诊断文案；统一上提到 `nativepricing` 的辅助函数或由各工具适配器在共享层调用同一函数。

- [ ] **Step 1: 写失败测试**：`TestFindExactWithFallbackNormalizesDotsAndAt`、`TestFindExactWithFallbackNoFuzzy`、`TestFindExactWithFallbackAmbiguousSpellingMisses`、`TestFindExactWithFallbackExactOnlyID`、`TestBuiltinContextLimitsThreeTiers`、`TestMissingPricingQuietOnEmptyUsage`。
- [ ] **Step 2: 运行确认失败**（编译失败）。
- [ ] **Step 3: 实现**。
- [ ] **Step 4: 运行确认通过**：`go test ./internal/nativepricing/ -count=1` 全绿；S1 金样本不漂移（`node clients/go/scripts/gen-native-pricing-goldens.mjs --check` 若存在）。
- [ ] **Step 5: Commit**：`feat(nativepricing): port find_exact_with_fallback and the builtin context limits`

---

### Task 9: hermes 适配器（SQLite）

**Files:** Create `tools/hermes.go`、`tools/hermes_test.go`

**精确规则（`adapters/hermes/src/{paths,parser,loader}.rs`）:** 根 `HERMES_HOME`（默认 `~/.hermes`），每根 `state.db`（`is_file`）。SQL `SELECT id,model,billing_provider,started_at,message_count,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,reasoning_tokens,estimated_cost_usd,actual_cost_usd FROM sessions WHERE model IS NOT NULL AND TRIM(model) != ''`。映射 `cache_write→cacheCreation`、`cache_read→cacheRead`、`reasoning→extra`；`session_id`/`model` trim 空 → 丢。数值宽读（先 i64 负数截 0，再 f64 取 >0 trunc）。时间 `started_at` f64，>1e12 毫秒否则 ×1000，必须 >0。`cost_usd = max(0,actual).or(max(0,estimated))`，>0 采信否则计算（`Calculate`，计价 output+reasoning）。候选：`provider != "hermes"` 且 `FindExactWithFallback("{provider}/{model}")` 命中 → 先 `provider/model` 再裸。去重按 session_id 跨库 first-wins。`messageCount` 汇总进 JSON。**区间/时间戳双读 SQLite 列类型**（`read_u64` 先 i64 后 f64）。

- [ ] **Step 1: 写失败测试**（含建库 fixture）：`TestHermesActualCostBeatsEstimatedWhenPositive`、`TestHermesZeroReportedCostFallsBackToPricing`、`TestHermesReasoningEntersExtraAndBillingOutput`、`TestHermesProviderCandidateNeedsExactFallbackHit`、`TestHermesDedupAcrossDatabasesBySessionID`、`TestHermesReportedCostColumnReadsIntegerOrReal`。
- [ ] **Step 2–5**：确认失败 → 实现 → 通过 → Commit `feat(adapters): port the hermes tool adapter`。

---

### Task 10: goose 适配器（SQLite）

**Files:** Create `tools/goose.go`、`tools/goose_test.go`

**精确规则（`adapters/goose/src/{paths,parser,loader}.rs`）:** 根 `GOOSE_PATH_ROOT`（空串退回默认）→ `$ROOT/data/sessions/sessions.db`；默认三候选（`~/.local/share/goose`、`~/Library/Application Support/goose`、`~/.local/share/Block/goose`），canonicalize 去重。SQL 取 `id,model_config_json,provider_name,created_at,total_tokens,input_tokens,output_tokens,accumulated_*`。token 优先级 `accumulated_input→input`、`accumulated_output→output`、`accumulated_total→total→in+out`，**读取必须 >0 否则换列**；三全 0 丢；`reasoning = total-(in+out)` 饱和。模型 `model_config_json.model_name`（缺失/非串/空 → 丢）。时间 `created_at` String→i64 双读；整数（>1e12 ms，否则 ×1000）→ 严格 `parse_ts` → 19 字符补 T/Z 当 UTC → 10 字符日期补 `T00:00:00Z`。**强制 `Calculate`**；计价 output=`output+reasoning`；先裸 model，若 0 且 provider≠goose 再 `provider/model`。provider：有 `provider_name` 仅 `-`→`_`（**不小写**）；否则按前缀，`starts_with('o')` 一律 openai（会把 opus 判错），兜底 `goose`。去重键 `"{dbpath}:{session_id}"`（跨库**不**合并）。

- [ ] **Step 1: 写失败测试**：`TestGooseAccumulatedColumnsWinAndMustBePositive`、`TestGooseReasoningIsTotalMinusInputOutput`、`TestGooseCreatedAtStringOrIntegerAndDateOnlyFallback`、`TestGooseProviderInferenceOPrefixQuirk`、`TestGooseDedupKeyIncludesDbPath`。
- [ ] **Step 2–5**：确认失败 → 实现 → 通过 → Commit `feat(adapters): port the goose tool adapter`。

---

### Task 11: kilo 适配器（SQLite，逐条 message）

**Files:** Create `tools/kilo.go`、`tools/kilo_test.go`

**精确规则（`adapters/kilo/src/{paths,parser,loader}.rs`）:** 根 `KILO_DATA_DIR`（默认 `~/.local/share/kilo`），库 `<dir>/kilo.db`。SQL `SELECT id,session_id,data FROM message`，`data` JSON。仅 `role=="assistant"` 且有 `tokens`；`cache.read→cacheRead`、`cache.write→cacheCreation`；`ApplyTotalFallback(usage, reasoning, total)`；全 0 丢；`modelID` 必填；`time.created` 必填 `<=0` 丢、<1e12 秒×1000。`cost` 即自报 USD：**display** 采信（无则 0）、**auto** 有自报用否则算、**calculate** 强制算。计算时 output += extra；候选：provider 归一（仅 `-`→`_`，跳过 `unknown`/`kilo`）且 `FindExact("provider/model")` 命中才加 → 裸 model；用 `find` + `FindAt`。去重按 `data.message.id`（否则 `{dbpath}:{row_id}`）跨库 first-wins。

- [ ] **Step 1: 写失败测试**：`TestKiloCostModeThreeStates`、`TestKiloCacheObjectLenientWhenNotObject`、`TestKiloTimestampSecondsVsMillisHeuristic`、`TestKiloProviderCandidateRequiresFindExact`、`TestKiloDedupAcrossDatabasesByMessageID`。
- [ ] **Step 2–5**：确认失败 → 实现 → 通过 → Commit `feat(adapters): port the kilo tool adapter`。

---

### Task 12: zcode 适配器（SQLite，动态 schema）

**Files:** Create `tools/zcode.go`、`tools/zcode_test.go`

**精确规则（`adapters/zcode/src/{paths,parser,loader}.rs`）:** 根 `ZCODE_HOME`（逗号多根；**非空但无效的根不回退默认**），库 `<root>/cli/db/db.sqlite`。表 `model_usage` 必需列 `id,session_id,started_at,model_id,status,input_tokens,output_tokens`；`session` 必需 `id,directory`；可选 `cache_creation_input_tokens,cache_read_input_tokens,computed_total_tokens,provider_id,session.version`；缺必需列 → 整库跳过。SQL `... FROM model_usage m LEFT JOIN session s ON s.id=m.session_id WHERE m.status='completed'`；只读 + `busy_timeout=5000` + `query_only=ON`，**不改 journal_mode**。token：`cache_read=min(cr,input)`、`cache_creation=min(cc,input-cache_read)`、fresh `input = input-cache_read-cache_creation`；`computed_total_tokens` 缺列退化为 `input+output`，多余进 extra。**`costUsd` 恒 None**；display→0；候选 `raw`、`raw` 小写，Z.ai provider（或 provider 缺失且 GLM 模型）再加 `zai/{raw}`、`zai/{lower}`；**未知自定义 provider 不当作 Z.ai**。Z.ai 的 cache-creation 展示保留桶但计价并入 input。`projectPath = session.directory`（空→`ZCode`），`version = session.version`。去重按 `model_usage.id` 跨库 first-wins。

- [ ] **Step 1: 写失败测试**：`TestZcodeFreshInputSubtractsCache`, `TestZcodeMissingRequiredColumnSkipsDatabase`、`TestZcodeComputedTotalFallsBackToInputPlusOutput`、`TestZcodeUnknownProviderIsNotZai`、`TestZcodeOpensReadOnlyWithoutChangingJournalMode`、`TestZcodeDedupAcrossDatabasesByModelUsageID`。
- [ ] **Step 2–5**：确认失败 → 实现 → 通过 → Commit `feat(adapters): port the zcode tool adapter`。

---

### Task 13: openclaw 适配器（JSONL + SQLite）

**Files:** Create `tools/openclaw.go`、`tools/openclaw_test.go`

**精确规则（`adapters/openclaw/src/{paths,parser,loader,sqlite}.rs`）:** 根优先级 `--open-claw-path` > `OPENCLAW_DIR` > 默认四根 `~/.openclaw|~/.clawdbot|~/.moltbot|~/.moldbot`。递归收 `.jsonl` / `.jsonl.deleted.*` / `.jsonl.reset.*`，跳 symlink，排序；另读 `<root>/agents/*/agent/openclaw-agent.sqlite`（只读，需 `transcript_events` 表）。解析：`type=="model_change"` 或 `custom+model-snapshot` 更新当前 model/provider；`message`+`role=="assistant"`+`usage` 才计费；`usage.cost.total` 即自报 `cost_usd`。时间 `message.timestamp` 优先于根 `timestamp`，整数/无符号/浮点毫秒或 RFC3339，失败回退 mtime。**展示名 `[openclaw] {model}`；定价名：若定价表精确含 `[openclaw] model` 用它，否则裸 model**。`extra = max(totalTokens, 桶和)-桶和`。去重 `migration_id:cost`，`migration_id = openclaw:session:ts:model:input:output:cc:cr:extra`；SQLite 行与 JSONL 同 `(session_id,message.id)` 或同 `migration_id` 则**替换**（保留服务商计费成本）。

- [ ] **Step 1: 写失败测试**：`TestOpenclawDisplayNamePrefixedPricingNameBare`、`TestOpenclawModelChangeUpdatesState`、`TestOpenclawSqliteReplacesJsonlBySessionAndMessage`、`TestOpenclawExtraIsMaxTotalMinusBuckets`、`TestOpenclawTimestampScalarOrRFC3339ThenMtime`。
- [ ] **Step 2–5**：确认失败 → 实现 → 通过 → Commit `feat(adapters): port the openclaw tool adapter`。

---

### Task 14: Provider 重接线 + 内部开关

**Files:** Modify `clients/go/internal/collect/providers/ccusagetool/ccusagetool.go`、Create `providers/ccusagetool/native.go`、`native_test.go`、Modify `register.go`（若有）

**精确规则:** 照抄 codex `native.go` 模式：`const useNativeTools = false`；`nativeCollect(ctx, options)` 置 `useNativeReport=true` 再走既有管线；`nativeReportRunner.Run` 实现 `ccusage.CommandRunner`，把 `TimeoutMs` 换 `context.WithTimeout`（S3 Important 4 做法），解析 `[<tool>, daily|session, "--json", …]`，按 `contract.CcusageToolCommand(source)` 选适配器（含 `gemini-cli→gemini`），产出报表 JSON，JSON 往返（`json.Marshal` → `ccusage.DecodeJSON`）。12 源逐源 `collect.RegisterNative`（无条件）。开关默认 ccusage，native 永不回落。`--since/--until` 只对 claude/codex 生效是既有契约；工具族窗口透传给适配器。

- [ ] **Step 1: 写失败测试**：`TestRegisterNativeAlwaysInstallsAllTwelveToolProviders`、`TestUseNativeToolsDefaultsToTheCcusagePath`、`TestNativeToolCollectMatchesNormalizePipeline`（每源一子测，用合成夹具）、`TestNativeToolRunnerMapsGeminiCLIToGeminiCommand`、`TestNativeToolRunnerHonoursTimeout`。
- [ ] **Step 2: 运行确认失败**。
- [ ] **Step 3: 实现**。
- [ ] **Step 4: 运行确认通过**：`go test ./internal/collect/providers/ccusagetool/ -count=1` 全绿（含既有 12 源测试）。
- [ ] **Step 5: Commit**：`feat(tools): wire the native adapters behind an internal switch`

---

### Task 15: 行级金样本 + CI 门禁 + 真机证据

**Files:** Create `clients/go/scripts/gen-tool-goldens.mjs`、`clients/go/internal/collect/adapters/tools/goldens/tool-reports.json`、`tools/goldens_test.go`；Modify `clients/go/scripts/check-deps.sh`、`.github/workflows/go-client.yml`；Create `docs/research/2026-11-XX-tools-native-parity.md`

**精确规则:**
- 生成器（对称 `gen-claude-goldens.mjs`）：每源一个合成夹具树（覆盖该源两条路径/去重/成本模式/边界），spawn `ccusage <cmd> {daily,session} --json --offline --single-thread -z UTC -s … -u …`，env 经 `child-env.mjs` 剥凭据、`<TOOL>_DATA_DIR` 指向夹具；断言 `ccusage --version`=20.0.33；不传 `--config`（与 claude 金样本同口径）。字节稳定（两次运行一致）。
- `goldens_test.go` 逐源逐形状比对（严格，无豁免表）。
- `check-deps.sh` 增 `node clients/go/scripts/gen-tool-goldens.mjs --check`（只读门禁，内存重 mint 逐字节比对）。
- CI `native-pricing` job 加 `go test ./internal/collect/adapters/tools/... ./internal/collect/providers/ccusagetool/... -race -count=1`；arm64 FMADDD 步骤加 `./internal/collect/adapters/tools`。
- 真机 evidence：本机有真实数据的来源（amp 1.7M、kimi 4.8M、zcode 794M）跑 `cmd/parity -source <tool>` 固定窗口要求 all match；无数据的来源标注 N/A。
- 翻转 `useNativeTools=true` 是独立提交，仅当 parity 全 match 且金样本全绿。

- [ ] **Step 1: 写夹具与生成脚本；生成金样本并提交**（用 `~/.tokenboard/bin/ccusage` 20.0.33）。
- [ ] **Step 2: 写 `goldens_test.go`，运行 → FAIL。**
- [ ] **Step 3: 接上 `nativeCollect` 后运行 → PASS。**
- [ ] **Step 4: 二次运行生成器确认字节稳定（`git diff` 无变化）。**
- [ ] **Step 5: Commit**：`test(adapters): freeze the twelve tool-source row-level goldens`

---

## 完成标准（S4a 出口）

1. `go test ./... -race`、`go vet ./...`、`gofmt -l .`、六目标交叉构建全绿。
2. 12 源行级金样本（daily + session）全绿，生成器可复现。
3. `cmd/parity -source <tool>` 在真机有数据的来源固定窗口全 `match`；无数据来源标注 N/A。
4. `useNativeTools` 保持 `false` 直至证据齐备；翻转是独立提交。
5. `docs/research/` 报告记录每源命令、窗口、结果与未覆盖边界（含 copilot 指向 S4b、各源无 sessionCount 的口径说明）。
