# S5 迁移差异台账（native vs 生产线上 ccusage）

- 日期：2026-11-15 整理，依据 2026-11-10 至 2026-11-15 的真实数据双跑，不新跑基准。
- 目的：兑现 `docs/superpowers/specs/2026-11-03-native-usage-sources-design.md` §2 G2 的**迁移闸门**——
  「落地前做一次 native vs 生产线上 ccusage 的 diff，每一处差异逐条列出并解释」，以及 D7 的
  「差异逐条进台账」，让首次全量上传造成的历史 `costUsd` 覆盖是**已知且有意**的。
- 口径：两侧都读本机真实数据。「生产线上 ccusage」= TS 采集链路 spawn 的 ccusage 20.0.33（**在线价表**）；
  「native」= Go 原生适配器（**冻结语料 + 服务端下发的动态目录 override**）。两侧 state 目录都是临时的，
  不触碰真实 cursor；`shadow` 会把本机 `model-pricing-cache.json` 播种进两侧，所以 native 侧走的是
  动态定价目录这条生产路径，不是纯静态回退（`clients/go/internal/cli/shadow.go` 的 `seedShadowPricingCache`）。

## 1. 来源

| 证据 | 内容 |
|---|---|
| `docs/research/2026-11-10-s5-post-flip-dual-run.md` | 翻转后首轮：codex、claude-code（preview + hook）、grok-build、deepseek-harness、kimi、zcode、amp，加九个空工具源 |
| `docs/research/2026-11-10-s5-flip-coverage.md` §2.4 | deepseek 族双向费率差的逐口径拆解，7.7% 总量差的来源 |
| `~/.tokenboard/logs/observation-dual-run.jsonl` 的 `observation-dual-run` 定时双跑 | 2026-11-12 至 11-15 的每日七源记录（codex、claude-code、grok-build、deepseek-harness、amp、kimi、zcode） |

定时双跑的最新三条有效记录（2026-11-13 / 11-14 / 11-15 03:2x 北京时间）结论一致：
claude-code、amp、zcode 为 `cost-only`，其余四源 `match`，没有出现费率口径以外的差异。

## 2. 差异总账

只有一类差异存在：**`costUsd`**。没有任何来源在 token 字段、`usageDate`、`timezone`、`model`、
`sessionCount` 上分叉，也没有单侧缺行（`onlyInTs` / `onlyInGo` 全为 0）。因此下表按「来源 → 机制 → 归因」排列，
不逐行罗列 131 条 claude 差异——逐行倍率分布见 post-flip 报告 §3。

| 来源 | 结果 | 差异行数 | 机制 | 归因 |
|---|---|---|---|---|
| codex | match | 0 | — | preview 与 hook 两条路径均逐位一致 |
| grok-build | match | 0 | — | 4 快照一致 |
| deepseek-harness | match | 0 | — | 4 快照一致 |
| kimi | match | 0 | — | 2 快照一致 |
| claude-code | cost-only | 131 / 513（preview）、131 / 519（hook） | 见 §3.1–§3.3 | G2 口径边界 |
| zcode | cost-only | 4 / 5 | 在线表对 `GLM-5.3` / `GLM-5.3-Flash` 无价，动态目录补了 | G2 口径边界（Go 多计价） |
| amp | cost-only | 2 / 2 | 动态目录 override 比在线表便宜 | G2 口径边界（Go 少计价） |
| 其余九个工具源（droid、codebuff、hermes、goose、kilo、copilot、gemini-cli、qwen、openclaw） | 两侧一致 `empty` | 0 | 本机无数据 | 不是等价性证据，只钉住子命令名映射；等价性依赖冻结金样本与 2026-11-09 的 parity 报告 |

### 2.1 claude-code 的 131 条按机制拆开

| 机制 | 行数 | 方向 | 说明 |
|---|---|---|---|
| deepseek 族双向费率差 | 98 | 双向，0.50×–4.74× | LiteLLM 在线表对 `deepseek-v4.1-flash` 与 `DeepSeek-V4.1-Flash` 命中不同条目；冻结快照归一化到同一费率。同一模型不同拼写既可能更贵也可能更便宜（`s5-flip-coverage.md` §2.4） |
| `kimi-k3.1` 精确命中 vs 最长键模糊命中 | 1 | Go 1.98×（$87 → $173） | 在线目录有 `kimi-k3.1` 精确键；冻结语料只有 `kimi-k3.1-pro` / `-highspeed`，按最长键命中更贵的 `-highspeed`。与 ccusage `--offline` 同一份配置时逐位一致 |
| 其余 deepseek 族细行（含 `-1017` 等） | 32 | 双向 | 同一机制的零散拼写（post-flip 报告 §3 把这一组记作「其余 33 条」，与该报告已经细分的 1 条 `kimi-k3.1` 指向同一批行，机制不变） |

总量层面：claude-code 的 native 离线口径比在线低 **7.7%**（`s5-flip-coverage.md`），但这只是总量上的巧合抵消——
逐行可以到达 2 倍以上。发布说明与裁决都必须按逐行倍率读，不能按总量读。

### 2.2 zcode 与 amp：方向相反的两条重复证明

- zcode：四个成本与 `ccusage zcode daily --offline --config ~/.tokenboard/ccusage.dynamic.json`
  **逐位相同**（0.00364661 / 0.0185976 / 0.00361046 / 0.00613888），说明 Go 与「ccusage + 同一份冻结配置」一致，
  差的是在线表缺价。
- amp：`grok-code-fast-1` 两条，Go 是在线价的 0.53× / 0.67×，同样与 `ccusage --offline --config` 逐位一致。
  差异来自动态目录的 override 更便宜。

两条都说明：**Go 与「ccusage + 冻结配置」是同一种计算**，与在线 ccusage 的差异是输入不同，不是实现不同。

## 3. 首次全量上传的影响（D7 落实）

历史 `costUsd` 会被 native 重传覆盖，覆盖范围是「本机历史上传过的、仍在 D1 里、且再次被上传的
`(source, date, model)` 行」。按上表，覆盖后：

- 非 claude 来源的费用变化只可能来自 zcode / amp 这类「动态目录 override」的差异；其余来源逐位不变。
- claude-code 的历史行会整体从在线口径换成冻结口径：总量约 -7.7%，单行可能 ±2 倍以上（§2.1）。
  **这是已知且有意接受的覆盖**（D7），不是缺陷；如果之后要对账，用本台账的机制说明解释任何一条差异。

## 4. 未覆盖

- Antigravity 三源（`antigravity-cli`、`antigravity`、`antigravity-ide`）不走 ccusage，不在本台账范围内；
  GUI 两源至今没有真实 usage 数据（本机账号没有 Antigravity AI 权限），见 `docs/specs/go-client-spec.md` §11 条件 2。
- 九个空工具源只有子命令映射被钉住，没有有数据的双跑（见 §2）。
- 台账依据的是本机数据（macOS darwin amd64）；Linux 与 Windows 的差异样本见
  `docs/research/2026-11-11-windows-linux-verification.md`（Linux 61 快照 1 条 `costUsd`，Windows 近期窗口 match）。
- 本台账是**汇总**，不是逐行明细。需要某个具体行的解释时，回到 post-flip 报告给出的命令重跑
  `shadow` 并看 `differing[].fields`；台账的职责是证明「差异类型封闭且有归属」，不是替代原始输出。
