# 2026-11-08 Codex 原生适配器 parity 与性能证据

- 日期：2026-11-08（Asia/Shanghai）
- 分支：`feat/native-usage-sources`
- 二进制：ccusage `20.0.33`（`~/.tokenboard/bin/ccusage`），Go `go1.27.3 darwin/amd64`
- 范围：S3 Task 9。覆盖 `codex` 来源的 parity、行级金样本与性能对照，
  **只是证据记录，不翻转默认开关**（`useNativeCodex` 保持 `false`）。

> 本文所有命令输出都来自当前工作树的实际执行。home 路径写成 `~`。明确区分
> 「已验证」「推断」「未覆盖」。

## 1. 测量口径

### 1.1 Parity 命令

```bash
cd ~/.tokenboard/TokenBoard/clients/go
go run ./cmd/parity -source codex \
  -since 2026-10-25 -until 2026-11-07 -json > parity.json
```

- 两侧都带 `--offline`（`ccusageReportArgs`，`cmd/parity/main.go:715`），与生产一致：
  codex 路径不存在 claude-code 那种「在线价表 vs 冻结语料」的假 diff 来源。
- ccusage 侧与 native 侧走同一份 merged pricing config（`pricing.Prepare`，临时 state dir），
  `pricingSource: "static"`。
- native 侧走 `collect.LookupNative` → `codex.nativeProvider` → 完整 `Collect` 管线：
  frozen session scope、session attribution、subagent corrections、
  `ProjectCodexDailyCosts`、context pricing 全部参与，只替换「跑 ccusage 拿报表」这一步。
- parity 剥离 `TOKENBOARD_HOOK_MODE`，比较 full-preview 路径；不碰真实 cursor。

### 1.2 本机数据面（2026-11-08 实测）

`~/.codex` 的历史形态决定了本次测量的可用窗口：

| 位置 | 文件 | 说明 |
|---|---|---|
| `~/.codex/sessions` | 5.8 GiB，400 个文件 | 2026-10-14 起为 plain `.jsonl`（10 月 13 个 + 11 月 154 个）；更早的 233 个（9 月 193、10 月上旬 26、7–8 月 14）已被 Codex 自身压缩为 `.jsonl.zst`，单个最大 514 MiB |
| `~/.codex/archived_sessions` | 符号链接 → `archived_sessions.local`，1.9 GiB，22 个 | 全部 `.jsonl.zst`；native 侧按 symlink 护栏默认拒绝，本报告统一用官方逃生阀 `TOKENBOARD_CODEX_SYMLINK_ROOTS_JSON` 放行 |

这台机器上「本月之前的 Codex 历史都在压缩帧里」——这不是测试夹具，是 Codex
`cleanup-old-sessions` 的日常行为（`~/.codex` 下留有 `.cleanup-old-sessions.pending.*` 标记）。它直接导致下文的
固定窗口选择与 `.zst` 边界（§4）。

## 2. Parity 结果

### 2.1 固定窗口：全 match（两次独立运行）

窗口 `2026-10-25 → 2026-11-07`（14 天，时区 `Asia/Shanghai`）。选它是因为本机该区间**没有**
`.jsonl.zst`（10 月 14 日起 Codex 只写 plain `.jsonl`），ccusage 侧与 native 侧看到同一批文件，
是真正的逐行对称比较：

```json
{
  "source": "codex",
  "since": "2026-10-25",
  "until": "2026-11-07",
  "timezone": "Asia/Shanghai",
  "status": "match",
  "nativeSnapshots": 10,
  "ccusageSnapshots": 10,
  "matched": 10,
  "pricingSource": "static"
}
```

两次独立运行（`/tmp/codex-parity2.json`、`/tmp/codex-parity4.json`）输出完全一致：10/10 match，
无 `valueDiff`/`onlyInNative`/`onlyInCcusage`/`liveWrite`。同一窗口内的
`gpt-6.1-terra` 是冻结语料未收录的新模型，两侧一致地「保留采集结果」（stderr 各有一行
`TokenBoard model pricing unavailable ... preserving collected result`），行为对称。

> 注：此前 parity harness 缺 `ProjectCodexDailyCosts` 的 ccusage 侧后处理，导致 7 处
> `costUsd` 假 diff（~1e-7 级）。已在 harness 修复（`postProcessCcusageRows`，TDD RED→GREEN，
> `TestRunParityAppliesProviderPostProcessing`），生产两侧本来就都应用该投影。

### 2.2 宽窗口（07-01 → 11-07）：150 行差异全部是压缩会话，不是移植分叉

| 侧 | 行数 | 日期跨度 |
|---|---|---|
| native（生产管线） | 14 | 2026-10-14 .. 11-07 |
| ccusage（裸跑真实 home） | 164 | 2026-07-10 .. 11-07 |
| `valueDiffs` / `onlyInNative` / `liveWrite` | 0 / 0 / 0 | — |

150 个 `onlyInCcusage` 的日期（07-10..10-13）与本机 `.jsonl.zst` 文件区间精确重合
（§1.2、§4）。决定性对照：**同一宽窗**下 TS 生产管线（`pnpm --filter @tokenboard/collector
exec tsx src/cli.ts preview --source codex --since 2026-07-01 --until 2026-11-07`，走真实
ccusage + frozen scope）与 Go native `preview` 都输出 **14 行**，逐字段比较
（input/output/cacheCreation/cacheRead/total/costUsd/sessionCount）**0 差异**。即
native == 生产口径；宽窗差异来自 §4 的 scope 枚举边界与 harness 两侧读取面的不对称。

### 2.3 全历史（无窗口）：两侧同款 fail-closed，无法构成对比

在 `~/.codex` 的 APFS clone 冻结副本上跑无窗口 parity（`cmd/parity -source codex`，
`CODEX_HOME=/tmp/codex-frozen`，避免活写竞态）：

```
parity: native side: Codex context pricing found gpt-5.5 daily usage without an unambiguous raw cost for 2026-07-10
parity: native side: Codex context pricing cannot match raw cost for 2026-07-10/gpt-5.5
real 1013.38
```

TS 生产侧在同一冻结副本上跑 `tsx src/cli.ts preview --source codex`（无窗口）**报出完全相同的
错误与日期**（`Codex context pricing cannot match raw cost for 2026-07-10/gpt-5.5`，
`packages/collector/src/providers/codex-context-pricing.ts:846` 的同款守卫）。

即「全历史 codex 采集在本机数据面上会被 context pricing 归因守卫拒绝」是**既有生产行为**
（该守卫要求每个 context-priced 模型的日行都能唯一配到原始成本；7 月 10 日的 gpt-5.5
在本机满足不了），native 忠实复刻。两侧同错意味着全历史 parity 没有可比对的行集——
这本身是行为一致性的证据，也是本报告 `full` 场景无法给出 native 数字的原因（§5.2）。

## 3. 金样本与覆盖缺口

行级金样本由**真实 ccusage 20.0.33** 在一个已提交的 14 文件夹具树上 mint
（`clients/go/internal/collect/adapters/codex/goldens/codex-reports.json`，
`fixtureSha256 cb903dd55ee1303feae194811a2259ddc5ade59fd845dfd72a7796e0e61f17c1`）。

夹具覆盖的场景（`testdata/build-codex-fixture.mjs`）：普通累积事件、`last_token_usage`
缺省（需差分）、compacted 配对（两种顺序 + 未配对）、fork 重放（父事件前缀不计重）、
不可用父的 burst 启发式、`codex-auto-review` 模型回退、`thread_settings_applied`
的 fast/flex、`.jsonl.zst` 拼接帧 + 截断尾帧（zeta）、带空格的大行（含 >64 KiB 嵌套搜索闸门）、
未建模成员里的坏 UTF-8（ccusage 照常计费）+ 非 JSON 行（丢弃）、archived 目录、
headless `codex exec` 形状（结果对象自带 usage）。

四组报表冻结：`daily --mode auto`、`daily --mode calculate`、`session`、无窗口 `daily`。
`goldens_test.go` 的五个测试：

- `TestCodexDailyMatchesTheGoldens`（auto/calculate/unbounded 三个子测试，逐行逐字段）
- `TestCodexSessionsMatchTheGoldens`
- `TestCodexGoldensPinTheUnknownMemberLine`（2026-05-24 = 29/2：坏字节行必须被计费，防「整行丢弃」回归）
- `TestCodexGoldensPinTheHeadlessExecRow`（05-12 只出现在无窗口报表：12/2/3/1/17）
- `TestCodexFixtureHashIsCurrent`（夹具树漂移即失败，金样本不允许静默过期）

生成器（`scripts/gen-codex-goldens.mjs`）只读已提交夹具、不重建；`--check` 模式在内存
re-mint 并与提交版逐字节比对。本地实测：绿 → 篡改一字节 → `exit 1` 报
`drifted from what ... produces (ccusageVersion)` → 恢复 → 绿。`check-deps.sh` 在 CI 的
`deps` job 里调用它（那里有 pnpm 安装的同版本 ccusage），因此 ccusage 输出漂移不会让金样本静默过期。

已登记的覆盖缺口（`goldens_test.go` 注释）：
- 被建模位置的坏 UTF-8（键 / 被建模字符串值）由 `parser_test.go` 逐个钉住，金样本不覆盖（因为
  那样整行被弃，无法区分「行内位置」）；
- 夹具里没有 `config.toml`：service tier 用 `thread_settings_applied` 事件覆盖，TOML 解析
  由 `speed_test.go` 单独覆盖；
- 夹具模型全部可定价；未定价模型的 `unpricedModels` 路径由 report 测试覆盖。

## 4. 已知边界：`.jsonl.zst` 压缩会话与显式长窗口

这是本轮最容易被误报为「移植缺陷」的地方，结论是**不是缺陷，是既有的生产行为**：

- **适配器层完整支持 `.zst`**：夹具 zeta 场景（拼接帧 + 截断尾帧）、`reader.go`/`paths.go`
  的 `isRolloutFile` 都按 ccusage 的 Rust 语义实现；本次全量 parity 里 514 MiB 的单文件
  正是经它读取（§2）。
- **但生产 provider 的 bounded/scoped 路径只枚举 `.jsonl`**：`CreateCodexSessionScopeBatches`
  → `sessionwalk.Resolve`（`.jsonl` 结尾），这是 TS `session-file-walk.ts:81`
  `entry.name.endsWith('.jsonl')` 的忠实移植。frozen scope 把文件复制进临时 CODEX_HOME 再让
  ccusage/native 读——所以压缩会话在**显式窗口**（`--since/--until`）的采集里从来不可见，
  TS 生产侧同样如此（同窗 TS `collector preview` 与 Go native 都只出 14 行，见 §2.2）。
- **默认同步不受影响**：`skills/tokenboard/scripts/sync-options.mjs` 的默认 lookback 是 7 天
  （`DEFAULT_LOOKBACK_DAYS = 7`），远在 Codex 压缩地平线（本机约 3–4 周）之内；只有用户显式
  传长窗口回填时才会命中这条边界。
- **parity harness 的 ccusage 侧不对称**：`cmd/parity` 的 ccusage 侧直接在真实
  `~/.codex` 上 exec 二进制（Rust reader 支持 `.zst`），native 侧走生产采集管线（scope 只收
  `.jsonl`）。所以宽窗 parity 的 `onlyInCcusage` 行必然是压缩会话，不是本移植引入的差异。

S3 不改变这条既有行为；若要补，必须 TS 与 Go 的 scope 枚举同时放宽，并重新验证
attribution/cursor 契约（超出本计划范围，登记为后续工作）。

## 5. 性能证据

口径：`cmd/bench-collect -source codex -rounds 5 -json`。ccusage 侧是**直接 exec 二进制**
（`codex daily` + `codex session`，带窗口参数，在真实 `~/.codex` 上）；native 侧是
`collect.LookupNative` 的**完整 provider 管线**（bounded 窗口会先复制 frozen scope——
即 native 侧的耗时里包含 ccusage 侧没有的拷贝成本）。同一份 merged pricing config。
`-scenario single` = 2026-11-07 当天；`30d` = 2026-10-09 → 11-07；`full` = 无窗口。
这是 bench-collect 自 S2 起的固定口径，两侧不共享同一份读取面。

**环境注记（重要）**：`full` 场景没能在本机测出 native 数字，原因见 §5.2——活跃树上
inventory 稳定性护栏拒绝（预期），APFS clone 冻结副本上 context pricing 守卫拒绝（与 TS
生产同款）。`single`/`30d` 两场景正常跑完。

### 5.1 场景结果

| 场景 | 侧 | 中位墙钟 | 最大 | 中位峰值 RSS | 每轮 external calls |
|---|---|---|---|---|---|
| `single`（1 天） | ccusage | 39.378 s | 39.667 s | 157,241,344 B（150.0 MiB） | 2（daily+session） |
| `single` | native | **3.165 s**（12.4×） | 3.850 s | **37,355,520 B（35.6 MiB）**（4.2×） | 1 |
| `30d` | ccusage | 40.692 s | 42.605 s | 165,298,176 B（157.6 MiB） | 2 |
| `30d` | native | **9.002 s**（4.5×） | 12.867 s | **41,885,696 B（39.9 MiB）**（3.9×） | 1 |
| `full` | ccusage | 见 §5.2 | — | — | 2 |
| `full` | native | 见 §5.2 | — | — | 1 |

`regression=false`（native 未比 ccusage 慢）。

补充实测（冻结树，带 1 天窗口单跑）：`ccusage codex daily` 21.9 s、`session` 22.4 s，
合计 44.3 s——**窗口对 codex 是剪枝的**（全量同树为 160.3 s，4× 差）。bench 里那句通用
note（「`--since/--until` 只过滤报表输出、不过滤扫描」）在本机 codex 上不成立，以实测为准。
因此 `single` 场景的对照是：ccusage 44 s 级 vs native 3.2 s（含 scope 拷贝）——差距来自
「spawn 二进制 + Rust 解析 + 子进程 JSON 报表」vs「进程内一次顺序扫描」。

### 5.2 全历史（full）

`cmd/bench-collect -scenario full` 在**活跃** `~/.codex` 上被 native 侧的 inventory 稳定性
护栏拒绝（`Codex session inventory changed during unbounded collection; retry the sync`——
25 分钟扫描期间本机 Codex 自身写入了新会话，这是 fail-closed 设计在真机上的证据，不是挂死）。

> **2026-11-12 更新：这条护栏已按真机证据改写。** 活跃机器上「扫描期间会话清单变化」是常态，
> 整源失败并重试一次只会把同一次多分钟扫描重跑进同一个移动目标（本轮实测：full 场景跑了
> 2 小时 17 分钟后以该错误退出）。现在两侧都改为输出漂移诊断（added/vanished/modified）并保留
> 已读到的结果，消失的文件跳过，下一轮同步自愈；确定性输入不走这条分支。改动与理由见
> `docs/research/2026-11-12-codex-inventory-drift.md`。
在 APFS clone 冻结副本上，native 侧的 `Collect` 又在 §2.3 的 context pricing 守卫处
fail-closed（与 TS 生产同款），所以 `bench-collect` 的 native 栏没有可记录的中位数。
**这不是 S3 引入的问题**：`full` 无窗口路径在本机数据面上就是生产双侧都拒绝的路径。

ccusage 侧的对照在冻结树上 5 轮实测（`codex daily` + `codex session`，无窗口，
`--offline --single-thread -z Asia/Shanghai`；`/usr/bin/time -l` 采峰值 RSS）：

| 轮 | `codex daily` | `codex session` | 合计 |
|---|---|---|---|
| 1 | 82.4 s | 80.1 s | 162.4 s |
| 2 | 78.8 s | 81.5 s | 160.3 s |
| 3 | 78.7 s | 78.5 s | 157.2 s |
| 4 | 75.5 s | 83.1 s | 158.6 s |
| 5 | 79.0 s | 83.5 s | 162.5 s |
| **中位** | **78.8 s** | **81.5 s** | **160.3 s**（最大 162.5 s） |

峰值 RSS：daily 中位 434,327,552 B（414.2 MiB），session 中位 487,915,520 B（465.3 MiB）——
注意这是**子进程**峰值，ccusage 全量常驻显著高于 single/30d 的 ~150 MiB，因为全历史
107 天的日报 + session 报表都聚合在内存里。

native 侧在同等数据上的「全历史」耗时**未测**：会被上述守卫拒绝。能下的性能结论只有
single/30d（§5.1，native 快 12.4×/4.5×、RSS 小 4.2×/3.9×）。这个边界已登记为未覆盖项。

## 6. 决定与未覆盖边界

已验证（本报告全部数字来自实际执行）：
- 固定窗 parity 10/10 match（两次独立运行）；
- TS 生产管线与 Go native 同宽窗逐字段一致（14/14、0 差异）；
- 行级金样本四组全绿 + 夹具哈希门禁 + `--check` 漂移检测（含负例）；
- `go test ./...` 40 包全绿；codex 两包 `-race` 全绿；`go vet`、`gofmt -l`、三平台
  `GOOS={windows,linux,darwin} GOARCH=amd64 go build` 全绿。

决定：
- **`useNativeCodex` 保持 `false`**。翻转必须独立提交，且只在固定窗 parity 全 match、
  新金样本全绿之后（S3 完成标准 #4）。本报告只提供证据，不做翻转。
- **宽窗 parity 的 150 行差异按「既有生产行为 + harness 不对称」记账**，不作为移植缺陷修复
  （§4）；若未来要补 `.zst` scope 枚举，TS 与 Go 两侧必须同步。
- **check-deps.sh 的 codex 门禁是只读 `--check`**（§3）：re-mint 由维护者显式跑生成器并 diff
  审查后提交，与 claude 生成器的维护流程一致。

未覆盖 / 已知边界：
- `~/.codex/config.toml` 的 service tier：金样本用事件级覆盖，TOML 解析由单元测试覆盖；
  真机 config.toml 的实盘走查未做（本机 config 不含 fast/flex tier）。
- full（无窗口）场景没有 native 中位数：全历史采集在本机被 context pricing 守卫
  fail-closed（与 TS 生产同款，§2.3）；ccusage 侧 5 轮实测 160.3 s 中位（§5.2）。
  native 侧到达同一失败点的耗时约 14 分钟（parity 总耗时 1013 s 减去 ccusage 侧 ~160 s，
  推断值，非中位数），未完成完整采集。
- hook 场景（`-scenario hook`）依赖本机真实 cursor，未在本次证据中跑（Task 9 范围是
  parity + 三场景；hook 窗口重算的正确性已由 Task 8 的 frozen-scope 重算测试钉住）。
- Windows/Windows Server 上的 `.zst` 解码路径未实测（金样本 zeta 覆盖语义，真机未覆盖）。

## 7. 复现

```bash
cd ~/.tokenboard/TokenBoard/clients/go

# 1. 固定窗 parity（两次独立运行应逐字节一致）
TOKENBOARD_CODEX_SYMLINK_ROOTS_JSON='["<archived_sessions 的真实目录>"]'   go run ./cmd/parity -source codex -since 2026-10-25 -until 2026-11-07 -json

# 2. 金样本漂移门禁（不写盘）
CCUSAGE_BIN=~/.tokenboard/bin/ccusage node scripts/gen-codex-goldens.mjs --check
# 或走完整门禁：
clients/go/scripts/check-deps.sh

# 3. Go 测试
go test ./internal/collect/adapters/codex/... ./internal/collect/providers/codex/... -race -count=1
go test ./... -count=1

# 4. 性能
go run ./cmd/bench-collect -source codex -scenario single -rounds 5 -json
go run ./cmd/bench-collect -source codex -scenario 30d   -rounds 5 -json
# full 需要冻结树（活跃树会被 inventory 变化护栏拒绝）：
#   cp -c -R ~/.codex/sessions /tmp/codex-frozen/sessions
#   cp -c -R ~/.codex/archived_sessions.local /tmp/codex-frozen/archived_sessions
#   CODEX_HOME=/tmp/codex-frozen go run ./cmd/bench-collect -source codex -scenario full -rounds 5 -json
```
