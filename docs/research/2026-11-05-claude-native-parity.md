# 2026-11-06 Claude Code 原生适配器 parity 与性能证据

- 日期：2026-11-06（Asia/Shanghai）
- 分支：`feat/native-usage-sources`，HEAD `399f406`（4 个性能提交见 §5）
- 二进制：ccusage `20.0.33`（`~/.tokenboard/bin/ccusage`），Go `go1.27.3 darwin/amd64`
- 范围：S2 Task 9 Step 1–5。只覆盖 `claude-code` 来源，**只是证据记录，不翻转默认开关**。

> 本文所有命令输出都来自当前工作树的实际执行。涉及本机 home 路径一律写成 `~`，产物中如出现
> 临时目录名也只用于说明结构，不含任何 token/凭据。明确区分「已验证」「推断」「未覆盖」。

## 1. 测量口径

### 1.1 Parity 命令

```bash
cd ~/.../TokenBoard/clients/go
go run ./cmd/parity -source claude-code \
  -since 2026-09-25 -until 2026-11-05 -json > parity.json
```

- 窗口：`2026-09-25 → 2026-11-05`（42 天），时区 `Asia/Shanghai`（`sessionusage.LocalTimezone()`）。
- `cmd/parity` **不传 `--offline`** 给 ccusage（生产同；见 `ccusageReportArgs`，`cmd/parity/main.go:683`），
  且从 `f113539` 起 ccusage 侧通过 `--config <prepared.ConfigPath>` 与原生侧使用同一份
  merged pricing config（`pricing.Prepare`，临时 state dir）。这保证 diff 不是由「一侧读 bundled
  overrides，另一侧读内置表」造成的假差异。
- parity 剥离 `TOKENBOARD_HOOK_MODE`，比较的是 full-preview 路径；不使用本机真实 cursor。
- 本机未配置 `TOKENBOARD_ENDPOINT`，因此 `pricing.Prepare` 的 catalogue 回退到
  `static`（bundled `internal/pricing/ccusage.json`，48 条 overrides）；该状态由 JSON 的
  `pricingSource: "static"` 明确记录。

### 1.2 两侧实现

| 侧 | 路径 | 定价数据 |
|---|---|---|
| native | `collect.LookupNative` → `claudecode.nativeCollect` → `claude.Collect` | `nativepricing.LoadEmbeddedCorpus()` + `MergedPricingOverrides`（冻结语料，3423 模型）|
| ccusage | `execCcusage` 直接调用 `ccusage claude daily/session` | ccusage 在线：LiteLLM 价表（每次运行可能联网刷新）|

## 2. Parity 结果（两次独立运行一致）

| 运行 | start (UTC) | load 1m 前/后 | 结果 |
|---|---|---|---|
| A | 2026-11-06T06:29:35Z | 33.88 → 292.05 | 见下 |
| B | 2026-11-06T04:50Z（前一轮，产物 `/tmp/parity-online.json`） | 未记录 | 与 A 完全一致 |

两次输出摘要（逐字段相同）：

```json
{
  "source": "claude-code",
  "since": "2026-09-25",
  "until": "2026-11-05",
  "timezone": "Asia/Shanghai",
  "status": "diff",
  "nativeSnapshots": 459,
  "ccusageSnapshots": 459,
  "matched": 140,
  "pricingSource": "static"
}
```

- `valueDiffs: 319`，`onlyInNative: 0`，`onlyInCcusage: 0`，`liveWrite: 0`。
- 319 条 diff 的 `fields` 全部只有 `costUsd`（按 `HashPayload` 的其他字段比较均相等），
  即 token 数、日期归属、模型名、sessionCount 均一致。
- A 的运行日志：`/tmp/parity-run/run.log`（exit 1 是 `status=diff` 的预期退出码）；
  完整差异清单 `parity.json`（85,497 B）。B 的产物：`/tmp/parity-online.json`。
  两份 `valueDiffs` 的 319 条 key 与数值逐条相同，**已验证**（Python 逐字段比对）。

### 2.1 窗口负载说明

A 运行结束时 load 1m 高达 292.05（`uptime`），是本机同时存在 Virtualization VM、Docker、
多个 claude 会话、`go test ./...` 等无关负载。**这只影响墙钟，不影响 parity 的 diff 枚举**：
parity 不取时间中位数，比较的是两侧输出快照字段；两次独立运行（相隔约 1.5 小时、负载不同）
给出完全相同的 319 条 diff，是对该判断的交叉验证。

## 3. 319 条 costUsd diff 的逐条归因

### 3.1 三路比较方法

另取一次 ccusage **离线内置费率表**输出（同一窗口、同一 `--config`、加 `--offline`）：

```bash
ccusage claude daily --json --breakdown --offline --single-thread \
  --since 2026-09-25 --until 2026-11-05 --timezone Asia/Shanghai \
  --config clients/go/internal/pricing/ccusage.json > /tmp/cc-offline-full.json
# 归一化为 "<date>|<model> -> costUSD" 的 map：/tmp/cc-offline-map.json（459 个键）
```

对 319 条 diff 逐条比对 `native.costUsd`、`ccusage(online).costUsd`、
`ccusage(--offline).costUsd`：

| 分类 | 条数 | 占 319 | 说明 |
|---|---:|---:|---|
| `native == --offline`（逐位或相对误差 ≤1e-9） | **174** | 54.5% | 模型在冻结语料内；online 的价差来自实时 LiteLLM 表，native 与 ccusage 内置表一致 |
| `--offline` 报告 `0.0`，native > 0 | **139** | 43.6% | 模型不在 ccusage 内置表也不在冻结语料；native 用原文 `costUSD`（Auto 模式），online 通过 LiteLLM 查到另一费率 |
| 三方互不相同 | **6** | 1.9% | 均为 `deepseek-v4-flash`；native 原文成本、离线内置费率、online 费率分属三个值 |

**已验证的直接例子**（`deepseek-v4.1-flash`，2026-09-26）：

```
parity:           native=801.5373286600038   ccusage(online)=772.4319757904401
ccusage --offline: 801.5373286600038         ← 与 native 逐位相同
```

`ccusage --offline` 单日命令与完整窗口离线 map 的值一致；证据见
`clients/go/cmd/parity/main.go:683`（`--offline` 只有 codex 侧固定传入）与
本次 `ccusage claude daily --offline` 的 stdout。

### 3.2 差异集中在代理网关模型名

窗口内 81 个 distinct 模型名，其中 48 个产生 diff。把所有 diff 模型名喂给
`nativepricing.Corpus.Find`（先加载 bundled overrides，与生产 `ModeAuto` 等价）后：

- **22 个精确命中**（如 `deepseek-v4.1-flash`、`GLM-5.3-Flash`、`step-5-preview`），
  它们与 `--offline` 逐位一致；online 的差异是费率时点不同。
- **26 个未命中**（全部是代理/自定义别名）：

```
DeepSeek-Flash, DeepSeek-V4-Flash-Official-solo, Kimi-k2.6, Qwen3.8-Flash,
claude-5.5-sonnet, deepseek-ai/DeepSeek-V4.1-Flash-1017, deepseek_for_coding,
dfmodel, glm-5.3-flash-free, glm-5.3-flash-max, glm-5.3-flash-solo,
glm-5.3-flash:free, group/auto-dfmodel, hy4-free, kimi-k3.1,
minimax-m3.1-flash, minimax/minimax-m3.1-flash:free, minimaxai/minimax-m3.1-flash,
qfmodel, qiniu/conatus-free, self-dploy/DeepSeek-V4-Flash,
self-dploy/DeepSeek-V4.1-Flash, self-dploy/GLM-5.3-Flash,
self-dploy/MiMo-V2.6-Flash, space-bunny-free,
vmc/deepseek-v4p1-flash-contributor-fallbacks
```

对未命中模型，native 的 `ModeAuto` 取 transcript 行里的 `costUSD`（上游 ccusage 在写这行时
按当时的实时价算过）；ccusage online 这次运行重新算了一遍。某些模型比值恒定
（`MiMo-V2.6-Flash` 恰好 1.25、`DeepSeek-V4.1-Flash` ≈0.4975），指向两份费率的固定倍差；
另一些模型比值随日期/token 构成变化，因为 online 按 breakdown 分桶重算而原文 `costUSD`
是整行一个值。**推断**（未逐行反推）：倍差来自 LiteLLM 表在 2026-11-03 冻结语料之后更新过
这些代理模型；未覆盖边界见 §6。

### 3.3 与计划 §10.1 口径闸门的关系

计划 Task 9 Step 1 已声明「生产 claude 不传 `--offline`，ccusage 会联网刷新 LiteLLM 价表，
原生侧是冻结语料」。本次结果**正是这一已知口径差异的真机实测**：差异只出现在费率，
且 174 条能用 ccusage `--offline` 逐位复现，足以排除 token 解析/去重/日期归属的语义漂移。
但 diff 不是 0，因此不满足「全 match」的翻转条件。

## 4. 显式定价配置（`TOKENBOARD_CCUSAGE_CONFIG`）路径

Task 7 修补轮 `cd77f13` 修复了「显式 config 的价目只通过 merged 文件传给 ccusage，
原生路径读不到」的分叉，并加了两条端到端测试。本次用真实二进制追加一条 parity 探针：

```bash
cat > /tmp/explicit-pricing.json <<'EOF'
{"defaults":{"pricingOverrides":{
  "deepseek-v4.1-flash":{"inputCostPerToken":0.000011,"outputCostPerToken":0.000011,
                         "cacheReadInputTokenCost":0,"cacheCreationInputTokenCost":0},
  "claude-opus-4-6":{"inputCostPerToken":0.000011,"outputCostPerToken":0.000011,
                     "cacheReadInputTokenCost":0,"cacheCreationInputTokenCost":0}
}}}
EOF
TOKENBOARD_CCUSAGE_CONFIG=/tmp/explicit-pricing.json \
  go run ./cmd/parity -source claude-code -since 2026-09-25 -until 2026-11-05 -json
```

结果见 §4.1（补记运行时填入）。这一步用同一份显式 config 让 ccusage 的 `--config` 与
原生 `MergedPricingOverrides` 都读到自定义费率；若两侧实现分叉，被覆盖模型的
`costUsd` 会产生新的 only-in-side 或额外 diff 类型。

### 4.1 实测结果

```json
{
  "since": "2026-09-25", "until": "2026-11-05", "timezone": "Asia/Shanghai",
  "status": "diff",
  "nativeSnapshots": 459, "ccusageSnapshots": 459, "matched": 183,
  "pricingSource": "static"
}
```

- `valueDiffs: 276`（baseline 319）、`onlyInNative: 0`、`onlyInCcusage: 0`、`liveWrite: 0`；
  字段仍全部只有 `costUsd`。
- 与 baseline 逐条相减：**42 条 `deepseek-v4.1-flash` 的 diff 全部消失**（该模型正是显式
  override 覆盖的目标）。这两项合起来证明：显式 config 的价目经 merged 文件同时到达
  ccusage 与原生 `MergedPricingOverrides`，且两侧算出了相同的数——Task 7 修补轮
  `cd77f13` 的 M1 分叉在真实二进制上不再出现。
- 另有 **1 条**基线 diff 也消失：`2026-10-28 | deepseek/deepseek-v4.1-flash-1017`
  （baseline native 0.9026224079999999 / ccusage 0.33490273200000004）。它不在显式
  override 的键里，只可能是两侧各自的别名折叠都把该名字归并到了被覆盖的
  `deepseek-v4.1-flash`（原生侧是 `normalizePricingKey` 的 `.`/`@` → `-`，ccusage 侧是它的
  双向后缀剥离）。**推断，未单独验证**：本次没有导出快照原值，也没有对该单日单独跑
  `ccusage --offline` 复核这一条；登记为 §6.2 的未覆盖边界。
- `claude-opus-4-6` 在 baseline 与显式运行中都没有 diff，因此它不能作为「显式 override
  被两侧读到」的证据；本条只由 `deepseek-v4.1-flash` 的 42 条消失支撑。
- 运行耗时 506.15 s real（`/usr/bin/time`），当时 load 1m > 90；耗时同样受无关负载影响，
  不作为性能数据引用。

## 5. 性能证据

### 5.1 CPU profile 引导的 4 项优化（已提交）

| 提交 | 文件 | 改动 |
|---|---|---|
| `77e66ab` | `internal/nativepricing/corpus.go` | 定价 key 归一化不再每次构建 `strings.NewReplacer` |
| `f60ddf3` | `internal/collect/adapters/claude/cost.go` | `Find` 按模型名 memoize，且 cost / missing 共用一次解析 |
| `77cedbd` | `internal/contract/contract.go` | `LoadLocation` 用 `sync.Map` 缓存已解析 zone |
| `399f406` | `internal/collect/adapters/claude/collect.go` | transcript 读缓冲 4 KiB → 256 KiB |

profile 的受控子集（8 个 transcript、145 MB，取真实 home 的前 20 MB 截断副本）：

| 指标 | 优化前 | 优化后 |
|---|---:|---:|
| 墙钟 | 44.2 s | 0.86 s |
| 分配 | 23 GB | 854 MB |
| CPU 采样 | 53.92 s | 1.23 s |

profile 尾部仅剩 `syscall.rawsyscalln`（文件 I/O）、pthread 同步与 GC，适配器业务代码
已不在主要瓶颈。测量方法：`runtime/pprof` + `go tool pprof -top/-cum/-peek/-list`，
临时 harness 在测量后已删除（工作树只有上表 4 个提交）。

### 5.2 `bench-collect` 三场景

见 §5.3。工具（`cmd/bench-collect`）每轮对 ccusage 侧跑 daily + session 两次调用，
对 native 侧跑一次 in-process 采集；`-rounds 5` 是硬下限，取中位数。
与 S1 基线（`docs/research/2026-11-03-native-vs-ccusage-baseline.md`）对照时**只能比较 RSS**：
S1 的墙钟已被无关负载污染（该报告 §2.1），且 S1 的 native 列恒为 `notImplemented`。

### 5.3 实测数字

（运行结束后填写；必须同时记录每场景开始/结束的 `uptime`，否则墙钟不可解读。）

## 6. 决定与未覆盖边界

### 6.1 `useNativeClaude` 保持 `false`

`clients/go/internal/collect/providers/claudecode/native.go:37` 的编译期常量不改。
理由（已验证）：Task 9 Step 3 要求「Step 1 全 match」才翻转，而本次 `status=diff`、
319 条 costUsd diff。现有测试 `native_test.go:152` 也断言该常量必须为 false。
原生路径继续通过 `collect.LookupNative` 注册的 seam 供 parity/bench 调用，
**不进入任何生产上传路径**。

### 6.2 已验证 / 推断 / 未覆盖

- **已验证**：两侧快照 key 集合完全相同（459/459，0 only-in-side）；所有 diff 字段只有
  `costUsd`；174 条 diff 的 native 值与 ccusage `--offline` 逐位相同；两次独立 parity 运行
  结果一致；4 项优化在受控子集上的前后 CPU 采样与分配量。
- **推断（有强证据但未逐行证明）**：其余 145 条 diff 来自 ccusage 在线价表与冻结语料/原文
  `costUSD` 的费率时点差异；26 个未命中模型全部是本机代理网关别名。
- **未覆盖**：
  1. 本机配置了 `TOKENBOARD_ENDPOINT` 且能成功拉到 models.dev 动态目录的路径
     （`pricingSource: "network"`）；当前无 endpoint，走 static 回退。
  2. Windows / Linux 真机 parity（本机 darwin/amd64）；CI 只跑 `-race` 单测与交叉构建。
  3. hook 增量路径的 parity（`shadow-dual-run --hook` 与 `--source all` 的差异另见 SDD 台账）。
  4. 2026-11-05 当天正在写入的 transcript 的活写竞态；窗口上界取到当天但 `liveWrite: 0`。
  5. 冻结语料生成之后 LiteLLM 对这 26 个别名究竟改了哪几项费率——本次没有抓取
     ccusage online 的实际价表快照，只观察到计算结果。
  6. `bench-collect` 的 `bytesRead` 仍为占位 0（`bytesReadPending: true`）。

## 7. 复现

```bash
cd ~/.../TokenBoard/clients/go
# 1) parity（生产参数、不带 --offline；diff 退出 1 是预期）
go run ./cmd/parity -source claude-code \
  -since 2026-09-25 -until 2026-11-05 -json > parity.json

# 2) 三场景性能，串行；先记录 uptime/vm_stat
for scn in single 30d full; do
  go run ./cmd/bench-collect -source claude-code -scenario "$scn" -rounds 5 \
    -ccusage-bin ~/.tokenboard/bin/ccusage -json > "bench-$scn.json"
done

# 3) 默认开关检查（必须为 false）
grep -n 'useNativeClaude' internal/collect/providers/claudecode/native.go
```

判读：`parity.json` 的 `pricingSource` 应为 `static` 或 `network`（据此解释费率口径），
`bench-*.json` 的 `ccusage.rssSource` 应为 `wait4-rusage`；若 `full` 各轮墙钟 >2× 离散，
先查 `uptime`（S1 基线报告 §2.1 的教训）。
