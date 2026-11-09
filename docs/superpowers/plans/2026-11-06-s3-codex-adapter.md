# S3: Codex 原生适配器 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用纯 Go 原生实现替换 codex 来源对 ccusage 的调用——读取 Codex 本地 `sessions/**/*.jsonl[.zst]`，复刻 ccusage v20.0.33 的解析/重放差分/去重/聚合/成本语义，产出与 `codex daily --json` / `codex session --json` **同形状的报表 JSON**，经现有 `ccusage.NormalizeCcusageDailyJSON` 转成 `contract.Snapshot`。

**Architecture:** 新增 `internal/collect/adapters/codex`（路径发现 / zstd 与行预筛 / 行解析与状态机 / fork 重放计划 / 聚合 / 报表与分桶成本）。成本查表走 S1 的 `internal/nativepricing`（本次扩展 `FindAt` 与 `long_context_split_threshold`），但**分桶公式实现在适配器内**（ccusage 的 Codex 成本不是单一 `calculate_cost_for_usage`：它按 service_tier 分桶、按每请求长上下文档位、以 `× (multiplier−1)` 增量叠加，无法复用 `nativepricing.Cost` 的整模型公式）。`providers/codex` 保留 ccusage 旧路径，用未导出 `useNativeCodex = false` 选择；`RegisterNative` 无条件注册。S2 的 `providers/claudecode/native.go` 是接线样板。

**Tech Stack:** Go 1.27、`encoding/json`（`json.RawMessage` + `json.Decoder.UseNumber`，不用结构体直解）、`internal/nativepricing`、`internal/collect/{sessionusage,sessionwalk,sessionfile,sessioncursor,zstdframes}`、`github.com/klauspost/compress/zstd`（已在 go.mod）。

**Spec:** `docs/superpowers/specs/2026-11-03-native-usage-sources-design.md`（§6.1.1 产出边界、§6.1.3 hook 双源和解、§7 Codex 语义、§8 金样本阻塞项、§8.1 S1 结转义务、§10.1 回滚设计）

**语义事实来源（实现时必须对照）:** ccusage v20.0.33 @ `1308c416`，`rust/adapters/codex/src/{paths,reader,parser,replay,aggregate,report,speed,types}.rs`、`rust/adapters/codex/src/codex-auto-review-fallbacks.json` 与 `rust/crates/ccusage-core/src/{cost,date_utils,pricing,output}.rs`。源码已在本地解压至 `/tmp/ccusage-src-1308c416/ccusage-1308c416`（临时目录，过期可重下）。下列任务里的每条规则都附该版本的 `file:line`。

## Global Constraints

- 语义冻结在 ccusage **v20.0.33**（commit `1308c416`）；派生规则在注释里注明 `file:line`。
- 适配器产出 **ccusage 报表形状的 JSON**（daily：`daily[]` + `models` map + `totals`；session：`sessions[]` + `sessionId/lastActivity/sessionFile/directory`），不是 `contract.Snapshot`（§6.1.1）。
- **只实现 CLI 报表路径（`aggregate.rs`），不移植 `loader.rs` 的事件流路径**。生产 provider 只跑 `codex daily/session --json`；`loader.rs` 的去重键与 aggregate 不同（不含 session 维度，`loader.rs:246-256` vs `aggregate.rs:26-36`），移植两套等于制造分叉。
- 成本只在适配器内用 `nativepricing` 的语料与 `FindAt` 计算；**hook 模式不得联网**。ccusage 侧生产始终 `--offline`（`providers/codex/command_options.go:26`），因此 parity 的 ccusage 侧也带 `--offline`（`cmd/parity/main.go:692`）——两侧都用冻结语料，理论上应当逐位一致。
- 过渡开关**不是用户可见环境变量**（§10.1）：包内未导出常量，默认 ccusage，翻转是独立提交。
- 只投影 token/model/timestamp/会话标识；不得读取或保存 prompt/completion/正文。`thread_settings_applied` 只取 `service_tier`；`turn_context` 只取 model。
- 时间戳解析**按 ccusage 的长度门手写**（`date_utils.rs:111-145`），不得用 `time.RFC3339Nano`（它接受 1/9 位小数与闰秒）。
- 排序必须确定：分组用 `BTreeMap` 语义（Go 用 `sort.Strings` 的键序），文件名排序用字节序；事件顺序按文件发现顺序（`loader.rs:203-216` 的按下标回填语义）。
- 三平台（darwin/linux/windows × amd64/arm64）构建通过；`gofmt`/`go vet` 干净；`go test -race` 通过。
- 新增依赖只允许一个：TOML 解析器（见 Task 6 决策 D1）；其余复用现有模块。

## Review Focus

1. **累积差分的边界**：`total_token_usage` 与 `last_token_usage` 的取舍、`previous_totals` 无条件推进、三处零判定阈值不同（5 项 vs 6 项）；Task 3 的差分测试。
2. **fork 重放误吞/漏吞**：`MatchingParent` 只在 `index == 0` 时回退 burst；burst 窗口是**事件间毫秒差 ≤ 1000ms**，不是秒边界；`forked_at` 之后的事件必须入账；Task 4 的重放测试。
3. **service_tier 分桶与乘数叠加**：`× (multiplier − 1)` 增量语义、`recorded_*` 第二遍应用、`auto` 模式从 `config.toml` 探测 tier；Task 6 的成本测试。
4. **`inputTokens` 语义**：输出为 non-cached（input − cache_read − cache_creation），但 `totalTokens` 用事件自报的总和，不重算；Task 5/6 的报表测试。
5. **`--since` 剪枝的宽限**：路径日期 + mtime 双条件、`until` 的 UTC 日期比 `--until` 宽 0–1 天；Task 1 的剪枝测试。

---

### Task 1: 包骨架 + 根解析 + 文件发现/去重/剪枝 + session id

**Files:**
- Create: `clients/go/internal/collect/adapters/codex/paths.go`
- Create: `clients/go/internal/collect/adapters/codex/paths_test.go`

**Interfaces:**
- Produces: `type Source struct{ Dir string; DedupeScope string }`；`HomePaths(env func(string) string, homeDir func() (string, error)) ([]string, error)`；`UsageSources(homes []string) []Source`；`CollectFiles(dir string) []string`；`CollectDedupedSources(sources []Source) []FileGroup`（`FileGroup{Dir string; Files []string}`）；`FilterByEligibility(sessionsDir string, files []string, since, until, timezone string) []string`；`SessionID(sessionsDir, file string) string`。

**精确规则（必须照抄）:**
- 根解析（`paths.rs:236-247`）：`CODEX_HOME` 存在时按 `,` 切分、`Trim`、丢空；**全空 = 0 个 home，不回退**。未设置时 `home_dir()` 拼 `.codex`；home 解析顺序 HOME → USERPROFILE → HOMEDRIVE+HOMEPATH（`home.rs:3-32`，`os.UserHomeDir` 不够）；全失败 → 硬错误 `home directory is not set`。
- 每个 home 派生（`paths.rs:34-67`）：`sessions/` 是目录 → 一个 source；`archived_sessions/` 是目录 → 另一个（**sessions 在前**）；都没有 → home 自身；跨 home 按路径字面去重（不 canonicalize）。
- 文件发现（`reader.rs:9-20`、`common/src/lib.rs:26-46`）：`*.jsonl`，或 `*.jsonl.zst`（去掉 `.zst` 后仍是 `.jsonl`）；大小写敏感；只收 `is_file()`、只递归 `is_dir()`，**不跟随 symlink**（Go 用 `WalkDir` + `entry.Type().IsRegular()`）；排序按完整路径字节序；同目录 `x.jsonl` 与 `x.jsonl.zst` 并存时保留 `.jsonl`（`paths.rs:91-95`）。
- 跨 source 去重键 `(DedupeScope, 相对 source 的未压缩路径)`（`paths.rs:228-234`），先到先得。
- `--since/--until` 剪枝（`paths.rs:117-218`）：
  - 日期参数已被 CLI 归一为 8 位（`YYYYMMDD`）；任一边解析失败 → **完全不剪枝**。
  - `since_millis` = `--since` 本地午夜；`until_path_date` = `--until+1 天本地午夜` 的**UTC 日期**（`paths.rs:178-182`）。
  - `file_date`：相对路径按 `/` 分段，取第一个「4 位 + 2 位 + 2 位」全数字且构成真实日历日的三元组（`paths.rs:196-208`）。
  - 保留条件：`until` 缺失或 `file_date` 缺失或 `file_date <= until_path_date`；且（`file_date >= since` 或 mtime 缺失或 `mtime >= since_millis`）。`--until` 不因 mtime 剪枝。
  - mtime 取 `fs::metadata`（跟随 symlink，但 symlink 文件不会被收集）；早于 epoch → 视为缺失 → 保留。
- session id（`parser.rs:892-904`）：相对 source 根 → 去掉 `.zst` → 去掉 `.jsonl` → 分量用 `/` 连接；空 → `"unknown"`；非 UTF-8 分量丢弃。

- [ ] **Step 1: 写失败测试**（`paths_test.go`）：`TestHomePathsSplitsEnvListAndKeepsZeroHomes`（含 `CODEX_HOME=""` → 0 个、不回退）；`TestUsageSourcesPrefersSessionsThenArchivedThenHome`；`TestCollectFilesKeepsJsonlAndZstAndDropsSymlinks`；`TestCollectFilesPrefersPlainOverCompressed`；`TestCollectDedupedAcrossSourcesKeepsFirst`；`TestFilterKeepsFileWhenPathDateInRangeOrMtimeNewer`（含 "路径日期在窗口外但 mtime 新 → 保留" 与 "无路径日期 → 永不因 since 丢"）；`TestUntilPathDateIsUtcDateOfNextLocalMidnight`（+08:00 下 `--until 2026-01-01` 保留路径日期 `2026-01-02` 的文件）；`TestSessionIDStripsCompressionAndExtensions`。
- [ ] **Step 2: 运行确认失败**：`cd clients/go && go test ./internal/collect/adapters/codex/ -run 'TestHomePaths|TestUsageSources|TestCollectFiles|TestCollectDeduped|TestFilter|TestUntilPathDate|TestSessionID' -v` → 编译失败。
- [ ] **Step 3: 实现** `paths.go`。
- [ ] **Step 4: 运行确认通过**：同上命令 → PASS。
- [ ] **Step 5: Commit**：`feat(adapters): add the Codex session file discovery and pruning layer`

---

### Task 2: 读取层 + 行预筛（字节级两阶段）

**Files:**
- Create: `clients/go/internal/collect/adapters/codex/reader.go`
- Create: `clients/go/internal/collect/adapters/codex/detect.go`
- Create: `clients/go/internal/collect/adapters/codex/reader_test.go`（读取与预筛同测）

**Interfaces:**
- Produces: `OpenRollout(path string) (io.ReadCloser, string, error)`（返回实际打开的路径：`.jsonl` 打不开时按 `NotFound` 换 `.jsonl.zst`，反之亦然）；`ReadLines(r io.Reader, visit func(line []byte) error) error`（`read_until('\n')` 语义，解压/读错误 → 停止但保留已读部分，不报错）；`ClassifyLine(line []byte) LineKind`，`LineKind` ∈ `{Session, Headless, Skip}`。

**精确规则（必须照抄）:**
- 缓冲 **128 KiB**（`reader.rs:7`）；zstd 用 `klauspost/compress/zstd` 的流式 `Decoder`，**必须支持拼接帧，并把截断尾帧当正常结束**（`compression_tests.rs:172-220`）；Go 侧已有 `internal/collect/zstdframes` 可做帧定界，若流式 Decoder 已按帧续读则直接用它并补测试。
- 行可以任意长，**不得用默认 64 KiB 的 `bufio.Scanner`**；用 `bufio.Reader.ReadBytes('\n')`（最后一行无换行也算一行）。
- 预筛（`parser.rs:25-47,662-713`）：
  - 第一道：命中无空格紧凑子串 `"type":"turn_context"`、`"type":"token_count"`（**且**有 `"type":"event_msg"`）、`"type":"thread_settings_applied"`（同样要有 event_msg）、`"type":"token_usage_record"`、`"type":"compacted"` → `Session`。
  - 第二道（带空格的 JSON）：`has_event_msg` 为假时，`"type":` 存在且行 < **65536 字节**，裸搜 `"type": "turn_context"` / `"type": "token_count"` / `"type": "thread_settings_applied"`；≥ 64 KiB 的带空格行**不进**嵌套规则。随后 `has_compaction_type`（裸搜 `token_usage_record` / `compacted`）或 `!has_compact_type` 成立才做结构扫描 `codex_line_type_flags`（逐 `"type"` 键、跳 `\n\r\t ` 空白、与 6 个枚举值精确匹配，命中即提前返回）。
  - 第三道：`"usage":` / `"input_tokens":` / `"prompt_tokens":` → `Headless`；三者都没有 → `Skip`。**顺序永远 Session 优先**。
  - 注意：`"input"` / `"output"` 别名**不在**第三道里（`parser.rs:708-710`），不要"顺手补"。

- [ ] **Step 1: 写失败测试**：`TestOpenRolloutFallsBackToTheOtherEncoding`（`.jsonl` 缺失 → 打开 `.jsonl.zst` 并返回实际路径）；`TestReadLinesKeepsEverythingBeforeATruncatedZstdFrame`；`TestReadLinesHandlesConcatenatedFrames`；`TestReadLinesAcceptsFinalLineWithoutNewline`；`TestClassifyLineMatchesCompactAndSpacedForms`（6 种记录 × 紧凑/带空格）；`TestClassifyLineExcludesSpacedTokenCountOver64KiB`；`TestClassifyLineTreatsInputOnlyAsSkip`。
- [ ] **Step 2: 运行确认失败**。
- [ ] **Step 3: 实现**。
- [ ] **Step 4: 运行确认通过**。
- [ ] **Step 5: Commit**：`feat(adapters): add the Codex rollout reader and line prefilter`

---

### Task 3: 行解析与状态机

**Files:**
- Create: `clients/go/internal/collect/adapters/codex/parser.go`
- Create: `clients/go/internal/collect/adapters/codex/types.go`
- Create: `clients/go/internal/collect/adapters/codex/parser_test.go`

**Interfaces:**
- Produces: `type RawUsage struct{ Input, CachedInput, CacheCreation, Output, Reasoning, Total uint64 }`；`type Event struct{ Timestamp string; SessionID string; Model string; ResponseID string; ServiceTier *Tier; IsFallbackModel bool; RawUsage }`；`type Tier int`（`TierStandard/TierFast/TierFlex`）；`ParseFile(sessionsDir, path string, replayPrefix []Event, isReplayedCompaction func(responseID string) bool, visit func(Event))`；`ParseTimestamp(value string) (int64, bool)`；`NormalizeTimestamp(value string) string`。

**精确规则（必须照抄）:**
- **JSON 语义对齐 serde**（移植风险最高，逐条有测试）：
  - 先 `utf8.Valid(line)`，坏 UTF-8 → 整行丢弃（`serde_json::from_slice` 报错）。
  - 重复键 → serde 报 `duplicate field` → 整行丢弃；Go 用 `json.Decoder` 到 `map[string]json.RawMessage` 检测不了重复键，需用 `Decoder.Token()` 流式判断或接受"最后值胜"并**记录为已知偏差**（Codex 实际不产生重复键；计划采用后者，测试 `TestDuplicateKeysTakeTheLastValueAsADocumentedDeviation`）。
  - 字段名**大小写敏感**：用 `map[string]json.RawMessage` 精确取键，禁止结构体 tag 匹配。
  - `payload`/`info`/`usage`/`metadata`/`thread_settings`/`data`/`result`/`response` 为非对象（标量/数组）→ 当作缺失（`types.rs:358-450` 的 lossy），不是整行失败。
  - 数字字段 lossy u64（`types.rs:452-539`）：JSON 整数，或**字符串**经 `TrimSpace` + `ParseUint`；负数/浮点/布尔 → 该字段缺失（0），不报错。
  - `timestamp` 非 string 或非正整数 → 整行失败（`types.rs:183-188`）。
- 字段别名（`types.rs:278-356`）：
  - input = `input_tokens` | `prompt_tokens` | `input` | 0；output = `output_tokens` | `completion_tokens` | `output` | 0；reasoning = `reasoning_output_tokens` | `reasoning_tokens` | 0。
  - cached = `cached_input_tokens` | `cache_read_input_tokens` | `cached_tokens` | 0，然后 `.min(input)`。
  - cache_creation = `cache_write_input_tokens` | `cache_creation_input_tokens` | 0，然后 `.min(input − cached)`（饱和）。
  - total = 记录值（> 0）否则 `input + output`（饱和，**不加 reasoning**）。
  - 归一在反序列化后做一次，跨记录相减后再做一次（`parser.rs:1310-1316`）。
- 时间戳（`date_utils.rs:111-161,356-368`；`parser.rs:1174-1193`）：只接受长度 20/24/25/29；小数位**恰好 3 位**；`T` 位置、`hour≤23`、`minute≤59`、`second≤59`（闰秒拒绝）、真实日历日；偏移 `±HH:MM`。数字时间戳：`> 10_000_000_000` 当毫秒，否则秒×1000（`10_000_000_000` 本身按秒）。规范化输出恒 `YYYY-MM-DDTHH:MM:SS.sssZ`。
- `token_count`（`parser.rs:479-554`）：
  - `advanced = total 缺失 || previousTotals != total`；`raw = advanced ? last_token_usage : total − previous`（逐字段饱和）；`previousTotals` 只要 total 出现就**无条件**更新。
  - 全零判定用 **5 个字段（不含 total_tokens）**；headless 与 `token_usage_record` 用 **6 项含 total**（三处阈值不同）。
  - compaction 配对：`advanced && latestUsageResponseID 指向 pending && (pending.raw == raw || pending.threadTotal == normalized(total))` → 删除 pending、标记 emitted，本次 token_count 正常入账。
  - 模型：payload 的 model 优先于 info；只更新 `current_model` 的是 `turn_context`，`token_usage_record` 用局部副本。
- `compacted`（`parser.rs:342-362`）：`payload.compaction_response_id` trim 非空 → 记入集合；若对应 pending 存在且首次 emitted → 补发事件。
- `token_usage_record`（`parser.rs:363-447`）：需 payload、response_id、时间戳、usage；全零（6 项）跳过；时间戳只记第一条；`latest_usage_response_id` 更新；marker 先到 → 立即 emit，否则 pending（先到者胜）；**没有任何 marker 配对的记录永远不计入**。
- `turn_context`（`parser.rs:448-454`）：只更新 model（`model|model_name|metadata.model`）并复位 fallback 标记。
- `thread_settings_applied`（`parser.rs:464-478,524-528`）：`service_tier` 字段**存在但无法识别 → 置 None**；字段不存在 → 保留旧值。映射 `default|standard→Standard`、`fast|priority→Fast`、`flex→Flex`。
- 模型状态（`parser.rs:794-831`）：无模型 → 沿用 `current_model`；仍无 → `"gpt-5"` 哨兵且 `isFallback=true`；哨兵期间每条无模型事件都标 fallback。`codex-auto-review` 按 `codex-auto-review-fallbacks.json` 的 7 条（`releasedOn` 降序）取第一个 `releasedOn <= 事件日期` 的模型，都不满足或日期不可解析 → `"gpt-5"`，命中即 `isFallback=true`（`parser.rs:833-846`）。
- replay 状态机（`parser.rs:100-112,219-267`）：只有 `response_id` 为空的事件参与。`MatchingParent`：与 `prefix[i]` **6 个 u64 全等**才前进并丢弃；不等且 `i == 0` → `detect_rewritten_burst`；不等且 `i > 0` → `Done`。`SkippingRewrittenBurst(prev)`：`0 <= ts − prev <= 1000` 才跳过并推进，否则 `Done` 且该事件入账。时间戳不可解析 → burst 结束、事件入账。
- `detect_rewritten_burst`（`parser.rs:131-178`）：重开文件，取头两个「Session 行 + `event_msg` + `token_count` + info 非空 + last/total 至少一个 + 时间戳可解析」事件的毫秒差，`0..=1000` → 返回第一个时间戳。

- [ ] **Step 1: 写失败测试**（每条一个测试，表驱动）：`TestRawUsageAliasPrecedence`、`TestRawUsageClampsCachedAndCacheCreation`、`TestLossyU64AcceptsIntegerStringsAndDropsNegatives`、`TestNonObjectPayloadIsTreatedAsMissing`、`TestInvalidUTF8LineIsDropped`、`TestDuplicateKeysTakeTheLastValueAsADocumentedDeviation`、`TestTimestampLengthGate`（20/24/25/29、1/2/4 位小数、闰秒、偏移）、`TestTokenCountDifferencesCumulativeTotals`、`TestTokenCountPrefersLastUsageWhenTotalAdvanced`、`TestTokenCountZeroGateUsesFiveFields`、`TestCompactionMarkerEmitsPendingRecord`、`TestUnmatchedUsageRecordIsNeverCounted`、`TestThreadSettingsKeepsPreviousTierWhenFieldMissing`、`TestAutoReviewModelFallbackTable`、`TestMissingModelUsesGpt5SentinelAndMarksFallback`、`TestReplaySkipsMatchingParentPrefix`、`TestReplayRewrittenBurstWithinOneSecond`、`TestReplayBurstEndsAtFirstSlowEvent`。
- [ ] **Step 2: 运行确认失败**。
- [ ] **Step 3: 实现**。
- [ ] **Step 4: 运行确认通过**。
- [ ] **Step 5: Commit**：`feat(adapters): port the Codex line parser and its cumulative-diff state machine`

---

### Task 4: fork 重放计划

**Files:**
- Create: `clients/go/internal/collect/adapters/codex/replay.go`
- Create: `clients/go/internal/collect/adapters/codex/replay_test.go`
- Create: `clients/go/internal/collect/adapters/codex/testdata/codex-fixture/`（含 fork/compaction/burst 夹具）

**Interfaces:**
- Produces: `type ReplayPlan struct{ ... }`；`NewReplayPlan(sources []FileGroup) *ReplayPlan`；`(p *ReplayPlan) Prefix(file string) []Event`；`(p *ReplayPlan) IsReplayedCompaction(file, responseID string) bool`。

**精确规则（必须照抄）:**
- 元数据只读首行（`replay.rs:273-308`）：`type == "session_meta"`；`timestamp` 取**顶层**；`session_id = payload.id`；`parent_id = payload.forked_from_id`，缺失则 JSON Pointer `payload.source.subagent.thread_spawn.parent_thread_id`；空串过滤。
- `session_id → []path` 的 **slice 保持文件发现顺序**；`first_non_child_path` = 该桶第一个不等于 child 自身的路径；找不到父日志 → 无父（`replay.rs:203-250`）。
- `forked_at` = child 自己的 metadata 时间戳；`replay_prefix` = parent 使用向量中第一个 `ts > forked_at` 的下标前缀（严格大于；`forked_at` 缺失 → 全量）；父 usage 缺失 → 空前缀；child 非 fork → 不过滤（`replay.rs:159-178`）。
- 父事件向量只收 `response_id` 为空的事件；父自身的 fork 去重**不递归**（`replay.rs:366-381` 传 `None`）。
- `is_replayed_compaction`（`replay.rs:182-200`）：parent 的 compactions 表含该 response_id 且（`forked_at` 缺失 ∨ 时间戳缺失 ∨ `ts <= forked_at`）。
- 带 `--since/--until` 时用 `for_bounded_files`：replay plan 可用**未过滤的全集**读父文件，但只对过滤后保留的 child 建索引（`replay.rs:118-152`）。

- [ ] **Step 1: 写失败测试**：`TestReplayPrefixStopsAtFirstEventAfterFork`（等于 fork 时刻仍算重播）；`TestReplayWithoutParentForksFromEmptyPrefix`；`TestReplayIgnoresParentThatIsNotInTheScanSet`；`TestReplayedCompactionBeforeForkIsDropped`；`TestBoundedPlanStillReadsUnprunedParents`。
- [ ] **Step 2: 运行确认失败**。
- [ ] **Step 3: 实现**。
- [ ] **Step 4: 运行确认通过**。
- [ ] **Step 5: Commit**：`feat(adapters): add the Codex fork replay plan`

---

### Task 5: 聚合（分组、去重、service_tier 分桶、时间桶）

**Files:**
- Create: `clients/go/internal/collect/adapters/codex/aggregate.go`
- Create: `clients/go/internal/collect/adapters/codex/aggregate_test.go`

**Interfaces:**
- Produces: `type ModelUsage struct{ Input, CachedInput, CacheCreation, Output, Reasoning, Total uint64; LongContext…; Standard, Fast, Flex Bucket; Timestamped map[int64]*TimestampedUsage; IsFallback bool }`；`type Group struct{ Input…; LastActivity string; Models map[string]*ModelUsage }`；`LoadGroups(sources []FileGroup, kind ReportKind, timezone string, since, until string) (map[string]*Group, error)`。

**精确规则（必须照抄）:**
- 日期归属（`aggregate.rs:408-430`）：`format_date_tz(ts, tz)`；`since/until` 比较用 8 位日期字符串（`date.replace('-',"")`），窗口外 → 丢弃；session kind 用 `event.session_id`（空则丢）。
- 无效时间戳（`aggregate.rs:332-334`）：`parse_ts_timestamp` 失败 → **整报错** `Invalid Codex timestamp: <原始串>`，不是跳过。
- 分组累加（`aggregate.rs:432-461`）：6 个字段饱和加；`last_activity` 取**事件时间戳原始字符串**的字典序最大者。
- 每模型累加（`aggregate.rs:463-524`）：
  - 长上下文按**每请求** `event.input_tokens > long_context_split_threshold(model)` 判定，累加 4 个 long_context 桶。
  - `has_time_dependent_pricing(model)` 时（DeepSeek V4 两族）累加 `timestamped_usage[ts_ms]`。
  - 主过程 `record_service_tier = false`（见第二遍）。
- 去重键（`aggregate.rs:753-780`）：有 `response_id` → `Response(id)`（**不含 session/file**）；否则 `Usage{timestamp, model, session(仅 session kind), 6×u64}`；**daily 键不含 session**（跨 session 的相同事件合并），session 键含 session——两处语义不同，别统一。
- 去重记录（`aggregate.rs:711-751`）：首到者胜；重复项合并 `service_tier`（优先级 **Standard > Fast > Flex > None**，与顺序无关）；compaction 记录保留 `file_index` 最小者（同键多文件时）；`insert` 返回 `response_id.is_none()` —— **带 response_id 的事件不直接入组**。
- 第二遍（`aggregate.rs:594-677`）：遍历去重表；compaction 记录 → 用记录的 model/tier 入库；Usage 记录若有 tier → 并入对应 tier 桶（以及 time-dependent 的 timestamped tier 桶）。
- 别名：model 经 `resolve_model_name`（`CCUSAGE_MODEL_ALIASES`），S2 已移植，复用 `adapters/claude` 的实现或提取到共享包。

- [ ] **Step 1: 写失败测试**：`TestDailyDedupeIgnoresSessionButSessionDedupeUsesIt`；`TestServiceTierMergePrefersStandardOverFastOverFlex`；`TestCompactionRecordUsesEarliestFileCopy`；`TestLongContextBucketIsDecidedPerRequest`；`TestTimestampedUsageOnlyForTimeDependentModels`；`TestInvalidTimestampFailsTheWholeReport`；`TestLastActivityUsesRawTimestampString`；`TestRangeFilterDropsEventsOutsideWindow`。
- [ ] **Step 2: 运行确认失败**。
- [ ] **Step 3: 实现**。
- [ ] **Step 4: 运行确认通过**。
- [ ] **Step 5: Commit**：`feat(adapters): aggregate Codex events into ccusage-shaped groups`

---

### Task 6: 报表 JSON + 分桶成本 + speed 探测

**Files:**
- Create: `clients/go/internal/collect/adapters/codex/report.go`
- Create: `clients/go/internal/collect/adapters/codex/cost.go`
- Create: `clients/go/internal/collect/adapters/codex/speed.go`
- Create: `clients/go/internal/collect/adapters/codex/report_test.go`、`cost_test.go`、`speed_test.go`

**Interfaces:**
- Produces: `ReportJSON(groups map[string]*Group, kind ReportKind, pricing *nativepricing.Corpus, speed SpeedPolicy, mode nativepricing.CostMode) map[string]any`；`type SpeedPolicy struct{ Forced bool; Tier Tier }`；`ResolveSpeedPolicy(requested string, homes []string) SpeedPolicy`（`config.toml` 探测）；`BucketCost(usage Bucket, p nativepricing.CorpusModel) float64`；`ModelCost(model string, u *ModelUsage, c *nativepricing.Corpus, now time.Time, s SpeedPolicy) float64`。

**精确规则（必须照抄）:**
- 报表形状（`report.rs:16-145`）：顶层 `{"daily": [...] | "sessions": [...], "totals": {...}}`；行键 `date`/`sessionId`；行字段顺序无关但键名固定：`inputTokens`（**non-cached** = input − cached − cache_creation，饱和）、`cacheCreationTokens`、`cacheReadTokens`、`outputTokens`、`reasoningOutputTokens`、`totalTokens`（事件自报总和）、`costUSD`、`models`（每模型同样 6 字段 + `isFallback` + 必要时 `missingPricing`）；session 行额外 `lastActivity`、`sessionFile`、`directory`（按最后一个 `/` 切分，无 `/` 时 directory 为空串）。
- `costUSD` 序列化用 `json_float`（`output.rs:452-461`）：有限整数 → 输出整数；否则 double。Go 用 `json.Marshal` 的 `-0.0` 与整数值需对齐（`float64(2)` 会输出 `2`，与 Rust 的 `json!(value as i64)` 一致；`-0.0` 输出 `-0`，Rust `json!(-0.0)` 输出 `-0.0` —— 记录为已知偏差或专门处理）。
- 成本（`report.rs:183-392`）：
  - 模型有 `timestamped_usage` → 对每个时间桶 `FindAt(model, ts)` 后分别计价并求和；否则 `Find(model)` 一次。
  - `calculate_codex_usage_cost`：standard 桶全价；`unclassified = total − (standard + flex + fast)`（饱和）；按 `speed` 决定 flex/fast 用量；最终 = `standardCost + flexCost×(flexMultiplier−1) + fastCost×(fastMultiplier−1)`。`Forced(Standard)` 直接返回 standard。
  - `calculate_codex_bucket_cost`：`cache_read = explicit ? rate : input`；`cache_creation = rate`；长上下文用 above 档（无则回落平档）；`long_input = long_input_tokens.min(input)`；`long_cached = min(long_cached_tokens, cached, long_input)`；`long_cache_creation = min(…, long_input − long_cached)`；`long_output = min(long_output_tokens, output)`；short 桶由总减 long 得出；按 8 项求和（顺序照 `report.rs:374-391`，浮点加法顺序影响最后一位）。
- speed（`speed.rs`）：默认 `Auto` → 探测每个 codex home 的 `config.toml`：`profile` 选中的 `profiles.<name>.service_tier` 优先，否则顶层 `service_tier`；`default|standard→Standard`、`fast|priority→Fast`、`flex→Flex`；多 home 取 Fast > Flex > Standard。TOML 解析失败 → None。
- 缺价（`report.rs:406-434`）：模型在语料中查不到（或零 token 门）→ 该模型标 `missingPricing`，并汇入 totals 的 `unpricedModels`（排序去重）；`mode == Display` 时不标。
- totals（`report.rs:147-181`）：逐组饱和加 token；`costUSD` = 各组成本之和。

**决策 D1（需用户确认）：TOML 解析依赖。** ccusage 用完整 TOML 解析器读 `config.toml`（`speed.rs:55-71`）。推荐引入 `github.com/pelletier/go-toml/v2`（纯 Go、无 cgo、MIT），因为它必须复刻「文件非法 → None」与多行字符串内 `service_tier = "..."` 不算数这类语义。备选：手写最小解析器，代价是上述边界无法完全对齐，且要自证。计划按推荐方案写；若用户否决，Task 6 降级为手写并增加偏差记录。

- [ ] **Step 1: 写失败测试**：`TestReportDailyShapeMatchesCcusage`（键集合 + non-cached 语义）；`TestSessionRowSplitsDirectoryAndFile`；`TestBucketCostSplitsLongContextAtThreshold`；`TestCacheReadFallsBackToInputRateWhenNotExplicit`；`TestSpeedMultiplierIsIncremental`（`× (m−1)`）；`TestForcedStandardIgnoresRecordedTiers`；`TestAutoSpeedUsesRecordedTiersAndUnclassifiedFallsBack`；`TestSpeedDetectsProfileThenTopLevelAndFastWinsAcrossHomes`；`TestSpeedIgnoresMultilineStringAssignments`；`TestTimestampedModelsArePricedPerBucket`；`TestMissingPricingOnlyOutsideDisplayMode`。
- [ ] **Step 2: 运行确认失败**。
- [ ] **Step 3: 实现**（`speed.go` 若采纳 D1，先 `go get github.com/pelletier/go-toml/v2` 并更新 `go.mod`/`go.sum`）。
- [ ] **Step 4: 运行确认通过**。
- [ ] **Step 5: Commit**：`feat(adapters): build the Codex reports and bucket cost formula`

---

### Task 7: nativepricing 扩展（FindAt + 长上下文阈值 + override 重放）

**Files:**
- Modify: `clients/go/internal/nativepricing/pricing_at.go`（新建）与 `pricing_at_test.go`
- Modify: `clients/go/internal/nativepricing/cost.go`（`Cost` 在 `at` 非零时走 `FindAt`）
- Modify: `clients/go/internal/nativepricing/corpus.go`（models.dev 阈值表与 override 记录）
- Modify: `clients/go/internal/nativepricing/overrides.go`（`WithOverrides` 保留字段级 override 以便 `FindAt` 重放）

**精确规则（必须照抄）:**
- `FindAt(model, at)`（`pricing.rs:1461-1483`）：`resolved = resolve_model_name(model)`；`deepseek_v4_model_identity(model) || deepseek_v4_model_identity(resolved)` 命中才走时段表，否则等价 `Find(model)`；命中时先 `Find(model)` 再覆盖 4 个费率 + 4 个 above 档 + 两个 explicit=true，然后对 `override[model] || override[resolved] || override[scheduled]` 应用显式字段（`pricing.rs:383-400`）。
- 时段表（`pricing.rs:252-380`）：
  - `CUTOFF = 1_786_896_000_000` ms；早于 cutoff → old 档。
  - `deepseek-v4-flash`：old 0.14/0.28/0.14/0.0028（input/output/cache_create/cache_read，单位 USD/token，`e-6`）；off-peak 0.22/0.66/0.22/0.007；peak 0.44/1.32/0.44/0.014。
  - `deepseek-v4-pro`：old 0.435/0.87/0.435/0.003625；off-peak 0.66/1.98/0.66/0.022；peak 1.32/3.96/1.32/0.044。
  - peak 判定（UTC）：weekday（周日=0）1..=5 且 hour ∈ [1,4) ∪ [6,10)；周末全 off-peak。
- `long_context_split_threshold(model)`（`pricing.rs:2753-2775`）：查 **models.dev 快照本身**（`embedded_models_dev_pricing().entries`，不是合并表），取 `modelWithoutDateSuffix` 后先 `pricingAlias` 再 base 的 `long_context_threshold`，缺失 → **200_000**（`DEFAULT_LONG_CONTEXT_THRESHOLD_TOKENS`，`pricing.rs:220`）。
  - 为什么不能直接用合并表：`mergeInto`（`corpus.go:604-630`）跳过主表已有的键，而 `applyLongContextRates`（`corpus.go:632-660`）只给「自己完全没有 above 档」的主表条目嫁接 models.dev 的档位。于是「LiteLLM 已发布 `*_above_200k_tokens`、models.dev 另有不同 `cost.tiers` 阈值」的模型，在合并表里 `LongContextThreshold == nil`（cost 路径按 200k 走），但 Rust 的 `long_context_split_threshold` 会返回 models.dev 的阈值。这一格就是必须另存一张表的原因。
  - 做法：`loadCorpus` 把 `dev.models`（阈值非 nil 的条目）另存为 `Corpus.DevThresholds map[string]int64`。键的形态要与 Rust 的 `tiers.entries` 一致：`dev.models` 的键是 models.dev 的 `entry.ID`（`corpus.go:551-572`），与 Rust `ModelsDevPricing::entries` 同源；**不要**再套一层 `normalizedModelsDevModelID`。`mergeInto` 不变。阈值只有 `modelsDevEntry.pricing()` 的 `longContextTier().Threshold` 一个来源（`corpus.go:590-597`），不引入新资产。
  - 别名解析顺序照 Rust：先 `pricingAlias(devId)`，再尝试 `base` 本身——两者都只在 `DevThresholds` 里查，**不走 fuzzy**。
- override 重放：`WithOverrides`/`applyOverride`（`overrides.go:270`）直接把字段写进 `Corpus.Models`，时段覆盖会把它抹掉。做法：`Corpus` 新增 `overrideFields map[string]overrideFields`（`WithOverrides` 解析后原样存一份），`FindAt` 在时段覆盖后调用**同一段** `applyOverride` 逻辑的纯函数形式（把 `applyOverride` 内部的计算抽成 `applyOverrideTo(base CorpusModel, fields overrideFields) CorpusModel`，`applyOverride` 调它写回 map）。这样 ccusage 的「先找 override 名字的三种拼写」也能照搬：`override[model] || override[resolved] || override[scheduled]`。
- `Cost` 的 `at` 形参：`!at.IsZero()` 时用 `FindAt(model, at.UnixMilli())`，否则保持 `Find`（`cost.go:141-144` 的注释同步改写）。现有 claude 调用已传事件时间，翻转 `useNativeClaude` 后才会真正生效；这与 S2 记录的 DeepSeek 缺口一致，**claude 侧不需要改代码**。
- flex 形参：同属 S1 未实现项，本次**不改**；Codex 的 flex/fast 乘数在适配器的分桶公式里用 `CorpusModel.FastMultiplier/FlexMultiplier` 自己算（见 Task 6），不经过 `Cost`。计划里明确记录这个分工，避免两处都改。

- [ ] **Step 1: 写失败测试**：`TestFindAtAppliesDeepSeekScheduleAtCutoff`（cutoff−1ms old、cutoff 当天 off-peak/peak）；`TestFindAtPeakWindowsAreHalfOpenWeekdaysOnly`；`TestFindAtKeepsStaticPricingForOtherModels`；`TestFindAtReappliesExplicitOverridesAfterTheSchedule`；`TestLongContextThresholdComesFromModelsDevOnlyAndDefaultsTo200k`；`TestThresholdStripsDateSuffixAndResolvesAlias`；`TestCostUsesFindAtWhenTimeIsProvided`。
- [ ] **Step 2: 运行确认失败**。
- [ ] **Step 3: 实现**。
- [ ] **Step 4: 运行确认通过**：`go test ./internal/nativepricing/ -count=1`（含既有 golden）。
- [ ] **Step 5: 交叉回归**：`go test ./internal/collect/adapters/claude/ ./internal/collect/providers/claudecode/ -count=1`。`Cost` 开始尊重 `at` 后，含 deepseek 模型行的 claude 结果会变化——这正是 §8.1 登记的缺口修复。若 `goldens/claude-reports.json` 因此失配，**先确认差异全部落在 deepseek 时段费率的模型上**，再重铸并 diff 审查（`node clients/go/scripts/gen-claude-goldens.mjs`），把重铸理由写进下一个提交信息；不得为了让测试变绿而回退 `FindAt`。
- [ ] **Step 6: Commit**：`feat(nativepricing): add event-time pricing and per-model long-context thresholds`

---

### Task 8: Provider 重接线 + 开关 + hook 双源和解

**Files:**
- Create: `clients/go/internal/collect/providers/codex/native.go`、`native_test.go`
- Modify: `clients/go/internal/collect/providers/codex/provider.go`（`useNativeCodex` 分派）
- Modify: `clients/go/internal/collect/providers/codex/register.go`（`RegisterNative`）
- Modify: `clients/go/internal/collect/providers/codex/provider_scope.go`（hook 路径 native 分支）
- Modify: `clients/go/cmd/bench-collect/measure.go`（native 参数表若需同步；ccusage 侧不动）

**精确规则:**
- 开关（对称 `providers/claudecode/native.go:33-37`）：`const useNativeCodex = false`，注释说明「默认 ccusage，翻转是独立提交」。
- 接线点：`provider.go:71 Collect` 最外层分派（与 claude 相同位置），native 分支保留原有的 timezone/collectedAt 解析、pricing `Prepare`、`ResolveScope(pricing.Scope{Agent:"codex", Report:"daily"})` 与 `ProjectCodexDailyCosts`/`applyCollectedCodexContextPricing` 后处理——**native 只替换「跑 ccusage 拿报表」这一步**。
- 适配器入口：`nativeCollect` 读取 `Options`（Timezone/Since/Until/StateDir/Env），解析 codex homes，跑 `LoadGroups` + `ReportJSON`（daily 与 session 两次，语义等价于 provider 的两次子命令），把 JSON 交给 `ccusage.NormalizeCcusageDailyJSON`（`Sessions` 传 session 报表）。空报告 → 空快照，不报错。
- `RegisterNative(contract.SourceCodex, nativeProvider{})` **无条件**执行。
- hook 路径（§6.1.3）：保留 `CollectHookIncremental` 的 cursor/pending 语义；把 `assertHookReconciliationSnapshots` 的 ccusage 侧换成「同一原生实现整窗重算」，覆盖的 `(date, model)` 必须一致，否则 fail-closed。**注意 codex hook 的既有复杂度**（profile cursors、legacy 迁移、context-pricing pending、reusable pending 去重）必须保留，`hook_profiles.go` 与 `provider_scope.go` 只改数据来源不改调度。
- `cmd/parity` 与 `bench-collect` 零逻辑改动即可受益；若 native 侧需要不同参数（比如 `--single-thread` 无意义），只影响 ccusage 侧命令构造，别改协议。

- [ ] **Step 1: 写失败测试**：`TestRegisterNativeAlwaysInstallsTheCodexProvider`；`TestUseNativeCodexDefaultsToTheCcusagePath`（stub runner 断言调用了 ccusage）；`TestNativeCollectMatchesNormalizePipeline`（Task 9 夹具）；`TestNativeHookRecomputesAndReconcilesTheSameWindow`；`TestNativeCollectReturnsEmptyForAnEmptyWindow`。
- [ ] **Step 2: 运行确认失败**。
- [ ] **Step 3: 实现**。
- [ ] **Step 4: 运行确认通过**（`go test ./internal/collect/providers/codex/ -count=1` 全绿，含既有 389 个测试）。
- [ ] **Step 5: Commit**：`feat(codex): wire the native adapter behind an internal switch`

---

### Task 9: 行级金样本 + CI 门禁 + 真机证据

**Files:**
- Create: `clients/go/scripts/gen-codex-goldens.mjs`、`clients/go/internal/collect/adapters/codex/goldens/codex-reports.json`、`goldens_test.go`
- Modify: `clients/go/scripts/check-deps.sh`（说明扩展为 codex 原生金样本门禁）
- Modify: `.github/workflows/go-client.yml`（native job 加 codex 适配器 `-race` 与生成器测试）
- Create: `docs/research/2026-11-XX-codex-native-parity.md`（真机 parity + bench evidence，脱敏）

**精确规则:**
- 生成器（对称 `gen-claude-goldens.mjs`）：spawn `codex daily --json --offline` 与 `codex session --json --offline`，env 经 `child-env.mjs` 剥 4 个凭据键；断言 `ccusage --version` = 20.0.33；夹具树含：普通累积、`last_token_usage` 缺省、compacted 配对、fork 重放（含 1s burst）、`codex-auto-review`、`thread_settings` 的 fast/flex、`.jsonl.zst` 拼接与截断帧、带空格的大行、坏 UTF-8/坏行。
- 金样本覆盖 `--mode auto` 与 `--mode calculate` 两组；窗口固定；**不传 `--config`**（与 claude 金样本同口径）。
- CI 只跑 native vs 金样本；ccusage 不再参与 native 门禁。
- 真机 evidence：`go run ./cmd/parity -source codex -since <固定窗口> -until <昨天>` 要求全 match；`bench-collect -source codex -scenario {single,30d,full}` 记录中位数与 RSS，与 ccusage 对照；翻转 `useNativeCodex = true` 必须是独立提交且只改这一行，**仅当 parity 全 match 且新金样本全绿**。
- 注意：parity 的 ccusage 侧对 codex 带 `--offline`，与生产一致；若出现 costUSD diff 即为真分叉（不是 claude 那种在线/冻结语料差异）。

- [ ] **Step 1: 写夹具与生成脚本；生成金样本并提交**（用 `~/.tokenboard/bin/ccusage` 20.0.33）。
- [ ] **Step 2: 写 `goldens_test.go`（daily/session 两形状 + 两组 mode），运行 → FAIL（适配器尚未接全链路时）。**
- [ ] **Step 3: 接上 `nativeCollect` 后运行 → PASS。**
- [ ] **Step 4: 二次运行生成器确认字节稳定（`git diff` 无变化）。**
- [ ] **Step 5: Commit**：`test(adapters): freeze the Codex row-level goldens from ccusage 20.0.33`

---

## 完成标准（S3 出口）

1. `go test ./... -race`、`go vet ./...`、`gofmt -l .`、三平台交叉构建全绿。
2. 行级金样本（daily + session，auto/calculate）全绿，生成器可复现。
3. `cmd/parity -source codex` 在真机固定窗口全 `match`；`bench-collect` 三场景有数字。
4. `useNativeCodex` 保持 `false` 直至证据齐备；翻转是独立提交。
5. `docs/research/` 报告记录命令、窗口、结果与未覆盖边界（`.zst` 真机样本不足、`config.toml` TOML 依赖决策等）。
