# 2026-10-30 三平台客户端审查台账（fix/post-merge-audit-followups @ edcbf1e）

六 agent 全维度审查（skill 全链路、Go 正确性、TS↔Go parity、跨平台语义、安全隐私、collector+测试 CI），基线在 macOS 本机、Linux 172.16.81.190、Windows 172.16.84.251 三平台实测。**0 P1；5 P2；若干 P3。全部为既有缺陷，非分支引入。**

本文件记录**审查结论与修复落地**；修复本身未提交（等用户确认）。

## 一、P2（全部已修）

### P2-1 Go `sessionfile` 解析器不跑 `Snapshot.Validate()`（P2，数据污染）
- 证据：`clients/go/internal/collect/sessionfile/parser.go` 的 `finish()` 直接 `int64(row.inputTokens)` 拼快照，全程无 `Validate()`；TS 同路径每条 `usageSnapshotSchema.parse`（`session-jsonl-parser.ts:281`）。Go 其余 7 个 producer 都有 Validate，只有它漏。
- 实测：`cacheRead=500 > total=20` 的快照 `Parse` 返回 err=nil、`Validate()` 报错。
- 链路：坏行经 hook → cursor pending → 下次 `SnapshotsOf` 还原 → 上传 → 服务端整批 400 → 5 次后全机 24h 暂停。
- 修复：`finish()` 每行先 `requireIntegerTokenCounts`（整数/范围/非负，防 float→int64 未定义行为）再 `snapshot.Validate()`，错误带 `source date model` 前缀。测试钉死精确错误文案 + 分数 token 拒绝。

### P2-2 Windows 定时任务脚本转义过冲（P2，定时同步全失效）
- 证据：`skills/tokenboard/scripts/schedule.mjs` 的 `escapeWindowsCmdValue` 把 `&`→`^&`、`^`→`^^`、`|`→`^|`。
- Windows 真机实测：`set "V=Tom & Jerry"` 值保留 `&`；`set "V=Tom ^& Jerry"` 值里带字面 `^`；`set "V5=a"b"` 保留内部引号。只有 `%`→`%%` 是必需的（batch 里单个 `%` 会被吞）。
- 影响：路径/用户名含 `&` 或 `^` 时 `TOKENBOARD_CONFIG_DIR` 变成不存在的路径，每次定时同步失败。
- 修复：只保留 `%`→`%%`；测试断言 `&`/`^`/`|` 字面保留。

### P2-3 skill `parseArgs` 不识别 `--key=value`（P2，静默走错路径）
- 证据：`config.mjs` 的 `parseArgs` 实测 `--mode=preview` → `{"mode=preview": true}`，`sync` 真实上传；`--source=codex` → all；`--until=…` 静默丢弃。仓库自己写进 hook 的正是 `--source=codex` 这种拼写。
- 修复：按 `=` 拆分（`split(/=(.*)/s, 2)`，值里可含 `=`）；新测试覆盖拆分、空值、未知来源拒绝。

### P2-4 `install-collector.mjs` 裸跑重装重置配置（P2，镜像被切回官方）
- 证据：`install-collector.mjs` 的 repoUrl/repoRef/packageManager 只读 flags/env，同函数只为 `clientType` 读了 saved config；而 `sync.mjs` 的报错文案恰好教用户裸跑它。
- 修复：新增 `resolveGitInstallOptions`，三项都回退到已保存配置；binary 分支同样回退 `saved.releaseRepo`/`saved.releaseBaseUrl`。3 条新测试（裸跑保留 / flag 优先 / 首次安装走默认）。

### P2-5 `TOKENBOARD_RELEASE_BASE_URL` 未从 ccusage 子进程剥离（P2，凭据外传）
- 证据：`sync.mjs` 把它注入 collector env；TS `child-env.ts` 与 Go `credentials.go` 的剥离名单都只有 upload token + pairing code；`install-collector.mjs` 注释自陈该 URL 可带 `user:token@host`。
- 修复：`TOKENBOARD_RELEASE_BASE_URL` 与 `TOKENBOARD_REPO_URL`（同为 `user:token@host` 形态）加入三处名单：TS `child-env.ts`、Go `ccusage/credentials.go`、**新增** `skills/tokenboard/scripts/child-env.mjs`。`upgrade-utils.mjs` 的 `spawnRedacted` 用它对 `git clone` / `pnpm install` 子进程剔凭据（后者会执行依赖 lifecycle 脚本，即第三方代码）。
- 防漂移：`child-env.test.mjs` 解析 TS 声明的数组并 deepEqual 比对 skill 名单；Go/TS 各自的 echo-env 测试断言四个键都被剥掉、`PATH` 等保留。AGENTS.md 不变量已同步。

## 二、P3（已修）

| 项 | 处理 |
|---|---|
| `IsValidTimezone` 缓存键小写化（Linux `LoadLocation` 大小写敏感） | 按精确字符串缓存，白盒测试钉住 |
| sqlite 外部读取器 stdout 无执行中上限 | `boundedStdout` 越界即取消子进程并报 `exceeded N bytes`，POSIX 夹具测试 |
| upload backoff 计数 float→int 溢出 | LoadBackoff clamp（NaN/<0→0，>阈值→阈值）+ 测试 |
| Go 丢弃越界日期只报计数 | 对齐 TS：前 10 行明细 + `%d more snapshots dropped` |
| `install-schedule --schedule-times` 不落盘 | 成功后 `mergeConfig({ scheduleTimes, updatedAt })`，三平台测试 |
| `uninstall.mjs` 守卫拒 `/root/.tokenboard` | 改为 `segments>=2 && isAbsolute` |
| `perSource` 不校验来源名 | 用 `usageSources` 镜像拒绝未知来源 |
| `shadow-dual-run --hook` 静默丢弃 `--until` | 新增 `validateDualRunFlags`，非法组合退出 1；每条记录带 `mode` |
| notify dispatch worker 致命错误完全静默 | 新增 `notify-worker-errors.log`（0600，脱敏，保留末 64 KiB）；`status.mjs` 展示最近 5 条 |
| selfupdate 无降级保护 | feed 低于本地版本时拒绝安装并提示，`--tag` 显式降级仍可用 |
| TS 引导下载不钉重定向主机 | `redirect: 'manual'` 逐跳钉 host（GitHub release CDN 白名单），越界拒绝 |
| 两处锁/日志写入未显式 0600 | `notify.mjs` tail-lock、`hooks.mjs` handler 日志与 notify.signal |
| `scheduled-sync-state.json` 持久化未脱敏 errorMessage | 写入前 `redactUrlCredentials` |
| TS `upload-backoff.summarize` 不脱敏 URL | 新增 `redactUrls`，两侧行为对齐 |
| opencode `readSinceDate` 死参数 | 删除 |
| `bounded-session-scan` 注释与 readline 实际行为不符 | 修正注释 |
| `session-file-walk` 先 readdir 再判长度 | 改 `opendir` 流式计数，超限即停 |
| collector 重测试默认 5s 超时 | `vitest.config.ts` 套件级 `testTimeout: 30_000` |
| 同尺寸原位重写测试依赖亚毫秒 mtime | Go/TS 两侧显式推前 mtime（Linux ext4 粒度 1ms 实测），`-count=5` 稳定 |
| CI `release.needs` 漏 `skill-windows` | 补齐 |
| CI paths 漏 `packages/collector/bin/**`、`vitest.config.ts` | 补齐 |
| CI 注释称 heavy 测试都有显式 timeout | 已随 `testTimeout` 变为事实 |
| shadow job 18 源清单是第五份硬编码 | 改为从 `usage-sources.mjs` 派生（排除 antigravity*，实测同为 18 源） |
| shadow fixtures 未覆盖险路径 | Grok `cachedReadTokens` 非 0；Pi 加 toolResult/compaction/fork/branch_summary/cacheWrite1h；DSH 加 zstd 多帧+截断尾帧+双编码文件 |
| TS 的 Windows 权限早退缺注释 | 补 ACL 说明，与 Go `perm_windows.go` 对齐 |

## 三、P3（决策后按 fail-closed 修）

### Windows 裸跑 Go 二进制时区回落 UTC
- 真机实测（Windows 10 22H2）：`time.Local.String()=="Local"`，`/etc/timezone` 不存在，同机 Node `Intl` = `Asia/Shanghai`。
- 影响：裸跑 `bin/tokenboard` 一律按 UTC 归属 usageDate，与同机 TS 分叉去重键。skill 路径恒传 `TOKENBOARD_TIMEZONE`，正常安装不受影响。
- 修复：`localTimezone()` 改返回 `(string, error)`；`fallbackTimezone(goos)` 在 Windows 上拒绝猜测并提示设置 `TOKENBOARD_TIMEZONE` 或 `--timezone`，Unix 保持 UTC（无两文件的主机本来就在 UTC）。
- **真机复验**：Windows 上裸跑 `preview` → exit 2，stderr 正是 `Cannot determine the system timezone on Windows. Set TOKENBOARD_TIMEZONE ...`；设 `TOKENBOARD_TIMEZONE=Asia/Shanghai` 后正常进入采集（exit 1 仅因该机 codex 数据存在跨源冲突诊断，与本改动无关）。

## 四、审查里「推断」项的实测定案

### `tasklist` 退出码语义（此前标"需真机探针，未覆盖"）
- Windows 10 22H2 实测：`tasklist /FI "PID eq 999999" /FO CSV /NH` → **exit 0**，stdout 是一句本地化 "没有运行的任务匹配指定标准"；存在的 PID（`4`）→ exit 0 + CSV 行。
- 结论：此前担心的"非零=unknown → 陈旧锁永不回收"**不成立**。两侧实现均以 CSV 行内容判定存活（`tasklistContainsPid`），非零才算 tasklist 自身失败——语义正确。已在 Go `liveness_windows.go` 补注释记录实测结论。

## 五、有意保留（勿重报）

- **`restoreAside` 非 EEXIST 保留副本**：`removeLockRecord` 的 link-EEXIST 分支保留 quarantine 副本，非 EEXIST 的错误也保留；TS 的 `.cleanup` 守卫未移植属既定取舍（Go 侧以 `removeLockRecord` 的字节比对 + 唯一 quarantine 名替代），2026-10-15 记为 P3 论证项。
- **statusline 二次 taskkill 失败的后代残留**：`taskkill /T` 只在根存活时向下遍历；根已退出时孙进程无法追踪，且 job object 对 Node child_process 不可用。已在 `antigravity-statusline-original.mjs` 补注释说明有界暴露。
- **`-free`/`:free` 零价键**（A2）：master 与本分支完全相同，属 ccusage 折叠语义的 Known limitation，`docs/model-pricing.md` 有记录。
- **GUI/IDE Antigravity language-server 端到端**：需真实语言服务器，CI 也不覆盖；本轮未变。

## 六、验证口径

- Go：`gofmt -l` 干净、`go vet ./...`、`go test ./... -race` 全绿、`GOOS=windows{amd64,arm64}` build+vet 通过。
- TS：`pnpm -r test`（usage-core 40 / collector 1266+3skip / web 1055）、`pnpm -r typecheck`、`pnpm format:check` 全过。
- skill：`node --test skills/tokenboard/scripts/*.test.mjs` **872 全过**（本轮新增 `child-env.test.mjs` 3 条）。
- 真机：Windows 探针见第三、四节；`status.mjs` 本机实跑正常。
- 真实性核验：`child-env` 的 spawn 测试做了 red→green 复验（临时移除 `env:` 行 → 失败 → 恢复 → 通过）。

## 七、CI Windows 失败与修复（2026-10-30 补记）

### 现象
`Go client / Test (windows-latest)` 在 PR #26 上是红的，报三个测试失败：
- `TestAFlagWithAValueIsAdoptedOverTheEnvironment`、`TestSinceEnvironmentChainUsesOrdinaryFallback`、`TestUnsetSourceTakesTheDefault`
- 失败信息：`parseArgs: Cannot determine the system timezone on Windows. Set TOKENBOARD_TIMEZONE ...`

### 根因
是本轮 `localTimezone()` fail-closed 改动（第三节）的连带影响：这三个测试只验证 source/since/flag 的解析优先级，却调用 `parseArgs` 走完整参数解析，在 Windows CI 上没有可用时区 → 被新 gate 拦下。**产品逻辑正确，测试夹具需要显式提供时区**（skill 真实路径恒传 `TOKENBOARD_TIMEZONE`）。

### 修复
`4f737cd`：三个测试补 `TOKENBOARD_TIMEZONE=UTC`（onboarding 与真实调度器一致），并注释说明为什么不在这里测时区 gate（它有自己的测试 `TestFallbackTimezoneFailsClosedOnWindows`）。

### 验证
- Windows 真机（`172.16.84.251`，仓库 `C:\Users\QDM\.tokenboard\TokenBoard` @ `4f737cd`）：`go test ./internal/cli/` → ok 3.044s
- CI run 41031925282（commit `4f737cd`）：**success**（全部 job 绿，含 windows-latest）

### 三平台基线（本轮结束时实测）
| 项 | macOS 本机 | Linux 172.16.81.190 | Windows 172.16.84.251 |
|---|---|---|---|
| skill 套件 | 872/872 | 872/872（node 24.22.1） | 863 pass / 9 skip / 0 fail（便携 node 24.22.1） |
| Go 全量 `go test ./...` | 待跑（本机改动后已跑，见第六节） | 全绿（`-race` 同） | cli 包 ok（真机） |

测试机运维注记：Linux 原 node 24.21.0 低于项目下限，已在 `~/.nvm/versions/node/v24.22.1` 安装合规版本（此前 6 个 setup 类失败均为此造成，非代码缺陷）；Windows 便携 node 24.22.1 解压在 `C:\Users\QDM\tools\node-v24.22.1-win-x64`。

## 八、全维度 agent 审查第二轮（2026-10-31，12 个 agent，三平台）

崩溃后全部 agent 以 transcript resume 复跑完成。覆盖：skill 全链路、Go 客户端、TS collector+usage-core、安全隐私、服务端+线上私人 CF、TS↔Go 一致性+跨平台、来源枚举四处副本、退出码与 hook 模式、通知与 cron、模型定价、公共面与前端。**0 P0/P1；确认 P2 8 项全部已修（各带红→绿测试）；P3 修复 6 项，其余记录在案。**

### 本轮已修（P2）

| # | 缺陷 | 证据 | 修复 |
|---|---|---|---|
| 1 | `HEAD /api/public/model-pricing` 绕过 IP 限流直达 D1 | `server.ts:63` 只放行 GET；Hono `hono-base.js:263` 把 HEAD 按 GET 派发；路由内无限流。测试先红（HEAD 得 200 而非 429） | 入口接受 GET+HEAD；HEAD 响应在 `fetch` 末尾剥 body（RFC 9110 §9.3.2），新增 2 条测试 |
| 2 | 一行损坏 `schedule_weekdays` 拖垮全体用户日报 | `normalize.ts:33` 直调会抛错的 `normalizeScheduleWeekdays`，且 `listDueWebhookSubscriptions` 的 `.map` 在 per-subscription try/catch 之外；修复前测试红（stack 指向 time.ts:55） | 改走带 try/catch 的 `normalizeSettingsScheduleWeekdays`，新增 cron 路径 weekday 降级测试 |
| 3 | 匿名 `/reports/daily/:id` 无限流，随机合法 id 即一次 D1 读 | 路由无 `enforceRateLimit`，`app/routes` 无 `_middleware` | 新增 `publicReportRead` 120/60s，格式校验之后、D1 读之前；新增 429 测试 |
| 4 | Go `ccusage --version` 探测继承完整环境（凭据外传给第三方二进制） | `acquire.go` 无 `cmd.Env`；同一二进制正式路径已剥 | `cmd.Env = scrubCredentialEnv(nil)`；红绿复验（移除修复→子进程抓到 token） |
| 5 | skill `readVersion`/`runsVersion` 同类泄漏 | `client-binary.mjs` 两个 spawn 无 env | 传 `scrubbedChildEnv()` |
| 6 | Go `selfupdate.verifyExecutable` 探测暂存二进制继承环境 | `selfupdate.go` 无 `cmd.Env`；注释自陈 "probed before it is trusted" | `ccusage.ScrubCredentialEnv(os.Environ())`（名单由 selfupdate 与 ccusage 共用一份）；真实下载链路测试断言暂存二进制抓不到任何凭据 |
| 7 | Go `sessionfile` 不剥行首 UTF-8 BOM | TS 每行 `new TextDecoder` 会剥；Go 直接 yield，首行 `\uFEFF{...}` 被 JSON 拒绝静默丢行 | `line_reader.go` 剥 BOM + 测试（红绿复验） |
| 8 | Go `sessionscan`/`sessionusage`（Pi/Grok/DSH 唯一入口）同病 | Go `TrimSpace` 不删 U+FEFF；TS `line.trim()` 会删 | `ParseJSONLine` 剥 BOM + 测试 |

### 本轮已修（P3）

- **`tasklistContainsPid` 子串匹配会命中 Session# 列**（`tasklist /FI "PID eq 1"` 把会话 1 的进程当 pid 1 → 陈旧锁永不回收）。重写为只读 CSV 第 2 字段，与 TS 锚定正则对齐；函数移入无 build-tag 的 `tasklist_csv.go`，7 条子测试三平台可跑（含带引号逗号镜像名）。
- **Go 行解析接受尾部垃圾**：`{"a":1}garbage` 在 TS 是 malformed、Go 静默入账（多算方向）。`sessionfile.readLineRecord` 与 `sessionusage.ParseJSONLine` 补二次 `Decode` 断言 `io.EOF`（照抄 codex `jsonlDecodeJSON` 的既有写法）。
- **Windows 定时任务命令行未转义 `%`**：cmd 对 batch 每一行做 `%` 展开，`C:\Tools\100%node\node.exe` 会被吃掉 `%` 指向不存在的文件。`nodePath`/`scriptPath` 过 `escapeWindowsCmdValue`；真机行为已由 Windows 探针记录（`echo [100%node]` → `[100node]`）。
- **TS hook 模式缺本地 ccusage 时会 `npx` 联网下载**：违反「hook 模式不得发起网络请求」，Go 侧早已 fail-closed。`resolvePackageRunner` 增 `hookMode` 参数，两个 hook-capable provider 传入；`TOKENBOARD_FORCE_PACKAGE_RUNNER` 显式覆盖仍放行。2 条新测试。
- **`pruneDeliveryLogs` 失败会跳过该 tick 全部投递**（紧随其后的 report-history prune 有 try/catch，它没有）：包 try/catch 对齐。
- **出站 webhook 未设 `redirect: 'manual'`**：投递目标钉死三家 provider，3xx 只能是偏离开箱路径的重定向，跟随会重放用量负载与钉钉签名；对齐上传/定价的既有口径。新增断言。
- **`liveness_windows.go` 注释失实**：原注释称 Windows 身份降级「与 TS 相同」，实际 TS 用 PowerShell `Get-Process … StartTime` 实现了身份。注释改写为如实描述（Go 有意不为此每次探活起 PowerShell；后果有界：PID 复用型陈旧锁由锁自身超时回收，方向保守永不误抢活锁）。

### 记录在案（未修，含理由）

- **75 退出码产生面两侧不对称**（TS 对整个 sync body 做 transient 分类，Go 只对 upload）：错误消息撞传输层关键字时 TS 多重试。方向无害（不丢数据），对齐需动 hook/ack 路径的既有测试契约，暂不动。
- **ingest body 上限只看 content-length**：分块上传可绕过预检；后续 Zod/批大小仍 fail-closed，Workers 平台自身有请求体上限。防御纵深项。
- **`safeResponseText` 读体失败按空串处理**：2xx 后流中断时投递大概率已成功；改成失败会引入重复投递。保留现状。
- **antigravity language-server / 外部 sqlite3 子进程继承完整环境**：两侧对称、均为本机可信二进制；与 ccusage（执行第三方包）威胁模型不同。
- **Go `LocalTimezone()` 仍回落 UTC**：仅库级直调（shadow/测试）可触发，CLI 路径已在 parseArgs fail-closed。
- **skill 裸 `renameSync`（scheduled-sync-state/scheduled-retry/coordinator-signal）无 Windows 重试**：collector 与 Go 均有；低频写、冲突窗口小。
- **Go `costUnavailableSources` 缺 parity 测试、hook 来源集合三处手写**：守卫缺口而非现存漂移；行为断言已覆盖 5 个费用不可用来源中的 3 个。
- 其余为文档级/不可达项（`usage-details-filters` 空洞断言、`collectSingleSource` 兜底、CI shadow 前缀过滤、Windows ctime 回退、时间戳严格度差异等），详见各 agent 报告。

### 「服务端 agent 判 weekday 为误报」的澄清

该 agent 按磁盘现状读取时我已把 `normalize.ts` 改为受保护调用，故其「证伪」读的是修复后代码；修复前的红灯测试（stack 明确指向 `normalize.ts:33 → time.ts:55` 抛 `Invalid schedule weekday`）是权威证据。**该缺陷为真。**

### 本轮验证口径

- Go：`gofmt -l` 干净、`go vet ./...`、`go test ./... -count=1` 全绿；`GOOS=windows/amd64`、`GOOS=windows/arm64`、`GOOS=linux` vet+build 通过。Linux 真机（172.16.81.190）全量 `go test ./... -race` 全绿。
- TS：`pnpm -r test`（usage-core 40 / collector 1268+3skip / web 1060）、`pnpm -r typecheck`、`pnpm format:check` 全过。
- skill：`node --test skills/tokenboard/scripts/*.test.mjs` **873 全过**（新增 Windows `%` 命令行测试）。
- 全部 P2 修复先红后绿（红态均实测记录），凭据类修复以子进程回写 env 文件实证「抓不到」。
