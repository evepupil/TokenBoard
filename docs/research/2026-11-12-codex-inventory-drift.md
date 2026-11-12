# Codex 无界采集：会话清单漂移不再整源失败（2026-11-12）

## 1. 问题

codex 的无界（range）采集在读取 daily/session 报表前后各做一次会话文件盘点，并断言两次
盘点完全一致：文件数相同、每个文件的身份路径与指纹（dev/ino/size/mtime）相同。任何差异都会
报 `Codex session inventory changed during unbounded collection; retry the sync`，整源失败。

这条护栏在真机上的代价：

- **正常使用必然触发**。扫描期间新开一个 codex 会话（added）、归档文件被轮转（vanished）、
  活跃会话追加写入（modified）都算漂移。会话文件 5.5 GB 的机器上，一次无界扫描要几十秒到
  几分钟，这个窗口里发生任何上述变化都不奇怪。
- 原有重试只有一次（`unboundedCodexCollectionAttempts = 2`），第二次扫描面对同一个仍在变化的
  目标，命中同样的漂移，然后整源失败。
- 实测（2026-11-12）：`bench-collect -source codex -scenario full` 在活跃的 `~/.codex` 上
  跑了 2 小时 17 分钟后以该错误退出；同一份数据在 APFS clone 的冻结副本上才能测出数字。

## 2. 改动

两个实现同步改：

| 位置 | 之前 | 现在 |
|---|---|---|
| Go `providers/codex/provider.go` | 两次盘点不一致 → 返回错误 → 重试一次 → 失败 | 输出一行诊断（`added N, vanished N, modified N`），继续用已读到的结果 |
| Go `providers/codex/context_pricing.go` | 读取时文件已消失 → open 失败 → 整源失败 | 跳过该文件并诊断，下一轮同步补上 |
| TS `providers/codex.ts` / `codex-context-pricing.ts` | 同上（throw） | 同 Go：诊断 + 继续，消失文件跳过 |

## 3. 为什么可以接受

- **每行数据仍来自一次真实读取**：扫描器读到哪个文件的那一刻，文件是什么样，行就按那样算。
  漂移只意味着这次快照略早于扫描结束，与「同步早几秒开始」等价。
- **下一轮同步自愈**：无界采集每次都重扫全部会话文件，`daily_usage` 按
  `(user, device, source, date, model)` 幂等 upsert，`snapshot_hash` 变化时覆盖。某文件在
  本轮只读到前半段，下一轮读到全文后会覆盖同一行。
- **确定性输入不受影响**：夹具、金样本、CI shadow 的输入在扫描期间不会变化，因此这些路径
  永远不进入漂移分支，`snapshotHash` 与之前逐位一致。
- **真正的错误仍然 fail-closed**：文件不可读、权限错误、JSONL 损坏、超限行、定价对账不一致
  等仍按原语义报错。

### 3.1 连带处理：raw cost 对不上 daily 快照时不再整源失败

同一轮实测（2026-11-12 晚，修复清单漂移后重跑 codex full）又撞到下一道同族护栏：

```
Codex context pricing cannot match raw cost for 2026-07-10/gpt-5.6-sol
```

含义是：daily 报表里 `2026-07-10/gpt-5.6-sol` 有 token，但会话文件里重建不出无歧义的
逐请求成本（历史文件被归档/压缩过，或某文件在扫描中被跳过）。这与清单漂移同源——**历史数据不完整
是常态**，而原实现让整源失败。

现在两侧都改为：

| 情形 | 处理 |
|---|---|
| raw cost 找不到对应 daily 快照 | 诊断（`... leaving the day's aggregate cost as reported`），该成本不参与改写 |
| daily 快照找不到无歧义 raw cost（含一个 alias 成本可套多个同日快照） | 诊断（`... keeping the day's aggregate cost`），该行保留 ccusage 日报成本 |
| 同一天同一模型出现重复 daily 快照 | **仍然报错**——这是数据/实现异常，不是历史不完整 |

语义后果：这类行退回「不做 context 分档修正」，即 ccusage 日报的原值；不会凭空多算或少算。
确定性输入下匹配总是成功，行为与之前一致。

## 4. 与 TS 的一致性

TS collector 同样修改，因此 `tokenboard shadow` 的两侧在活跃机器上都能给出结果，不会出现
「Go 成功、TS 失败」这种无法比的组合。两侧的诊断文案与计数口径一致。

## 5. 测试

- Go：`TestProviderReportsASessionThatChangesDuringReconciliationInsteadOfRetrying`（原「重试」
  用例改写）、`TestProviderReportsASessionThatAppearsDuringReconciliation`、
  `TestProviderSkipsASessionFileThatVanishesDuringTheScan`。
- TS：`reports a session that changes during ccusage reconciliation instead of retrying`。
- 金样本与 shadow fixture 未改动，全部通过。

## 6. 遗留

- 「重试一次」对其它 codex 变更类错误（子会话归属变化、canonical attribution 变化）仍然有效，
  本次没有改动。
- 漂移诊断写入 stderr；`notify.mjs` 的噪声过滤目前只识别 `TokenBoard model pricing` 前缀，
  因此这类诊断会作为普通输出出现在 hook 日志里，不会被误判为错误。
