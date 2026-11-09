# 2026-11-09 copilot 原生适配器（S4b）parity 与证据报告

- 日期：2026-11-09（Asia/Shanghai）
- 分支：`feat/native-usage-sources`
- 计划：`docs/superpowers/plans/2026-11-08-s4b-copilot-adapter.md`
- 二进制：ccusage `20.0.33`（`~/.tokenboard/bin/ccusage`），Rust 源码 `/tmp/ccusage-refetch/ccusage-1308c416`
  （commit `1308c416`，计划的 `/tmp/ccusage-src-1308c416` 不存在，改用同一 commit 的解包目录），
  Go `go1.27.3 darwin/amd64`
- 范围：S4b —— `copilot` 来源（第 12 个 ccusage 工具来源）的原生 Go 适配器、loader、goldens、
  provider 接线与 CI 门禁。**不翻转 `useNativeTools`（保持 `false`）**，生产仍走 ccusage 子进程。

> 本文命令输出均来自当前工作树的实际执行。明确区分「已验证」「推断」「未覆盖」。

## 1. 语义来源

唯一权威是 ccusage v20.0.33 `rust/adapters/copilot/src/`：

| 规则 | Go 实现（文件） | Rust 出处 |
|---|---|---|
| 数据源发现 | `copilot/paths.go` | `paths.rs:23-79` |
| session-state 逐行解析（shutdown / usage_checkpoint、modelMetrics、`totalNanoAiu`） | `copilot/session_state.go` | `parser.rs:164-373` |
| OTel 导出行分类（ChatSpan / InferenceLog / AgentTurnLog / AgentSummarySpan）、时间戳与属性 | `copilot/otel.go` | `parser.rs:375-660` |
| 重复 chat span / 已被 OTel 收窄的候选抑制 | `copilot/dedupe.go` | `loader.rs:127-269` |
| 区间差分、`latest_visible`、`otel_after` 替换、credit gap 8 类分支、同键去重 | `copilot/reconcile.go` | `loader.rs:271-432` |
| 编排、定价、报表 | `copilot/loader.go`、`copilot/register.go` | `loader.rs:22-125, 434-521`、`report.rs:11-24` |

共享层（S4a）提供 `tools.Options/Entry/Summarize/ReportJSON`、`nativepricing.Cost`。copilot 与 S4a 的
11 个工具来源共享报表构建与 `missing_pricing` 口径外的全部定价路径。

## 2. 金样本（已验证）

### 2.1 夹具

`clients/go/testdata/copilot-goldens-fixtures/copilot/` 与上游 `rust/adapters/copilot/tests/fixtures`
逐字节相同（生成器以 sha256 钉死 4 个文件：`otel/trace.jsonl`、`session-state/{session-a,session-b,session-credits}/events.jsonl`）。
这是上游 `crates/ccusage/tests/copilot_cli.rs` 生成 `copilot_cli__*` 快照所用的同一棵树，未另造夹具。

### 2.2 mint 与校验

- 生成器：`clients/go/scripts/gen-copilot-goldens.mjs`，断言 `ccusage 20.0.33`、空别名表、无 `--config`，
  `HOME` 指向空目录，`COPILOT_HOME` 指向夹具树，`COPILOT_OTEL_FILE_EXPORTER_PATH` 置空，argv 为
  `copilot daily|session --json --mode auto|calculate --offline --single-thread --timezone UTC --since 20260101 --until 20260228`。
- 输出：`clients/go/internal/collect/providers/ccusagetool/copilot-goldens/copilot-reports.json`（4 份报告）。
- 交叉校验：同一脚本重新 mint 上游快照 `copilot_cli__focused_daily_json`（daily）与
  `copilot_cli__focused_monthly_and_session_json`（session 段）并与提交副本逐段比较（键序规范化后），
  不一致即失败。

```text
$ node clients/go/scripts/gen-copilot-goldens.mjs --check
gen-copilot-goldens: goldens and 2 upstream snapshots match.
exit=0
```

### 2.3 Go 端逐位比较

`TestCopilotAdaptersMatchTheGoldens`（`providers/ccusagetool/copilot_goldens_test.go`）经 provider 的真实
runner（`newNativeToolRunner`，`useNativeTools` 之外的同一 seam）跑 argv，所有叶子逐位比较（数字按 float64 位模式），无豁免列表。

```text
$ go test ./internal/collect/providers/ccusagetool/ -run TestCopilotAdaptersMatchTheGoldens -count=1 -v
--- PASS: TestCopilotAdaptersMatchTheGoldens
    --- PASS: TestCopilotAdaptersMatchTheGoldens/daily/auto
    --- PASS: TestCopilotAdaptersMatchTheGoldens/session/auto
    --- PASS: TestCopilotAdaptersMatchTheGoldens/daily/calculate
    --- PASS: TestCopilotAdaptersMatchTheGoldens/session/calculate
```

| 报告 | 行数 | totals（auto / calculate） |
|---|---|---|
| daily | 6 | input 275 / output 142 / cacheCreate 45 / cacheRead 30 / total 492；cost 0.084411875 / 0.004411875 |
| session | 4 | 同上 |

daily 的 6 行与 session 的 4 行在两个模式下是同一行集，auto 与 calculate 只差费用。auto 按自报成本计：
credit gap 行带 `nanoAiu/1e11` 成本（1 AIU = $0.01），token 行没有自报成本、按 token 计费，合计 0.084411875；
calculate 忽略所有自报成本、全部按 token 重算，得到 0.004411875。credit gap 行没有 token，
不会进入 `unpricedModels`（Ruling 4）。

## 3. 单元测试

```text
$ go test ./internal/collect/adapters/copilot/... ./internal/collect/providers/ccusagetool/ -count=1
ok  	.../internal/collect/adapters/copilot	0.476s
ok  	.../internal/collect/providers/ccusagetool	0.752s
$ gofmt -l internal/collect   → 无输出
$ go vet ./internal/collect/adapters/... ./internal/collect/providers/ccusagetool/   → 干净
```

reconcile 纯函数覆盖 8 类 credit gap（有 OTel 跳过、全 shutdown 跳过、shutdown 总额未知跳过、正常报缺、
无 shutdown 仅 checkpoint、恢复会话无 modelMetrics、since 前扣减、后缀最小值衰减）以及：
区间差分、`latest_visible` 丢弃、`otel_after` 首次超额起替换、OTel 替换不受窗口影响、跨窗口 shutdown
仍计入归属、同键去重、原始窗口在报表时区换算。

## 4. 真机 parity：N/A（未覆盖）

本机 `~/.copilot` 只有 `ide/` 目录（`ls ~/.copilot` → `ide`），没有 `session-state/` 也没有 `otel/`，
即 collector 口径下该来源无可读数据。因此**没有**真实数据上的 TS↔Go 双跑或 `ccusage copilot`↔native 对比，
真机 parity 标为 N/A；现有证据是 §2 的逐位金样本 + 上游快照交叉。真实 Copilot 用户数据的差异
（例如 OTel 导出形态的变体）未被覆盖。

## 5. Rulings

1. **窗口换算使用报表时区**：`Reconcile` 把原始 `--since/--until` 交给 `tools.DateRangeBoundsMs(..., Timezone)`；
   计划未写明时区，Rust `loader.rs:81-85` 传的是 CLI 的 `timezone`。变异验证：改成空时区后
   `TestCopilotRawWindowConvertsInTheReportTimezone` 在 `TZ=Asia/Tokyo` 下变红，恢复后绿。
2. **session-state 解码必须照 serde 宽松**：所有声明字段走 `non_empty_string` / `lenient_object` /
   `lenient_f64` / `lenient_u64`，未知字段（夹具 `requests.cost`）忽略；非字符串 `type`/`id` 使该字段为 None 但整行不丢；
   时间戳无法解析时回落到文件 mtime（Rust `format_rfc3339_millis` 对 None 的行为）。
   `TestCopilotSessionStateDropsOnlyNonStringFields` 钉住。
3. **`include_session_metadata=true`**：计划示例假定 false，Rust `report.rs:11-16` 是 `kind == Session`，按源码走。
4. **`missing_pricing` 用静态 `Find`**：`missing_pricing_model_for_usage`（`cost.rs:48-59`）只看无时间戳的
   `find`，与计费用的 `find_at` 不同；credit gap（`unknown`、0 token）永不进 `unpricedModels`。
5. **目录读取排序**：`SourcePaths` 与共享 `tools.walk` 按名字排序。Rust 的 `read_parallel` 保持收集顺序，
   但 `collect_files` 本身依赖 `read_dir` 顺序；Go 侧没有保证，排序使同时间戳快照的合并顺序确定。
6. **注册走 `tools.RegisterWindowed`**：copilot 包导入 `tools` 取共享读取器，`tools` 不能反向导入，故由
   `register.go` 的 `init` 自注册，provider 另以空白导入 `internal/collect/adapters/copilot` 确保 init 执行。
   Ruling 代价：`tools.HasNativeAdapter` 需同时查两张表。
7. **`--mode` 命令行覆盖配置**：native runner 解析 `--mode`（只接受 auto/calculate/display，其余报错），
   并计入定价缓存键。
8. **金样本测试放在 provider 包**：测试专属导出在 `go vet` 里不能从其他包的测试代码访问（报 `undefined`），
   故直接通过 provider 包内未导出的 runner 驱动。
9. **runner 的 `overrides` 仅测试用**：goldens 用来覆盖维护者 shell 里的 `COPILOT_HOME`；生产路径不设。

## 6. 已知边界与未覆盖

- 真机 parity N/A（§4）。
- 上游快照只覆盖 daily 与 session 两种报表；monthly/weekly 由共享层承担（S4a 已验证），本报告未单独对比。
- 计划与 Rust 不一致之处只在上述 Ruling 2/3/4 中裁决，其余逐函数照抄。
- 共享 `WalkFiles` 的有界上限（S4a Ruling）同样作用于 `~/.copilot/otel` 递归，极端深树会少收文件。

## 7. 撮要

| 项 | 结果 |
|---|---|
| 完成标准 1（两包测试） | 全绿 |
| 完成标准 2（金样本 + 上游快照交叉） | 4/4 报告逐位一致；2 个上游快照一致 |
| 完成标准 3（reconcile 纯函数 8 类 credit gap + 边界） | 覆盖，含时区窗口变异验证 |
| 完成标准 4（provider 接线 + 12 源注册测试） | `TestRegisterNativeInstallsEveryToolProvider` 通过 |
| 完成标准 5（本文） | 本文件 |
| `useNativeTools` | 未翻转（保持 `false`） |
