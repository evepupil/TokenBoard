# 2026-11-10 native vs ccusage 性能对比（S5 收尾）

- 日期：2026-11-10（Asia/Shanghai），2026-11-12 补测 full 与 hook 场景（§2.3–§2.5）
- 分支：`feat/native-usage-sources`；测量时代码状态 `0552790`（三个开关已翻转，获取层尚未删除），
  原始输出见 `docs/research/2026-11-10-bench-artifacts/`；补测时的代码状态是 `6677f87`
  （codex 清单漂移改为诊断），原始输出见 §1 列出的 `/tmp/bench-g5/`（临时目录，不入库）
- 二进制：ccusage `20.0.33`（`~/.tokenboard/bin/ccusage`），Go `go1.27.3 darwin/amd64`
- 范围：spec §9.3 场景 A（单日）与 B（近 30 天）于 2026-11-10 测量；场景 C（全量）与 D（hook）
  于 2026-11-12 补测。**全量场景 native 曾比 ccusage 慢 4.3 倍**（§2.3，§3.5 分析根因）；
  2026-11-13 的两项优化针对这些成本，2026-11-14 凌晨完成三个提交点的端到端复测（§3.7）。

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

补测场景（2026-11-12）的命令与口径：

```bash
# full：无窗口，扫全部历史
/tmp/tb-bench -source codex -scenario full -rounds 5 -ccusage-bin ~/.tokenboard/bin/ccusage -json
# hook：窗口 = cursor 最新日期到当天，每轮前重置 cursor（冷 cursor）
/tmp/tb-bench -source claude-code -scenario hook -rounds 5 -json
/tmp/tb-bench -source codex       -scenario hook -rounds 5 -json
```

- 补测全程通过 `sysctl -n vm.loadavg` 起跑闸门，每场景只在 1 分钟负载 < 40 时开始；实际起跑负载：
  claude-full 24.94、claude-hook 23.74（结束 46.80）、codex-hook 38.78（结束 44.37）、
  codex-full 21.67（结束 5.67）。结束负载列出来，是因为它决定了这一轮有多可信。
- codex-full 有两次失败尝试（06:27、09:29 起跑，exit 1）：都发生在 codex 清单漂移仍按 fail-closed
  处理的二进制上。`6677f87` 改成漂移诊断后，15:35 的第三次尝试 5 轮全部成功，§2.3 采用这一轮。
- hook 场景的窗口取本机 hook cursor 里最新的 `usageDate` 到当天（`scenario.go:93-121`）：
  本轮实测两侧都是 `20261112..20261112`，即单日窗口。每轮开始前 `resetHookCursor` 删掉 state
  目录里的 cursor（该目录是本轮新建的临时目录，不碰真实 cursor），所以每轮都是**冷 cursor**。
- 冷 cursor 下 native 走 `collectHookUsage`（`provider_scope.go:579`）：`CollectHookProfiles` 先做
  一遍变更检测再把变更日期交给窗口内的采集，而 ccusage 侧直接按窗口重扫，没有这遍检测。
- 生产环境 hook 由前一次运行留下的 cursor 续跑，只有变更文件会被读。冷 cursor 不是生产条件，
  §3.6 解释为什么仍值得记录。

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

### 2.3 codex full（无窗口，2026-11-12 补测）

| 侧 | 中位墙钟 | 最大墙钟 | 中位峰值 RSS | 最大峰值 RSS | calls |
|---|---|---|---|---|---|
| ccusage | 2m35.6s | 2m49.5s | 455 MiB | 464 MiB | 2 |
| native | **11m8.8s** | 11m39.4s | 505 MiB | 560 MiB | 1 |

`regression: true` —— `native median wall 11m8.762s exceeds ccusage 2m35.594s (+329.8%)`。
5 轮离散度很小（ccusage 155.0–169.5s，native 649.8–699.4s），比值可信。根因见 §3.5。

> 同一场景在 2026-11-13 晚间复测为 native 963.2s vs ccusage 287.4s（3.35 倍）；优化前后的
> 三个提交点对照见 §3.7。两次的绝对时间都受机器负载影响，只有倍差方向可比。

### 2.4 claude-code full（无窗口，2026-11-12 补测）

| 侧 | 中位墙钟 | 最大墙钟 | 中位峰值 RSS | 最大峰值 RSS | calls |
|---|---|---|---|---|---|
| ccusage | 2m47.9s | 2m53.0s | 4.13 GiB | 4.17 GiB | 2 |
| native | **2m22.4s** | 2m25.6s | 3.15 GiB | 3.15 GiB | 1 |

`regression: none`（native −15.2%）。与 §3.5 的 codex 形成对照：当时两侧都是"全量三遍扫描"的
结构，claude 侧 native 仍然更快，说明 §3.5 的差距来源不在扫描遍数本身，而在 codex 每条记录的
处理成本。

> 本场景另有一次更早的测量（`claude-full.txt`，起跑负载 24.9）：ccusage 4m14.8s vs native
> 3m12.4s。两次方向一致、幅度不同，反映的是机器负载而不是实现差异；上表是 11-12 那一轮。

### 2.5 hook 场景（冷 cursor，窗口 20261112..20261112，2026-11-12 补测）

| 源/侧 | 中位墙钟 | 最大墙钟 | 中位峰值 RSS | 最大峰值 RSS | calls |
|---|---|---|---|---|---|
| claude-code ccusage | 3m23.1s | 5m1.6s | 3.01 GiB | 3.04 GiB | 2 |
| claude-code native | **12m54.8s** | 14m13.4s | 3.23 GiB | 3.23 GiB | 1 |
| codex ccusage | 1m21.7s | 2m40.1s | 172 MiB | 174 MiB | 2 |
| codex native | **1m5.1s** | 1m9.8s | 58.5 MiB | 58.5 MiB | 1 |

claude-code `regression: true`（+281.5%），codex `regression: none`（−20.3%）。两个源的差异同源，
解释见 §3.6。

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
5. **全量场景 codex 反向退化 4.3 倍（§2.3）**，根因是同一份语料被扫三遍；代码已于 2026-11-13
   处理，端到端复测待补（见 §3.7）。
   当时的 `collectUnboundedUsageAttempt` 依次跑 `daily` 报表、`collectSessionCounts` 的
   `session` 报表、`CollectCodexContextPricingUsagesFromFiles` 的 context pricing，ccusage 只被
   调用两次（bench 里 `calls: 2`）。本机语料 `~/.codex/sessions` 6.61 GiB（其中 5.39 GiB 是
   zstd）加 `archived_sessions.local` 1.90 GiB zstd，压缩比约 4 倍，三遍合计要过约 30 GiB 解压
   后的文本。已排除的三种解释：(a) 语料不同——`archived_sessions` 是指向
   `archived_sessions.local` 的符号链接，两侧读的是同一批文件，同一份单文件语料两侧
   `totalTokens` 都是 3317815；(b) zstd 支持不一致——ccusage 读 `.jsonl.zst`（`sessions/` 与
   `archived_sessions/` 两处都测过）；(c) 清单漂移触发重试——`codex-full.err` 为空、5 轮全部成功。
   三遍对两遍只解释 1.5 倍，剩下的约 2.9 倍单遍差距是推断（依据：`sample` 抓到的 CPU 主要落在
   `parseFile`/`ClassifyLine` 与 zstd 解码），说明 Go 的单遍处理成本高于 ccusage 的 Rust 实现。
   §2.4 的 claude-code 全量没有退化，所以"全量三遍"本身不是充分原因；区别在 codex 每条 rollout
   记录的解析与分类成本。
6. **hook 场景 claude-code 冷 cursor 下反向退化 3.8 倍（§2.5）**，codex 同类场景反而快 20%。
   两者走的是不同路径，所以不矛盾：hook 场景是单日窗口，native 走
   `collectHookUsage` → `CollectHookProfiles`（`provider_scope.go:579`），冷 cursor 时先做一遍
   变更检测决定要重算哪些日期，再在窗口内采集；ccusage 侧没有这遍检测，但它仍要全量重扫
   （§3.1 的 note）。claude-code 的变更检测要遍历约 1 万个会话文件（本机 `~/.claude/projects`
   实测 10191 个 `.jsonl`、26 GiB），叠加 context pricing 后超过了 ccusage 的两遍；codex 的语料
   小一个量级（6.6 GiB，且多为 zstd），变更检测的代价没有盖过 native 省下的报表序列化。
   §2.3 的 4.3 倍退化走的是 `collectUnboundedUsage`（无窗口），与这里不是同一条路径。
   生产 hook 是热 cursor，只读变更文件；冷 cursor 是这个机制的最差条件，作为上界记录。
   `skills/tokenboard/scripts/notify.mjs` 会把 hook 各阶段耗时写进 run log，热 cursor 的实测不在
   本报告范围。

7. **2026-11-13：上一条的两个原因都处理了（代码已合并，计时待补测）**。
   ① `LoadGroupsPerKind` 让 `daily` 与 `session` 共用一次解析：同一批事件同时进入两套去重表，
   语料从三遍降到两遍；`nativeReportRunner` 按下发内容缓存这份结果，第二个报表直接复用。
   ② 解析按文件并发，worker 上限 8；读者只解析，事件按文件顺序流式交给聚合，读取预算
   （`2*workers` 个槽位，worker 在认领文件之前取得槽位、文件被记账之后释放）把同时在内存里的
   已解析文件限制在 16 个以内（8 worker 时），不会随语料线性增长。第一版流式实现把预读窗口
   做成 `workers+1` 且 worker 在认领之后才排队取槽，最早未记账文件的 worker 会被后来文件占满的
   槽位卡住，CI 上稳定死锁；认领前取槽消除了这种交错。
   实测（本机 40 个真实文件、584 MB、1 分钟负载 167）：串行 8.85s、8 路并行 3.24s，**2.13 倍**；
   解析占总耗时 92%（单独测 40 个大文件：parse-only 7.23s，含聚合 7.85s），所以并行的上限接近
   核数。等价性由两组测试钉住：共享解析对两次独立解析逐字段相等（1/2/4/16 workers、有窗口与
   无窗口），以及真实 50 个文件上新旧二进制的 snapshot 逐字段相同。
   补测脚本 `~/.tokenboard/observation/codex-bench.sh` 在三个提交点各跑 5 轮，1 分钟负载 < 40
   才起跑。三个点是 `6677f87`（优化前）、`995aa74`（共享解析）、`114660d`（并发解析）——旧的并发
   提交 `93eee11` 不进基准，它的槽位顺序在上面说的死锁里，已被 `114660d` 取代（行为相同的正确
   版本，差异只在取槽顺序）。

   **2026-11-13 晚间测得前两个点、11-14 凌晨测得第三点**（`codex full`，同机同口径，5 轮中位）：

   | 提交点 | 侧 | 中位墙钟 | 最大墙钟 | 中位峰值 RSS | 最大峰值 RSS | calls |
   |---|---|---|---|---|---|---|
   | `6677f87` 优化前 | ccusage | 287.4s | 355.8s | 497 MiB | 499 MiB | 2 |
   | `6677f87` 优化前 | native | **963.2s** | 984.7s | 528 MiB | 540 MiB | 1 |
   | `995aa74` 共享解析 | ccusage | 209.5s | 229.4s | 489 MiB | 498 MiB | 2 |
   | `995aa74` 共享解析 | native | **381.4s** | 403.4s | 1000 MiB | 1000 MiB | 1 |

   起跑负载 19.10（第一点）、16.16（第二点），结束 13.59 / 7.91。第三点单独一张表
   （起跑负载 37.87）：

   | 提交点 | 侧 | 中位墙钟 | 最大墙钟 | 中位峰值 RSS | 最大峰值 RSS | calls |
   |---|---|---|---|---|---|---|
   | `114660d` 共享+并发+流式 | ccusage | 281.3s | 417.0s | 488 MiB | 518 MiB | 2 |
   | `114660d` 共享+并发+流式 | native | **319.1s** | 593.1s | 1009 MiB | 1010 MiB | 1 |

   native 对 ccusage 的倍差从 3.35 倍 → 1.82 倍 → **1.13 倍**；native 绝对墙钟 963.2s →
   381.4s → 319.1s，共 **3.02 倍**。`regression: true` 仍成立（`native median wall 5m19.089s
   exceeds ccusage 4m41.318s (+13.4%)`），但差距已经落在本机轮间噪声附近：native 五轮
   269–593s、ccusage 247–417s，最大的那轮 native 593s 明显是负载尖峰。要判定「是否已经追平」
   需要一台真正空闲的机器，本机给不出这个精度。

   **峰值内存没有回来，反而停在 1 GiB**：三点分别是 528 → 1000 → 1009 MiB。这是本次补测
   推翻了预判的地方——流式改造（`78790ae`）把「已解析事件」的缓冲压到 `2*workers` 个文件，
   但真实峰值由别的东西主导：`LoadGroupsPerKind` 同时持有 daily 与 session 两套去重表和分组，
   而旧的三遍实现一次只构建一套。换言之，共享解析省掉的墙钟是拿峰值内存换来的，约 2 倍。
   组级实验（40 个真实文件）里内存没有出现这个台阶，是因为那里的分组表规模远小于全量语料；
   全量场景才暴露出来。后续若要把内存压回去，方向不是把解析再改小，而是让一次采集只物化
   一套分组（例如两个报表一次读出、或把 session 报表改成从 daily 分组派生），这没有做。

   **ccusage 侧跨点差异**：287.4s（第一点）→ 209.5s（第二点）→ 281.3s（第三点）。bench 先跑完
   5 轮 ccusage 再跑 5 轮 native，两侧不在同一段负载里，且三个点跨了两天；所以跨提交点只能看
   「native/ccusage 倍差」与 native 的绝对变化，不能拿 ccusage 的绝对值当刻度。

   第三点在成功前作废过两轮：14:04 UTC（负载 5.64 起跑）与 16:08 UTC（33.64 起跑）都在中途
   被负载污染——机上一度有 943 个进程、负载 400 上下（另有 `tokenboard sync --source all` 与
   Docker 虚拟机并发），第一轮 ccusage 就跑了约 30 分钟（干净时一轮 3–6 分钟）。`sample` 确认
   bench 在 `wait4` 等 ccusage 子进程、子进程在跑而非挂起，只是读数被污染，已中止并作废。
   17:41 UTC 第三次尝试通过。脚本因此加了开跑后的看门狗：每 60s 复查负载，一旦 ≥ 60 就杀掉
   bench 与其子进程、把读数改名留痕并回到闸门（最多三次）。**旧的 `93eee11` 版本不重测**。

## 4. 取舍记录

- 2026-11-10 时本报告只覆盖 A/B，C 沿用旧记录并注明「全量可能更慢」。2026-11-12 的补测把
  「可能」坐实为「codex 全量慢 4.3 倍」，发布说明必须写明这一点，不能沿用旧的含糊表述。
  claude-code 全量仍然更快，不能把 codex 的结论推广到所有源。
- 2026-11-14 的补测把倍差压到 1.13 倍（§3.7），但**没有追平**：`regression: true` 仍成立，且峰值
  RSS 约为 ccusage 的 2 倍。发布说明应写成「codex 全量已大幅收窄，但同语料下仍略慢于 ccusage，
  峰值内存约 2 倍」，不能写成「已追平」或「已更快」。
- D（hook 增量）在补测里跑了冷 cursor 版本。两份实现共享 `sessioncursor` 层，所以 cursor 的
  收益与实现无关；冷 cursor 测的是「没有任何缓存可用的最坏情况」。
- E（冷启动到首字节）被 A 覆盖：ccusage 的进程 spawn 成本已经包含在 single 场景的墙钟里。

## 5. 未覆盖

- **端到端对比（TS collector 全链路 vs Go 客户端）没有计时结果**。2026-11-13 起 Go 侧已从三遍
  降到两遍，TS 的 `collectCodexCcusageRangeAttempt`（`packages/collector/src/providers/codex.ts:481`）
  仍是 ccusage `daily`、ccusage `session`、`collectCodexContextPricingUsagesFromFiles` 三遍，
  所以「native 对 ccusage 二进制」的比值不再能直接当作迁移前后的等待时间对比——Go 侧现在少一遍。
  要回答迁移前后谁更快，必须实测 TS 全链路；§3.7 的三个点都完成了，这一项仍然没有。
  2026-11-12 起过一轮同语料计时（`tokenboard preview --source codex` 对
  `tsx src/cli.ts preview --source codex`），native 一侧 27 分钟后因本机进入工作时间、负载升到
  93 而中止，TS 一侧未开跑——本机白天负载长期 70–140，全量单轮就要十几分钟，计时在当前条件下
  不可得。**这条结论是代码结构得出的，不是计时得出的**，如果将来要拿它对外比较，需要一台空闲
  机器的实测。
- 12 个 ccusage 工具来源：本机未安装这些工具，两者都返回空结果，测不出差异；其 parity 证据见
  `2026-11-09-tools-native-parity.md`。
- Windows/Linux 真机未测性能（RSS 采集在 darwin 上验证；Windows 路径由 CI
  `rss_windows_test.go` 覆盖编译与执行）。
