# 2026-11-06 Claude Code 原生适配器 parity 与性能证据

- 日期：2026-11-06（Asia/Shanghai）
- 分支：`feat/native-usage-sources`；测量时代码状态 `399f406`，文档首次提交 `0b53573`
  （4 个性能提交见 §5；2026-11-06 复核修复见 §8）
- 二进制：ccusage `20.0.33`（`~/.tokenboard/bin/ccusage`），Go `go1.27.3 darwin/amd64`
- 范围：S2 Task 9 Step 1–5。只覆盖 `claude-code` 来源，**只是证据记录，不翻转默认开关**。

> 本文所有命令输出都来自当前工作树的实际执行。涉及本机 home 路径一律写成 `~`，产物中如出现
> 临时目录名也只用于说明结构，不含任何 token/凭据。明确区分「已验证」「推断」「未覆盖」。

## 1. 测量口径

### 1.1 Parity 命令

```bash
cd ~/.tokenboard/TokenBoard/clients/go
go run ./cmd/parity -source claude-code \
  -since 2026-09-25 -until 2026-11-05 -json > parity.json
```

- 窗口：`2026-09-25 → 2026-11-05`（42 天），时区 `Asia/Shanghai`（`sessionusage.LocalTimezone()`）。
- `cmd/parity` **不传 `--offline`** 给 ccusage（生产同；见 `ccusageReportArgs`，`clients/go/cmd/parity/main.go`），
  且从 `f113539` 起 ccusage 侧通过 `--config <prepared.ConfigPath>` 与原生侧使用同一份
  merged pricing config（`pricing.Prepare`，临时 state dir）。这保证 diff 不是由「一侧读 bundled
  overrides，另一侧读内置表」造成的假差异。
- parity 剥离 `TOKENBOARD_HOOK_MODE`，比较的是 full-preview 路径；不使用本机真实 cursor。
- 本机未配置 `TOKENBOARD_ENDPOINT`，因此 `pricing.Prepare` 的 catalogue 回退到
  `static`（bundled `internal/pricing/ccusage.json`，48 条 overrides）；该状态由 JSON 的
  `pricingSource: "static"` 明确记录。（`TOKENBOARD_ENDPOINT` 为空是从产物推断的：
  baseline 的 `run.log` 没有捕获 stderr，只有显式运行留下的 `direct.err` 能直接佐证。）

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
  --config internal/pricing/ccusage.json > /tmp/cc-offline-full.json
# 归一化为 "<date>|<model> -> costUSD" 的 map：/tmp/cc-offline-map.json（459 个键）
```

对 319 条 diff 逐条比对 `native.costUsd`、`ccusage(online).costUsd`、
`ccusage(--offline).costUsd`：

| 分类 | 条数 | 占 319 | 说明 |
|---|---:|---:|---|
| `native == --offline`（逐位相同） | **174** | 54.5% | 模型在冻结语料内且费率非零；online 的价差来自实时 LiteLLM 表 |
| `--offline` 报告 `0.0`，native > 0 | **139** | 43.6% | 分两种：113 条来自 26 个「不在 ccusage 内置表也不在冻结语料」的别名（native 用原文 `costUSD`）；26 条来自 5 个「在冻结语料里但费率为 0」的模型（`MiniMax-M3.1-Flash`、`MiniMax-M3.1-Flash-Preview`、`longcat-2.5-preview-free`、`step-5-preview`、`step-5-preview-free`），native 按 $0 计而 online 有价 |
| 两个不同值（不是三方） | **6** | 1.9% | 均为 `deepseek-v4-flash`；ccusage 的 **online 与 offline 逐位相同**，只有 native（冻结语料费率）与 ccusage（内置/在线费率）不同 |

> 修正记录（2026-11-06 复核）：原先把第三类写成「三方互不相同」，并把 139 条全部归为「不在冻结语料」，
> 两者都不准确。复算显示：6 条里 `ccusage(online) == ccusage(--offline)` 逐位相等（如 2026-10-16
> `4.952892440000005`），native 的 `2.08333965` 恰好等于冻结语料费率计算的
> `13,641,303×1.5e-7 + 61,507×6e-7 + 80,000×3e-9`；139 条中有 26 条命中了零费率条目。
> 因此第三类的成因是「冻结语料费率 ≠ ccusage 内置费率」，不是「在线价表刷新」。

**已验证的直接例子**（`deepseek-v4.1-flash`，2026-09-26）：

```
parity:           native=801.5373286600038   ccusage(online)=772.4319757904401
ccusage --offline: 801.5373286600038         ← 与 native 逐位相同
```

`ccusage --offline` 单日命令与完整窗口离线 map 的值一致；证据见
`ccusageReportArgs`（`clients/go/cmd/parity/main.go`；`--offline` 只有 codex 侧固定传入）与
本次 `ccusage claude daily --offline` 的 stdout。

### 3.2 差异集中在代理网关模型名

窗口内 81 个 distinct 模型名，其中 48 个产生 diff。把所有 diff 模型名喂给
`nativepricing.Corpus.Find`（先加载 bundled overrides，与生产 `ModeAuto` 等价）后：

- **22 个能被语料解析**（如 `deepseek-v4.1-flash`、`GLM-5.3-Flash`、`step-5-preview`）。其中
  16 个费率非零的模型与 `--offline` 逐位一致；另 6 个不同（`deepseek-v4-flash` 的 6 条费率差，
  以及 5 个零费率模型的 26 条，见 §3.1 的修正记录）。
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

结果见 §4.1。这一步用同一份显式 config 让 ccusage 的 `--config` 与
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

下面三条描述**上一版运行**的读数（2026-11-06 15:02，产物 `/tmp/parity-explicit/parity.json`）；
其中「成本只涨在 deepseek 目标模型上」的部分已被 2026-11-07 的复跑推翻，见其后两条。

- `valueDiffs: 276`（baseline 319）、`onlyInNative: 0`、`onlyInCcusage: 0`、`liveWrite: 0`；
  字段仍全部只有 `costUsd`。
- 与 baseline 逐条相减：**42 条 `deepseek-v4.1-flash` 的 diff 全部消失**（该模型正是显式
  override 覆盖的目标），另有 **1 条**基线 diff 也消失：`2026-10-28 |
  deepseek/deepseek-v4.1-flash-1017`。**已验证（原生侧）**：临时探针对它执行
  `corpus.WithOverrides(bundled+explicit).Find(...)` 得到 `in=1.1e-05`（$11/M），说明
  `normalizePricingKey` 的 `.` → `-` 归一化加模糊匹配把它折叠到了被覆盖的
  `deepseek-v4.1-flash` 条目上。**推断（ccusage 侧）**：该行两侧现已相等，因此 ccusage
  也把它折叠到了同一覆盖键；这一侧没有单独导出它算出的原值。
- `claude-opus-4-6` 在 baseline 与显式运行中都没有 diff，因此它不能作为「显式 override
  被两侧读到」的证据。
- **2026-11-07 复跑（取代此前的「不可复现」结论）**：上一版本节写过一条「复核修正」，
  断言「这次运行不能用本节给出的两键 config 复现，产物只可能来自更宽的 override 集」。
  用同一条命令在低负载窗口重跑后，**该结论不成立**，现撤回。实测：
  - 重跑（`/tmp/parity-explicit-rerun.json`，01:18:01→01:23:33 CST，exit 1 = `statusDiff`
    的既定语义）：456/456 快照、`matched 181`、`valueDiffs 275`、`pricingSource: static`、
    config `…/ccusage.dynamic.json`。
  - 与上一版产物（`/tmp/parity-explicit/parity.json`，276 条 diff / matched 183）逐键对比：
    共有 key 275 条，其中 **252 条的 native 与 ccusage 值逐位相同**，只有 **23 条**变化
    （10 个模型）。即文档里的两键 config 确实复现了上一版产物。
  - 对照运行（同代码、同日，**不设** `TOKENBOARD_CCUSAGE_CONFIG`）：
    318 条 diff / matched 138，且代理模型的 native 值回到 §2 baseline 一侧
    （`glm-5.3-flash:free` 2026-10-19 = 0.04481755、`claude-5.5-sonnet` 2026-10-24 =
    0.07674846，两者与 baseline **逐位相同**；`longcat-2.5-preview-free` 2026-10-07 =
    3.189158 vs baseline 3.188324，差 0.03%，属可忽略的漂移）。
    因此「有无显式 config」就是这一组值变化的开关，不是代码或数据状态漂移。
  - 与 baseline 相比：重跑有 **188 条 native 值**变化（37 个模型）、**128 条 ccusage 值**变化。
    这两个数字与上一版记录的 184 / 116 同量级——所以「大规模连带变化」是真实现象，
    但它的成因不是「更宽的 override 集」。
- **成因（已验证部分）**：用 `pricing.Prepare` 直接导出两次的合并 config 并递归比对，
  两份文件只差两处：新增 `deepseek-v4.1-flash` 覆盖（$11/M）、`claude-opus-4-6` 的费率被
  覆盖（$5/M → $11/M）；`mode` 两侧都是 `auto`。受影响的行本身**既无价格也无上报成本**
  （在 `priceUsage` 里 `reported=false, found=false`，同一行 token 数两轮完全相同，如
  `glm-5.3-flash:free` 2026-10-19 都是 255703）。也就是说这些行自己的成本是 0，
  却拿到了非零成本 ⇒ 成本来自 `ccusage.NormalizeCcusageDailyJSON` 的父行分摊
  （`internal/ccusage/normalize.go:472-486`：`parentCost × rowTokens/parentTokens`）。
  被覆盖的 deepseek 行把当天的父行总额抬高，同一天其它模型按 token 份额一起被抬高。
  2026-10-19 `deepseek-v4.1-flash` 从 718.68 涨到 24797.20（34.5×），同日
  `glm-5.3-flash:free` 从 0.04481755 涨到 1.38764430（31.0×），方向与量级吻合。
- **仍未验证的部分**：各模型的分摊倍率并不一致（glm 31.0× vs deepseek 34.5×），
  说明父行/份额的切分还有别的结构（会话级或分组合并）没有拆清；本节不据此下结论。
  同理，上一版把 **45 条别名折叠行**解释为「native 已按 1.1e-5 计费、ccusage 保持旧值」
  也受同一分摊影响，该解释**待复核**，数量（33 + 11 + 1）仍可作为观测事实引用。
- **对 §3 的影响**：这一组 184/116 条变化是**两侧同时**发生的（native 与 ccusage 都涨），
  因此不能当作 native 与 ccusage 的分叉证据；§3 的 319 条 baseline diff 结论不受影响。
- 运行耗时：本次 5 min 33 s（load 1m 7.98→40.66，跑后读数含自身负载）；
  上一版为 506.15 s（`/usr/bin/time`，当时 load 1m > 90）。两者都只说明负载差异，
  不作为性能数据引用。

## 5. 性能证据

### 5.1 CPU profile 引导的 4 项优化（已提交）

| 提交 | 文件 | 改动 |
|---|---|---|
| `77e66ab` | `internal/nativepricing/corpus.go` | 定价 key 归一化不再每次构建 `strings.NewReplacer` |
| `f60ddf3` | `internal/collect/adapters/claude/cost.go` | `Find` 按模型名 memoize，且 cost / missing 共用一次解析 |
| `77cedbd` | `internal/contract/contract.go` | `LoadLocation` 用 `sync.Map` 缓存已解析 zone |
| `399f406` | `internal/collect/adapters/claude/collect.go` | transcript 读缓冲 4 KiB → 256 KiB |

profile 的受控子集（8 个 transcript、145 MB，取真实 home 的前 20 MB 截断副本）。
下表是**本机实测记录，harness 与产物已在测量后删除、没有外部可复核的留存**：

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

环境（`/tmp/bench-run-2026-11-06/env.log`，`run.sh` 同目录）：

| 时刻 | load 1/5/15 |
|---|---|
| run 开始 06:56:46Z | 95.96 / 85.89 / 87.82 |
| `single` 结束 07:20:12Z | 34.60 / 52.74 / 56.56 |
| `30d` 结束 07:54:00Z | 18.71 / 21.34 / 29.60 |

两者的 `ccusageNetworkAllowed` 都是 `true`（生产参数、不带 `--offline`）、
`ccusage.rssSource: wait4-rusage`（精确到单个子进程）、native `rssSource: rusage-self`。

| 场景 | 窗口 | 侧 | 墙钟中位数 | 墙钟最大 | RSS 中位数 | RSS 最大 |
|---|---|---|---:|---:|---:|---:|
| `single` | 20261105 | ccusage | 163.2 s | 166.0 s | 3.563 GiB | 3.567 GiB |
| `single` | 20261105 | native | **119.3 s** | 160.1 s | **1.959 GiB** | 1.993 GiB |
| `30d` | 20261007→20261105 | ccusage | 222.0 s | 288.5 s | 4.026 GiB | 4.032 GiB |
| `30d` | 20261007→20261105 | native | **175.4 s** | 187.8 s | **3.168 GiB** | 3.168 GiB |
| `full` | 无过滤 | ccusage | 137.3 s | 167.2 s | 3.602 GiB | 3.642 GiB |
| `full` | 无过滤 | native | 167.7 s | 177.7 s | **2.710 GiB** | 2.711 GiB |

`full` 的负载时间线（`/tmp/bench-run-full.env.txt`，2026-11-07 补跑）：

| 时刻 | load 1/5/15 |
|---|---|
| 跑前 16:41:54Z | 5.30 / 4.63 / 4.54 |
| 跑后 17:07:32Z | 97.91 / 38.92 / 22.96 |

跑后那一行是 **bench 自身把机器打满**的读数（跑完瞬间 1m 均值仍包含自己的峰值），不是外部负载；
跑前的 5.30 是本次唯一有效的环境读数（同时 free pages 1.05 M ≈ 4.0 GiB，与 `single`/`30d`
那次的 95.96 起步完全不同量级）。整轮 real ≈ 25 min 38 s，exit 0，stderr 为空。

native/ccusage 比值：`single` 墙钟 0.731、RSS 0.550；`30d` 墙钟 0.790、RSS 0.787；
**`full` 墙钟 1.221（native 更慢 22.1%，触发 `regressions` 标记）、RSS 0.753**。
`single`/`30d` 未触发 `regressions`，`full` 触发了——这是三个场景里唯一一次 native 中位墙钟
高于 ccusage。

口径要点（读这张表前必须知道）：

- 两侧是**同一件工作的两种实现**：ccusage 侧每轮调 `claude daily` + `claude session`
  两次（生产路径），native 侧一次 in-process `Collect` 同时产出两份报告。所以「native 墙钟更短」
  成立的前提是这份工作定义（两份报告）而不是单条命令。
- **native 的 RSS 是进程高水位，不是每轮独立峰值**：native 在 `bench-collect` 进程内跑，
  `RUSAGE_SELF.ru_maxrss` 单调不减。`single` 的五轮 1.957/1.958/1.959/1.959/1.993 GiB 与
  `30d` 的 3.1654/3.1678/3.1683/3.1683/3.1683 GiB 都符合「到该轮为止的高水位」。因此 native 的
  RSS **中位数略低估真实峰值**，
  上界以 `RSS 最大` 列（`single` 1.993 GiB、`30d` 3.168 GiB）为准。ccusage 侧是 `wait4` 的每子进程峰值，
  无此偏差。
- 墙钟受负载影响：`single` 在 load 96→35 下测得、`30d` 在 load 35→19 下测得，且两组内各轮离散可见
  （`single` ccusage 127.6–166.0 s、native 113.6–160.1 s）。**不能**把 `30d` 的中位数与 `single`
  直接相减判断窗口开销。真正稳健的信号是 RSS：`single` native 1.99 GiB vs `30d` 3.17 GiB，
  与 S1 基线「窄窗口不省扫描、但结果集更大则 RSS 更高」的结论方向一致。
- `native 119 s` 与 §5.1 受控子集（145 MB）的 `0.86 s` 差距来自全量 transcript 的文件 I/O 与
  dedupe 索引规模（本机 `find ~/.claude/projects -name '*.jsonl'` 当时计数约 1.0 万个）：
  profile 尾部只剩 `syscall.rawsyscalln`，说明剩下的时间在读写真实文件，不是适配器业务逻辑。
- native 的 RSS 是 bench 进程自身高水位，包含报告 JSON、语料与 harness 自身开销；ccusage 侧只是
  子进程峰值。两侧统计对象不完全对等，影响很小，但读表时要知道。

#### `full` 场景（2026-11-07 补跑完成）

`full` 在 2026-11-06 07:54:00Z 那次以 exit 1 结束，stderr
`bench-collect: ccusage side: round 5: ccusage claude daily --json: signal: killed`，
**原因是用户为减轻本机负载手动结束了 ccusage 进程**，不是工具或适配器缺陷。

2026-11-07 00:41 CST 在低负载窗口重跑（跑前 load 1m 5.30）后完成，exit 0、stderr 为空，
数字见上表 `full` 两行。读法：

- **墙钟**：ccusage 137.3 s 中位（单轮 137.3/135.7/133.0/167.2/150.9），native 167.7 s 中位
  （173.2/177.7/145.6/146.5/167.7）。native 比 ccusage 慢 22.1%，是三个场景里唯一的一次
  native 落后，`bench-collect` 因此置了 `regressions`。这与 `single`/`30d` 的方向相反。
- **RSS**：ccusage 3.602 GiB 中位，native 2.710 GiB 中位（单轮 2.6845/2.7099/2.7104/2.7104/2.7114，
  仍符合 native「进程高水位单调不减」的口径，中位略低估真实峰值）。RSS 比值 0.753，
  与 `single`（0.550）、`30d`（0.787）同向：native 更省内存。
- **为什么 `full` 会反过来**：`full` 无 `--since/--until`，ccusage 的 daily+session 两次扫描与
  `single`/`30d` 同量级（`--since` 只过滤输出不省扫描，见 notes），但 native 侧要一次性把
  全部 transcript 建去重索引并同时产出两份报告，结果集最大（ccusage `outputBytes` 3.77 MB）。
  **推断**：native 的墙钟优势来自「一次 in-process 读文件同时出两份报告」，当窗口放大到需要
  保留全部 42 天以上的 dedupe 状态时，这个优势被索引维护成本吃掉。
  **未验证**：没有对 `full` 做 profile，判断依据仅是三个场景的比值方向与 §5.1 的受控 profile。
- ccusage 侧 `outputBytes` 3,766,507 字节；`ccusageNetworkAllowed: true`（生产参数、不带
  `--offline`）。

#### 与 S1 基线对照

S1 基线（`docs/research/2026-11-03-native-vs-ccusage-baseline.md`）只有 ccusage 列
（native 恒 `notImplemented`）：single 3.1711 GiB、30d 4.4165 GiB、full 4.4410 GiB（均为中位数）。

| 场景 | S1 ccusage RSS 中位数 | 本次 ccusage RSS 中位数 | 偏差 |
|---|---:|---:|---:|
| single | 3.1711 GiB | 3.563 GiB | +12.4% |
| 30d | 4.4165 GiB | 4.026 GiB | −8.8% |

两次测量的 ccusage 同为 20.0.33，差异只能归因于**机器语料本身变了**（S1 之后又积累了
transcript）与负载/机器状态不同，S1 报告 §2/§5 已就此打过预防针。**推断，未验证**：single 变大
更可能因为结果集模型数增加（本次窗口 81 个 distinct 模型）；30d 变小可能是 S1 当时负载更高。
本表只用于说明「跨两次运行不能逐位比较」，不作为趋势结论。native 侧无 S1 基线可比。

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
- **推断（有强证据但未逐行证明）**：其余 145 条 diff = 139 条 `--offline` 报 0 但 native > 0
  （113 条未命中别名取原文 `costUSD` + 26 条零费率语料模型）+ 6 条冻结语料费率与 ccusage
  内置表不同（这 6 条 online 与 offline 逐位相同，不存在「在线价表」差异）；26 个未命中模型
  全部是本机代理网关别名。
- **未覆盖**：
  1. 本机配置了 `TOKENBOARD_ENDPOINT` 且能成功拉到 models.dev 动态目录的路径
     （`pricingSource: "network"`）；当前无 endpoint，走 static 回退。
  2. Windows / Linux 真机 parity（本机 darwin/amd64）；CI 只跑 `-race` 单测与交叉构建。
  3. hook 增量路径的 parity（`shadow-dual-run --hook` 与 `--source all` 的差异另见 SDD 台账）。
  4. 2026-11-05 当天正在写入的 transcript 的活写竞态；窗口上界取到当天但 `liveWrite: 0`。
  5. 冻结语料生成之后 LiteLLM 对这 26 个别名究竟改了哪几项费率——本次没有抓取
     ccusage online 的实际价表快照，只观察到计算结果。
  6. `bench-collect` 的 `bytesRead` 仍为占位 0（`bytesReadPending: true`）。
  7. ~~**`full` 场景未完成**：用户在 `round 5` 手动结束了 ccusage 以减轻本机负载，`full.json`
     为空；需在低负载窗口（用户约定深夜、其不使用机器时）重跑，命令见 §7。~~
     **已于 2026-11-07 00:41 CST 补跑完成**（exit 0，跑前 load 1m 5.30），数字见 §5.3；
     结论：`full` 是唯一 native 中位墙钟高于 ccusage 的场景（+22.1%），RSS 仍低 25%。
     因此「无窗口过滤」下 native 没有墙钟优势，单选 `full` 的机器应保留 ccusage 路径。
  8. `single` 与 `30d` 的 native RSS 是进程高水位（见 §5.3），真实峰值可能略高于表中中位数。

## 7. 复现

```bash
cd ~/.tokenboard/TokenBoard/clients/go
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

# 4) §4.1 的显式 config 复跑（两键 $11/M）+ 对照组（不设该变量）
TOKENBOARD_CCUSAGE_CONFIG=/tmp/explicit-pricing.json \
  go run ./cmd/parity -source claude-code -since 2026-09-25 -until 2026-11-05 -json > explicit.json
TOKENBOARD_CCUSAGE_CONFIG= \
  go run ./cmd/parity -source claude-code -since 2026-09-25 -until 2026-11-05 -json > control.json
```

判读：`parity.json` 的 `pricingSource` 应为 `static` 或 `network`（据此解释费率口径），
`bench-*.json` 的 `ccusage.rssSource` 应为 `wait4-rusage`；若 `full` 各轮墙钟 >2× 离散，
先查 `uptime`（S1 基线报告 §2.1 的教训）。第 4 组里 `explicit.json` 与 `control.json` 的
`pricingConfig` 分别是 `ccusage.dynamic.json`（合并文件）与 `ccusage.bundled.json`
（materialized bundled），这一差别就是 §4.1 那组 25–35 倍值变化的入口。

## 8. 2026-11-06 全维度复核与修复

6 个独立审查 agent（适配器语义、原生定价引擎、provider/hook 接线、parity 数据复算、安全隐私、
CI/文档）加一轮 Codex 只读审查（8 条发现，无 Critical）。所有发现都回到源码或产物复核后才计入。
`useNativeClaude` 仍为 `false`，下列修复只影响 native seam 与开发工具。

### 8.1 已修复

| 问题 | 位置 | 修复 |
|---|---|---|
| ccusage 的 6 层配置作用域（`commands.*`、`claude.defaults` 等）的价格覆盖被丢弃 | `internal/pricing/scope.go`（新）、`providers/claudecode/native.go` | `PreparedConfig.ResolveScope` 按 `ConfigContext::option_maps` 顺序逐层字段合并，native 按 `claude daily` 作用域计价 |
| 配置里的 `defaults.mode`（auto/calculate/display）被忽略，固定 `ModeAuto` | 同上 | 模式随作用域解析并传入适配器；`display` 使用行内 `costUSD` |
| advisor 行携带部分 `cache_creation` 分档时与平面字段重复计量 | `adapters/claude/entry.go` | 分档存在时先清零再赋值（`types.rs:41-50`） |
| advisor 行被错加 `-fast` 后缀、`<synthetic>` 被错误过滤 | `adapters/claude/report.go` | advisor 行模型原样入桶（`lib.rs:566`、`daily.rs:390`），别名解析仍照旧 |
| parity 的活写判据方向与实际采集顺序相反（ccusage 先跑、native 后跑） | `cmd/parity/main.go` | 改为要求 native（后扫）≥ ccusage，并修正测试夹具 |
| 畸形显式 config 的 `defaults`/`codex` 段在 Go 侧 fail-open、TS 侧 fail-closed | `internal/pricing/config.go` | Go 改为报错（`explicit defaults/codex must be an object`） |
| 整请求长上下文分支对负数 token 无保护，可产生负成本 | `internal/nativepricing/cost.go` | 各桶 `<= 0` 归零，与边际分支一致 |
| `nativepricing.Cost` 对空模型名会模糊命中 `@` 开头行 | `internal/nativepricing/cost.go` | 空名短路返回 0/false（`cost.rs:99-101`） |
| `saturatingAdd` 负数右操作数会返回 `MaxInt64` | `adapters/claude/report.go` | 非正右值视为 0 |
| 根目录去重用原始字符串，`/a` 与 `/a/` 被当成两个根 | `adapters/claude/paths.go` | 按组件归一化（Rust `Path` 语义）；`/a/./` 不再重复扫描 |
| 非法 UTF-8 的候选行被接受并计量 | `adapters/claude/entry.go` | 候选行先过 `utf8.ValidString`（serde 语义） |
| 每个被 `--since` 剪掉的 transcript 各打一行日志，携带绝对路径、淹没真实错误 | `adapters/claude/collect.go` | 汇总为一行 `Skipped N Claude session file(s) ...`，不带路径 |
| 开发脚本 spawn ccusage 时继承凭据环境 | `scripts/gen-claude-goldens.mjs`、`scripts/gen-native-pricing-goldens.mjs`、`scripts/check-deps.sh` | 统一剥离 4 个凭据键；`scripts/child-env.test.mjs` 对照 Go/skill 名单 |
| CI 只跑定价生成器测试，新脚本无门禁 | `.github/workflows/go-client.yml` | `native pricing generator tests` 同时跑 `child-env.test.mjs` |

### 8.2 已知遗留（未修，需在翻转前决策）

- **hook 对账在 `-fast` / 模型别名 / `<synthetic>` 行上会永久失败**：增量解析用原始
  `message.model`，重算走适配器的后缀/别名映射，精确键断言失败并保留 pending。这是 TS 侧
  同样存在的共享缺陷（先于 S2），修复要改 cursor/对账契约并两侧同时验证。
- **DeepSeek 时段定价未实现**：`nativepricing` 没有 `FindAt`，`Cost` 的 `at` 形参被忽略。
  影响所有含 deepseek 模型行的成本（claude 路径同样），归属 S1/S3，需补语料资产与冻结输入定义。
- 非法代理项转义（`\ud800`）仍被 `encoding/json` 替换为 U+FFFD 而非整行拒绝；畸形输入。
- 扫描层不设单行长度/递归深度上限（刻意与 ccusage 一致；共享 `sessionscan` 已有上限，适配器没有）。
- parity/bench/shadow 的文本与 JSON 输出会打印本机绝对路径（仅开发工具，无凭据）。
- 研究文档 §3.2 的 26 个代理模型别名**有意保留**：它们是「语料未命中」这一结论的唯一可复核
  输入，替换成占位符后该节无法复现；其中不含凭据、主机名或路径。审查台账
  （`docs/research/audit-2026-10-30-ledger.md`）的内网 IP 与 Windows 用户名已于 2026-11-06
  替换为「测试机 A/B」与 `<user>`。
- §4.1 的显式 config 证据已于 2026-11-07 复跑重新确认：两键 config 可复现上一版产物
  （275 条公共 key 中 252 条逐位相同），此前「不可复现、疑似更宽 override 集」的结论已撤回；
  188/128 条连带变化的成因已定位到 `NormalizeCcusageDailyJSON` 的父行分摊，但分摊倍率
  不一致的剩余结构仍未拆清（见 §4.1 末两条）。

### 8.3 作用域 override 与 mode 的真实二进制验证

修复后用仓库自带的 Claude 夹具（7 个 transcript，`clients/go/internal/collect/adapters/claude/testdata/claude-fixture`）
做了端到端探针：`ccusage claude daily` 直接用 `--config` 读同一份配置，parity 三组都 `match`（16/16，0 diff）。

| 配置 | ccusage `claude-opus-4-6-fast` | ccusage `claude-opus-4-6` | 总成本 | parity |
|---|---:|---:|---:|---|
| 无 `--config` | 0.0027 | 0.00045 | 2.184083 | match |
| `claude.defaults.pricingOverrides` = $123/M | **0.048708** | **0.008118** | 2.237759 | match |
| `defaults.mode = "display"` | **0** | **0** | 0.50027（行内 `costUSD`） | match |

第一行与第二行证明 ccusage 确实应用了 `claude.defaults` 作用域（成本 ×18），修复前 native 读根
`defaults.pricingOverrides`、会停留在第一行的值，parity 必现 diff；第三行证明 `mode=display`
让 ccusage 改用行内 `costUSD`，修复前 native 固定 `ModeAuto` 会算出计算值。三组都 match，
说明 native 现在解析的是与 ccusage 相同的 6 层作用域和同一个 mode。
（命令：`cd clients/go && CLAUDE_CONFIG_DIR=<fixture> go run ./cmd/parity -source claude-code
-since 2026-02-25 -until 2026-03-31 -json`，配置经 `TOKENBOARD_CCUSAGE_CONFIG` 传入。）
