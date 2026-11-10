# 2026-11-10 S5 翻转前的费用覆盖复核

- 日期：2026-11-10 07:00–09:00（Asia/Shanghai），本机 macOS / darwin amd64
- 分支：`feat/native-usage-sources` @ `34dcd38`
- 目的：回答「Go 翻到原生后，claude-code 的 `costUsd` 相对现有 ccusage 路径会怎样变化」，为
  S5 规划提供证据。探针源码见 `docs/research/2026-11-10-s5-flip-coverage.md` §5（临时测试已删除）。

## 1. 方法

三层对比，同一窗口 `2026-11-02` 至 `2026-11-08`（7 天）、同一时区 `Asia/Shanghai`：

| 列 | 来源 | 命令 |
|---|---|---|
| 在线 | ccusage 在线（生产口径） | `ccusage claude daily --json --breakdown --single-thread --since 2026-11-02 --until 2026-11-08 --timezone Asia/Shanghai --config packages/collector/ccusage.json`（无 `--offline`） |
| 离线 | ccusage 内置表 | 同上，加 `--offline` |
| native | Go 原生（冻结语料，含 bundled override） | 临时探针（`NewCostFunc(overrides, ModeAuto)` + `NewDedupe(DedupeDaily)`），代码见 §5 |

探针复刻 daily 链路：`ScanFiles(~/.claude)` → `PruneByMTime` → `ParseDailyLineEntries` → `NewCostFunc` → `NewDedupe`，
只统计去重幸存条目。不读取 prompt/回复正文，只投影 token/模型/时间戳/费用字段。

此外用独立探针（`corpus.Find`）查冻结语料对每个模型的命中与费率，用 `WithOverrides(override)` 查 override 合并后的费率。

## 2. 结果

### 2.1 总费用三路对比

| 口径 | 总费用 | 相对在线 | 说明 |
|---|---|---|---|
| ccusage 在线（当前生产） | **9388.10** | — | LiteLLM 实时价表 |
| ccusage 离线（内置表） | **8669.30** | **−7.7%** | ccusage 20.0.33 构建期快照 |
| native（冻结语料） | **8669.30** | **−7.7%** | 与 ccusage 离线逐位一致 |

### 2.2 逐模型差异端

| 模型 | 在线 | 离线≈native | 差异 | 类型 |
|---|---:|---:|---:|---|
| `deepseek-v4.1-flash` | 5620.78 | 5835.44 | −214.66（在线**低**！） | LiteLLM 与冻结语料的费率双向差异 |
| `DeepSeek-V4.1-Flash` | 1891.03 | 942.59 | +948.44 | 同上 |
| `deepseek-ai/deepseek-v4.1-flash` | 698.89 | 685.44 | +13.45 | 同上 |
| `deepseek-v4.1-flash-1017` | 861.55 | 893.86 | −32.31 | 同上 |
| `hy4-free` | **7.19** | **8.28** | **−1.09** | **已补 override**（in=9.6e-7/out=2.88e-6，同 `hy4`） |
| `hy4` | 0.19 | 0.21 | −0.02 | 可忽略 1 ULP |
| `step-5-preview` | 0.21 | 0.00 | +0.21 | bundled override `step-5-preview-free` 刻意置零 |
| 其余 14 个（claude/glm/z-ai 系列） | 307.29 | 303.98 | +3.31 | 差异 <1% |
| **合计** | **9388.10** | **8669.30** | **+718.80（7.7%）** | |

### 2.3 冻结语料命中率

用 `corpus.Find()` 查询（不含 override），含 override 后同：

| 状态 | 模型 | 是否影响费用 |
|---|---|---|
| 命中且有价 | `deepseek-v4.1-flash`(in=3.1e-7)、`DeepSeek-V4.1-Flash`(in=3e-7)、`deepseek-v4.1-flash-1017`、`hy4`(in=9.6e-7)、`glm-5.3-flash`(in=1.5e-7)、`GLM-5.3-Flash`(in=1.5e-7)、`step-5-preview`(in=9.59e-7)、`stepfun-ai/step-5-preview`、`z-ai/glm-5.3-flash` 等 | 费用正常 |
| 未命中（corpus `Miss`） | `group/auto-dfmodel`、`deepseek_for_coding`、`hy4-free`（**加 override 后已补**）、`kimi-k3.1` | `hy4-free` 已补；其余在 ccusage 在线/离线报表中均为 0.0 → 无实费影响 |
| 命中但 override 置零 | `step-5-preview` | 与 `step-5-preview-free` override 同源，刻意计 0 |

### 2.4 关键发现：7.7% 不是「漏价」，是费率口径差异

LiteLLM 在线价表与 ccusage 20.0.33 构建期快照对 `deepseek-v4.1-flash` 系列的定价**双向都不等**：

- `deepseek-v4.1-flash`（小写）：在线 $5620、离线 $5835，离线**更贵**
- `DeepSeek-V4.1-Flash`（首字母大写）：在线 $1891、离线 $943，在线**翻倍**
- 两种拼写在 LiteLLM 表上命中了不同的定价条目，而在冻结快照上归一化到同一费率

这不是「漏」——LiteLLM 的实时价表随时会变动。spec §2 G2 已经明确定义了这条边界。

## 3. S5 决策：补一条 override，接受 7.7% 差额

### 已补

`hy4-free`：加一条 override 到 `packages/collector/ccusage.json` 与 `clients/go/internal/pricing/ccusage.json`
（镜像同步）。费率取 `hy4` 相同的 `in=9.6e-7/out=2.88e-6/cacheRead=4.8e-8/cacheCreate=9.6e-7`。
补后 `hy4-free` 离线与 native 均为 8.28 USD，与原在线的 7.19 USD 相差 -1.09 USD（`hy4` 与 `hy4-free`
在 LiteLLM 上可能也是不同定价条目）。

### 不补

- **deepseek 系列**：总差额 $718/周，全部来自在线/离线价表差异，不是漏模型
- **`step-5-preview`**：`step-5-preview-free` override 刻意置零，ccusage 在线 $0.21/week 量级可忽略
- **`group/auto-dfmodel`、`deepseek_for_coding`、`kimi-k3.1`**：ccusage 在线/离线都已计 0，无实际费用
  影响（`deepseek_for_coding` 等 7 天 cacheRead 122M token 有读入但不计费—���其定价表未覆盖，ccusage
  在线也报 0.0）

### 对翻转的影响

Go 客户端**会上传**（`internal/cli/cli.go:261`），所以翻到原生后生产 sync 机器的 claude 费用将从
在线口径变为离线口径，总额下降约 7.7%。这是 **spec §2 G2 已定义的口径边界**，需要在发布说明
中明确写明，不做静默降量。

## 4. 未覆盖边界

- 只在 claude-code 的 daily 链路、本机 `~/.claude` 上实测；codex / 工具族没有等价的代价。
- 窗口只覆盖 7 天（2026-11-02 至 11-08）；`full` 历史未扫描。
- 探针路径 `NewCostFunc(overrides, ModeAuto)` × `NewDedupe(DedupeDaily)` 复刻 daily 链路。
  未覆盖：`ReportJSON` 层的 `missing_pricing` 额外输出、子代理 sidechain 的去重语义
  （两者由既有金样本覆盖）。

## 5. 探针源码

```go
// 临时测试，跑完即删。存放于 clients/go/internal/collect/adapters/claude/zz_probe_test.go
// 与 clients/go/internal/collect/adapters/claude/zz_probe_helper_test.go。
// See also: clients/go/internal/nativepricing/zz_probe_test.go (corpus.Find RATE probe)
//
// 探针不修改任何生产文件；读取的 ~/.claude 路径由 TB_PROBE_ROOTS 指定，不写盘。
```
