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


## 4. 未覆盖

- 只验证 claude-code（hook 路径最复杂、且是生产主力）。codex 的 hook 增量走
  `providers/codex/hook_profiles.go` 的独立实现，两次尝试都没能构成有效实验，见下条。
- **codex 的热 cursor 仍未验证——不是没试，是夹具不成立**：用同样方法试了四份真实 codex
  会话（`2026/10/14`、`10/15`、`11/03`、`11/04`），把文件截成两半再比「半份冷扫」与「整份
  冷扫」的总量，**四份的总量全部相同**，于是截断本身不改变结果，做不出可判定的差异。直接
  原因是 codex 的用量来自逐轮的 `token_count` 事件，截断尾部常常不产生新的计费事件；其中
  两份（`11/03`、`11/04`）连总量都是 0，既无 token 也无成本。另外，夹具必须放在源文件真实
  的 `sessions/YYYY/MM/DD` 目录下——放到 `sessions/2026/01/01/` 时 provider 静默返回空结果
  且 exit 0，不报错。要验证 codex 热 cursor，需要一个**尾部确实带用量事件**的会话，本机现有
  样本里没找到。
- 文件「缩小」或整体重写（compaction）的情形未测；本次只测了追加。
- 未在 Windows / Linux 上跑。
