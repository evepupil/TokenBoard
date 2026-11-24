# S4b: copilot 原生适配器实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **状态（2026-11-12 回填）：7 个 Task 已全部交付。** 执行期进度由 ledger 跟踪、结束后按流程删除，
> 本文件的步骤复选框未回填——**未勾选不代表未完成**。交付证据：`clients/go/internal/collect/adapters/copilot/`、
> `clients/go/internal/collect/providers/ccusagetool/copilot-goldens/`（含上游夹具快照）、
> `docs/research/2026-11-09-copilot-native-parity.md`。

**Goal:** 用纯 Go 原生实现替换 `ccusage copilot daily|session --json` 子进程——读取 `~/.copilot/otel/**/*.jsonl`（OTel 导出）与 `~/.copilot/session-state/<dir>/events.jsonl`（累计快照），复刻 ccusage v20.0.33 的 OTel 分类去重、快照区间差分、OTel 替换判定与 credit gap 对账，产出同形状报表 JSON。

**Architecture:** 新增 `clients/go/internal/collect/adapters/copilot`（按 agent 调研的分层：`paths.go`、`otel.go`、`session_state.go`、`reconcile.go`（纯函数）、`loader.go`、`report.go`）。复用 S4a 的 `adapters/tools` 共享层（读文件/宽容字段/时间戳/报表行/定价）。`reconcile.go` 做成输入 `[]Entry, []CreditSnapshot, bounds` → 输出 `{intervals, otelAfter, attributedNano, gaps}` 的纯函数，这是唯一能低成本复刻 Rust 25 个 loader 测试的形态。

**Tech Stack:** 同 S4a。

**Spec:** `docs/superpowers/specs/2026-11-03-native-usage-sources-design.md` §9.4.2（copilot 单列）、§8（金样本）。

**语义事实来源:** ccusage v20.0.33 @ `1308c416`，`rust/adapters/copilot/src/{paths,parser,loader,report}.rs`、`rust/adapters/copilot/tests/fixtures/**`（**上游自带的集成夹具，直接作为金样本输入**）、`rust/crates/ccusage/tests/copilot_cli.rs` 与 6 份快照。源码已在 `/tmp/ccusage-src-1308c416/ccusage-1308c416`。

## 特殊情况（用户 2026-11-08 明确）

本机无 copilot 使用数据（`~/.config/github-copilot` 只是 2025-04 的 IDE 符号缓存，全盘无 `otel/`/`session-state/`）。因此：

- 语义**完全以 ccusage 源码为准**；不试图从本机数据反推。
- 真机 parity 标注 N/A；证据体系 = 上游集成夹具 + 金样本（由 ccusage 20.0.33 一次性 mint 并冻结）+ 逐条算法单测（对照 `loader.rs:1519-1752` 的 8 类 credit gap 用例）。
- 若上游 copilot 日志格式在 20.0.33 后演进，属「冻结语义 vs 现实漂移」已知边界，写入报告，不在本阶段追逐。

## Global Constraints

- 同 S4a 的全部约束（报表形状、时间戳严格解析、饱和算术、宽容字段、产物边界、开关不回落）。
- **两路数据源与合并顺序必须照抄**：`session_state.entries ++ otel_entries ++ credit_gaps`，时间戳稳定排序（`loader.rs:116-124`）；三路之间不再按键去重，只靠 `otel_after` 时间戳抑制 OTel 行（`loader.rs:105-114`）。
- **`--since/--until` 两套语义并存**：条目级字符串比较 + copilot 内部毫秒半开区间（until 为次日 0 点、开，`date_utils.rs:212-225`）。
- credit 单位：nano-AIU；`cost_usd = nano_aiu / 1e11`（1 AIU = 1e9 nano = $0.01，`loader.rs:373-374`）；credit gap 条目模型固定 `"unknown"`、token 全 0。
- 成本公式若落在 `nativepricing` 外，乘积经 `nativepricing.Product`/`Sum`（arm64 FMADDD 守卫）。

## Review Focus

1. **区间差分**（`loader.rs:201-268`）：每 `(session,model)` 累计值差分（saturating）、`latest_visible` 之后丢弃、`>= otel_start` 丢弃、`< since` 丢弃、全 0 丢弃；`request_count` 同步差分。
2. **OTel 替换判定**（`loader.rs:164-195`）：任一区间 `request_count==0` → 不替换；累计计数比较**覆盖所有 shutdown、与窗口无关**；`start==0` 则无抑制。
3. **credit gap 对账**（`loader.rs:289-357`）：四道 skip（有 OTel 条目 / 全 shutdown / shutdown 的 nano 为 None）、舍去最后 shutdown 前的 checkpoint、running max、**后缀最小值衰减**（后续 shutdown 补报会回退先前差额）、单调增量、日期归属落在首次「稳定未被解释」的快照时间戳。
4. **OTel 分类与抑制矩阵**（`parser.rs:584-621`、`:550-582`）：四级优先级、重复 chat span 保留最早时间戳、同 response_id 不同用量视为不同调用。
5. **输入减法与 reasoning**：OTel 的 input 先减 cacheRead+cacheCreation；reasoning 不计入 output，仅当 total 表明未含时才成 extra。session-state 的 reasoning 已在 output 内。

---

### Task 1: 包骨架 + 路径发现（两路 + 文件导出器覆盖）

**Files:** Create `adapters/copilot/paths.go`、`paths_test.go`

**精确规则（`paths.rs:20-83`）:** 根 `COPILOT_HOME`（trim 非空）否则 `~/.copilot`；OTel = `<root>/otel/**/*.jsonl`（递归）；session-state = `<root>/session-state/<dir>/events.jsonl`（**只下一层，仅此文件名**）；`COPILOT_OTEL_FILE_EXPORTER_PATH` 单个已存在文件追加为 OTel；按路径去重（先登记者保留 kind）、全局按路径排序。

- [ ] **Step 1: 写失败测试**：`TestCopilotPathsOtelsRecurseAndSessionStateDoesNot`、`TestCopilotFileExporterPathIsAnExtraOtelFile`、`TestCopilotDedupKeepsFirstKind`。
- [ ] **Step 2: 确认失败** → `Step 3 实现` → `Step 4 通过` → `Step 5 Commit`：`feat(copilot): add the copilot data-source discovery`。

---

### Task 2: session-state 快照解析（shutdown / checkpoint）

**Files:** Create `session_state.go`、`session_state_test.go`

**精确规则（`parser.rs:177-373`）:** 仅 `session.shutdown` / `session.usage_checkpoint`；session_id = 父目录名（空 → 整文件空）；缺 type/timestamp 或不可解析 → 跳过。shutdown 的 `modelMetrics` 逐模型：`usage.inputTokens`（含缓存）减 `cacheReadTokens+cacheWriteTokens`、`reasoningTokens`、`requests.count`、`totalNanoAiu`（全部模型都带才保留 total，`parser.rs:285-306`）；空模型名或五项与 request_count 全 0 → 跳过。checkpoint 仅 `totalNanoAiu`，无 total 不产快照。`nano_aiu()` 非有限/负 → None 否则 round u64。`dedup_key`：有事件 id → `shutdown:{session}:{id}:{model}`，否则 `shutdown:{session}:{ts}:{model}:{用量}:{count}`；快照键 `credits:{session}:{id|is_shutdown:ts:total}`。

- [ ] **Step 1: 写失败测试**：`TestCopilotShutdownSubtractsCacheFromInput`、`TestCopilotShutdownTotalRequiresAllModels`、`TestCopilotCheckpointWithoutTotalProducesNoSnapshot`、`TestCopilotSessionIDFromParentDir`、`TestCopilotNanoAiuRejectsNonFinite`。
- [ ] **Step 2–5**：确认失败 → 实现 → 通过 → Commit `feat(copilot): parse session-state usage snapshots`。

---

### Task 3: OTel 解析（分类 + 时间戳 + 属性）

**Files:** Create `otel.go`、`otel_test.go`

**精确规则（`parser.rs:22-53,400-461,623-691,794-839`）:** `attributes` 动态 map；预过滤 `"attributes"`。四类：ChatSpan（span 且 `gen_ai.operation.name=="chat"` 或 name 前缀 `"chat "`）、AgentSummarySpan（`invoke_agent`）、InferenceLog（非 span 且 `event.name=="gen_ai.client.inference.operation.details"` 或 body 前缀 `GenAI inference:`）、AgentTurnLog（`copilot_chat.agent.turn`）。token 属性含退化键；**input 减 cache_read+cache_creation**；reasoning 不计 output，仅 total 未含时成 extra。时间戳优先级 `endTime>startTime>hrTime>_hrTime>time>timestamp>observedTimestamp>timeUnixNano`；数组 `[秒,纳秒]`；标量量级：`>=1e17` ns、`>=1e14` µs、`>=1e11` ms、否则 s；全失败 → mtime → `utc_now`。模型 `gen_ai.response.model → gen_ai.request.model`，`normalize_copilot_model`（去 `-1m-internal`/`-1m` 后缀，先长后短）。session 属性优先级 3 级（同级取**最后一个**，即 `session.id` 胜 `gen_ai.conversation.id`）→ trace 最佳 → traceId → `unknown-session`。

- [ ] **Step 1: 写失败测试**：`TestCopilotOtelsClassifiesFourKinds`、`TestCopilotOtelInputSubtractsCacheBuckets`、`TestCopilotReasoningOnlyExtraWhenTotalExcludesIt`、`TestCopilotTimestampPriorityAndMagnitudeGuess`、`TestCopilotSessionIDTieTakesLastAttribute`、`TestCopilotModelSuffixNormalization`。
- [ ] **Step 2–5**：确认失败 → 实现 → 通过 → Commit `feat(copilot): parse OTel exporter rows`。

---

### Task 4: 候选抑制与 dedup key

**Files:** Create `dedupe.go`、`dedupe_test.go`

**精确规则（`parser.rs:550-621,693-726`）:** 四级抑制矩阵；重复 chat span（8 元用量相同）保留**最早时间戳**；同 response_id 不同用量 = 不同调用；`dedup_key`：Chat/AgentSummary → `trace:span`（缺则 `span:{session}:{ts}:{index}`）；Inference → `log:trace:span`；AgentTurn → `agent-turn:{trace|session}:{turn.index|idx-index}[:index]`。

- [ ] **Step 1: 写失败测试**：`TestCopilotDuplicateChatSpanKeepsEarliest`、`TestCopilotSameResponseIDDifferentUsageBothCount`、`TestCopilotSuppressionMatrixOrder`。
- [ ] **Step 2–5**：确认失败 → 实现 → 通过 → Commit `feat(copilot): add the OTel candidate suppression matrix`。

---

### Task 5: 对账纯函数（区间差分 + OTel 替换 + credit gap）

**Files:** Create `reconcile.go`、`reconcile_test.go`

**精确规则（`loader.rs:140-377`）:** 输入快照集合与 `[since, until)` 毫秒边界，输出 `intervals`、`otelAfter`、`attributedNano`、`gaps`。区间：按 `(session,model)` 分组、`(timestamp,index)` 排序、首条原样、之后 saturating 差分；丢弃条件按 Review Focus 1。OTel 替换按 Review Focus 2。credit gap 按 Review Focus 3（含后缀最小值衰减、`gap = lasting - reported`、`reported = max(reported, lasting)`、日期=首次稳定未解释的快照时间戳、模型 `unknown`、成本 `nano/1e11`）。

- [ ] **Step 1: 写失败测试**（对照 `loader.rs:1519-1752` 的 8 类用例逐条）：`TestCopilotIntervalsDifferencing`、`TestCopilotDiffDropsBeyondLatestVisible`、`TestCopilotOtelReplacementStartsAtFirstExcess`、`TestCopilotOtelReplacementIgnoresWindow`、`TestCopilotCreditGapSkipWhenOtelsPresent`、`TestCopilotCreditGapSkipWhenAllShutdown`、`TestCopilotCreditGapSuffixMinimumDecays`、`TestCopilotCreditGapAttributedIncludesOutOfWindowShutdowns`。
- [ ] **Step 2–5**：确认失败 → 实现 → 通过 → Commit `feat(copilot): port the interval and credit-gap reconciliation`。

---

### Task 6: loader 编排 + 报表

**Files:** Create `loader.go`、`report.go`、`copilot_test.go`

**精确规则（`loader.rs:49-124,434-521`、`report.rs:11-20`）:** 并行读但保序；单文件失败仅 debug。合并：先汇总三路 → 计算 `(session,model)->Vec<ts>` → 区间化（产出 otel_after 与 attributed）→ credit gap → OTel 抑制 → 拼接稳定排序。`usage_entry_to_loaded`：`costUsd` 仅 credit gap 有值；计价时 extra 并入 output；`missing_pricing_model_for_usage`（Auto 且有内嵌 cost → 无缺失）。`projectPath` 恒 `GitHub Copilot CLI`；`version` 恒 None；session 数 = distinct session_id。

- [ ] **Step 1: 写失败测试**：`TestCopilotMergesThreePipelinesInOrder`、`TestCopilotCreditGapOnlyHasCost`、`TestCopilotReportShapeMatchesFocusedSnapshot`（用上游夹具的等价合成树）。
- [ ] **Step 2–5**：确认失败 → 实现 → 通过 → Commit `feat(copilot): orchestrate the copilot loader and report`。

---

### Task 7: 金样本（上游夹具）+ CI 门禁 + Provider 接线

**Files:** Create `clients/go/scripts/gen-copilot-goldens.mjs`、`adapters/copilot/goldens/copilot-reports.json`、`goldens_test.go`；Modify `check-deps.sh`、`go-client.yml`、`providers/ccusagetool/native.go`（把 copilot 加入命令派发）

**精确规则:**
- 生成器：把上游 `rust/adapters/copilot/tests/fixtures/**`（otel/trace.jsonl + session-state/{session-a,session-b,session-credits}/events.jsonl）复制为仓库内夹具（脱敏、保留结构），spawn `ccusage copilot {daily,session} --json --offline -z UTC --since 20260101 --until 20260228`，mint 金样本；断言版本。
- 同时参考上游 6 份快照（`crates/ccusage/tests/snapshots/copilot_cli__*`）作为独立交叉校验：native 输出应与其 JSON 快照等价（键序规范化后）。
- provider 接线复用 S4a Task 14 的 native runner（copilot 走同一 `contract.CcusageToolCommand` 表，命令名 `copilot`）。
- 真机 parity：N/A（本机无数据），报告写明。

- [ ] **Step 1: 写夹具 + 生成脚本；mint 金样本。**
- [ ] **Step 2: 写 `goldens_test.go` → FAIL。**
- [ ] **Step 3: 接通后 → PASS。**
- [ ] **Step 4: 与上游 6 份快照交叉校验。**
- [ ] **Step 5: Commit**：`test(copilot): freeze the copilot row-level goldens from ccusage 20.0.33`。

---

## 完成标准（S4b 出口）

1. `go test ./internal/collect/adapters/copilot/... ./internal/collect/providers/ccusagetool/... -race` 全绿。
2. copilot 金样本（daily + session）全绿，且与上游 6 份 JSON 快照交叉一致。
3. reconcile 纯函数单测覆盖 8 类 credit gap 用例 + 区间/替换边界。
4. 真机 parity 记录为 N/A（本机无 copilot 数据），理由写入 `docs/research/` 报告。
5. `useNativeTools` 维持 `false`，翻转在 S4 总盘点（S5 前）统一执行。
