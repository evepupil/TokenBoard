# 2026-11-10 热 cursor 增量验证（S5 未覆盖项）

- 日期：2026-11-10 23:00–23:30（Asia/Shanghai），本机 macOS / darwin amd64
- 目的：补上 `docs/specs/go-client-spec.md` §11 与 `2026-11-10-s5-post-flip-dual-run.md` §6
  共同记下的空白——**生产的热 cursor 增量**。既有双跑两侧都用全新临时 state dir
  （`clients/go/internal/cli/shadow.go:126,132`），只测到冷 cursor。
- 方法：不走 `shadow`，直接驱动 Go 客户端的 hook 路径跑两次，用持久 state dir 制造热 cursor，
  再与一次全新 state dir 的冷扫对比。不涉及 TS 侧，因此本文验证的是**增量正确性**（自洽），
  不是与 ccusage 的 parity——parity 已由双跑单独覆盖。

## 1. 驱动方式

hook 增量路径由 `TOKENBOARD_HOOK_MODE=1` 触发（`clients/go/internal/cli/cli.go:736`），
`preview` 命令在 hook 模式下走 `sessioncursor.CollectHookIncremental`。根目录用
`CLAUDE_CONFIG_DIR` 指到夹具，state dir 用 `TOKENBOARD_STATE_DIR` 指到可复用的目录。

```bash
export CLAUDE_CONFIG_DIR=/tmp/hotcursor2/claude
export TOKENBOARD_STATE_DIR=/tmp/hotcursor2/state     # 同一个，跨两次运行复用
export TOKENBOARD_HOOK_MODE=1 TOKENBOARD_TIMEZONE=Asia/Shanghai
/tmp/tb-a81450b preview --source claude-code
```

夹具取自本机真实会话文件的副本（只读源文件，复制到临时目录后再改）：

- `a.jsonl`：1037 行真实会话；先只放前 600 行，随后**追加**剩余 437 行（模拟文件增长）。
- `b.jsonl`：另一份真实会话（1509 行），**全程不变**，用来验证未变更文件不会产生虚假增量。

## 2. 结果

三轮：`cold`（a 截断 + b 完整，全新 state）、`hot`（追加 a 的剩余行后，复用同一 state）、
`ref`（a/b 均完整，全新 state，作为参照冷扫）。

| 指标 | cold | hot | ref |
|---|---|---|---|
| 快照键数 | 9 | 18 | 18 |
| 非零 `sessionCount` 的键 | 2 | 1 | 1 |

- **`hot` 与 `ref` 键集合完全相同，且 18 个键的 7 个字段（input/output/cacheCreation/cacheRead/total/sessionCount/costUsd）逐项零差异。**
  即：在一次部分文件增长之后，hook 路径产出的绝对状态与全新冷扫一致，没有漏键、没有重复累计。
- `cold → hot` 变化的键恰好 10 个，全部落在 `a.jsonl` 覆盖的日期（`2026-10-09 / 10-12 / 10-26 / 10-31`）；
  `b.jsonl` 的 5 个 `2026-10-29` 键值不变。
- `b.jsonl` 的键在 `hot` 中**存在且值不变**——即未变更文件的快照是从 cursor 缓存还原的
  （`HookIncrementalResult.CachedSnapshots`），不是被重新解析，也没有被丢弃。

### 2.1 一个被我自己的错误假设浪费的步骤

第一次只用一个文件做实验时，我把「cold + hot」相加去和「全量冷扫」比较，得到每个字段恰好约 2 倍，
看上去像重复计数。实际是我的合并方式错了：**hook 路径对变更文件重算的是绝对总量，不是增量**，
`RangeArgs` / `ChangedKeys` 只决定「哪些键需要重新覆盖」，上传侧按
`(user_id, device_id, source, usage_date, model)` 五元键 upsert，不是累加。
正确的判据是「热跑对变更键的绝对值 == 冷扫的绝对值」，`hot == ref` 已经成立。

## 3. `sessionCount` 在不同输入间 1→0：已定性

同一个键 `(2026-10-09, deepseek-v4.1-flash)`，token 与成本完全相同，但 `sessionCount` 在截断
输入上是 1、完整输入上是 0。查清后这不是解析差异，也不是移植缺陷。

**`sessionCount` 不来自解析器。** claude 原生路径在
`clients/go/internal/collect/providers/claudecode/native.go:229`（预览）与 `:396`（hook）调用
`ccusage.NormalizeCcusageDailyJSON`，并把**独立的 sessions 报告**经 `NormalizeOptions.Sessions`
传入（`HasSessions: true`，注释说明空报告等于「没有会话」而非「没采集」）。
`ccusage/normalize.go:247` 的 `readSessionCount` 再从那张表里按 `(usageDate, model)` 取值。

**会话的归属键是单点的**：日期取 `lastActivity`（`readSessionDate`，normalize.go:271-288），
模型取 token 最多的那一个（`readSessionCountModel`，normalize.go:290-303），然后只在那一个键上
加 1。用夹具实测：

| 输入 | 该会话最后活动 | 主导模型 | 归属键是否存在于 daily 行 | sessionCount |
|---|---|---|---|---|
| 前 600 行 | `2026-10-09` | `deepseek-v4.1-flash` | 命中 | 1 |
| 完整 1037 行 | `2026-10-31T03:03:17Z` | `deepseek-v4.1-flash`（3060 万 token） | **未命中** | 0 |

完整文件里该会话的归属键是 `(2026-10-31, deepseek-v4.1-flash)`，但那天 daily 只有
`DeepSeek-Flash` 与 `DeepSeek-V4.1-Flash`（拼写不同），没有同名的行，于是
`sessionCounts[key]` 查空、这个会话被静默丢弃。所以 1→0 的原因是**归属键落空**。

**为什么不算缺陷**：`readSessionCount` 与 `readSessionCountModel` 都是从 TS 归一化器逐字移植的，
且两侧共用同一份实现，属既有的 ccusage 语义。值得记录的口径限制是——**会话归属到当天不存在的
模型行时，它的会话数会静默消失**；token 与成本不受影响（它们来自 daily 行自身的数据）。
影响面因此限于会话数展示与排行榜的会话统计。


## 4. codex（DeepSeek）热 cursor：同样成立

方法同上，只是换 `TOKENBOARD_CODEX_HOMES_JSON` 指到临时 home，且**必须保留原文件名**（见 §4.1）。
夹具是本机真实会话 `~/.codex/sessions/2026/10/14/rollout-2026-10-14T16-48-23-<uuid>.jsonl`
（1997 行）的一半：

| 指标 | cold（998 行） | hot（补全 1997 行） | ref（全新冷扫） |
|---|---|---|---|
| 快照键数 | 1 | 1 | 1 |
| `totalTokens` | 11948967 | **27188719** | 27188719 |
| 与 ref 的字段差异 | — | **0** | — |

截断具有判别力（11948967 < 27188719），且热跑补全后的结果与全新冷扫**逐字段完全一致**——
codex 的 hook 增量（`providers/codex/hook_profiles.go` 的独立实现）在热 cursor 上也成立。

### 4.1 我先前「codex 截断不改变总量」的结论是夹具缺陷

第一次做 codex 实验时我把夹具**改名**成 `rollout-fixture.jsonl` 放进临时 home，得到的四份会话
「截断冷扫 == 整份冷扫」。那不是 codex 的性质，是我的夹具造错了：**会话身份由文件名里的时间戳与
UUID 决定**，改名后截断副本与完整副本是两个不同会话，比较自然没有意义。

正确的做法是保留原文件名、只改内容长度。改成这样之后立刻得到有判别力的结果（见上表）。

另外两条实测约束：

- **目录日期必须是会话的真实日期**（`sessions/YYYY/MM/DD`）。放到 `sessions/2026/01/01/` 时
  provider 静默返回空结果、`exit 0`、不报错。
- 只设 `TOKENBOARD_CODEX_HOME` 仍会去读真实的 `~/.codex/archived_sessions` 并因符号链接失败；
  必须用 `TOKENBOARD_CODEX_HOMES_JSON='["<temp home>"]'`。用空目录验证过隔离性：空 home 得到
  0 行，说明临时 home 是唯一读取来源。

### 4.2 codex 的用量口径（顺带核实）

真实会话里的事件名是 `token_usage_record`（本机样本 221 条），`event_msg` 里的
`token_count` 携带**累计总量** `info.total`；`adapters/codex/parser.go:746-757` 用
「本次 total − 上次 total」取增量，所以补全文件后新增事件的增量会自然接续。

## 5. Antigravity GUI 两源的 SQLite 热 cursor（合成夹具）

本机没装 Antigravity（`/Applications` 与 `~/Applications` 都没有，`~/.gemini/antigravity*`
也不存在），拿不到真实会话。改用**合成夹具**验证历史库这条路由：按
`antigravitymeta/parser_test.go` 的 protobuf 形状造 `gen_metadata (idx INTEGER PRIMARY KEY,
data BLOB)`，`data` 是 root → chatModel → {usage, timestamp, model} 的嵌套消息。

| 指标 | cold（2 行） | hot（补到 4 行） | ref（全新 state） |
|---|---|---|---|
| 快照键数 | 1 | 1 | 1 |
| `totalTokens` | 4600 | **14000** | 14000 |
| 与 ref 的字段差异 | — | **0** | — |

截断有判别力（4600 < 14000），热跑与全新冷扫逐字段一致——GUI 历史库的 cursor 增量
（`lastReadRowIndexByCascade` 加文件扫描状态）是正确的。

### 5.1 怎么驱动（CLI 不适用的原因）

CLI 没有给 GUI 源留覆盖会话目录的入口：`clients/go/internal/cli/cli.go:435-446` 构造
`collect.Options` 时**没有填 `HomeDir`**，而 `antigravitygui/options.go:64-73` 的
`defaultConversationDir` 在 `HomeDir` 为空时回落到 `os.UserHomeDir()`。于是从 CLI 出发只有改
`HOME` 一条路，而本机 sandbox 会把 `HOME` 重置回真实家目录，结果一直是
`category=history-unavailable`（该类别对应「会话目录不存在」）。

可用的两条路：

1. `go run ./cmd/tb-shadow-antigravity <conversationsDir> <outFile>` —— 仓库自带的调试入口，
   直接传目录，输出事件 JSON。已用它确认夹具可读（2 个事件）。
2. 在模块内直接调 `antigravitygui.Collect(Options{HomeDir: <含 .gemini 的目录>, StateDir: …})`
   —— 本次三轮实验用的就是这条，能拿到完整 `contract.Snapshot` 列表做字段比较。

**这不是产品缺陷**：生产环境 `os.UserHomeDir()` 本来就是正确来源；它只意味着 GUI 源无法用
`TOKENBOARD_*` 指到夹具，做对照实验必须走上面两条路。

### 5.2 仍未覆盖

language-server 路由（`collectLanguageServerUsage`）完全没有验证——它需要一个真实运行的
Antigravity language server。所以 spec §11 解除暂停条件 2 只满足了一半：SQLite 历史路由已有
合成夹具的热 cursor 证据，language-server 路由仍只有单测。

## 6. 未覆盖

- 已覆盖 claude-code、codex 的预览与 hook 增量（§2、§4），以及 Antigravity GUI 两源的 SQLite 路由（§5）。
- ~~文件「缩小」或整体重写（compaction）的情形未测；本次只测了追加。~~ 2026-11-11 已补：缩小、同尺寸改写、整体重写三类场景热 cursor 均与全新冷扫逐字段一致，见 `2026-11-11-hot-cursor-rewrite.md`。
- 未在 Windows / Linux 上跑（2026-11-11 已在真机补上，见 `2026-11-11-windows-linux-verification.md`）。
