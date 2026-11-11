# 2026-11-11 Windows / Linux 真机验证（S5 未覆盖项）

- 日期：2026-11-11（Asia/Shanghai）
- 分支 / 代码：`feat/native-usage-sources` @ `c44d000`
- 目的：补上 `docs/specs/go-client-spec.md` §6 限制（「Windows / Linux 上的表现」）与 §8
  「Windows 换入语义……未在本机（darwin）实测」两处空白。此前 Go 侧的全部验证都只在
  macOS/darwin amd64 上做过；CI 的 windows-latest / ubuntu-latest 跑的是同一套测试，
  但没有覆盖真实用户数据，也没有在真机上执行过自更新换入。
- 机器：
  - Linux：Ubuntu，kernel 6.8.0-146-generic，x86_64，24 核 / 31 GiB。
  - Windows：Windows amd64，管理员账户，Git Bash（MINGW64），MinGW gcc 15.1.0、
    `CGO_ENABLED=1`（race 检测器可用）。

## 1. 环境准备（两机相同口径）

两机系统 Go 都低于 `clients/go/go.mod` 的 `go 1.27`，靠 `GOTOOLCHAIN=auto` 自动取到
**go1.27.3**（Linux 系统为 1.22.2，Windows 为 1.24.5）。两机 Node 均为 v24.21.0，低于
`^22.23.4 || ^24.22.1 || >=26.12.1` 的下限，故安装 **v24.22.2**：

- Linux：nodejs.org `node-v24.22.2-linux-x64.tar.xz`，sha256
  `48cc0e21e048790e54c0cf5749c2725005313d652651c40b7a21feb9697aaf75`（与官方 `SHASUMS256.txt` 一致）。
- Windows：`node-v24.22.2-win-x64.zip`，sha256
  `ca1bff5d8ead13c9f2ea404a176db46bd430704d5b5113734049fa365e7799e2`（同上）。

源码以 `clients/go/**` 加仓库根配置文件分发（`.goreleaser.yaml`、`.npmrc`、`package.json`、
`apps/web/package.json`、`packages/collector/{package.json,ccusage.json,src/child-env.ts}`、
`packages/usage-core/package.json`）。**这一步不是可选项**：第一次分发漏了根文件，两机各出现
2 个失败（`TestDevCommandsAreNotInTheGoreleaserBuildList` 读 `.goreleaser.yaml`、
`TestGoldens_overridesMatchTheShippedConfig` 读 `packages/collector/ccusage.json`），补齐后复跑全绿。
测试确实依赖仓库根，而不只是 `clients/go`。

## 2. Go 测试矩阵

| 项目 | Linux | Windows |
|---|---|---|
| `go vet ./...` | 通过 | 通过 |
| `go test ./... -race -count=1` | **exit 0，43 个包 ok** | **exit 0，43 个包 ok** |
| 交叉构建 windows/amd64、windows/arm64、linux/arm64、darwin/arm64 | 全部通过 | —（原生） |
| 交叉 vet windows/amd64、windows/arm64、darwin/arm64 | 通过 | — |
| `gofmt -l .` | 空 | —（CI 不跑） |

Windows 的 `-race` 是真正的原生 race 检测（MinGW gcc + `CGO_ENABLED=1`），不是跳过。

## 3. skill 脚本测试（`node --test skills/tokenboard/scripts/*.test.mjs`）

| 平台 | tests | pass | fail | skipped |
|---|---|---|---|---|
| Linux（Node 24.22.2） | 871 | 871 | 0 | 0 |
| Windows（Node 24.22.2） | 871 | 862 | 0 | 9 |

9 个跳过全部带显式 `{ skip: process.platform === 'win32' }`，对应真实能力缺失而非未跑：

- `antigravity-statusline.test.mjs:297` 子进程树强制终止（另有一处以
  `t.skip('POSIX file mode assertion')` 跳过权限断言）；
- `config.test.mjs:624,649`、`coordinator.test.mjs:1357,1392` 文件/目录权限重收紧；
- `process-liveness.test.mjs:193` 信号驱动的进程身份探测；
- 两条 notify 的「pid 被复用」用例。

本机实测三条能力证据：`fs.chmodSync(dir, 0o700)` 后 stat 仍是 `666`；对安装了 SIGTERM 处理器的
子进程发信号不生效（`exited null / signal null`）；账户是管理员（`IsInRole(Administrator)=True`），
所以不是「权限不足」造成的跳过。

## 4. 真实数据采集与双跑

两机都有真实会话：Windows `~/.codex` 1.1G、`~/.claude` 34M；Linux `~/.codex` 2.2G、
`~/.claude` 4.5M（19 个会话文件）。

- **Windows 预览**（`preview --source all --since 20261101`）：exit 0，6 条快照——
  claude-code 5 行 / 121,431,183 tokens，codex 1 行 / 476,647 tokens。
- **Windows 时区 fail-closed 实测**：不设 `TOKENBOARD_TIMEZONE` 时 exit 2 并报
  `Cannot determine the system timezone on Windows. Set TOKENBOARD_TIMEZONE ... or pass --timezone`，
  与设计一致（不会静默按 UTC 归属日期）。
- **Windows 双跑**：`shadow --source claude-code` → `match`，2 条匹配、0 差异、3 条 `liveWrite`
  （当天仍在写入的会话行，按三条件归因）；`shadow --source codex --since 20261101` → `match`，1 条。
- **Linux 全量双跑**（`shadow --source all`，无 `--until`）：`diff`，61 条快照，1 条差异，
  0 条 liveWrite。唯一差异是 `claude-code / 2026-09-19 / deepseek-v4.1-flash`，且只有 `costUsd`：
  TS `0.23173868116000004` vs Go `0.23962135`。这是 2026-11-10 已定性的 G2 费率口径边界
  （在线/离线价表），不是语义分歧。本次还试过用 `TOKENBOARD_CCUSAGE_CONFIG` 把两侧钉到
  `packages/collector/ccusage.json`：**差异不会消失**，因为该模型不在那份配置的
  `pricingOverrides` 里，两侧各自回退到自己的内建表——即「钉配置」只对配置里列出的模型有效。
- Linux 上 antigravity 三源按 unavailable 跳过（`history-unavailable` /
  `language-server-unavailable`），opencode / pi / grok-build / deepseek-harness 未安装。

## 5. Windows 真机自更新换入

用一台 Linux 主机上的模拟 GitHub 布局发布源（`/MisonL/TokenBoard/releases/latest` 302 →
`/releases/tag/v2.0.0`，资产与 `checksums.txt` 静态提供，端口转发给 Windows），
Windows 上以带版本戳的 v1.0.0 二进制作为「旧版」，发布资产为 v2.0.0。

| 用例 | 结果 |
|---|---|
| 正常换入（1.0.0 → 2.0.0） | `{"updated": true, "version": "2.0.0"}`，exit 0；`tokenboard.exe` 变为 16,133,120 字节并报 2.0.0；保留 `tokenboard.exe.backup-20261111T041527Z` |
| 重复运行 | `{"updated": false, "version": "2.0.0"}`，exit 0，不再下载 |
| 校验和被篡改（`0c1f9f39…`） | `checksum mismatch for tokenboard_windows_amd64.tar.gz`，**exit 1**，版本仍为 1.0.0，无 `tokenboard.exe.new` 残留 |
| 同上 + `--scheduled` | 同样报错但 **exit 0**，版本仍为 1.0.0（调度器无法处置升级失败，按设计就绪） |

这组结果直接证实了 spec §8 中「`os.Rename` 两步换入在 Windows 可行」的源码级论证：第一步把
**正在运行的** exe 改名为 backup 成功，第二步 `staged → current` 此时目标不存在。此前该条只做过
`GOOS=windows go build`，本机（darwin）无法实测。

顺带观察：换入时客户端提示「现有的 `C:\Users\<user>\.tokenboard\bin\ccusage.exe` 原地保留」——
S5 之后升级不再分发 ccusage，但也不删除旧版留下的文件。

## 6. 真实数据发现：旧版 codex fork 文件让 codex 源整体 fail-closed

Windows 全量预览 `preview --source codex --since all` **exit 1、stdout 为空**，stderr：

```
Codex context pricing found conflicting session identities for C:/Users/<user>/AppData/Local/Temp/tokenboard-codex-home-3822322530:2026/03/06/rollout-2026-03-06T22-44-51-019cc39b-c392-7c30-8391-0b8562247422.jsonl
```

触发文件是 `~/.codex/sessions/2026/03/06/rollout-2026-03-06T22-44-51-019cc39b-….jsonl`
（853 行 / 1,535,465 字节；记录构成 `session_meta` 2、`response_item` 528、`event_msg` 315、
`turn_context` 7、`compacted` 1）。两条 `session_meta`：

1. `id=019cc39b-c392-7c30-8391-0b8562247422`，`source.subagent.thread_spawn`（子线程）；
2. `id=019cc24a-eac5-7ff1-939e-77b54adfa32c`，`source="cli"`（父线程）。

两条都没有 `session_id`。`readSessionIdentity` 的键序是 `session_id, sessionId, thread_id,
threadId, id`，于是第一条把身份定为子线程 id，第二条得到父线程 id，同一 alias 出现两个身份
→ `scanFile` 抛错（`context_pricing.go:1343,1351`；TS 同位置 `codex-context-pricing.ts:1259,1266`）。

**这是既有 TS 行为，不是 Go 移植缺陷**：把同一文件复制到 Linux 上的临时 CODEX_HOME，两侧
（Go 与 `pnpm exec tsx src/cli.ts`）都 exit 1、同一条错误、连前一行诊断也相同
（`Skipping Codex subagent usage correction for 2026-03-06/gpt-5.4: child usage 17505413 exceeds session row 7035696`）。
最小复现（Linux，合成文件）：

| 文件形状 | 结果 |
|---|---|
| 两条 `session_meta`，`id` 不同、无 `session_id` | **冲突**，exit 1，0 字节输出 |
| 两条 `session_meta`，共享 `session_id`（新版 Codex fork 形状） | 正常，1 条快照 361 字节 |

对真实文件按行截断也能复现：`head -2` 起即冲突（2/3/10/50/200/500/853 行全部 exit 1）。
新版 Codex 的 fork 文件会在子线程 meta 里写 `session_id`（本机 macOS 2026-11-03 的样本即是），
所以只有**旧版本**留下的 fork 文件会踩中。

影响面：这类机器上 codex 源**整体**失败（不是跳过一行）。按窗口收集不受影响——
Windows 上 `--since 20261101` 的 codex 双跑仍是 `match`。既有单测
`TestUsesTheStableSessionIDWhenCodexEmitsAPerRecordID` 只覆盖了新版形状，旧形状没有用例。
S5 的翻转不改变这条行为（两侧本来就一致），但它会原样继承到 Go 客户端。

## 7. 仍未覆盖

- ~~文件 compaction / 整体重写下的热 cursor（只测了追加；见 2026-11-10 那份文档 §6）。~~ 2026-11-11 已补，见 `2026-11-11-hot-cursor-rewrite.md`。
- Antigravity GUI 的 language-server 路由（需要真实运行的语言服务器）。
- 2 周稳定观察与 D8（与上游作者对齐）——都不是本机可推进的项。
- ~~旧版 codex fork 文件的冲突处置：当前两侧一致 fail-closed，是否改成「以文件自身 meta 为准、
  忽略嵌入的父线程 meta」需要两侧同时改并补用例，属独立决定。~~ 2026-11-11 已决定并落地：
  文件内采纳最新 `session_meta`（旧 fork 重放父线程），同一 alias 下两个文件最终身份不一致仍 fail-closed；
  两侧同时改并各补两条用例（`2f5891a`）。