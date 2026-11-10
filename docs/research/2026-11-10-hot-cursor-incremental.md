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

## 3. 一项待查观察（未定性）

同一个键 `(2026-10-09, deepseek-v4.1-flash)`，token 与成本完全相同，但：

| 输入 | inputTokens | costUsd | sessionCount |
|---|---|---|---|
| a 截断（600 行）+ b | 2225696 | 0.7038571200000001 | **1** |
| a 完整（1037 行）+ b | 2225696 | 0.7038571200000001 | **0** |

**我没有把它定性为缺陷。** 已确认的事实：

- `sessionfile/parser.go:193` 用 `int64(len(row.sessions))` 赋值，而该文件里建行的唯一路径
  （`mergeMetric`，`parser.go:473-487`）必然放入至少一个 session id，所以**解析路径不可能产出 0**。
- `sessionusage/aggregate.go:96` 在新建行时显式写 `SessionCount: 0`，函数注释是「按与 ccusage daily
  报告相同的方式，把 usage 记录合并为每 (usageDate, model) 一行」。这是**第二条**建行路径，
  不携带会话信息。
- 因此 0 不是解析产物，而是另一条聚合路径产生的行在该键上生效。

未确认的部分：为什么「文件被截断」会让该键走解析路径、而「文件完整」走零会话的聚合路径；
这是否与既有的「零成本行 pro-rata 分摊」在同一日期重写该行有关。在读完 `Aggregate` 的调用链
之前，任何「这是 bug」的结论都只是猜测。**复现方式已完整记录在上述夹具里**，下次可直接接着查。

影响面评估（当前）：`sessionCount` 只影响展示与排行榜的会话数统计，不参与 token/成本；
且该键的 token 与成本在两种输入下完全相同，所以即使这是缺陷，也不会造成用量或费用错误。

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