# S5 迁移差异台账（native vs 生产线上 ccusage）

- 日期：2026-11-15 整理，依据 2026-11-10 至 2026-11-15 的真实数据双跑；§2.3 为 2026-11-19 依据
  后续定时双跑（至 2026-11-19 03:24 北京时间）的补记，不新跑基准。
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
| `~/.tokenboard/logs/observation-dual-run.jsonl` 的 `observation-dual-run` 定时双跑 | 2026-11-13 至 11-19 北京时间 03:2x 的 7 条七源记录（codex、claude-code、grok-build、deepseek-harness、amp、kimi、zcode；11-13 那条 codex 为 `error`），另有 2026-11-12 的两条单源补跑与 2026-11-13 09:43 的 codex 单源补跑 |

定时双跑（日期按北京时间，日志里的 `at` 是前一日 19:2x UTC）的观察：

| 北京时间 | 结论 |
|---|---|
| 11-13 | claude-code、amp、zcode 为 `cost-only`；grok-build、deepseek-harness、kimi 为 `match`；codex 那次为 `error`，当日 09:43 单源补跑为 `match` |
| 11-14 / 11-15 | claude-code、amp、zcode 为 `cost-only`，其余四源 `match` |
| 11-16 至 11-19 | 同上，但 **kimi 转为 `cost-only`**（机制见 §2.3），即 4 cost-only + 3 match |

除 §2 列出的 `costUsd` 口径差以外，没有出现任何其他差异（各记录的 `onlyInTs` / `onlyInGo` / `unexplainedRows` 全为 0）。

## 2. 差异总账

只有一类差异存在：**`costUsd`**。没有任何来源在 token 字段、`usageDate`、`timezone`、`model`、
`sessionCount` 上分叉，也没有单侧缺行（`onlyInTs` / `onlyInGo` 全为 0）。因此下表按「来源 → 机制 → 归因」排列，
不逐行罗列 131 条 claude 差异——逐行倍率分布见 post-flip 报告 §3。

| 来源 | 结果 | 差异行数 | 机制 | 归因 |
|---|---|---|---|---|
| codex | match | 0 | — | preview 与 hook 两条路径均逐位一致 |
| grok-build | match | 0 | — | 4 快照一致 |
| deepseek-harness | match | 0 | — | 4 快照一致 |
| kimi | cost-only（北京时间 2026-11-16 起） | 2 / 2 | deepseek 族费率差的又一次出现，见 §2.3 | G2 口径边界（在线表变了） |
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

### 2.3 kimi 从 match 变为 cost-only（2026-11-19 补记）

定时双跑从**北京时间 2026-11-16 03:23** 那次起把 kimi 记为 `cost-only`（11-13 至 11-15 的三次是 `match`；
日志 `at` 为 `2026-11-15T19:23:39Z`）：两条 `deepseek-v4.1-flash` 行，
`2026-10-09` 在线 0.7678864213999999 / native 2.456199409999999，`2026-10-10` 在线 1.4907061078000006 /
native 4.90099708，约 3.2 倍。2026-11-19 重跑 `shadow --source kimi` 复现同样的四个数
（`onlyInTs` / `onlyInGo` / `liveWrite` 均为 0）。

这仍是 §2 的 `costUsd` 口径差，不是新的分叉。2026-11-19 实测两侧各自逐位复现：

```
ccusage kimi daily --json --offline --config ~/.tokenboard/ccusage.dynamic.json --timezone Asia/Shanghai
→ 2.456199409999999 / 4.90099708          # 与 native 逐位一致（不带 --config 也一样）
ccusage kimi daily --json --timezone Asia/Shanghai
→ 0.7678864213999999 / 1.4907061078000006  # 与 TS 侧逐位一致
```

即 Go 与「ccusage + 冻结语料」仍是同一种计算。两次记录的 token 字段完全相同、native 侧又只由冻结语料决定，
所以 11-15 与 11-16 之间发生变化的只能是 TS 侧读到的**在线费率**——这一句是从上述事实推出的结论，
本机没有保留 11-15 当天的在线表快照，无法直接比对。在线侧具体命中了哪一档费率也没有逐项还原
（这两个数对不上本地 LiteLLM 缓存与动态目录里任何单一费率条目的直接线性组合，可能涉及 ccusage 自身的
分层或合成规则）；本台账只钉住「差异在输入、不在实现」。

由此产生的读数纪律：**本节任何一行的 `match` 都只对记录当天成立**。在线价表会变，双跑的分类会随之漂移，
而 native 侧由冻结语料决定，不会跟着动。台账升级为「差异类型封闭且有归属」的证明，不承诺逐日的
`match` 集合稳定。

## 3. 首次全量上传的影响（D7 落实）

历史 `costUsd` 会被 native 重传覆盖，覆盖范围是「本机历史上传过的、仍在 D1 里、且再次被上传的
`(source, date, model)` 行」。**触发条件是 `snapshot_hash` 变化，而 hash 的 payload 含 `costUsd`**——
所以只要 native 算出的成本与当初线上 ccusage 算出的不同，哪怕 token 计数一字不差，该行也会被覆盖。

> 这一点在 2026-11-15 复核时修正过一次：服务端 upsert 曾经有一条「token 计数相同则冻结 `cost_usd`」
> 的臂（2026-10-10 加入），它会让本节的论断在「只差成本」的行上不成立，同时留下 hash 与行内容不一致
> 的行。该臂已按 D7 删除（见设计规格 §9.4.1 的 2026-11-15 修订），本节描述与代码一致。

> **两条边界（2026-11-16 复核补记）**：
> 1. **没有自愈路径。** 修复部署前被冻结过的行，其 `snapshot_hash` 早已等于客户端当前 payload 的
>    hash，客户端的 `/check` 会比中并跳过，所以这些行**不会**因为这次修复被自动纠正——只有该键的
>    token 或成本再次变化时才会被覆盖。这与 D7「不服务端重算历史」一致，但别把本节读成「历史会自我修正」。
> 2. **「hash 与行一致」只对 token 被替换的行成立。** `preserveCodexSessionOnlySql` 臂刻意保留旧
>    token 与旧成本、却写入新 hash，那是它防止无 token 的 session-only 报告清空已有用量的职责。

按上表，覆盖后：

- 非 claude 来源的费用变化只可能来自 zcode / amp 这类「动态目录 override」的差异，或 kimi 这种在线表
  自身变动（§2.3）；其余来源逐位不变。
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
