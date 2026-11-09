# 2026-11-10 S5 翻转前的费用覆盖复核

- 日期：2026-11-10 07:00–07:30（Asia/Shanghai），本机 macOS / darwin amd64
- 分支：`feat/native-usage-sources` @ `3c65b28`（探针为临时测试，未提交；探针源码见 §3）
- 目的：回答「Go 翻到原生后，claude-code 的 `costUsd` 相对现有 ccusage 路径会怎样变化」，为
  `docs/superpowers/plans/2026-11-10-s5-remove-ccusage-acquisition.md` 的翻转决定提供证据。

## 1. 方法（只投影计量字段）

临时 Go 测试（`internal/collect/adapters/claude/zz_probe_test.go`，跑完即删）复刻 daily 链路：

- 输入：`ScanFiles(~/.claude)` → `PruneByMTime(since, Asia/Shanghai)` → `ParseDailyLineEntries`
  → `NewCostFunc(overrides, ModeAuto)` → `NewDedupe(DedupeDaily)`，即 `claude.Collect` 的前半段；
- 逐去重幸存条目统计：`reported`（`Usage.ReportedCost != nil`，即行内 `costUSD` 存在）、
  `corpusHit/corpusMiss`（`nativepricing.Corpus.Find`，即冻结语料，**不含** override）、
  `cost`（`Entry.Cost`，即 native 的计算/采用结果）、四个 token 桶之和；
- 窗口 `2026-11-02..2026-11-08`（与 `ccusage claude daily ... --since 2026-11-02 --until 2026-11-08`
  同参、同 `packages/collector/ccusage.json`），另跑 `2026-10-25..2026-11-08` 对照。
- 不读取 prompt/回复正文；探针只调用既有解析器的 token/模型/时间戳字段。

命令：

```bash
cd clients/go
TB_PROBE_ROOTS="$HOME/.claude" TB_PROBE_OVERRIDES="<repo>/packages/collector/ccusage.json" \
  TB_PROBE_SINCE=2026-11-02 TB_PROBE_UNTIL=2026-11-08 \
  go test ./internal/collect/adapters/claude/ -run TestZZProbeReportedCost -count=1 -v
```

## 2. 结果

### 2.1 行内 `costUSD` 的覆盖：0

两个窗口（14 天）中，daily 链路去重幸存条目里 **`reported = 0`（逐模型全部为 0）**。
本机 transcript 不写行内 `costUSD`；会话汇总行带 `totalCostUSD`，但那不是被计费的载体。

### 2.2 逐模型（窗口 `2026-11-02..2026-11-08`，带 bundled override）

| 模型 | 条目 | reported | 语料命中 | native 成本 (USD) |
|---|---:|---:|---:|---:|
| `deepseek-v4.1-flash` | 88786 | 0 | 88786 | 5835.39 |
| `DeepSeek-V4.1-Flash` | 31974 | 0 | 31974 | 942.58 |
| `deepseek-v4.1-flash-1017` | 16312 | 0 | 16312 | 893.85 |
| `deepseek-ai/deepseek-v4.1-flash` | 12263 | 0 | 12263 | 685.44 |
| `group/auto-dfmodel` | 8453 | 0 | **0** | **0.00** |
| `deepseek_for_coding` | 1399 | 0 | **0** | **0.00** |
| `deepseek-v4.1-flash[1M]` | 872 | 0 | 872 | 57.75 |
| `z-ai/glm-5.3-flash` | 315 | 0 | 315 | 8.07 |
| `GLM-5.3-Flash` | 241 | 0 | 241 | 4.47 |
| `claude-opus-5.5` | 235 | 0 | 235 | 155.76 |
| `stepfun-ai/step-5-preview` | 225 | 0 | 225 | 30.13 |
| `glm-5.3-flash` | 125 | 0 | 125 | 2.79 |
| `DeepSeek-V4-Flash` | 70 | 0 | 70 | 1.15 |
| `hy4-free` | 65 | 0 | **0** | **0.00** |
| `deepseek-v4.1-flash-abliterated-free` | 55 | 0 | 55 | 3.56 |
| `claude-fable-5` | 24 | 0 | 24 | 38.15 |
| `claude-sonnet-5-5` | 6 | 0 | 6 | 1.53 |
| `step-5-preview` | 6 | 0 | 6 | 0.00（override 零费率） |
| `hy4` | 1 | 0 | 1 | 0.21 |
| `deepseek-v4.1-flash测试` | 1 | 0 | 1 | 0.13 |
| `""`（空模型名） | 1 | 0 | 1 | 0.00 |

## 3. 对 2026-11-05 §9 归因的更正

`docs/research/2026-11-05-claude-native-parity.md` §9 把 117 条 diff 中的 45 条写成
「native 按 `ModeAuto` 取行内 `costUSD`，ccusage 在线用实时价重算」。**该表述不成立**：
§2.1 显示本机没有任何行内 `costUSD`。正确的成因是：

- `NormalizeCcusageDailyJSON`（`clients/go/internal/ccusage/normalize.go:472-487`）在行内无成本时，
  把**同一天的父行成本按 token 占比摊给子行**：`parentCost × rowTokens/parentTokens`；
- `group/auto-dfmodel`、`deepseek_for_coding` 等模型在 native 侧 `corpusMiss` → 计 0，于是当天
  父行总额全部分摊给了同一天的其它模型（本机即各种 deepseek 变体），使这些行比 ccusage 的
  在线价表结果高出约 0–80 USD/天；
- 两侧共用同一 normalize 代码，所以 72 条「native == ccusage --offline」逐位相同——那是分摊前
  数字就相同的行；45 条是「被分摊抬高的行」与「ccusage 在线价表结果」之差，本质仍是父行总额
  不同（native 少算了未覆盖模型），而不是单价不同。

### 3.1 这对翻转意味着什么

Go 客户端**会上传**（`internal/cli/cli.go:261` 的 `upload.UploadSnapshots`），所以翻转不是「只影响 shadow」：
生产 `sync` 的某一台机器一旦装上翻到原生的客户端，它上传的 claude 行就来自 native。

- `tokenboard shadow` 仍比较 TS（ccusage）与 Go（native），会继续看到上述 45 类的差异；
- 父行分摊与在线/离线价表两侧共用，所以 token 列、日期归属、模型名、sessionCount 全一致；
  差异只落在 `costUsd` 列，来源是「父行总额」（未覆盖模型在 native 侧计 0，在 ccusage 在线
  侧按实时价计），而不是单价表不同；
- 上传的数字随之由 native 计算：命中语料的模型按冻结语料计价，未命中语料的代理别名计 0；
  **父行分摊两侧共用**，所以这不是「native 少摊」而是「父行总额本身变小」——当日总费用下降，
  下降量集中在未覆盖的代理别名上，其它模型的分摊额也按比例缩小；
- 因此翻转前必须先决定：未覆盖的代理别名是否要补进 `pricingOverrides`，还是接受这块用量计 0。

这属于 spec §2 G2 已经承认的口径边界（「与线上 ccusage 逐字节一致」不可达），但它**需要用户
知情**：它不是「解析错」，而是「移除 ccusage 后拿不到代理模型的实时价」。可选缓解（不在本计划内）：
服务端下发的动态定价目录 `pricingOverrides` 覆盖这些代理别名。2026-11-10 08:00 复核时，
`packages/collector/ccusage.json` 的 48 条 override 中已有 `claude-*` 系列；代理别名
（`group/auto-dfmodel`、`deepseek_for_coding`、`hy4-free`、`DeepSeek-V4-Flash`、`kimi-k3.1`）
尚未覆盖。

## 4. 未覆盖边界

- 只在 claude-code 的 daily 链路、本机 `~/.claude` 上实测；codex / 工具族没有等价的代价。
- 探针直接用 `ParseDailyLineEntries`（daily 链路），AgentProgress 包装已包含其中；advisor
  拆分的每个子条目也各计一条。未覆盖：`ReportJSON` 层对 `missing_pricing` 的额外输出、
  以及子代理（sidechain）在报表里的去重语义（由既有金样本覆盖，本探针不重复）。
- 窗口内的 `full` 历史（2026-11 之前）未扫描；`PruneByMTime` 只保留窗口相关文件，结论对更早的
  窗口**未验证**。
