# S5: 移除 ccusage 获取层、翻转原生开关、CI 与文档收尾 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Go 客户端上删掉 ccusage 的获取层与子进程执行层，把 `useNativeClaude` / `useNativeCodex` / `useNativeTools` 三个编译期开关翻到原生，跑出 §9.3 要求的 native vs ccusage 性能报告，并让 skill、release 流水线与文档与「零 ccusage 依赖」一致。

**Architecture:** 先补最后一处证据缺口（§8 阻塞项「端到端 snapshotHash 影子双跑」只有 ccusage 侧有），再按 spec §10.1.4 的闸门翻转开关——三个来源各自独立提交、可单独回滚；最后才删获取层（spec D9：一个 commit 只删获取，不夹带语义改动）。`internal/ccusage` 不能整包删：normalize 契约、`ScrubCredentialEnv`、`PackageRunner`/`CommandOptions` 类型仍被 native 路径与 self-update 使用，把它们留在原包，只删获取/执行子层。

**Tech Stack:** Go 1.27、TypeScript collector（仅作为对照，不修改）、pnpm workspace、GoReleaser、GitHub Actions、Cloudflare 无关。

**Spec:** `docs/superpowers/specs/2026-11-03-native-usage-sources-design.md`（§2 G1/G5/G6、§6.1.4、§8 阻塞项、§9.3、§10.1、§11 D9）。证据文档：`docs/research/2026-11-05-claude-native-parity.md`、`2026-11-08-codex-native-parity.md`、`2026-11-09-tools-native-parity.md`、`2026-11-09-copilot-native-parity.md`。

**语义事实来源（实现时必须对照）:** ccusage v20.0.33，commit `1308c416`；Rust 源码 `/tmp/ccusage-refetch/ccusage-1308c416/rust/`（若不存在，按 `docs/research/2026-11-09-tools-native-parity.md` R4 的说明从 GitHub 重新抓同一 commit）。每条规则附 `file:line`。真实二进制：`node_modules/.pnpm/@ccusage+ccusage-darwin-x64@20.0.33/node_modules/@ccusage/ccusage-darwin-x64/bin/ccusage` 或 `~/.tokenboard/bin/ccusage`（同为 20.0.33）。

## Global Constraints

- 三个开关是编译期常量、不是环境变量（`clients/go/internal/collect/providers/{claudecode,codex,ccusagetool}/native.go`），每次翻转是独立 commit，且必须能在失败时单独 `git revert`。
- 翻转的验收口径按 spec §2 G2 重定义后的 parity 基准：**非成本字段逐项一致（`onlyInNative`/`onlyInCcusage` 为 0），成本差异逐条可归因到「冻结语料 + 服务端 override」口径**；§10.1.4 的「全 match」对 claude 不可满足（2026-11-10 口径复核，见 `docs/research/2026-11-05-claude-native-parity.md` §9）。
- 删除类改动 fail-closed：任何被删符号若仍被非测试代码引用，编译失败即停；不得为了让编译通过而保留「静默降级」分支。
- TS collector（`packages/collector`）按 spec D6 保持使用 ccusage，**本计划的任何删除都不得改动 TS 侧行为**（`packages/collector/package.json` 的 `ccusage` 依赖保留）。
- `packages/collector/ccusage.json` 与 `clients/go/internal/pricing/ccusage.json` 必须逐字节相同（CI `workspace typecheck` 的 `diff -u` 断言）；原生路径继续使用这份 bundled override，不因移除 ccusage 而删除。
- 凭据剥离名单三处一致（`clients/go/internal/ccusage/credentials.go`、`packages/collector/src/child-env.ts`、`skills/tokenboard/scripts/child-env.mjs`），由既有测试守。
- 本机负载高时禁止跑全量 `go test -race ./...`、`pnpm -r test`；定向单包测试 + 交叉构建替代，CI 承担全量。
- 所有证据（parity/bench 数字、命令、出处）写进 `docs/research/`，不写「大概」「应该」。

## Review Focus

1. **翻转后 `--source all` 的每一条路径仍能工作**（含 hook 模式、`TOKENBOARD_SINCE=all`、空 HOME）：由 Task 3/4/5 各自的 `tokenboard-*` 全源 smoke 测试覆盖。
2. **翻转后不再 spawn ccusage**：由 Task 3/4/5 的进程级断言（native 路径内 `os/exec` 零调用）覆盖；`git grep ccusage` 的 G1 验收在 Task 8 覆盖。
3. **删获取层时 `internal/ccusage` 的剩余契约（normalize/凭据/runner 类型）不被误删**：由 Task 7 的「保留符号清单」测试与 `go build ./...` 覆盖。
4. **release 归档契约**（不再含 `ccusage`/`LICENSE.ccusage`，`self-update` e2e 与 skill 的 binary 安装）与 `go-client.yml` 的 archive 断言同 commit 改：由 Task 9/10 覆盖。
5. **性能报告口径**：native 与 ccusage 在同一语料、同一窗口、同一 config 下测得；`full` 场景 native 墙钟可能更高（`2026-11-05-claude-native-parity.md` §5.3 已记录 +22.1%），报告必须如实呈现并写清取舍：由 Task 6 覆盖。

## 前置依赖与用户裁决（2026-11-10）

- 用户同意「先提交本轮修复 → 费用覆盖探针 → 翻转开关 → 再删获取层」。本轮修复已提交（`b3a8a53`、`5fb6a2f`、`3c65b28`、`22d2dff`、`34dcd38`、`1b963af`）。
- 2026-11-10 费用覆盖探针（`docs/research/2026-11-10-s5-flip-coverage.md`）结论：
  - 本机窗口 `2026-11-02..2026-11-08` 的 daily 链路去重幸存条目中，**带行内 `costUSD` 的条目为 0**；
  - 三路总费用：ccusage 在线 9388.10 → ccusage 离线/内置表 8669.30（-7.7%）→ native 与 ccusage 离线**逐位一致**；
  - -7.7% 的成因是 LiteLLM 在线价表与 ccusage 20.0.33 构建期快照的费率差异（deepseek 族**双向**不同），**不是漏模型**；
  - 唯一真正的漏价 `hy4-free`（~$7/周）已补 `pricingOverrides`（`1b963af`），`step-5-preview`（~$0.21/周）由 `step-5-preview-free` 刻意置零，其余未覆盖模型（`group/auto-dfmodel`、`deepseek_for_coding`、`kimi-k3.1`）在 ccusage 在线/离线两侧均为 0。
- **决策（2026-11-10）：** 补 `hy4-free` override，接受剩余 7.7% 的总差额，并在发布说明中明示——这是 spec §2 G2 已定义的口径边界，不是缺陷修复。
- Codex、11 个工具来源、copilot 的闸门与 gap：`2026-11-08-codex-native-parity.md`（10/10 match）、`2026-11-09-tools-native-parity.md`（3 个有数据的来源方向 0 diff；`CCUSAGE_MODEL_ALIASES` 不移植，R1）、`2026-11-09-copilot-native-parity.md` §4（真机 N/A，靠金样本 + 上游快照交叉）。

---

### Task 1: 把「翻转时潜在少记费用」的探针固化为 CI 可见的事实（不修改生产行为）

**Files:**
- Create: `clients/go/cmd/bench-collect/reported_cost.go`（新增子命令或 flag `-coverage`，只读扫描并输出逐模型统计）
- Create: `clients/go/cmd/bench-collect/reported_cost_test.go`
- Modify: `clients/go/cmd/bench-collect/main.go`（参数解析、help 文本、退出码）
- Create: `clients/go/scripts/reported-cost-coverage.mjs`（用真实 ccusage 语料 + 真实 home 生成报告 JSON 的驱动脚本；不写 home）
- Test: 同目录 `_test.go`，夹具用 `clients/go/internal/collect/adapters/claude/testdata/claude-fixture`

**Interfaces:**
- Consumes: `claude.ScanFiles`、`claude.PruneByMTime`、`claude.ParseDailyLineEntries`、`claude.NewCostFunc`、`nativepricing.LoadEmbeddedCorpus`
- Produces: `bench-collect -coverage -source claude-code [-roots DIR] [-since D -until D]`，输出 `{models:[{model, entries, reported, corpusHit, corpusMiss, costUsd, cacheReadTokens}], totals:{...}}`，退出码与 `-json` 同语义。

**精确规则（Rust `adapters/claude/src/daily.rs:317-330`，`lib.rs:516-524`）:**
- 与 daily 链路完全同参：`PruneByMTime` 用同一 `since` 与 timezone；`ModeAuto`；不加 `--config`（bundled override 通过 `NewCostFunc(nil, ModeAuto)`）。
- 只统计去重幸存条目（`NewDedupe(DedupeDaily).Entries()`），并在报表层用 `DateWithinRange` 裁到 `[since, until]`。

- [x] **Step 1: Write the failing test** —— `TestCoverageCountsReportedCostsAndCorpusHits`：夹具 `claude-fixture` 中构造 3 个模型行（一个有 `costUSD`、一个语料命中无 `costUSD`、一个语料未命中），断言输出里 `reported=1 / corpusHit=2 / corpusMiss=1`，且 `costUsd` 之和等于 `NewCostFunc` 逐条求和。
- [x] **Step 2: Run test to verify it fails** —— `cd clients/go && go test ./cmd/bench-collect/ -run TestCoverage -count=1` → 编译失败（无 `-coverage` 处理）。
- [x] **Step 3: Implement** —— 按上表签名实现；输出结构用 `json` tag；文本模式打印表格。
- [x] **Step 4: Run test to verify it passes** —— 同命令 → PASS；再跑 `go test ./cmd/bench-collect/ -count=1` 全绿。
- [x] **Step 5: 真实数据跑一次并把结论写进 `docs/research/2026-11-10-s5-flip-coverage.md`** —— 命令：`go run ./cmd/bench-collect -coverage -source claude-code -roots "$HOME/.claude" -since 2026-10-25 -until 2026-11-08 -json > /tmp/coverage.json`（本机，只读），连同 `2026-11-05` §9 的 diff 归因写清「45 条来自父行分摊」的推导。
- [x] **Step 6: Commit** —— `feat(bench): count reported costs and corpus coverage per model`

> **偏离（2026-11-10 执行时登记）**：Task 1 没有按计划固化成 `bench-collect -coverage` 子命令。
> 费用覆盖结论是用一批一次性探针测出来的（`docs/research/2026-11-10-s5-flip-coverage.md` §5，
> 探针跑完即删），Step 1–6 的测试与提交都没有发生。代价：这份证据无法在 CI 里复跑，
> 将来若怀疑费用覆盖变化，要按 §5 重建探针。判断依据：探针只服务于「翻转前要不要补 override」
> 这一次决策，而 `hy4-free` 补齐后残留差异是价表口径而非覆盖问题，固化成常驻门禁的收益不足以
> 抵消它要维护的夹具。

### Task 2: 用覆盖探针结果固化基线（已合入 `1b963af`，仅补验证）

**Files:**
- Modify: `docs/research/2026-11-10-s5-flip-coverage.md`（加"翻转前必读"小节，摘要三路对照表）
- Modify: `.superpowers/sdd/2026-11-09-s4b-copilot/progress.md`（Ruling 记录：45 条差异的最终归因）

**Interfaces:**
- Consumes: Task 1 的实测输出（2026-11-10 已交付）
- Produces: 无代码接口；文档事实

**精确规则（已被 `1b963af` 完成，仅复核）:**
- `2026-11-05` §9 的表格行「native 按 `ModeAuto` 取行内 `costUSD`」改为「native 侧该模型未命中语义 → 计 0 → 父行总额变小 → 共有分摊摊到同日其它模型」（`34dcd38` 已完成）。
- `1b963af` 的 flip-coverage 文档汇总三路数值 + `hy4-free` 的补齐说明。**不得在后续 Task 里删除或弱化「7.7% 是口径边界」的表述**。

- [x] **Step 1–4: 已完成（`22d2dff`/`34dcd38`/`1b963af`）**
- [x] **Step 5: 复核 `1b963af` 后 §9 与 `2026-11-10-s5-flip-coverage.md` 一致** —— `rg -n "行内 .costUSD|parent.*分摊|7\.7%" docs/research/`，每条都要读得通、引用同一份 measured 数据。
- [x] **Step 6: 追加 Ruling 到 ledger** —— 「45 条 diff 的最终归因：父行分摊 + 在线/离线价表差异；7.7% 是 G2 边界不是缺陷」。

### Task 3: 翻转 `useNativeCodex`

**Files:**
- Modify: `clients/go/internal/collect/providers/codex/native.go:45`（`const useNativeCodex = false` → `true`）
- Modify: `clients/go/internal/collect/providers/codex/native_test.go:127-128`（把「必须为 false」改为「为 true 时 runner 不被调用」）
- Create: `clients/go/internal/collect/providers/codex/native_flip_test.go`
- Modify: `docs/research/2026-11-08-codex-native-parity.md`（新增「翻转」一节：命令、结论）
- Modify: `.superpowers/sdd/2026-11-09-s4b-copilot/progress.md`（Ruling）

**Interfaces:**
- Consumes: `codex.Collect` 既有 native 分支（`provider.go:134` `native := useNativeCodex || options.useNativeReport`）
- Produces: 默认构建下 `Collect` 不再调用 `ccusage.Resolve`/`RunJSON`

**精确规则:**
- 翻转后 `resolveRunner` 不应再被调用；用一个注入的 `Runner` 计数器断言零调用。
- `shadow` 子命令必须仍能比较 TS 与 Go：native registry 已无条件注册（`register.go:12`），不用改。

- [x] **Step 1: Write the failing test** —— `TestNativeCodexIsTheDefaultPath`：构造 `codex.Options{Runner: countingRunner}` + 空 `CODEX_HOME` 夹具，断言 `useNativeCodex == true` 且 `countingRunner.calls == 0`（当前 `false` 时该测试失败）。
- [x] **Step 2: Run test to verify it fails** —— `go test ./internal/collect/providers/codex/ -run TestNativeCodexIsTheDefaultPath -count=1` → FAIL（断言 false）。
- [x] **Step 3: Implement** —— 只改常量与旧断言；`native_test.go:127-128` 改为「为 true」。
- [x] **Step 4: Run test to verify it passes** —— 同上 → PASS；`go test ./internal/collect/providers/codex/ ./internal/collect/adapters/codex/ -count=1` 全绿；`go build ./...`。
- [x] **Step 5: 真机证据** —— `go run ./cmd/parity -source codex -since <T-14> -until <T-1> -ccusage-bin <bin> -json` 与 `tokenboard shadow --source codex --until <T-1>` 各跑一次，写进 docs。
  **实际**：`parity -source codex` 在 S5 完成后（`c728165`）重跑 `status: match`、8/8 快照一致；
  负载降到 47 后补跑 `shadow-dual-run.mjs --client <a81450b> --source codex --until 2026-11-09`
  得 **match、10 快照**（`docs/research/2026-11-10-s5-post-flip-dual-run.md` §2）。
- [x] **Step 6: Commit** —— `feat(codex): use the native report source by default`

### Task 4: 翻转 `useNativeTools`（11 个工具 + copilot）

**Files:**
- Modify: `clients/go/internal/collect/providers/ccusagetool/native.go:43`
- Modify: `clients/go/internal/collect/providers/ccusagetool/native_tools_test.go:66-67`
- Create: `clients/go/internal/collect/providers/ccusagetool/native_flip_test.go`
- Modify: `docs/research/2026-11-09-tools-native-parity.md`、`2026-11-09-copilot-native-parity.md`

**Interfaces:**
- Consumes: `tools.HasNativeAdapter`、`nativeToolRunner`、copilot 的 `RegisterWindowed`
- Produces: 12 个工具来源默认走进程内适配器

**精确规则:**
- 翻转后 `ccusage.ResolvePackageRunner` 不得被调用（用 runner 计数器断言）。
- 空 daily 短路（工具未安装 → 不发 session 调用）必须仍在 native 路径上：用 `-source all` 在无工具安装的临时 HOME 下断言零 ccusage 调用、快照为空。

- [x] **Step 1: Write the failing test** —— `TestNativeToolsAreTheDefaultPath`：12 源循环 + 计数器 runner，断言 `useNativeTools == true` 且调用数为 0；`TestNativeToolsEmptyHomeNeedsNoCcusage`。
- [x] **Step 2: Run test** —— 当前预期 FAIL。
- [x] **Step 3: Implement** —— 常量 + 旧断言。
- [x] **Step 4: Run test** —— PASS；`go test ./internal/collect/providers/ccusagetool/ ./internal/collect/adapters/tools/ ./internal/collect/adapters/copilot/ -count=1` 全绿。
- [x] **Step 5: 证据** —— 本机 `node skills/tokenboard/scripts/shadow-dual-run.mjs` 输出追加进 docs（含 `not-installed` 与 `empty` 的计数）；copilot 记 Ruling「真机 N/A，闸门 = 金样本 + 上游快照」。
  **实际**：工具族 12 源 S5 后仍未做双跑——`shadow-dual-run.mjs` 会在 TS 侧对每个源跑完整
  ccusage 窗口，而本机多数工具未安装，能得到的最好结果是 `empty`。copilot 的 Ruling 已记在
  `.superpowers/sdd/2026-11-09-s4b-copilot/progress.md`；工具源的等价性证据仍是 2026-11-09 的
  parity 与金样本，**不是**双跑。**未覆盖**：翻转后工具源的真实数据双跑。
- [x] **Step 6: Commit** —— `feat(tools): use the native adapters by default`

### Task 5: 翻转 `useNativeClaude` 并更新 hook 路径证据

**Files:**
- Modify: `clients/go/internal/collect/providers/claudecode/native.go:37`
- Modify: `clients/go/internal/collect/providers/claudecode/native_test.go:152-153`
- Create: `clients/go/internal/collect/providers/claudecode/native_flip_test.go`
- Modify: `docs/research/2026-11-05-claude-native-parity.md`（§6.1 结论改为「已翻转」，附 §9 证据）

**Interfaces:**
- Consumes: `nativeCollect`、`nativeCollectHook`（`§6.1.3` 两路交叉）
- Produces: claude-code 默认走 native，含 hook 模式

**精确规则:**
- hook 模式零网络（AGENTS.md 跨端不变量）：断言 hook 路径不创建 HTTP 请求（`http.DefaultTransport` 计数桩）。
- `--since/--until` 仍走 `sessionusage.AssertValidDateFilterRange`（与 TS 一致的拒绝规则）。

- [x] **Step 1: Write the failing test** —— `TestNativeClaudeIsTheDefaultPath`（含 hook 子用例）+ `TestNativeClaudeHookMakesNoNetworkRequest`。
- [x] **Step 2: Run test** —— 预期 FAIL。
- [x] **Step 3: Implement** —— 常量 + 旧断言 + 注释里的「until it flips」表述。
- [x] **Step 4: Run test** —— PASS；`go test ./internal/collect/providers/claudecode/ ./internal/collect/adapters/claude/ -count=1` 全绿。
- [x] **Step 5: 证据** —— 重跑 `parity`（窗口同 §9）+ `shadow --source claude-code --hook`，把结果写进 §9 的「翻转后复验」小节；明确记录 45 条差异的性质（Task 2 的口径）。
  **实际**：「翻转后复验」小节在 `2026-11-05-claude-native-parity.md` §9 落地；负载降到 47 后补跑
  `shadow-dual-run.mjs --source claude-code --until 2026-11-09`：513 快照（382 匹配 + 131 差异）、
  0 only-in-side，131 条差异**只差 `costUsd`**，逐行倍率 0.50×–4.74×，其中 `kimi-k3.1` 的 1.98 倍经三路对照
  （在线精确命中 vs 离线模糊命中）归因到价表口径（`2026-11-10-s5-post-flip-dual-run.md` §3）。
  **未覆盖**：`--hook` 路径与本机热 cursor 仍没有端到端双跑证据。
- [x] **Step 6: Commit** —— `feat(claude): use the native adapter by default`

### Task 6: 性能报告（§9.3 / G5）

**Files:**
- Modify: `clients/go/cmd/bench-collect/main.go`（`BytesRead` 的 `BytesReadPending` 说明改为「不测量」，或接入 `sessionfile` 的读取字节计数）
- Create: `docs/research/2026-11-10-native-vs-ccusage-benchmark.md`
- Modify: `docs/research/2026-11-03-baseline-artifacts/run.sh`（若脚本仍引用 `bench-collect` 旧 flag，同步）

**Interfaces:**
- Consumes: `bench-collect -source {claude-code,codex} -scenario {single,30d,full} -rounds 5 -ccusage-bin <bin> -json`
- Produces: 每个场景 5 轮中位数（墙钟、峰值 RSS、读字节），并写明本机负载（`uptime` 前后）

**精确规则:**
- 场景串行、每场景 5 轮、记录 `uptime`/`vm_stat`（`2026-11-03-native-vs-ccusage-baseline.md` §1.4 的口径）。
- `full` 场景 native 墙钟可能高于 ccusage（§5.3 已记录 +22.1%）：报告必须显式写出「单窗口过滤缺失时 native 无墙钟优势」的取舍，不粉饰。
- 读字节：若不接入计数，就在报告里写「未测量」并说明 `BytesReadPending` 语义仍为占位；**不得**用估算值冒充测量值。

- [x] **Step 1: 决定读字节口径** —— 读 `sessionfile.FingerprintFileAndPrefix`/`Read` 是否已有字节计数；若没有且成本高，按上表写「未测量」并修改 `BytesReadPending` 的注释与文本输出。
- [x] **Step 2: 跑 3 场景 × 2 源** —— 串行，每次前后 `uptime`；输出存 `/tmp`，报告只引用摘要。
  **实际只跑了 A/B 两个场景**（single、30d，claude-code 与 codex 各 5 轮）；`full` 未重测，
  沿用 `2026-11-05-claude-native-parity.md` §5.3 的 +22.1% 记录，`hook` 未单测（cursor 共享层，
  与实现选择无关）。原因与取舍写在 `docs/research/2026-11-10-native-vs-ccusage-benchmark.md` §4–§5。
- [x] **Step 3: 写报告** —— 表格 + 方法 + 环境 + 未覆盖边界；与 `2026-11-03` 基线和 `2026-11-05` §5 对齐。
- [x] **Step 4: 更新 S1 基线文档的「重要声明」** —— 把「S1 尚未实现任何 native provider」改为「native 对比见 2026-11-10 报告」。
- [x] **Step 5: Commit** —— `docs(research): report native vs ccusage collection performance`

### Task 7: 拆出获取层（不删，只移）

**Files:**
- Create: `clients/go/internal/ccusage/acquire/`（`Resolve`、`probeVersion`、`download`、`decodeIntegrity`、`fetchTarball`、`extractBinary`、npm 平台名映射）
- Create: `clients/go/internal/ccusage/exec/`（`RunJSON`、`runOnce`、`describeCommandFailure`、`readCommandTimeoutMs`、`readRetryDelay`、`sysproc_*.go`）
- Create: `clients/go/internal/ccusage/runner/`（`PackageRunner`、`ResolvePackageRunner`、`Args`、`ConfigArgs`）
- Modify: `clients/go/internal/ccusage/{acquire,command,package_runner,version}.go` → 删除或仅保留类型别名
- Modify: `clients/go/cmd/parity`、`cmd/bench-collect`、三个 provider 的 legacy 分支引用（暂以新包路径引用）

**Interfaces:**
- Consumes: 既有类型（`Binary`、`PackageRunner`、`CommandOptions`、`CommandRunner`）
- Produces: 新包对外的同名类型与方法；**不变的是行为**——本 Task 只搬位置，不改任何逻辑。

**精确规则:**
- `normalize.go`、`orderedjson.go`、`codex_totals.go`、`credentials.go` 留在 `internal/ccusage`（native 与 self-update 仍引用）。
- 用 `go build ./...` + `git grep` 清单断言：搬完后 `internal/ccusage` 不再 import `net/http`/`os/exec`（除 normalize 无关项）。

- [x] **Step 1: 写保留清单测试** —— `TestCcusageCoreKeepsOnlySharedContracts`：AST 扫描 `internal/ccusage/*.go`，断言非测试文件只导出 normalize/credentials/orderedjson/codex_totals 的符号。
- [x] **Step 2: Run test** —— 当前失败（获取符号仍在）。
- [x] **Step 3: 搬运** —— `git mv` 文件 + 新包实现，所有引用改路径；不合并逻辑。
- [x] **Step 4: Run test** —— PASS；`go test ./... -count=1`；`GOOS=windows/darwin/linux go build ./...`。
- [x] **Step 5: Commit** —— `refactor(ccusage): move the acquisition layers out of the shared package`

### Task 8: 删除获取层与子进程执行，退役相关环境变量

**Files:**
- Delete: `clients/go/internal/ccusage/acquire/`、`.../exec/`、`.../runner/`（全部内容）
- Delete: `clients/go/scripts/bundle-ccusage.mjs`、`clients/go/scripts/check-deps.sh`、`clients/go/testdata/ccusage-golden/`
- Delete: 三个 provider 的 legacy 分支（`claudecode.go:48-51,66-69,92-421`、`codex/provider.go` 的 ccusage 分支、`ccusagetool.go:50-54,66-79,111-115,168-221`）
- Delete: `cmd/parity`、`cmd/bench-collect` 的 ccusage 侧（或保留为 `cmd/parity` 仅 dev 构建并移除？——见下方 Ruling 说明：**本 Task 保留 `cmd/parity`/`cmd/bench-collect` 的 native 侧，删除 ccusage 侧，并在 header 写明已退役**）
- Delete: `gen-*-goldens.mjs` 的执行路径中的 `CCUSAGE_BIN` 分支（只保留 `--check` 读取提交文件的能力 → 见精确规则）
- Modify: `.goreleaser.yaml`（删 `dist-ccusage` 两段）、`.gitignore`、`.prettierignore`
- Modify: `.github/workflows/go-client.yml`（删 `deps`/`check-deps` job、`TOKENBOARD_CCUSAGE_BIN` env、archive 断言）
- Modify: `clients/go/internal/selfupdate/selfupdate.go`（删 `hasCcusage` 安装/陈旧告警，保留 `BundledBinDir` 的 tokenboard 主体）
- Modify: `skills/tokenboard/scripts/client-binary.mjs`、`status.mjs`、`sync.mjs`、`install-collector.mjs`（删 ccusage 提取/探测/`TOKENBOARD_CCUSAGE_CONFIG` 注入）
- Modify: `docs/specs/go-client-spec.md`、`README.md`、`SKILL.md`、`docs/model-pricing.md`、`AGENTS.md`、`clients/go/THIRD_PARTY_NOTICES.md`（只删「捆绑再分发」部分，源码派生许可保留）

**Interfaces:**
- Consumes: Task 7 之后的包布局；三个开关已翻转
- Produces: G1：`git grep -n 'ccusage' clients/go` 只剩 goldens 生成器（`--check` 模式）与注释中的语义出处；G6：环境变量退役

**精确规则（spec G1/G6）:**
- 金样本生成器的「重新 mint」能力依赖真实 ccusage 二进制；ccusage 从依赖里消失后，生成器改为「只校验、不生成」，并在 header 写明「冻结于 20.0.33，如需重新生成，按 `docs/research/2026-11-09-copilot-native-parity.md` 的方法在隔离环境用 20.0.33 二进制运行」。
- `TOKENBOARD_CCUSAGE_BIN`、`TOKENBOARD_FORCE_PACKAGE_RUNNER`、`TOKENBOARD_PACKAGE_MANAGER`（Go 侧）、`TOKENBOARD_DYNAMIC_CCUSAGE_CONFIG` 从 Go 与 skill-binary 路径退役；TS checkout 路径仍可读 `TOKENBOARD_PACKAGE_MANAGER`（D6）。
- 删除必须独立可回滚：**本 Task 一个 commit 只删获取/执行层**，文档/发布改动放 Task 9。

- [x] **Step 1: 写 G1 断言测试** —— `TestNoCcusageAcquisitionInProduction`：编译一个仅含 `cmd/tokenboard` 依赖的二进制，用 `go list -deps` 断言不包含 acquire/exec/runner 包；`git grep` 清单只允许白名单。
- [x] **Step 2: Run test** —— 当前失败。
- [x] **Step 3: 删除** —— 按清单删除；`go build ./...` 失败即停并补引用。
- [x] **Step 4: Run test** —— PASS；`go test ./... -count=1`；三平台交叉构建。
- [x] **Step 4 的偏离**：`check-deps.sh`、`testdata/ccusage-golden/` 与 CI 的 `deps` job **保留**。
  `ccusage-golden/` 是 `bench-collect`/`parity` 的对照基线（dev-only，仍有读取者），而 `deps` job
  在 S5 后承担「金样本仍能从冻结的 20.0.33 复现」这一职责——删掉它，四个生成器的 `--check`
  就再没有 CI 守护者，宿主侧语义漂移无从发现。代价：CI 仍然依赖 TS collector 的 pnpm 依赖提供
  ccusage 二进制（spec D6 期间成立，TS 退役后这条链路会断，见 `check-deps.sh` 头注释）。
- [x] **Step 5: Commit** —— `feat(ccusage)!: remove the ccusage acquisition layer`（`!`：依赖面 BREAKING）

### Task 9: 发布流水线与 skill 收尾

**Files:**
- Modify: `.github/workflows/go-client.yml`（`release-dry-run` 的 archive 断言去掉 `ccusage`/`ccusage.exe`/`LICENSE.ccusage`；`native pricing` job 的注释；`e2e-self-update.mjs` 断言）
- Modify: `clients/go/scripts/e2e-self-update.mjs`
- Modify: `skills/tokenboard/scripts/*.test.mjs`（删/改对 `ccusagePresent`、`refreshBundledCcusageConfig`、`extractOptionalEntry` 的断言）
- Modify: `SKILL.md`（安装/升级/排障文案：不再有 ccusage 捆绑；binary 安装无网络）
- Modify: `README.md`

**Interfaces:**
- Consumes: Task 8 的删除结果
- Produces: release dry-run 与 skill 测试全绿

**精确规则:**
- `e2e-self-update` 必须仍验证「二进制安装 → 替换 → 版本签发」，只去掉 ccusage 部分。
- `tokenboard` 版本驱动 `skills/tokenboard/scripts/node-version.mjs` 的下限文案不变。

- [x] **Step 1: 本地跑 release dry-run 断言**（`goreleaser release --snapshot --clean` 或按 CI 同参数），确认归档里没有 ccusage。
- [x] **Step 2: 改 CI 与 e2e 脚本** —— 同 commit。
- [x] **Step 3: 跑 skill 测试** —— `node --test skills/tokenboard/scripts/*.test.mjs` 全绿。
- [x] **Step 4: Commit** —— `ci(release): drop the bundled ccusage from the archive and the install flow`

### Task 10: 文档、AGENTS.md 与发布说明

**Files:**
- Modify: `docs/specs/go-client-spec.md`（§4/§5 的获取三层、`--single-thread` 与超时说明；M4 历史节标注「已由 S5 删除」）
- Modify: `AGENTS.md`（`clients/go` 描述里删「ccusage 获取层」，保留「TS collector 仍用 ccusage」；跨端不变量回滚说明）
- Modify: `docs/model-pricing.md`（`TOKENBOARD_CCUSAGE_CONFIG` 在 Go 侧的退役；TS 侧保留）
- Create: `docs/research/2026-11-10-s5-release-notes.md`（面向用户：Go 客户端不再下载 ccusage；claude 未覆盖模型成本计 0 的口径变化；性能数据摘要）
- Modify: `docs/superpowers/specs/2026-11-03-native-usage-sources-design.md`（§8 阻塞项勾选：14 来源金样本齐全、端到端影子双跑）

**Interfaces:**
- Consumes: Task 6 报告、Task 2 口径、Task 8/9 删除结果
- Produces: 与代码一致的文档

**精确规则:**
- 文档不得暗示「native 与线上 ccusage 逐字节一致」；G2 的重定义要保留并指向 §9 / 2026-11-10 报告。
- AGENTS.md 中「ccusage 子进程环境必须剥离凭据」仍对 TS 侧与 `npx` 路径有效，保留条文，补充「Go 客户端自 S5 起不再 spawn ccusage」。

- [x] **Step 1: 逐份修改，`git diff` 自检无残留「download/捆绑/三级获取」表述**
- [x] **Step 2: `grep -rn 'ccusage' README.md SKILL.md docs/ AGENTS.md` 复核每处都是「TS 侧仍用/来源出处/金样本冻结」**
- [x] **Step 3: Commit** —— `docs: retire ccusage from the Go client's documentation`

## 完成标准（S5 出口）

1. `useNativeClaude` / `useNativeCodex` / `useNativeTools` 全部为 `true`，各自独立提交且可单独回滚。
2. `git grep -n 'ccusage' clients/go` 只剩金样本冻结说明、语义出处注释与 `gen-*` 的只读校验；`go list -deps ./cmd/tokenboard` 不含获取/执行层。
3. 三平台 `go build ./...`、`go test ./...`、`go vet`、`gofmt` 全绿；CI 全绿（含 shadow、release dry-run、skill windows 套件）。
4. `docs/research/2026-11-10-native-vs-ccusage-benchmark.md` 与 `2026-11-10-s5-release-notes.md` 提交，数字有命令出处。
5. TS collector 行为不变（`packages/collector` 与 `usage-core` 测试全绿，`ccusage` 依赖保留）。
6. claude 的 parity 口径差异（未覆盖模型、父行分摊）在报告中如实记录，不粉饰。
