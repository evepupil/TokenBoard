# 2026-11-10 native vs ccusage 性能对比（S5 收尾）

- 日期：2026-11-10（Asia/Shanghai）
- 分支：`feat/native-usage-sources`；测量时代码状态 `0552790`（三个开关已翻转，获取层尚未删除），
  原始输出见 `docs/research/2026-11-10-bench-artifacts/`
- 二进制：ccusage `20.0.33`（`~/.tokenboard/bin/ccusage`），Go `go1.27.3 darwin/amd64`
- 范围：spec §9.3 场景 A（单日）与 B（近 30 天）；场景 C（全量）沿用
  `2026-11-03-native-vs-ccusage-baseline.md` 与 `2026-11-05-claude-native-parity.md` §5.3 的结论，
  本次未重测（见 §5「未覆盖」）。

> 本文所有数字来自实际执行，命令与原始文件见 §1 与 artifacts 目录。本机负载在测量期间为
> 76–142（load average），属于高度共享的机器：**只看 5 轮中位数与最大值，不看单轮**。

## 1. 测量口径

```bash
cd clients/go
go build -o /tmp/tb-bench ./cmd/bench-collect
/tmp/tb-bench -source claude-code -scenario single -rounds 5
/tmp/tb-bench -source claude-code -scenario 30d    -rounds 5
TOKENBOARD_CODEX_SYMLINK_ROOTS_JSON='["~/.codex/archived_sessions.local"]' \
  /tmp/tb-bench -source codex -scenario single -rounds 5
TOKENBOARD_CODEX_SYMLINK_ROOTS_JSON='["~/.codex/archived_sessions.local"]' \
  /tmp/tb-bench -source codex -scenario 30d -rounds 5
```

- 两侧在同一份 merged pricing config 下运行（`pricing.Prepare` 写入同一临时 state 目录，
  catalogue 来源为 `static`，即 bundled `internal/pricing/ccusage.json`）。
- ccusage 侧直接 exec 20.0.33；native 侧在 bench 进程内调用 `collect.LookupNative`。
- RSS：ccusage 侧取子进程 `wait4` rusage（`rss=wait4-rusage`），native 侧取 `RUSAGE_SELF`。
- Codex 需要 `TOKENBOARD_CODEX_SYMLINK_ROOTS_JSON`，因为 `~/.codex/archived_sessions` 是指向
  `archived_sessions.local` 的符号链接，native 扫描默认拒绝符号链接（fail-closed，行为正确）。
- 窗口按 `Asia/Shanghai` 归属：single = 前一天（`20261109`），30d = `20261011..20261109`。

## 2. 结果

### 2.1 claude-code

| 场景 | 侧 | 中位墙钟 | 最大墙钟 | 中位峰值 RSS | 最大峰值 RSS |
|---|---|---|---|---|---|
| single（1 天） | ccusage | 3m51.4s | 4m29.4s | 2.81 GiB | 2.83 GiB |
| single（1 天） | native | 2m42.9s | 2m51.8s | 1.74 GiB | 1.75 GiB |
| 30d | ccusage | 5m42.7s | 6m8.1s | 3.40 GiB | 3.54 GiB |
| 30d | native | 4m12.3s | 4m23.3s | 3.16 GiB | 3.28 GiB |

### 2.2 codex

| 场景 | 侧 | 中位墙钟 | 最大墙钟 | 中位峰值 RSS | 最大峰值 RSS |
|---|---|---|---|---|---|
| single（1 天） | ccusage | 2m5.9s | 3m3.7s | 181.8 MiB | 182.6 MiB |
| single（1 天） | native | 13.7s | 16.9s | 41.1 MiB | 49.3 MiB |
| 30d | ccusage | 2m3.9s | 2m49.2s | 189.3 MiB | 194.7 MiB |
| 30d | native | 34.4s | 41.1s | 52.3 MiB | 54.1 MiB |

`regression: none` 四组全部成立（native 中位墙钟不超过 ccusage）。

## 3. 解读

1. **Codex 是量级差**：墙钟 −89%（single）/ −72%（30d），峰值 RSS −77% / −72%。ccusage 每次
   invocation 都要重新解析全部 session JSONL（`--since/--until` 只裁剪输出，不裁剪扫描，见
   artifacts 里的 note），native 直接流式读同一批文件，省掉了报表序列化/反序列化。
2. **claude-code 是中等差**：墙钟 −30%（single）/ −26%（30d），峰值 RSS −38% / −7%。claude 的
   原生适配器需要同时产出 daily 与 session 两份报表（sessionCount 的来源），比 codex 的聚合
   路径更重，所以差距小于 codex；30d 的 RSS 差距在本机高负载下接近噪声（3.16 vs 3.40 GiB 中位，
   但最大值 3.28 vs 3.54 GiB 方向一致）。
3. **绝对时间都很长**，与 spec §9.1「单次全量扫 ~30 s」的基线不一致：本机 2026-11-10 的负载
   长期在 70–140，这一轮测的是「高负载机器上的相对成本」，不是绝对吞吐。中位数的比值在同一天
   同一负载下仍然可比，但不能拿来和 2026-11-03 的基线绝对值横向对比。
4. **RSS 绝对值同样受本机规模影响**（claude 历史在 GB 级），结论只对「native ≤ ccusage」成立。

## 4. 取舍记录

- 本报告只覆盖 A/B 两个场景。C（全量无窗口）在 `2026-11-05-claude-native-parity.md` §5.3 记录过
  native 墙钟 +22.1% 的结果；S5 之后的实现未改变该路径（`--since/--until` 的窗口裁剪逻辑与定价
  路径未动），因此沿用该记录并在发布说明中写明「全量场景可能更慢」。
- D（hook 增量）在两份实现里走的是同一条 cursor 路径（`sessioncursor` 共享层），本次未单测；
  hook 的收益（只读变更文件）与实现选择无关，属于 cursor 层而非 report source。
- E（冷启动到首字节）被 A 覆盖：ccusage 的进程 spawn 成本已经包含在 single 场景的墙钟里。

## 5. 未覆盖

- 未跑 `-scenario full` 与 `-scenario hook`（本机负载 70–140，全量单轮 ~5 分钟 × 5 轮 × 2 侧
  会占用数小时）；full 的结论引用 §5.3，hook 的结论引用 cursor 共享层的设计。
- 12 个 ccusage 工具来源：本机未安装这些工具，两者都返回空结果，测不出差异；其 parity 证据见
  `2026-11-09-tools-native-parity.md`。
- Windows/Linux 真机未测（RSS 采集在 darwin 上验证；Windows 路径由 CI `rss_windows_test.go`
  覆盖编译与执行）。
