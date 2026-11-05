# S2: Claude Code 原生适配器 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用纯 Go 原生实现替换 claude-code 来源对 ccusage 的调用——读取 Claude Code 本地 JSONL，复刻 ccusage v20.0.33 的解析/去重/成本语义，产出与 `claude daily --json --breakdown` / `claude session --json` **同形状的报告 JSON**，经现有 `ccusage.NormalizeCcusageDailyJSON` 转成 `contract.Snapshot`。

**Architecture:** 新增 `internal/collect/adapters/claude`（发现 / 行解析 / 去重 / 聚合 / 报表 JSON），成本走 S1 的 `internal/nativepricing`（冻结语料 + `pricing.Prepare` 的服务端 override）。`providers/claudecode` 同时保留 ccusage 旧路径与原生路径，用**未导出**的内部开关选择，默认仍指向 ccusage；只有 parity 全绿后另起独立提交翻转。原生 provider 无条件注册进 `collect.RegisterNative`，使 `cmd/parity`/`bench-collect` 始终能对比原生实现。行级金样本由 ccusage 20.0.33 对固定夹具树一次性生成并提交，CI 只跑 native 比对。

**Tech Stack:** Go 1.27、`encoding/json`（流式行解析）、`internal/nativepricing`、`internal/collect/{sessionwalk,sessionscan,sessioncursor,sessionusage}`、`internal/jsdate`、`time.LoadLocation`。

**Spec:** `docs/superpowers/specs/2026-11-03-native-usage-sources-design.md`（§6.1.1 产出边界、§6.1.3 hook 双源和解、§7 Claude Code 语义、§8 金样本阻塞项、§10.1 回滚设计）

**语义事实来源（实现时必须对照）:** ccusage v20.0.33 @ `1308c416`，`rust/adapters/claude/src/{paths,lib,daily}.rs` 与 `rust/crates/ccusage-core/src/{types,cost,date_utils}.rs`。下列任务里每条规则都附该版本的 `file:line`。

## Global Constraints

- 语义冻结在 ccusage **v20.0.33**（commit `1308c416`）；派生规则在注释里注明 `file:line`。
- 适配器产出 **ccusage 报表形状的 JSON**（`daily[]`+`modelBreakdowns[]`、`sessions[]`），不是 `contract.Snapshot`，由 `ccusage.NormalizeCcusageDailyJSON` 转换（§6.1.1）。
- 成本只用 `internal/nativepricing`：`Cost(corpus, model, usage, at, ModeAuto|ModeCalculate, fast, false)`；override 来自 `pricing.Prepare(...).Overrides`，经 `nativepricing.WithOverrides` 合并。**hook 模式不得联网**。
- 不改 `internal/contract`、`packages/usage-core` 的既有语义；不改 S1 已冻结的 `internal/nativepricing` 行为（可加导出，不改语义）。
- 过渡开关**不是用户可见环境变量**（§10.1）：包内未导出常量，默认 ccusage，翻转是独立提交。
- 只投影 token/model/timestamp/会话标识；不得读取或保存 prompt/completion/正文。
- 时间戳解析**按长度门**（20/24/25/29），不得用 `time.RFC3339` 宽松解析；日期归属用配置时区。
- 排序必须稳定（`sort.SliceStable`），成本比较用 total-order（`math.Float64bits`），不用 `<`。
- 三平台（darwin/linux/windows × amd64/arm64）构建通过；`gofmt`/`go vet` 干净；`go test -race` 通过。

## Review Focus

1. **同一消息多文件/多次重放**（sidechain replay、跨会话副本、fork）只计一次；Task 3 的去重键与两级 sidechain 桶测试。
2. **缺 `request_id` / 非 `msg_` 前缀**的合并边界；Task 3 的键构造测试。
3. **`<synthetic>` / `advisor_message` / `-fast`**；Task 2/4 的模型处理测试。
4. **跨时区/跨日边界**；Task 2 的日期归属测试。
5. **空窗口**返回 0 行而非错误，且 0 行不得被当作覆盖；Task 6/8 的空窗口测试。

---

### Task 1: 包骨架 + 根解析 + 文件发现/剪枝 + 会话分组

**Files:**
- Create: `clients/go/internal/collect/adapters/claude/paths.go`
- Create: `clients/go/internal/collect/adapters/claude/paths_test.go`

**Interfaces:**
- Produces: `type Roots struct{ Dirs []string }`; `ResolveRoots(env func(string) string, homeDir string) (Roots, error)`; `type SessionFile struct{ Path, SessionID, ProjectPath string; MTime time.Time; MTimeKnown bool }`; `ScanFiles(roots Roots, projectFilter string) ([]SessionFile, error)`; `PruneByMTime(files []SessionFile, sinceDate string, timezone string, now time.Time, pruned func(string)) ([]SessionFile, error)`; `PathSessionParts(path string) (sessionID, projectPath string)`。

**精确规则（必须照抄）:**
- 根解析（`paths.rs:23-55`）：`CLAUDE_CONFIG_DIR` 按 `,` 切分、`Trim`、丢空；每项展开 `~`（`path_utils.rs:3-15`）；若末段是 `projects` 且是目录则取父目录；仅保留 `<root>/projects` 为目录的项；**设置了但无一有效 → 硬错误**（`paths.rs:40-42`），不回退。未设置时：`$XDG_CONFIG_HOME`（缺省 `$HOME/.config`）下的 `claude` 与 `$HOME/.claude`，各自仅当有 `projects/` 目录时保留（`paths.rs:45-53`）。
- TokenBoard 适配：provider 传入已解析的 Claude home（沿用 `readClaudeHome`：`CLAUDE_CONFIG_DIR`→`CLAUDE_HOME`→`~/.claude`）；`ResolveRoots` 收到显式 home 时把它当作 `CLAUDE_CONFIG_DIR` 的等价输入（单目录）。这一点在 Task 7 的 parity 中以真机配置验证。
- 扫描（`paths.rs:65-79`、`common/src/lib.rs:14-46`）：递归 `*.jsonl`，**不限深度、不跟随 symlink**（`file_type()`），结果按完整路径字符串排序（`paths.rs:77`）——这个顺序决定去重结果。
- `--project` 仅当是合法路径段（非空、非 `.`/`..`、不含 `/` `\`）时当目录捷径，否则全扫后按 entry 的 project 过滤（`paths.rs:69-75,248-254`）。
- `--since` 剪枝（`paths.rs:84,117-172`）：`MTIME_PRUNE_MARGIN_MS = 1 天`；只对 `--since` 生效；`threshold = since_ms - 1天`；文件 live ⇔ `mtime >= threshold` 或 mtime 不可读；**会话组**用并查集：文件以其路径推导的 session id 与文件内**第一条** `sessionId` 值合并；组内任一文件 live 则整组保留。`--until` 不剪枝。
- 目录布局（`paths.rs:269-331`）：`relative` = `projects` 之后的段；`len==2 && 末段 X.jsonl` → session=X、project=relative[0]；`len>=4 && 倒数第二段=="subagents"` → session=relative[len-3]、project=relative[:len-3] 以 `MAIN_SEPARATOR` 连接；否则 session=relative[len-2]、project=relative[:len-2]（缺省 `"unknown"` / `"Unknown Project"`）。`projects/p/sess/subagents/workflows/wf_1/a.jsonl` → session `wf_1`、project `p/sess/subagents/workflows`（**不得**并入 subagents 分支）。

- [ ] **Step 1: 写失败测试**（`paths_test.go`）：`TestResolveRootsUsesConfigDirListAndRejectsAllInvalid`（逗号列表、`~` 展开、末段 `projects` 取父、全无效硬错误不回退）；`TestResolveRootsFallsBackToXdgAndHome`；`TestScanFilesSortsByFullPathAndSkipsSymlinks`；`TestPruneByMTimeKeepsWholeSessionGroup`（兄弟文件旧、其一新 → 全保留）；`TestPruneByMTimeIgnoresUntil`；`TestPathSessionParts`（4 个形状，含 workflows 反例）。
- [ ] **Step 2: 运行确认失败**：`cd clients/go && go test ./internal/collect/adapters/claude/ -run 'TestResolveRoots|TestScanFiles|TestPruneByMTime|TestPathSessionParts' -v` → 编译失败（未实现）。
- [ ] **Step 3: 实现** `paths.go`（上述签名与规则；文件遍历复用 `sessionscan`/`os.ReadDir`，symlink 用 `entry.Type()` 判定；并查集路径压缩）。
- [ ] **Step 4: 运行确认通过**：同上命令 → PASS。
- [ ] **Step 5: Commit**：`feat(adapters): add the Claude session file discovery and pruning layer`

---

### Task 2: 行解析与校验（含模型处理与 advisor 拆分）

**Files:**
- Create: `clients/go/internal/collect/adapters/claude/entry.go`
- Create: `clients/go/internal/collect/adapters/claude/entry_test.go`

**Interfaces:**
- Produces: `type Usage struct{ Input, Output, CacheCreate5m, CacheCreate1h, CacheRead int64; HasCacheCreate bool; ReportedCost *float64; Speed string; Fast bool }`；`type Entry struct{ MessageID, RequestID, SessionID, Model string; Timestamp time.Time; Sidechain bool; IsSynthetic bool; ProjectPath string; Usage Usage }`；**权威（多条目）解析接口**：`ParseLineEntries(line string) []Entry`（session/entry 链，父条目在前、随后是每个 advisor 行；空切片=丢弃）与 `ParseDailyLineEntries(line string) []Entry`（daily 链，额外接受 AgentProgress 包装）；`ParseLine(line string) (Entry, bool)` / `ParseDailyLine(line string) (Entry, bool)` 仅作「只取父条目」的便捷包装（**会丢弃 advisor 行**，collector 两条链都不得使用）；`validSemverPrefix(s string) bool`；`ParseTimestamp(s string) (time.Time, bool)`。
- 说明：ccusage 的 entry loader 与 daily loader **都会**拆分 advisor iterations（`lib.rs:559-598` 是 `claude session` 走的 loader；`daily.rs:368-398` 是 daily 的），所以两条链都必须消费多条目形式，否则 advisor 用量在两个报表里都会被少计。AgentProgress 包装行例外：上游 advisor 拆分解析的是原始行的**顶层** `message`（`daily.rs:368`），包装行没有顶层 `message`，因此只产出父条目。

**精确规则:**
- 预过滤：行必须包含**逐字节** `"usage":{`（`lib.rs:509-512`、`daily.rs:302-305`）——`"usage": {` 要被丢弃。
- `null` 黑名单（`lib.rs:727-736,832-886`）：仅当行含 `null` 字面量时才深扫；字段名 `id,cwd,model,speed,costUSD,version,sessionId,requestId,isApiErrorMessage,cache_read_input_tokens,cache_creation_input_tokens` 在**任意深度**为 null → 丢行；唯一豁免：`message.usage.iterations[]` / `data.message.message.usage.iterations[]` 里的 `model`。重复 JSON 键 → 丢行。
- 必需字段：`timestamp`、`message`、usage 内 `input_tokens`/`output_tokens`（缺失 → 丢行）。
- 跳过（`lib.rs:668-707`）：`version` 存在但不是 semver 前缀（`\d+\.\d+\.\d` 前缀，`lib.rs:888-908`）；`sessionId`/`requestId`/`message.id`/`message.model` 为空字符串。
- 时间戳（`date_utils.rs:111-161`）：只接受长度 20/24/25/29；毫秒必须恰 3 位；偏移只接受 `Z` 或 `±HH:MM`（h≤23,m≤59）。其他一律丢行。
- token：`cache_creation` 存在时 `cacheCreate5m/1h` 取 `ephemeral_*`（`types.rs:41-50`），平面 `cache_creation_input_tokens` 被忽略；否则用平面值记入 5m、1h=0。`speed` 只接受 `standard|fast`，其他字符串 → 丢行（`types.rs:60-65`）。
- 模型（`lib.rs:535-543`）：`<synthetic>` → `IsSynthetic=true`（token 计入总量、不进 breakdown、不定价）；`fast` → `Fast=true`，显示名加 `-fast` 由 Task 4 处理，定价用**原始**模型名。显示名还要再过 `resolve_model_name`（`CCUSAGE_MODEL_ALIASES`，`model_aliases.rs:16-30`；`-fast` 后缀对基础模型查别名后再拼回）——本仓库生产路径从不设该变量（实测为空），实现须支持但默认恒等，不能省略这一步当作差异。
- advisor（`lib.rs:559-598,635-658`、`daily.rs:368-398`）：行内出现 `advisor_message` 时，`message.usage.iterations[]` 中 `type=="advisor_message"` 且 `model` 非空的项各生成一条独立 Entry：`MessageID = "<父id>:advisor:<index>"`、`RequestID` 继承父、`Sidechain`/`SessionID`/`Timestamp` 继承、`ReportedCost=nil`、usage 取该 iteration。
- `ParseDailyLineEntries`（以及只取父条目的 `ParseDailyLine`）额外接受 `{"sessionId","data":{"message":{...}}}` 包装（`daily.rs:182-227`），且该路径 `version` 视为缺失。

- [ ] **Step 1: 写失败测试**：表驱动：`TestParseLineRejectsUsageWithSpace`、`TestParseLineNullBlacklistAnyDepth`（含 iterations.model 豁免）、`TestParseLineDuplicateKeysDropped`、`TestParseLineSkipsInvalidVersionAndEmptyIDs`、`TestParseTimestampLengthGate`（1/2/6 位小数、无时区、`v1.2.3` 全拒）、`TestCacheCreationBreakdownWinsOverFlat`、`TestCacheCreationEphemeralFieldsAreU64`（负数/小数/null 的 `ephemeral_*` 必须丢整行）、`TestSyntheticAndFastModelFlags`、`TestAdvisorIterationsBecomeSeparateEntries`、`TestBothEntriesFormsReturnParentAndAdvisorRows`（session 与 daily 两条链都产出父条目 + advisor 行）、`TestBothEntriesFormsRejectTheSameLines`（两条 Entries 链共用同一套校验与清理，被拒行在两条链上都返回空）、`TestParseDailyLineAcceptsAgentProgressWrapper`。
- [ ] **Step 2: 运行确认失败**；**Step 3: 实现** `entry.go`；**Step 4: 运行通过**。
- [ ] **Step 5: Commit**：`feat(adapters): port the Claude line parser and its validation gates`

---

### Task 3: 去重索引（entry 版与 daily 版）

**Files:**
- Create: `clients/go/internal/collect/adapters/claude/dedupe.go`
- Create: `clients/go/internal/collect/adapters/claude/dedupe_test.go`
- Modify: `clients/go/internal/collect/adapters/claude/entry.go`（只加字段与注释，不改解析行为）

**Interfaces:**
- Consumes: `Entry`，本任务新增三个字段（`entry.go`）：`PathSessionID string`（路径推导的 session id，Task 5 用 `PathSessionParts` 填；**去重用的 session 是** `SessionID` 非空则取 `SessionID`、否则取 `PathSessionID`——`lib.rs:405-411` 的 `loaded_entry_session_id`）、`Cost float64` 与 `MissingPricing bool`（该条目已算好的成本与缺价标记；**必须由调用方在 `Add` 前填好**，daily 替换第③级读 `Cost`，见下方顺序约束）。
- Produces: `type Dedupe struct{...}`; `func NewDedupe(mode DedupeMode) *Dedupe`（`DedupeEntry`/`DedupeDaily`）; `func (d *Dedupe) Add(entry Entry)`（内部决定替换/保留；**无 error 返回**——ccusage 的去重没有任何失败路径，留一个恒 nil 的 error 只会长出死代码）; `func (d *Dedupe) Entries() []Entry`（保留者，按首次出现顺序）。内部键类型必须是**结构体**：`struct{ MessageID, RequestID, SessionID string; TimestampMs int64 }` 加条件字段，不得用拼接字符串。

**精确规则:**
- 精确键（`lib.rs:350-375`）：总是含 `message_id`、`request_id`（缺省与空串区分：空串已在 Task 2 丢弃）；`request_id` 缺失时追加 `session_id`，且若 `message_id` 不以 `msg_` 开头再追加 `timestamp`。
- 两个 sidechain 桶（`lib.rs:377-392`）：`hash("sidechain-replay", mid, sid)` 对**每个有条目的 entry** 建索引；`hash("sidechain-replay-entry", mid, sid)` 只对 `isSidechain==true` 的 entry 建索引。候选是 sidechain 时查前者，候选不是时查后者。
- sidechain 匹配谓词（`lib.rs:427-440`）：`mid 相同 && (两侧都无 request_id 或 timestamp 相同) && (候选是 sidechain || 已存在者 isSidechain==true)`。**daily 变体**（`daily.rs:486-498`）去掉 timestamp 条件，只比 `mid`、**索引的 session id**、sidechain 条件。
- 替换优先级（`lib.rs:198-212`）：① sidechain 标记不同 → 已有者是 sidechain 则替换（非 sidechain 胜）；② 总 token 不同（`input+output+cache_create+cache_read`）→ 大者胜；③ **仅 daily** 插入在 ② 与 ④ 之间：`entry.Cost` 不同 → 大者胜（`daily.rs:582-601`）；④ 候选有 speed 而既有无 → 替换；⑤ 否则保留既有（first-seen）。
- **顺序约束**：ccusage 在 dedupe 之前就为每条 entry 算好 cost（`daily.rs:317-324`），所以 `Entry.Cost` 必须在 `Add` 前填好；本任务只读它，不负责计算（成本计算在 Task 4，接线在 Task 5）。
- 去重是**全局的**：单次 load 内跨所有文件、所有根；遍历顺序 = 文件排序序 + 行序（`lib.rs:170-182`）。
- 跨会话副本：同一 `mid` 在另一 session 存活时登记 `session_alias` 路由，使后续 replay 仍能命中存活者（`lib.rs:270-286,474-489`）。

- [ ] **Step 1: 写失败测试**：`TestDedupeKeyUsesRequestIDWhenPresent`、`TestDedupeKeyFallsBackToSessionAndTimestampOnlyForNonMsgIDs`、`TestDedupeMergesDuplicateAcrossFiles`、`TestSidechainReplayMergesOnNewRequestID`、`TestDailyDedupCostTieBreakBeatsSpeedRung`、`TestEntryDedupDoesNotUseCostRung`、`TestDailySidechainMatchIgnoresTimestampEntryMatchRequiresIt`、`TestDedupeIsOrderIndependentForTheSurvivorSet`（乱序输入同一集合 → 保留者集合一致）。
- [ ] **Step 2: 运行确认失败**；**Step 3: 实现**；**Step 4: 运行通过**。
- [ ] **Step 5: Commit**：`feat(adapters): port the Claude dedupe index with sidechain replay buckets`

---

### Task 4: 聚合与报表 JSON（daily + session），成本经 nativepricing

**Files:**
- Create: `clients/go/internal/collect/adapters/claude/cost.go`
- Create: `clients/go/internal/collect/adapters/claude/daily.go`
- Create: `clients/go/internal/collect/adapters/claude/session.go`
- Create: `clients/go/internal/collect/adapters/claude/report.go`
- Create: `clients/go/internal/collect/adapters/claude/cost_test.go`
- Create: `clients/go/internal/collect/adapters/claude/daily_test.go`
- Create: `clients/go/internal/collect/adapters/claude/session_test.go`

**Interfaces:**
- Produces: `func NewCostFunc(overrides map[string]any, mode CostMode) (CostFunc, error)`（错误来自 `WithOverrides` 的严格校验；调用方 fail-closed）；`type CostFunc func(model string, u Usage, at time.Time) (cost float64, missing bool)`；`func PopulateCosts(entries []Entry, cost CostFunc) []Entry`（去重**之前**逐条填 `Cost`/`MissingPricing`，复刻 `daily.rs:317-324` 的顺序）；`BuildDaily(entries []Entry, opts DailyOptions) []byte`；`BuildSessions(entries []Entry, opts SessionOptions) []byte`；`type DailyOptions struct{ Timezone string; Since, Until string }`；`type SessionOptions struct{ Timezone string; Since, Until string }`。两个 `[]byte` 都必须是可直接喂 `ccusage.DecodeJSON` 的 JSON。
- 输入 `entries`：`Cost`/`Fast`/`IsSynthetic` 已由调用方在去重前填好（成本**先于**去重，见 Task 3 的顺序约束），且已按文件排序序去重（Task 3 daily 模式）。builder 只做累加与排序，**不再重算成本**（重算会与去重的第③级比较口径分叉）。

**精确规则:**
- 分组（`daily.rs:112-145`）：无 `--instances/--project` 时按 `date`（BTreeMap 升序）；日期由 `FormatDate(timestamp, timezone)` 得（`lib.rs:524`）。按 `since/until` 过滤行（`summary.rs:291-305`）。
- 累加（`types.rs:77-96`、`daily.rs:617-644`）：input/output/cacheCreate(5m+1h)/cacheRead 饱和相加；`totalTokens = 四项之和`；**不做任何减法**（`inputTokens` 是未缓存部分，`cost.rs:139-142`）。`modelsUsed` 按首次出现顺序（`daily.rs:622-633`）。breakdowns 按 `cost` **降序稳定排序**（`f64::total_cmp`，`daily.rs:647`）；成本相同的保持首次顺序。
- 成本（`cost.rs:31-46,93-199`）：`display` = 自报值否则 0；`auto` = 自报值否则计算；`calculate` = 恒计算。`<synthetic>` 不进 breakdown。`fast` 时**整单成本**乘 `fast_multiplier`（`cost.rs:110-115`）。1h cache 按 `2×` 基础价（`cost.rs:7,128-131`），且 200k 以上档位同样 ×2。长上下文：有 `tiers` 阈值 → 整请求切档；否则 200k 边际（`cost.rs:143-198`）。缺价 → `missingPricing:true`，成本 0。
- 输出形状（`output.rs:27-121`）：`{"daily":[...], "totals":{...}}`；daily 行含 `date,inputTokens,outputTokens,cacheCreationTokens,cacheReadTokens,totalTokens,totalCost,modelsUsed,modelBreakdowns`；breakdown 含 `modelName,四个 token,cost`（`missingPricing` 仅 true 时出现）；totals 含五项 token、`totalCost`、`unpricedModels`（仅非空）。键序按字母序（serde_json 无 preserve_order）——**用 `map` 或有序结构生成后按字母序写出**，parity 测试按解析值比较。
- session（`summary.rs:125-170`、`commands/mod.rs:146-206`）：分组键 `(projectPath, sessionID)`（都来自**路径**，不是序列化 sessionId）；条目先按 `since/until` 过滤再分组；`input+output+cacheCreate+cacheRead==0` 的会话丢弃；`lastActivity`=最大时间戳、`firstActivity`=最小，格式 `2006-01-02T15:04:05.000Z`（UTC）；按 `totalCost` 降序；字段 `sessionId,inputTokens,…,totalCost,lastActivity,firstActivity,modelsUsed,modelBreakdowns,projectPath`。

- [ ] **Step 1: 写失败测试**：`TestBuildDailyGroupsByDateAndSortsBreakdownsByCostDesc`（成本相同保持首现序）、`TestDailyTotalsAndUnpricedModels`、`TestSyntheticEntriesCountTokensButNotBreakdown`、`TestFastMultipliesWholeModelCost`、`TestSessionRowsGroupByPathDerivedIDsAndDropZeroToken`、`TestLastActivityIsMaxTimestampInUTC`、`TestEmptyWindowEmitsEmptyArrays`。
- [ ] **Step 2: 运行确认失败**；**Step 3: 实现**；**Step 4: 运行通过**；**Step 5: Commit**：`feat(adapters): assemble the Claude daily and session reports`

---

### Task 5: 适配器 Collect 入口（读文件 / override / 日期过滤 / 空窗口）

**Files:**
- Create: `clients/go/internal/collect/adapters/claude/collect.go`
- Create: `clients/go/internal/collect/adapters/claude/collect_test.go`

**Interfaces:**
- Produces: `type Options struct{ Timezone, Since, Until string; Roots Roots; Overrides map[string]any; Mode CostMode; Stderr func(string) }`；`Collect(ctx context.Context, opts Options) (dailyJSON, sessionsJSON []byte, err error)`。`CostMode` 复用 `nativepricing.CostMode`（默认 `ModeAuto`）。
- **不得**直接产出 Snapshot；provider 负责 `ccusage.DecodeJSON` + `NormalizeCcusageDailyJSON`。

**行为:** 解析根 → 扫描 → `--since` 剪枝（`stderr` 报被剪组）→ 逐文件流式 `ParseDailyLineEntries`（daily 链）与 `ParseLineEntries`（session/entry 链）→ 各自去重 → 成本用 `nativepricing.LoadEmbeddedCorpus()` + `WithOverrides(opts.Overrides)`（**每条链内、去重之前**逐条 `PopulateCosts`）→ `BuildDaily`/`BuildSessions`。空窗口必须返回 `{"daily":[],"totals":{...}}` 形状而不是 nil/错误。`ctx` 取消要快速返回。

**逐行流式读取，不用 `os.ReadFile`**：claude 主目录可能有数 GB 的 transcript，ccusage 的整文件读取在 Go 侧是可控的内存风险。用 `bufio.Reader.ReadBytes('\n')`（`bufio.Scanner` 有 64KiB 行上限，不能用）。行切分语义对齐 `fast.rs:82-99`：以 `\n` 切、末行无换行也算一行、空文件零行。

**读取失败 fail-closed（有意偏差）**：ccusage 的 `let Ok(content) = fs::read(path) else { return empty }`（`lib.rs:507`、`daily.rs:300`）会静默跳过不可读文件；TokenBoard 的采集口径是「真实读取失败必须报错，禁止静默丢数据」（AGENTS.md），所以本实现返回 error。这条偏差必须写在代码注释里，并在 Task 6 的金样本夹具里避开不可读文件（金样本比较的是内容，不是错误路径）。

**两条链都必须消费多条目形式**：ccusage 的 entry loader 同样拆分 advisor iterations（`lib.rs:559-598`），父条目与 advisor 行都算用量，用只取父条目的 `ParseLine`/`ParseDailyLine` 会让 session 报表和 daily 报表同时少计（见 Task 2 的 Interfaces）。

- [ ] **Step 1: 写失败测试**：`TestCollectEmptyWindowReturnsEmptyReport`、`TestCollectAppliesOverridesToCost`、`TestCollectRespectsContextCancellation`、`TestCollectDailyAndSessionUseDifferentParsers`（AgentProgress 只影响 daily）。
- [ ] **Step 2: 运行确认失败**；**Step 3: 实现**；**Step 4: 运行通过**；**Step 5: Commit**：`feat(adapters): add the Claude collector entry point`

---

### Task 6: 行级金样本（ccusage 20.0.33）+ CI 比对

**Files:**
- Create: `clients/go/scripts/gen-claude-goldens.mjs`
- Create: `clients/go/internal/collect/adapters/claude/testdata/claude-fixture/`（夹具 JSONL 树）
- Create: `clients/go/internal/collect/adapters/claude/goldens/claude-reports.json`
- Create: `clients/go/internal/collect/adapters/claude/goldens_test.go`

**夹具必须覆盖（每条对应一个已知语义）：**
1. 同 `message_id+request_id` 在两文件重复 → 一条；
2. 无 `request_id` 的 `msg_*` 跨时间戳同会话 → 合并；非 `msg_` 无 `request_id` 不同时间戳 → 两条；
3. sidechain replay（父 + `isSidechain:true` 副本，新 request id）；
4. 跨会话副本（同 mid 不同 sessionId）；
5. `<synthetic>` 零/非零 token；
6. `advisor_message` iterations；
7. `-fast`（`speed:"fast"`）；
8. 1h cache breakdown（`ephemeral_1h_input_tokens`）与无 breakdown 的平面字段；
9. above-200k 与 models.dev tier 各一；
10. 无效行：`"usage": {`（带空格）、`version:"v1.2.3"`、空 `sessionId`、`"id":null`、重复键、1 位毫秒。
11. AgentProgress 包装行（只应影响 daily，不应影响 session 报表）。**时间戳必须在 `data.message.timestamp`**（`daily.rs:206-227` 的 `DailyAgentProgressMessage`）；放在顶层会让 untagged 反序列化两种形状都不匹配，ccusage 静默丢弃整行（2026-11-05 实测：顶层写法 daily 当天只剩 3 input，正确写法 14 input）。
12. `costUSD` 自报成本**至少两行**：一行明显偏离计算值（`0.5`），一行恰等于计算价（如 `0.00027`）。只有一行时 `--mode auto` 与 `--mode calculate` 的输出相同，auto 优先取自报值这条规则等于没测（实测：无 costUSD 时两种 mode totalCost 一致，加一行 0.5 后 auto=0.50105、calculate=0.0021）。

**生成配方（钉死，fail-closed）:**
`CLAUDE_CONFIG_DIR=<fixture-tree> ccusage claude daily --json --breakdown --offline --single-thread -z UTC -s <fixed> -u <fixed> --mode {auto,calculate}`，
以及 `ccusage claude session --json --offline --single-thread -z UTC -s/-u`。
**不带 `--config`**：金样本冻结的是 ccusage「空别名表 + 内置五资产 + builtin 表」的核心语义，带上仓库的动态 collector 配置会让金样本随配置漂移；override 路径由 Task 5 的单测与 Task 9 的影子双跑覆盖。生成器还须验证环境干净：`~/.claude/ccusage.json`、`~/.config/claude/ccusage.json`、`<cwd>/.ccusage/ccusage.json` 都不存在，`CCUSAGE_MODEL_ALIASES` 未设置，否则 exit 1。
脚本断言 `--version` == `20.0.33`、每个夹具日至少一行、输出非空，否则 exit 1。产物含 `{claudeVersion, command, fixtureSha256, daily, sessions}`。

**测试：** `goldens_test.go` 用 `//go:embed` 读金样本；用适配器跑同一夹具树（`ResolveRoots` → fixture；`ScanFiles` 不剪枝），比较**解析后的 JSON 值**（键序无关）：
- `TestClaudeDailyMatchesTheGoldens`（auto + calculate 两种 mode）；
- `TestClaudeSessionsMatchTheGoldens`；
- 若适配器产出与金样本不同，失败信息带字段级 diff 与 `file:line` 出处。

- [ ] **Step 1: 写夹具与生成脚本；生成金样本并提交**（用 `~/.tokenboard/bin/ccusage` 20.0.33）。
- [ ] **Step 2: 写失败测试**，运行 → FAIL（适配器尚未接上 Task 1-4 的完整链路）。
- [ ] **Step 3: 接上适配器的 `Collect` 入口**（Task 5 的签名）后运行 → PASS。
- [ ] **Step 4: 二次运行生成器确认字节稳定**（`git diff` 无变化）。
- [ ] **Step 5: Commit**：`test(adapters): freeze the Claude row-level goldens from ccusage 20.0.33`

---

### Task 7: Provider 重接线 + 内部开关 + RegisterNative

**Files:**
- Modify: `clients/go/internal/collect/providers/claudecode/claudecode.go`
- Create: `clients/go/internal/collect/providers/claudecode/native.go`
- Create: `clients/go/internal/collect/providers/claudecode/native_test.go`

**Interfaces:**
- `providers/claudecode` 新增未导出常量 `useNativeClaude = false`（编译期开关；翻转是独立提交）。
- `nativeCollect(ctx, options) ([]contract.Snapshot, error)`：`pricing.Prepare` → `pricing.PreparedConfig.Overrides` → `claude.Collect` → `ccusage.DecodeJSON` → `ccusage.NormalizeCcusageDailyJSON(..., Sessions: sessions, HasSessions: true)`。
- `Collect()` 按开关分派；`init()` 里 `collect.RegisterNative(contract.SourceClaudeCode, nativeProvider{})` **无条件**执行（parity/bench 必须能跑原生侧，即使默认仍走 ccusage）。
- 根解析分四支（Task 7 brief 有完整代码）：`CLAUDE_CONFIG_DIR` 设了 → `homeDir=""`；`CLAUDE_HOME` 设了 → `readClaudeHome` 的结果；`Options.HomeDir` 设了 → `<HomeDir>/.claude`；都没设 → `homeDir=""`，交给 `ResolveRoots` 走 ccusage 的 `$XDG_CONFIG_HOME/claude` + `$HOME/.claude` + `home::home_dir`（`paths.rs:38-53`）。
- hook 模式沿用 `pricing.Prepare(HookMode:true)`（不联网）。
- `Collect` 必须收到非空 `Timezone`（Task 5 已注明空 Timezone 会让剪枝与日期换算不一致）。

- [ ] **Step 1: 写失败测试**：`TestRegisterNativeAlwaysInstallsTheNativeProvider`、`TestSwitchDefaultsToCcusage`（`useNativeClaude == false`，Collect 走旧路径，用 stub runner 断言调用了 ccusage）、`TestNativeCollectMatchesNormalizePipeline`（用 Task 6 夹具，native → snapshots 与直接 normalize 金样本一致）。
- [ ] **Step 2: 运行确认失败**；**Step 3: 实现**；**Step 4: 运行通过**；**Step 5: Commit**：`feat(claudecode): wire the native adapter behind an internal switch`

---

### Task 8: hook 双源和解（§6.1.3）

**Files:**
- Modify: `clients/go/internal/collect/providers/claudecode/claudecode.go`（`collectHookUsage`）
- Create: `clients/go/internal/collect/providers/claudecode/hook_native_test.go`

**行为:** hook 模式下不再调用 ccusage：`sessioncursor.CollectHookIncremental` 仍负责扫描/游标/缓存（不变）；数字改由 `nativeCollect` 在 `incremental.RangeArgs` 对应的日期窗口上整窗重算；随后 `sessioncursor.AssertHookReconciliationSnapshots("Claude", incremental.ChangedDates, incremental.ChangedKeys, snapshots)` 对**同实现内的增量解析键集**与**整窗重算**做交叉校验（fail-closed）。`Changed=false` 时返回空；缓存快照合并逻辑（`SnapshotsOf`/`MergeSnapshots`）不变。

- [ ] **Step 1: 写失败测试**：`TestHookNativeReconcilesIncrementalKeysAgainstWindowRecompute`（发现键缺失 → 报错）、`TestHookNativeNoChangesReturnsEmpty`、`TestHookNativeNeverRunsCcusage`（stub runner 计数为 0）、`TestHookNativeOfflinePricing`（hook 下不发起网络；用 fetcher 计数断言）。
- [ ] **Step 2: 运行确认失败**；**Step 3: 实现**；**Step 4: 运行通过**；**Step 5: Commit**：`feat(claudecode): reconcile the hook path inside the native implementation`

---

### Task 9: CI 门禁、真机 evidence、默认翻转（独立提交）

**Files:**
- Modify: `.github/workflows/go-client.yml`（扩 `native-pricing` job：`go test ./internal/collect/adapters/claude/... -race`、`node --test clients/go/scripts/gen-claude-goldens.test.mjs` 若有）
- Modify: `docs/superpowers/specs/2026-11-03-native-usage-sources-design.md` §8 的阻塞项勾选说明
- Create: `docs/research/2026-11-05-claude-native-parity.md`

**步骤:**
- [ ] **Step 1:** 在真机上跑 `go run ./cmd/parity -source claude-code -since <固定窗口> -until <同上>`（native vs 本机 ccusage 20.0.33，**生产参数、不带 `--offline`**）：要求 `match`（或逐条记录 `diff` 及原因）。把命令、窗口、结果写入 `docs/research/2026-11-05-claude-native-parity.md`（脱敏）。
  **已知的口径差异**：生产 claude 不传 `--offline`，ccusage 会联网刷新 LiteLLM 价表（`pricing.rs:1002-1038`）；原生侧是冻结语料。2026-11-05 实测共同模型价差为 0，实时表只多出构建期白名单外的模型，所以 diff 若出现，先确认是不是命中这些条目（它们通常已被 models.dev 快照或动态目录覆盖）。
- [ ] **Step 2:** 用 `bench-collect` 跑 native vs ccusage（single/30d/full 三种场景），把中位数与 RSS 记入同一报告，与 S1 基线对照。
- [ ] **Step 3:** **仅当** Step 1 全 `match` 且新金样本测试全绿时，另起一个独立提交把 `useNativeClaude = true`；否则保持 `false` 并在报告里写明原因（§10.1 口径闸门）。翻转提交只改这一行。
- [ ] **Step 4:** CI：`native-pricing` job 增加 claude 适配器的 `-race` 测试；`check-deps.sh` 的说明更新为「原生金样本闸门」。
- [ ] **Step 5:** 全量验证：`go test ./... -count=1 -race`、`go vet ./...`、`gofmt -l .`、三平台交叉构建、`git diff` 对禁止路径为空。
- [ ] **Step 6: Commit**：`test(ci): gate the native Claude adapter and record its parity evidence`

---

## 完成标准（S2 出口）

- `go test ./internal/collect/adapters/claude/... ./internal/collect/providers/claudecode/... -race` 全绿；行级金样本（daily auto/calculate + sessions）与 ccusage 20.0.33 产出**按解析值一致**。
- `cmd/parity -source claude-code` 在固定窗口全 `match`；`bench-collect` 能测出 native 侧数据。
- hook 路径不再调用 ccusage，且增量键 vs 整窗重算的交叉校验有测试覆盖（含缺失键 fail-closed）。
- 内部开关默认仍为 ccusage；翻转（若发生）是只改一行的独立提交，并附真机 parity 报告。
- `internal/contract`、`packages/usage-core`、S1 的 `internal/nativepricing` 行为未变；`internal/ccusage` 仅消费、未被语义改动（获取层保留到 S5）。
- 三平台构建通过；`.github/workflows/go-client.yml` 覆盖新测试。
