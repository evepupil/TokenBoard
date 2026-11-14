# 2026-11-03 native vs ccusage 基线（S1：仅 ccusage 基线）

- 测量日期：2026-11-04 19:42–20:30（+0800），本机 macOS / darwin amd64
- 分支：`feat/native-pricing-engine`，基线提交 `0aa1a06`
- ccusage：`20.0.33`（`~/.tokenboard/bin/ccusage`）
- Go：`go1.27.3 darwin/amd64`
- 工具：`clients/go/cmd/bench-collect`（dev-only，Task 7 交付）
- 数据文件：`docs/research/2026-11-03-baseline-artifacts/{single,30d,full}.json`、`run.log.txt`
  （原始产物；`run.sh` 见 §1.4）

> 发布说明：提交的产物与本文档中**唯一**的变换是把本机 home 目录改写为 `~`
> （`/Users/...` → `~`），其余字节未动，数值保持可审计。

> **重要声明（必读）**
>
> ~~S1 尚未实现任何 native provider~~ —— **2026-11-10 更新**：native 侧已交付，对比结果见
> `docs/research/2026-11-10-native-vs-ccusage-benchmark.md`（S5；single/30d 两个场景，5 轮中位数）
> 与 `2026-11-05-claude-native-parity.md` §5.3（full 场景，native 墙钟 +22.1%）。
> 本文的 value 仍然是**ccusage 侧的基线**：`bench-collect` 的 native 列在本轮三场景里全部是
> `notImplemented`（0 轮测量），所以本文任何数字都**不能**被引用为“native 更快/更慢”的证据。
> 两份新报告与本文件的测量条件不同（本机负载 59 vs 76–142），绝对值不可直接相减。

## 1. 测量方法

### 1.1 场景定义

`bench-collect` 用 `settledDay`（昨天，Asia/Shanghai）避免与正在写入的源竞争：

| 场景 | 日期窗口 | 语义 |
|---|---|---|
| `single` | `20261103..20261103` | 单日窗口，“空跑成本” |
| `30d` | `20261005..20261103` | 典型定时同步窗口 |
| `full` | 无 `--since/--until` | 全量历史 |

### 1.2 每轮实际执行的 ccusage 调用

`bench-collect` 镜像 collector 的真实调用，**每轮 2 次调用**（daily + session），不是设计文档 §9.1
里单条命令的测量：

```
claude daily   --json --breakdown --single-thread [--since S --until U] --timezone Asia/Shanghai
claude session --json             --single-thread [--since S --until U] --timezone Asia/Shanghai
```

与设计文档 §9.1（2026-11-03，load ≈ 59）的差异，**两批数字不可直接相减比较**：

- §9.1 用 `--offline`、**不带** `--single-thread`、只跑单条 daily/session；
- 本文走 collector 真实路径：**不带 `--offline`**（`--offline` 会改用 ccusage 内置费率表，改变入库
  cost），**带 `--single-thread`**（go-client-spec §5 记录：RSS 约降 57%，墙钟约升 1.7×），
  且每轮把 daily 与 session 的墙钟相加、RSS 取两者较大值。

### 1.3 指标口径

- 墙钟：`cmd.Start()` 到 `cmd.Wait()`，每轮两次调用之和。
- 峰值 RSS：ccusage **子进程**的 `wait4` rusage（`ru_maxrss`），darwin 单位为字节；
  三次运行的 `rssSource` 均为 `wait4-rusage`（精确到单个子进程，非高水位估计）。
- `bytesRead` 在 S1 为占位 0（`bytesReadPending: true`），读字节计数在 S2 落地。
- 每场景 **5 轮**（工具硬下限 5），取中位数并记最大值。

### 1.4 执行方式

三个场景**严格串行**，每个场景 5 轮串行；场景之间记录 `uptime` 与 `vm_stat`。驱动脚本
`run.sh` 与运行日志 `run.log.txt` 见 `docs/research/2026-11-03-baseline-artifacts/`。

```bash
cd ~/.tokenboard/TokenBoard/clients/go
go run ./cmd/bench-collect -source claude-code -scenario single -rounds 5 \
  -ccusage-bin ~/.tokenboard/bin/ccusage -json > /tmp/tokenboard-bench-8/single.json
go run ./cmd/bench-collect -source claude-code -scenario 30d -rounds 5 \
  -ccusage-bin ~/.tokenboard/bin/ccusage -json > /tmp/tokenboard-bench-8/30d.json
go run ./cmd/bench-collect -source claude-code -scenario full -rounds 5 \
  -ccusage-bin ~/.tokenboard/bin/ccusage -json > /tmp/tokenboard-bench-8/full.json
```

`-h` 实测该构建接受的 flag：`-source`、`-scenario single|30d|full|hook`、`-rounds`（最小 5）、
`-ccusage-bin`、`-json`；无 `-since/-until`（窗口由场景决定）。实际调用与参考命令一致，未做改写。

## 2. 环境与负载

| 时刻 | load 1/5/15 | 登录会话数 | free (GiB) | free+inactive (GiB) |
|---|---|---|---|---|
| 19:42 运行前 | **5.75 / 5.36 / 5.51** | 7 | 3.35 GiB | 29.27 GiB |
| 19:50 `single` 后 | 5.44 / 6.69 / 6.29 | 15 | 2.89 GiB | 28.39 GiB |
| 20:07 `30d` 后 | 13.25 / 15.37 / 12.39 | 27 | 4.25 GiB | 27.99 GiB |
| 20:30 `full` 后 | **153.82 / 158.57 / 100.18** | 29 | 4.66 GiB | 27.20 GiB |
| 20:30 复核（事后） | 134.34 / 153.66 / 99.77 | 29 | 4.28 GiB | 26.95 GiB |

> 表中 free / free+inactive 均由**同一份** `vm_stat` 快照计算；`run.log.txt` 的 `mem()` 另取过一次快照，
> 因此日志里同一时刻的尾数可能差 ±0.03 GiB，不影响结论。

- 全程 `Pages throttled: 0`（每次 `vm_stat` 快照均为 0），未观察到 OOM kill；纯 free 页最低 2.89 GiB，
  另有约 26 GB inactive 可回收，**未出现内存压力**。事后手工执行 `vm.swapusage`：
  used 370 MB / 2048 MB（**运行前未采集 swap，属方法学缺口**）。
- 运行前确认无残留 ccusage 进程（`ps` 计数 0）。

> **采样来源说明**：表中 load / 页数来自 `run.sh` 的 `uptime` / `vm_stat`（记录在 `run.log.txt`）。
> 而 20:30 事后复核行、`vm.swapusage`、`ps -r` 与“无 OOM kill”的判断是**事后手工执行**的，
> **不在 `run.log.txt` 里**。

### 2.1 关键异常：测量窗口被无关负载污染（不可忽略）

`full` 结束时 load 1 分钟均值 **153.82**，与运行前 5.75 相差 27 倍；登录会话数 7 → 29。
事后 `ps -r` 显示负载来自**与本任务无关**的进程：一个 Virtualization VM（218% CPU，已运行 2h14m）、
多个 `claude` 会话、`xctest`、Playwright headless Chromium、python3.14、Docker backend 等。
本任务自身任何时刻最多只有 2 个串行 ccusage 子进程。

后果：

- **墙钟数据受污染**，尤其 `30d`/`full`。按场景边界的采样：`30d` 在 load 5.4 → 13.3 之间测得，
  `full` 在 13.3 → 153.8 之间测得（边界采样，非逐轮）。证据：`full` 第 2 轮 174.7 s，第 5 轮
  455.8 s（2.61×），同期负载持续上行；`30d` 五轮整体上行（162.1 → 236.8 s），第 4 轮回落至 196.4 s。
- **RSS 数据基本不受影响**：同场景各轮 RSS 离散 < 1.5%，且负载飙升期间没有抬升——内存分配不随
  CPU 调度变化。故 **RSS 是本次更可信的指标，墙钟中位数应视为上界**。
- 没有轮次失败（15/15 exit 0，stderr 全空）。我判断继续跑完并如实记录比中止更有用：负载来自
  长时间运行的无关进程（VM 已跑 2h14m），短期不会回落，等待无确定收益；这一点是我的取舍，
  brief 并未定义停止条件。

## 3. 原始数据（每轮 + 中位数 + 最大值）

墙钟单位秒（毫秒原始值见 JSON）；RSS 为字节与 GiB 双列；`calls` 恒为 2。

### 3.1 `single`（窗口 20261103..20261103）

| 轮次 | 墙钟 (s) | 峰值 RSS (B) | 峰值 RSS (GiB) | 输出 (B) | calls |
|---|---|---|---|---|---|
| 1 | 100.863 | 3,384,643,584 | 3.1522 | 107,195 | 2 |
| 2 | 102.690 | 3,423,936,512 | 3.1888 | 107,195 | 2 |
| 3 | 109.283 | 3,397,554,176 | 3.1642 | 107,195 | 2 |
| 4 | 106.801 | 3,404,951,552 | 3.1711 | 107,195 | 2 |
| 5 | 103.572 | 3,417,931,776 | 3.1832 | 107,195 | 2 |
| **中位数** | **103.572** | **3,404,951,552** | **3.1711** | 107,195 | |
| **最大值** | **109.283** | **3,423,936,512** | **3.1888** | 107,195 | |

### 3.2 `30d`（窗口 20261005..20261103）

| 轮次 | 墙钟 (s) | 峰值 RSS (B) | 峰值 RSS (GiB) | 输出 (B) | calls |
|---|---|---|---|---|---|
| 1 | 162.120 | 4,739,043,328 | 4.4136 | 3,706,106 | 2 |
| 2 | 188.626 | 4,785,029,120 | 4.4564 | 3,706,106 | 2 |
| 3 | 212.851 | 4,759,633,920 | 4.4328 | 3,706,106 | 2 |
| 4 | 196.431 | 4,742,131,712 | 4.4165 | 3,705,058 | 2 |
| 5 | 236.797 | 4,719,394,816 | 4.3953 | 3,705,058 | 2 |
| **中位数** | **196.431** | **4,742,131,712** | **4.4165** | 3,706,106 | |
| **最大值** | **236.797** | **4,785,029,120** | **4.4564** | 3,706,106 | |

### 3.3 `full`（无日期过滤）

| 轮次 | 墙钟 (s) | 峰值 RSS (B) | 峰值 RSS (GiB) | 输出 (B) | calls |
|---|---|---|---|---|---|
| 1 | 224.518 | 4,771,774,464 | 4.4441 | 3,798,470 | 2 |
| 2 | 174.661 | 4,756,496,384 | 4.4298 | 3,799,248 | 2 |
| 3 | 235.371 | 4,768,518,144 | 4.4410 | 3,801,088 | 2 |
| 4 | 294.922 | 4,786,659,328 | 4.4579 | 3,801,933 | 2 |
| 5 | 455.804 | 4,753,686,528 | 4.4272 | 3,802,534 | 2 |
| **中位数** | **235.371** | **4,768,518,144** | **4.4410** | 3,801,088 | |
| **最大值** | **455.804** | **4,786,659,328** | **4.4579** | 3,802,534 | |

### 3.4 汇总

| 场景 | 墙钟中位数 | 墙钟最大 | RSS 中位数 | RSS 最大 | 输出中位数 |
|---|---|---|---|---|---|
| single | 103.572 s | 109.283 s | 3.1711 GiB | 3.1888 GiB | 107,195 B (0.10 MiB) |
| 30d | 196.431 s | 236.797 s | 4.4165 GiB | 4.4564 GiB | 3,706,106 B (3.53 MiB) |
| full | 235.371 s | 455.804 s | 4.4410 GiB | 4.4579 GiB | 3,801,088 B (3.63 MiB) |

场景总墙钟（含 `go run` 编译与轮间开销）：single 523 s、30d 997 s、full 1387 s。

## 4. “single ≈ 30d ≈ full” 是否成立？

设计文档 §9.1 的核心事实是：`--since/--until` **只过滤输出，不减少扫描量**。本次数据：

- **输出量随窗口增长，30 天后饱和**：107,195 B（0.10 MiB）→ 3,706,106 B（3.53 MiB）→
  3,801,088 B（3.63 MiB）；single 是全量的 2.8%，30d 与 full 只差 2.5%。
- **成本没有按同比例缩小**：single 的墙钟中位数是全量的 **44.0%**（103.6 / 235.4 s），RSS 是全量的
  **71.4%**（3.17 / 4.44 GiB）。一个只输出 2.8% 数据的单日窗口，仍要付出 44% 的墙钟和 71% 的峰值内存。
  这与 §9.1 的“窄窗口不省扫描”方向一致：**ccusage 单条命令约 30 秒（§9.1），而 collector 的双调用
  路径（daily+session）单日窗口仍需约 100 秒、数 GB**。
- **但本文没有复现字面意义的“三者几乎相同”**：实测中位数是 103.6 / 196.4 / 235.4 s 与
  3.17 / 4.42 / 4.44 GiB，不是等值。原因是**墙钟被无关负载污染**（§2.1）：single 在 load ≈ 5.4–6.7
  下测得且五轮极稳（100.9–109.3 s，离散 8%）；`30d` 在 load 5.4 → 13.3、`full` 在 13.3 → 153.8
  下测得，`full` 第 5 轮（455.8 s）是第 2 轮（174.7 s）的 2.61×。因此 **30d/full 的墙钟中位数只能
  当上界**，无法据其判定窗口对墙钟的真实影响。
- **RSS 的差异是真实差异**：single 3.17 GiB 明显低于 30d 的 4.42 GiB 与 full 的 4.44 GiB
  （低 **28.20%** vs 30d、**28.60%** vs full），且各轮稳定、与负载无关。**推断**（非测量）：差异
  来自结果集规模（daily `--breakdown` 与 session 报表按 日期×模型 累积的行数），而非扫描阶段；
  30d 与 full 的 RSS 中位数相差仅 0.55%，说明 30 天窗口已基本覆盖全量结果集。该推断未单独验证。
- **与 §9.1 的交叉校验（推断，非测量）**：§9.1 记录单条 daily/session 约 31.5/32.4 s、8.9–9.3 GB
  （无 `--single-thread`、`--offline`）。按 go-client-spec §5 的 `--single-thread` 代价（墙钟约 1.7×、
  RSS 约 −57%）外推，每轮两次调用应约 110 s、约 4 GB。本次 full 的 RSS（4.44 GiB）与该外推吻合，
  说明 full 的 235 s 中位数确实被负载抬高；但外推不能替代干净窗口的实测。

**结论（分两个维度）**：

- 墙钟：受负载污染，**不足以判定**窗口对墙钟的影响；`full` 的 235 s / `30d` 的 196 s 中位数只能
  当上界，字面“single ≈ 30d ≈ full”需低负载窗口重测才能确认或被推翻。报告不把 103.6 < 235.4 s
  当作“单日更便宜”的证据。
- RSS：存在**真实的约 28% 差异**（single 3.17 GiB vs 30d/full 4.42/4.44 GiB），30d/full 更高；
  这与“扫描不变、结果集不同”的推断一致。这一点支持设计文档“窄窗口不省扫描”（扫描阶段成本相同），
  同时说明单日窗口仍需约 3.17 GiB 峰值 RSS，并非接近零。

## 5. 异常、限制与未覆盖边界

1. **负载污染（最重要）**：见 §2.1。墙钟（尤其 30d/full）为受污染的上界；RSS 可信。
2. **swap 未采集运行前值**：仅事后读到 used 370 MB / 2048 MB，无法判断是否为本次运行造成。
3. **`bytesRead` 为占位 0**：S1 无读取计数器（`bytesReadPending: true`），本次无法报告真实读字节数。
4. **与 §9.1 不可直接比较**：flags 不同（本文无 `--offline`、有 `--single-thread`、每轮 2 次调用），
   这是 collector 的真实路径，不是探索性基线。
5. **仅覆盖 `claude-code`**：codex 与 12 个 ccusage 工具源未测（本任务范围）。
6. **未测 `hook` 场景**：需要本机 hook cursor 水位，且 native 侧不存在，留待 S2+。
7. **`go run` 每次场景前会编译**：编译时间不计入轮内墙钟（测量从 ccusage 子进程 `Start()` 开始），
   但计入场景总墙钟。
8. **机器语料未在本次重新统计**：沿用设计文档 §9.1 的记录（Claude Code ~9,828 JSONL / 23 GB），
   未在测量期间做全盘 `du/find`（避免额外 I/O 干扰）。

## 6. 复现

```bash
cd ~/.tokenboard/TokenBoard/clients/go
# 低负载窗口执行；三个场景串行，勿并行
for scn in single 30d full; do
  go run ./cmd/bench-collect -source claude-code -scenario "$scn" -rounds 5 \
    -ccusage-bin ~/.tokenboard/bin/ccusage -json > "/tmp/bench-$scn.json"
done
```

判读要点：`ccusage.rssSource` 应为 `wait4-rusage`；`native.status` 在 S1 恒为 `notImplemented`；
若 `full` 各轮墙钟出现 >2× 离散，先查 `uptime`，不要直接把中位数当结论。
