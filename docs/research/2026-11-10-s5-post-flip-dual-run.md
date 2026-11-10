# 2026-11-10 S5 翻转后的真实数据双跑

- 日期：2026-11-10 17:26–18:30（Asia/Shanghai），本机 macOS / darwin amd64，负载 47
- 分支 / 二进制：`feat/native-usage-sources` @ `a81450b` → `go build -o /tmp/tb-a81450b ./cmd/tokenboard`
- 目的：补齐 S5 计划 Task 3/5 Step 5 记下的未覆盖项——翻转后（获取层已删、三个来源全走原生）
  的端到端双跑。生产本机仍是 `clientType: git`（TS collector），所以两侧都是真实路径：
  TS 侧 = 生产采集链路 + ccusage 20.0.33（在线价表），Go 侧 = 原生适配器（冻结语料）。

## 1. 命令

```bash
TOKENBOARD_CODEX_SYMLINK_ROOTS_JSON='["<HOME>/.codex/archived_sessions.local"]' \
  node skills/tokenboard/scripts/shadow-dual-run.mjs --client /tmp/tb-a81450b --source codex --until 2026-11-09

node skills/tokenboard/scripts/shadow-dual-run.mjs --client /tmp/tb-a81450b --source claude-code --until 2026-11-09
node skills/tokenboard/scripts/shadow-dual-run.mjs --client /tmp/tb-a81450b --source claude-code --hook

# 工具族：只有 kimi 与 zcode 在本机有数据，且工具源不接受 --until
node skills/tokenboard/scripts/shadow-dual-run.mjs --client /tmp/tb-a81450b --source kimi --since all
node skills/tokenboard/scripts/shadow-dual-run.mjs --client /tmp/tb-a81450b --source zcode --since all
```

claude-code 的 preview 与 hook 两次都判为 `diff`，zcode 也是 `diff`，harness 按设计 **exit 1**
（`exitCodeForDualRun`：任一 `diff`/`error` 即失败）。
结构化明细由同一二进制直接产出：

```bash
TOKENBOARD_COLLECTOR_DIR=$PWD TOKENBOARD_TIMEZONE=Asia/Shanghai \
  /tmp/tb-a81450b shadow --source claude-code --until 2026-11-09 > /tmp/shadow-claude.out
```

## 2. codex：match，preview 与 hook 两条路径

| 模式 | 命令 | 结果 |
|---|---|---|
| preview | `shadow-dual-run.mjs --client /tmp/tb-a81450b --source codex --until 2026-11-09` | `match`，10 快照 |
| hook | `shadow-dual-run.mjs --client /tmp/tb-a81450b --source codex --hook` | `match`，18 快照，`liveWrite` 1 |

翻转后 codex 的真实数据等价性在全量与增量两条路径上都成立。

## 3. claude-code：preview 与 hook 同口径，131 条只差 `costUsd`

两条路径的字段级结果完全相同：

| 指标 | preview | hook |
|---|---|---|
| 快照总数 | 382 | 384 |
| 差异 | 131 | 131 |
| `onlyInTs` / `onlyInGo` | 0 / 0 | 0 / 0 |
| 差异字段 | 只有 `costUsd`（131/131） | 只有 `costUsd`（131/131） |
| 差异模型数 | 22（deepseek 族 98 条，其余 33 条） | 22（分布逐项相同） |
| 倍率区间（go/ts） | 0.50×–4.74× | 0.50×–4.74× |
| `liveWrite` | — | 4 |

hook 多出的 2 条快照与 4 条 `liveWrite` 来自当天正在写入的会话，属已知的活写竞态，
不是语义差异。

token、日期、时区、模型名、`sessionCount` 全部逐位一致；成本差异的逐行倍率（go/ts）方向不一致：
deepseek 族的两种拼写在在线表上命中不同条目，既能更贵也能更便宜
（`2026-11-10-s5-flip-coverage.md` §2.4 记录的「双向费率差」的逐行体现）。
**没有任何非成本字段的分叉**，所以按 spec §2 G2 的定义，这不是语义移植缺陷；
但倍率远大于总量级的 7.7%，发布说明和后续裁决都必须按逐行倍率看，不能按总量看。

### 3.1 `kimi-k3.1` 的 1.98 倍：精确命中 vs 模糊命中

| 口径 | 成本 | 命中的费率（per token） |
|---|---|---|
| ccusage 在线（TS 生产路径） | 87.17202984216998 | input 2e-6 / output 1e-5 / cacheRead 2e-7（`kimi-k3.1-pro`） |
| ccusage `--offline`（同一份 `--config`） | 172.74319440000005 | input 4e-6 / output 2e-5 / cacheRead 2e-7（`kimi-k3.1-pro-highspeed`） |
| Go 原生（同一份动态 override） | 172.74319440000005 | 同上 |

决定性对照实验（同一天、同一份最小配置，只含两个候选键）：

```bash
# 配置：kimi-k3.1-pro (2e-6/1e-5/2e-7) 与 kimi-k3.1-pro-highspeed (4e-6/2e-5/2e-7)
ccusage claude daily --json --breakdown --timezone Asia/Shanghai \
  --since 2026-10-29 --until 2026-10-29 --offline --config /tmp/mini.json
# → kimi-k3.1 cost 172.74319440000005（模糊匹配到 -highspeed，最长键优先）
ccusage claude daily ... --config /tmp/mini.json   # 不带 --offline
# → kimi-k3.1 cost 87.17202984216998（在线目录里有精确键）
```

结论：**Go 与 ccusage `--offline` 逐位一致**，差异全部来自在线目录对 `kimi-k3.1` 的精确命中。
这是 spec §2 G2 定义的口径边界，但幅度提醒值得写进发布说明：单行成本差异可以是 ~2 倍，
不只 7.7% 的总量级。触发条件是服务端目录里同时存在同一模型名的「基础版」与「highspeed 版」，
冻结语料只能按最长键模糊命中。

同一现象在窗口内还有更极端的行：`deepseek-ai/DeepSeek-V4.1-Flash-1017` 在 2026-10-26 是
4.74 倍（$0.0087 → $0.0412）、2026-10-25 是 2.01 倍，`DeepSeek-V4.1-Flash` 在 2026-09-27 / 10-09
是 0.50 倍。它们同属 deepseek 族的双向费率差（在线表对不同拼写命中不同条目），不是新的机制；
这些行的绝对金额都在分币量级，`kimi-k3.1` 那一条才是唯一既倍率高（1.98×）又金额大（$87 → $173）的。

## 4. harness 的判定与人工裁决

`shadow-dual-run.mjs` 把 claude-code 记为 `diff` 而不是 `match`，这是**正确的 fail-closed 行为**：
harness 只能看到「字段不同」，无法判断差异是否可归因。人工裁决结论：

- 131/131 差异只涉及 `costUsd`；
- deepseek 族 98 条与其余 32 条是已知的在线/离线费率差（`2026-11-10-s5-flip-coverage.md` §2.4）；
- `kimi-k3.1` 1 条经三路对照归因到在线精确命中 vs 离线模糊命中（§3.1）。

因此 claude-code 的翻转后双跑结论是：**语义等价成立；成本差异全部落在 G2 口径边界内**，
但「单行可达 2 倍」是这条边界的新证据，发布说明需如实写。

## 5. 工具族：kimi match，zcode 四条 cost-only 差异

12 个工具来源里本机只有三处有数据（`--since all`，Go 原生侧计数）：`kimi` 2 条、`zcode` 5 条；
`goose` / `copilot` / `openclaw` / `gemini-cli` 返回 0 条，其余六个目录不存在。

| 来源 | 结果 |
|---|---|
| kimi | `match`，2 快照 |
| zcode | `diff`，5 快照中 4 条差异，全部只差 `costUsd` |

zcode 的 4 条是 `2026-10-23 / 10-26 / 10-30` 的 `GLM-5.3-Flash` 与 `2026-10-25` 的 `GLM-5.3`，
TS 侧 0、Go 侧非零。**三路对照**：用同一份动态配置（`~/.tokenboard/ccusage.dynamic.json`）跑
`ccusage zcode daily --offline`，四个成本与 Go 输出**逐位相同**
（0.00364661 / 0.0185976 / 0.00361046 / 0.00613888）。

> 第一次对照时我用了 bundled 配置 `packages/collector/ccusage.json`，ccusage 报 0 且
> `missingPricing: true`，看起来像 Go 单方面计价；换成 Go 侧实际使用的动态配置后两侧一致。
> 差异的原因是**动态目录给 GLM-5.3 系补了价，而在线表没有**，与 claude 侧 `kimi-k3.1` 同属
> G2 口径边界（方向相反：这次是 Go 侧有钱、在线侧没有）。

## 6. 未覆盖

- codex 与 claude-code 的 hook 路径都已跑（codex match；claude-code 与 preview 同口径），
  但两侧都用**全新临时 state dir**，测的是冷 cursor 上的增量行为；生产的热 cursor
  （只有少量文件变更、窄 ccusage 窗口）仍无端到端证据。
- 工具族只有 kimi / zcode 有数据（§5）；其余十个来源在本机不存在或返回 0 条，它们的等价性
  只能依赖冻结金样本与 2026-11-09 的 parity 证据，**没有**双跑证据。
- preview 窗口截止 2026-11-09（避开活写竞态），不是全历史；`--hook` 与 `--until` 互斥，
  所以 hook 那次必然包含当天，其 diff 里已由 harness 单列 `liveWrite`。
- 只在本机、darwin 上验证。
