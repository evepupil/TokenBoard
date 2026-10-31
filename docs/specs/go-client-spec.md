# TokenBoard Go 客户端（clients/go）实施规格

状态：**实施中**（2026-10-15 用户确认方向；M0 契约层与 M1 上传/锁/CLI 已实现并合入 `feat/model-pricing-maintenance`，见 §11）。上游依据：`docs/research/client-binary-zig-gui-research.md`（调研终稿）。
本 spec 是实施契约：实施过程中偏离此处必须先更新本文件。

## 0. 已批准的决策（用户拍板，不重开）

| # | 决策 | 内容 |
|---|---|---|
| D1 | 语言 | **Go**，Web 端（apps/web）留 TS 不动 |
| D2 | 仓库 | **不拆库**：Go client 长期住在 `clients/go/`，无拆仓里程碑 |
| D3 | 依赖策略 | **能用最新就用最新**：依赖跟随 latest，靠「升级门禁」（见 §5）兜底，不做长期 pin |
| D4 | 交付形态 | 单二进制，GoReleaser × 6 平台（darwin/linux/win32 × x64/arm64），免 CGO |
| D5 | ccusage | 捆绑 > 探测 > 下载（fail-closed）；ccusage 是 Rust 静态二进制（npm 平台包分发，MIT，sha512 可 pin） |
| D6 | GUI | 与 CLI 解耦另行立项，不进本 spec |
| D7 | Zig | 不采用 |
| D8 | 前置沟通 | 开工前与上游作者对齐（skill 是上游核心资产，client Go 化改变交付模式） |

## 1. 目标与非目标

**目标**
- `clients/go/` 提供 `tokenboard` 二进制，行为与现有 TS collector（`packages/collector`）等价：preview / sync / warm-hooks / hook 模式，同一 env 契约（`TOKENBOARD_*`）。
- 迁移完成后 TS collector 进入 deprecated，skill 脚本默认 spawn Go 二进制；`perSource` 开关支持逐来源回滚。
- 升级通道从 git-clone 换成 GitHub Releases + `tokenboard self-update`（rename-swap 保留回滚）。

**非目标**
- 不改服务端（Worker/API/D1 schema）；不改上传协议。
- 不替换 ccusage 的解析职责（继续 spawn 其二进制读 Claude Code/Codex 等来源）。
- 不做 GUI；不做自建定价源；不改 hook 语义（含「hook 模式禁联网」纪律）。
- 迁移期不改 TS collector 的行为语义（冻结只收 bugfix，避免影子基线移动）。

## 2. 仓库布局

```
clients/go/
  cmd/tokenboard/main.go            # 入口，极薄
  internal/
    cli/                            # preview/sync/warm-hooks/hook/self-update 子命令（cobra）
    collect/                        # 编排：source 分类、失败语义、exit 75 瞬态契约
      providers/                    # grokbuild/ deepseekharness/ pi/ opencode/
                                    # antigravitycli/ antigravity/ antigravityide/
                                    # claudecode/ codex/
      sessioncursor/                # cursor JSON v1 读写、增量读取（对应 session-cursor*.ts）
      jsonl/ sqlite/ zstd/          # 共享底层
    upload/                         # ingest/check/重试/退避 pause
    pricing/                        # 定价目录 fetch/cache/静态、ccusage override 生成
    contract/                       # UsageSnapshot + 全部 fail-closed 校验（对应 usage-core）
      contract.json                 # 由 packages/usage-core 导出的 JSON Schema（生成类型）
      goldens/                      # 金样本：TS 导出的接受/拒绝+哈希清单
    state/                          # 状态目录、renameAtomic、flock
    platform/                       # launchd/systemd/schtasks、symlink 守卫
    ccusage/                        # 捆绑/探测/下载三层获取器（见 §4）
  testdata/                         # 与 packages/collector 共用语义的 fixture（影子验证输入）
```

## 3. 硬契约（每条都要有专门测试，违反即 bug）

1. **snapshotHashPayload 字节级一致**：SHA-256 输入是键序固定、无空格的规范化 JSON。Go 侧**手工拼键序**，禁止依赖 `encoding/json` 的 map 序列化。金样本覆盖：全字段/缺字段/costUnavailable 来源/unicode 模型名。
2. **cursor JSON v1 双向兼容**：TS 写 → Go 读 → Go 写 → TS 读，内容零差异（含 sha256+mtime+size+offset+pendingUpload、codexHookProfileHash、commit 前校验、缺失文件清理）。这是 per-source 灰度的前提。
3. **usage-core 全部校验语义**：来源枚举（`usageSources`，当前 21 个，含 12 个 ccusage 工具来源）、cacheRead≤total、costUnavailable 来源 costUsd 必须 0、token/cost 上限、时区校验（嵌入 `time/tzdata`；金样本覆盖 Intl 边界，如 `Etc/GMT+5` 反号）。Intl 接受的偏移标识符（`±HH`、`±HHMM`、`±HH:MM`，时 00–23、分 00–59）由 `contract.LoadLocation` 以固定偏移支持，日期归属与 Intl 一致；ICU 缩写（如 `CST`、`EST`）依赖 CLDR 表、Go 无法复刻，仍按 `Invalid timezone` fail-closed 拒绝。**时区接受集偏差不止一种（2026-10-24 实测双向对照）**：Intl 接受而 Go 拒绝——`US/Pacific-New`、`SystemV/EST5`、`SystemV/YST9YDT`、`Canada/East-Saskatchewan`（方向安全：拒绝而非算错）；Go 接受而 Intl 拒绝——`posixrules`（tzdata 里真实存在的一个文件；方向危险：会采集成功、却因服务端用 Intl 校验而永久 400，5 次后进入 24h 上传暂停）。`local`/`factory`/`posixrules` 已列入 `goOnlyZoneNames` 显式拒绝，并有表驱动测试；新增此类名称须同时补测试与本节。
4. **env 契约不变**：`TOKENBOARD_ENDPOINT/UPLOAD_TOKEN/TIMEZONE/SOURCE/SINCE/UNTIL/HOOK_MODE/STATE_DIR/FAIL_ON_SOURCE_ERROR/CCUSAGE_CONFIG/CODEX_SYMLINK_ROOTS_JSON/…` 与 TS 逐一同名同义；`transientSyncExitCode=75` 保留。
5. **stderr 行为契约**：skill 脚本按行解析 stderr（脱敏、进度、跳过形态），Go 输出格式对齐。
6. **providers 语义陷阱清单**（平移时逐条带 fixture 测试）：Pi cacheWrite+cacheWrite1h 双档与 entry-id 去重；Grok 面值入账+cachedRead 拆 fresh；DSH 多帧 zstd+尾帧截断容忍+seq 去重；OpenCode SQL 投影+只读打开；Antigravity 原文不落盘+bounded 扫描+cursor 上限；Codex 混合模型对账+重试消息前缀耦合+symlink 策略；costUnavailable fail-closed；ccusage 工具族子命令映射（gemini-cli→`gemini`）与「空 daily 报告短路、不跑 session」两侧同口径。

**来源枚举 parity 的专项测试（2026-10-25，随 PR #25 的 12 个工具来源补齐）**：金样本只覆盖 hash payload、不覆盖来源集合，所以 `contract_test.go` 的 `TestUsageSourcesMatchUsageCore` 用硬编码的 21 项声明序列断言 `AllSources()` 的顺序与内容——两侧任何一边加来源都会先红。CI 的 `shadow` job 同步把 12 个工具源加入逐源循环：干净 HOME 下两侧都应报空 match，子命令名一旦漂移（如误传 `gemini-cli`，ccusage 会 exit 2），Go 侧整源失败而 TS 侧报空，diff 即失败。

## 4. ccusage 集成（三层，fail-closed）

优先级：**捆绑 > 探测 > 下载**。
1. **捆绑**：CI 从 npm registry 下载 `@ccusage/ccusage-<platform>-<arch>@<version>` tarball，验 `dist.integrity`（sha512），随 GoReleaser tarball 分发；安装脚本放 `<configDir>/bin/`（`TOKENBOARD_CONFIG_DIR`，缺省即 `~/.tokenboard/bin/`）。MIT 再分发需附许可声明。
2. **探测**：PATH 上已有 ccusage 可用；版本与 client 期望不符 → stderr 告警（不拒绝）。
3. **下载**：sync/preview 时检测两者皆无 → 下载期望版本到 `<configDir>/bin/`，sha512 不符即拒用。**hook 模式禁止下载**（禁联网纪律），只用已有版本否则该 source unavailable。（当前 Go/TS collector 都没有 `doctor` 子命令。）
- 版本策略（D3）：`clients/go/internal/ccusage/version.go` 记录期望版本；升级依赖时跑 §5 门禁。期望版本一般等于 TS 侧 package.json 的版本（升级同 PR 双改）。

## 5. 依赖升级门禁（D3 的兜底机制）

`clients/go/scripts/check-deps.sh`（CI 跑；已实现，金样本在 `clients/go/testdata/ccusage-golden/`）：
1. 对 ccusage：取固定 fixture 会话树，用二进制跑 `claude daily --json --breakdown` / `claude session --json`（含 `--config packages/collector/ccusage.json`，与原采集调用同形），键序规范化后与金样本 diff；shape 变化 → 退出码 1，人工审后 `--update` 重铸。版本闸门：二进制版本必须等于 TS 侧 `packages/collector/package.json` 的 pin，否则直接拒绝。旧/新双版本对照留给 CI 传入 `CCUSAGE_BIN` 两次调用。
2. 对 Go 依赖：常规 `go build`+ 全量测试即为门禁；`go.mod` 无 pin 压力，常规 dependabot/手动升级。
- JSON 输出上游无 schemaVersion、无 CHANGELOG —— 此门禁是唯一防线，不可省。

## 6. 影子验证（语义等价的保证，三层）

1. **fixture 测试平移**：TS 测试的输入文件树（JSONL/SQLite）直接复用为 Go golden 输入，期望值提取为 golden JSON；按 provider 分批。
2. **`tokenboard shadow` 命令**（已实现）：同 env 下运行 TS `preview` 与 Go 采集，两组快照按 snapshotKey（source/usageDate/timezone/model）排序规范化 diff（剔除 collectedAt——按 hash payload 比较），非空即 exit 1 输出结构化差异（`onlyInTs`/`onlyInGo`/`differing` 字段级；`liveWrite` 单列可归因于当天活写的行，不计入失败）。隔离方式：两侧各用独立的临时 `TOKENBOARD_STATE_DIR`（比 spec 原定的 `TOKENBOARD_SHADOW=1` no-op 写更直接：真实 cursor 完全不可达），preview 本身不上传；hook 模式由 `--hook` 显式给出、不从环境继承（不给就清掉 `TOKENBOARD_HOOK_MODE` 保证全量语义）。shadow **不占用真实的 `collector-run.lock`**（2026-10-21 修，`cd4c75e`）：两侧都不写 cursor，占锁保护不了任何东西，却会让整机的定时同步/hook 在锁上等 35s 后报「Timed out waiting for cursor lock」——当日 18:00 的定时同步就是这样失败的；代价是对比期间与并发 sync 同时读 session 文件，只读不冲突。需要 `TOKENBOARD_COLLECTOR_DIR` 指向 checkout（`packages/collector/src/cli.ts` 必须存在），子进程用 `node --import tsx`。CI 中全部 home/工具目录 env 指向 fixture（`XDG_DATA_HOME/CODEX_HOME/DSH_HOME/GROK_HOME/PI_CODING_AGENT_DIR/…`），不依赖真实用户数据。**CI 门禁已接入（2026-10-21）**：workflow 的 `shadow` job 先跑 `cmd/shadow-fixtures` 生成 grok-build / pi / deepseek-harness / opencode 四个文件型源的 fixture 树并导出 env，再逐个跑 `tokenboard shadow --source <s>`（claude-code / codex 另跑一次 `--hook`，覆盖生产实际使用的增量路径），任一 diff 即失败；`release` 以 `needs: [test, deps, shadow]` 为前置。antigravity 三源中 `antigravity-cli` 已进 CI（fixture 由 `scripts/antigravity-fixture.mts` 生成，两侧都按 HOME 解析 conversations 目录）；GUI 两源需要 language-server，暂不进 CI 门禁。**已知限制（2026-10-21 实测）**：两侧顺序扫描，正被写入的源（如活跃 Claude Code 会话）会在当天行上出现竞态差异——第二次扫描读到更多字节，pro-rata 成本分摊随之偏移；全量路径用 `--until <昨天>` 比较已沉降的日期即可。`--hook` 与 `--until` 互斥（两侧都以 usage error 拒绝：hook 的窗口来自 cursor 变更日期而非参数），所以 hook 路径的对比**无法排除当天**。当天行的活写竞态不再需要人工判断：`shadowReport.liveWrite` 按三条件自动归因（见 §11 M7「活写竞态根因」），只有无法归因的行才计入 `differing` 并 exit 1。本机真实数据验证：codex 近 14 天 3 条快照 match；claude-code 排除当天后 184 条快照 match（当天行的差异经确认为上述活写竞态，非语义缺陷）。
3. **生产双跑**：本机 crontab TS 上传 + Go shadow 7 天，人审无 diff 后切换。**已实现（2026-10-21）**：`node skills/tokenboard/scripts/shadow-dual-run.mjs` 逐源跑 `tokenboard shadow`，把每源一条 JSON 记录追加进 `~/.tokenboard/logs/shadow-dual-run.jsonl`，供人审。设计要点：不安装任何计划任务、不上传、不碰真实 cursor（shadow 两侧各用临时 state dir）；判定四态 `match`/`diff`/`not-installed`/`busy`——来源未安装不算失败（具名 `--source` 在两侧都是 fail-fast，错误文案直接匹配），与并发 sync 抢锁超时同样不算 diff，只有 `diff`/`error` 才 exit 1；`--until <昨天>` 只透传给 claude-code/codex（其余源不支持该参数），用于把正在写入的当天排除在比较之外；`--since` 缺省时按 `sync-options.mjs` 的 `readSince` 取与定时同步同一个 lookback 窗口（2026-10-21 修，`2ee83de`——此前文档写「默认取 config lookback」但代码根本没算，传给 collector 的是空值，collector 把空值当全量历史，于是双跑比的是几个月的数据、而生产只传 7 天）；`codexSymlinkRoots` 与 `TOKENBOARD_CCUSAGE_BIN` 按 `sync.mjs` 同口径注入，否则符号链接归档与两侧 ccusage 版本差异会造成假 diff。本机实测（2026-10-21）：claude-code 277 条 match、codex 3 条 match、grok-build 4 条、deepseek-harness 4 条，opencode/pi/antigravity-cli 为 not-installed。
- 限制（2026-10-21 更新）：影子默认覆盖全量 preview 语义；`--hook` 让两侧都改走 hook 增量路径，因此 hook 路径本身现在也能被门禁与双跑覆盖。仍未覆盖的是「真实 cursor 状态」——shadow 两侧都用全新的临时 state dir，测的是 hook 路径在冷 cursor 上的行为（首次运行会扫完整个 `--since` 回看窗口），而生产的热 cursor 增量（只有少量文件变更、窄 ccusage 窗口）仍靠单测 + 切换后小流量观察。

## 7. 灰度切换（per-source）

- config 增 `perSource: {"pi":"go","codex":"ts",...}`（缺省全 `ts`）；`sync.mjs buildSyncInvocation` 据此 spawn TS（`node --import tsx …`）或 Go 二进制；env 构造代码两端共用不复制。**已实现（2026-10-21）**：`config.mjs` 的 `readPerSource` 校验映射（`go`/`binary`→Go 二进制，`ts`/`git`→checkout，未知值 fail-closed），`resolveClientForSource` 决定每次调用的客户端——具名 source 用自身条目，未映射的 source 沿用机器级 `clientType`；`perSource` 进入 profile-scoped 键集，`status.mjs` 原样输出。
- **已知限制**：`--source all` 一次只跑一个客户端（TS collector 无"只采集这些 source"的参数，Go 侧也未扩展子集契约）。映射与 `clientType` 不一致时 `all` 运行 fail-closed 报错，提示逐 source 同步或统一映射；不会静默用单一客户端采集全部。
- 回滚 = 字段改回 `ts`（具名 source 的运行即时生效；`all` 运行要求映射与 `clientType` 一致）。**未通过 §3.2 双向兼容测试的 source 不许切**。
- 全部 source 走 Go 且稳定 2 周 → 默认值翻转为 `go`，TS collector 标记 deprecated。

## 8. 升级通道

- GoReleaser：6 平台 tarball（3 OS × 2 arch）+ checksums.txt；`tokenboard self-update`：查 Releases → 比较 → 下载 → 验 checksum → rename-swap（新版先 `.new` 落地、`--version` 验证后替换、旧版留 backup）。
- 定时升级路径改调 `self-update --scheduled`，**解耦 git 工作树状态**（消解「安装目录=开发仓库→脏树→升级永久跳过」死结）。
- 现存 git-clone 用户：upgrade.mjs 迁移分支——装二进制 + `config.clientType:'binary'`，不删旧 checkout；`clientType` 缺省 `'git'` 保持兼容。
- 包管理器（brew/scoop/winget）：二期，检测到包管理器安装时 self-update 提示改用之，避免双头更新。

## 9. 里程碑（出口可验证）

| 阶段 | 内容 | 人日 | 出口 |
|---|---|---|---|
| M0 | 骨架 + 契约层（JSON Schema 生成、金样本、cursor 双向兼容） | 5–6 | §3.1/3.2 测试全绿 |
| M1 | upload/编排/state/锁 | 5 | fixture sync dry-run 与 TS 对照一致 |
| M2 | grok/dsh/pi/opencode + zstd 分帧 | 7 | 影子 diff=0（该批） |
| M3 | antigravity 三源 + 不落盘专项 | 10 | 同上 |
| M4 | claude-code + ccusage 集成层 | 7 | hook 离线行为验证 |
| M5 | codex 全家（context-pricing 对账最大项） | 12–14 | codex 影子 diff=0 |
| M6 | GoReleaser/self-update/skill 改造 | 6 | 干净机 install→sync→self-update 端到端 ✅（本机 stub 发布端点跑通，见 §9 末） |
| M7 | per-source 灰度 + 双跑 + 切换 | 6–7 | 全 source 走 Go，TS deprecated |

合计 ~10–11 周单人；providers 批次可并行压缩。**每批出口标准统一：Go 测试数 ≥ 对应 TS 测试数、影子 diff=0、该批 per-source 切换可用。**

## 10. 风险与缓解（top5，完整 11 项见调研报告）

1. codex 对账语义走样（高×高）→ M5 单列、逐测试平移、禁止「Go 里更好写」式语义优化
2. cursor 兼容破坏→全量重扫/漏传（中×高）→ M0 双向契约测试 + 真实数据双读验证后才许切
3. snapshotHash 漂移→check 去重失效烧 D1 配额（中×高）→ 手工拼键序 + 字节级金样本
4. 迁移期 TS 变更→影子基线移动（高×中）→ **迁移期 TS collector 冻结只收 bugfix**（硬纪律）
5. modernc/sqlite 行为差异（中×中）→ SQL 输出对照测试；硬伤再评估分平台 CGO

## 11. 当前状态与下一步

- [x] 调研完成（见 research 报告）；ccusage 已升 20.0.33（2cc5249，PR #24）
- [ ] **前置：与上游作者对齐（D8）** —— 开工条件。**事实状态：被绕过，未完成**。实施在未对齐的情况下完成了 M0–M6（PR #24 自 2026-10-04 起挂在上游未合并）。D8 的风险（skill 是上游核心资产，Go 化改变交付模式）因此仍未消解，只是推迟到合并时面对。这不是可自行推进的项：只能由上游作者回应。

**M4 状态（claude-code + ccusage 集成层）**：

- [x] `internal/ccusage`：`Resolve` 三层获取（`TOKENBOARD_CCUSAGE_BIN` → `~/.tokenboard/bin/ccusage` → PATH 探测 → npm 下载 + sha512 完整性校验），**hook 模式在下载层之前返回错误**（不联网）；`RunJSON` 命令层（超时具名、瞬态重试、Windows `.cmd`/`.bat` shell 引号与元字符拒绝、128MiB 输出上限）；`PackageRunner`（bunx/npm exec/pnpm dlx/npx，`--config` 拼接）；`NormalizeCcusageDailyJSON`（ordered record 保序、pro-rata 成本分摊、session 计数按报告时区、codex 总量重算）。
- [x] `internal/pricing`：模型定价目录（网络分页 + 游标环检测、24h 缓存 + ETag/304、陈旧缓存与 bundled 静态回退、hook 模式离线）、动态 ccusage 配置生成与显式配置优先级、context tier 校验。
- [x] `internal/collect/providers/claudecode`：range 与 hook 两条路径；hook 走 `sessioncursor.CollectHookIncremental` + 窄窗口 reconcile + 对账断言；`TOKENBOARD_FORCE_PACKAGE_RUNNER` 跳过二进制获取；非 hook 获取失败回退 package runner（保留 TS 无捆绑二进制的行为），hook 模式 fail-closed。
- [x] CLI 接线：`warmHookCursors`（仅无界非 hook 的 claude-code 预热高水位）、`pricingDiagnosticSink`（未定价模型按 provider 聚合，20 个上限）、`acknowledgeUploadCursors` 补上 `shouldAckCursor` 的非 Antigravity 分支（hook 模式按已上传分组清 `pendingUpload`，range 模式不动）。
- 已修复的移植缺陷（有测试钉住）：
  - `sessioncursor` 的 `ReadLines` 闭包原本删除 `scanState.unreadChangedFiles`，而 `ScanResult` 的副本在扫描结束时已拷好，导致 `Commit` 永远拒绝（「cannot commit before all changed files are read」）；改为直接写 `result`，与 TS `readChangedSessionJsonlLines` 一致。
  - cursor 条目校验曾强制 `sha256` 为 64 位 hex，而内容哈希早已切到 blake2b512（128 hex），Go 读不回自己写的 cursor；改为只要求字符串，与 TS `isValidCursorEntry` 一致。
  - `NormalizeCcusageDailyJSON` 曾把 daily 输入当 sessions 传，session 计数全错；stub 传入的普通 map 也未转 ordered record。
  - `parseJSDate` 不支持 ccusage 的显示日期（`Apr 28, 2026`），TS 的 `Date.parse(value + ' UTC')` 支持。
  - `internal/pricing` 曾用 RE2 不支持的前瞻正则做 model ID 校验，包初始化即 panic；改为等价函数。
- 与 TS 的已知边界：
  - Go 侧捆绑二进制是 spec §4 的第一层，TS 没有；非 hook 获取失败仍回退 package runner 以保持 skill 安装兼容。
  - bundled 静态配置在 Go 侧是嵌入文件，运行时落盘到 `<stateDir>/ccusage.bundled.json`；TS 从 checkout 读 `ccusage.json`。
  - Windows 的 dev/ino 由 `identity_windows.go` 给出平台回退，不与 Node 的 stat 逐位对齐。
  - **sync stdout 的 `timings` 键名不同**：TS 记录 `cursorScan`/`ccusageDaily`/`ccusageSession`/`upload`/`cursorAck`，Go 的 provider 把扫描与 ccusage 合并成一次采集，只能诚实归因 `collect`/`upload`/`cursorAck`（`internal/cli` 的 `elapsedMillis`）。skill 的 `parseSyncTimings` 接受任意合法键名，run record 只会少掉更细的拆分，不会丢整块计时。
  - **cursor 锁的心跳失败被静默忽略**：TS `withCursorLock` 在回调成功时把心跳失败抛给调用方；Go 的 `refreshMtime` 只在锁仍属于自己时刷新，失败即放弃（见 `internal/state` 注释）。后果是锁被 stale sweep 抢走后，Go 不会在写入前断言所有权（TS 有 `assertCursorWriteOwnership`）。心跳每 5s、stale 窗口 30s，触发需要连续 6 次 Chtimes 失败，属已知、可接受的偏差。
- M4 出口（hook 离线行为）：`TestHookModeNeverDownloadsCcusage`（无二进制时 hook 失败且 runner 不运行）、`TestResolveHookModeFailsClosedWithoutABinary`、`TestResolvePrefersTheBundledBinaryOverPATH`、`TestDownloadVerifiesIntegrityAndInstallsTheBinary` 覆盖获取层；`TestHookModeUsesChangedFilesToNarrowReconciliation` 等 6 条覆盖 hook 对账语义。
- **M4 影子 diff 口径（2026-10-17 实测，commit 92b6493）**：同一 Claude home fixture（两个模型、cache 读写、跨小时），`TOKENBOARD_CCUSAGE_BIN` 指向 `packages/collector/node_modules/.bin/ccusage`（20.0.33），分别跑 TS `tsx src/cli.ts preview --source claude-code` 与 Go `tokenboard preview --source claude-code`：
  - range 模式：snapshot 数组除 `collectedAt`（墙钟）外逐字段、逐序一致；未定价诊断行一致。
  - hook 模式：snapshot 一致；写出的 `claude-code-cursor.json` 除 `updatedAt` 外逐字段一致，包括 blake2b512 内容哈希（128 hex）、`endsWithNewline`、`pendingUpload`、`missingCost` 与 `lastScanHighWaterMs`（同一浮点值）。
  - hook 离线：`env -i`（PATH 无 ccusage）下 `sync --source claude-code` 报 `ccusage is not installed and hook mode does not download it`、退出码 1、不写 cursor、不联网。

**M5 状态（codex 全家，进行中）**：

- [x] 叶子层（a61dbb0、660f116）：`internal/codexusage`（legacy cached-input-folded 与 additive 两种 token 口径）、`codex/homes.go`（显式 > `TOKENBOARD_CODEX_HOMES_JSON` > legacy `CODEX_HOME` 逗号列表 + 歧义守卫）、`command_options.go`（恒 `--offline`）、`cost_projection.go`（1,000,000 定点、最大余数、按模型名破平）、`subagent_math.go`。
- [x] `attribution_cache.go` + `jsonl_reader.go`（660f116）：有界 JSONL 读取与投影校验、attribution cache（私有 0700、指纹竞态、legacy 无 dev/ino 不匹配、超限丢弃重建）。
- [x] `session_scope.go` + `session_cloner.go`（660f116）：k 路归并按相对路径合并、bounded scope、冻结副本与投影文件两种来源；Go 无 clone 原语，回退为 O_EXCL + `io.CopyBuffer` 并保留 TS 文案。
- [x] `context_pricing.go`（660f116）：规则编译、usage 提取、动态定价目录选择、指纹 memo；测试镜像 TS 的 83 条 + 7 条 table。
- [x] `hook_profiles.go`（660f116）：per-home profile cursor（`codex-cursor.profile-<sha256(home)>.json`）、legacy cursor 迁移（按 `contentHashAlgo` 分派摘要、活动路径优先于 `archived_sessions`、已持久化条目免读源文件）、`mergeCodexHookIncrementals` 的 pending 去重/对账剔除/reusable 子集。
- [x] CLI 接线（660f116、1701f94）：`warmHookCursors` 的 Codex 分支按 `ResolveHookCursorPlan` 预热每个 profile cursor；Codex hook 上传后按「文件 × cursor scope」确认（`(relativePath, sha256)` 精确匹配，清 `pendingUpload` 与 `codexContextPricingPending`），与按日分组的确认互斥；`collect.Options.HookAcknowledgement` 承接 TS 侧挂在 snapshot 上的 acknowledgement 元数据。
- [x] context pricing cursor 标记（660f116）：`sessioncursor.ContextPricingMarker` 由 codex 包 `init` 安装，`UpdateCursorFile` 对 codex 源恒调用，缺标记即报错（不静默丢 pending 修正标记）。
- 已修复的移植缺陷（有测试钉住）：
  - `sessionfile.FingerprintFile` 在新增「按算法分派」的指纹后一度把空算法映射到 legacy sha256，而扫描侧恒用当前算法，导致所有 session 读回都报 `Session file changed while reading`；`FingerprintFile` 固定传当前算法，空算法只在**记录值**分派时代表 legacy。
  - `hook_profiles` 的 legacy 迁移曾用「是否为普通文件」挑选活动/归档路径，而 TS 是「活动路径存在即优先」（符号链接/目录随后由内容比对拒绝）；按普通文件探测会让过期归档副本覆盖更新的活动会话。
  - `matchesLegacySessionContent` 必须复刻 TS 的三次 stat 一致性校验（lstat → open+stat → lstat → 读 → stat → lstat），否则文件在读取中被替换时不会 fail-closed。
- [x] subagent usage 链：`subagent_usage_child/json/cache/worker_pool/usage.go`（继承累积量扣除、跨 profile 事件去重、FIFO 缓存与指纹失效、worker pool 与 panic 拒绝、oversized 行诊断合并）。
- [x] `codex.ts` provider 编排：`provider.go`（hook / scoped / bounded / unbounded 四条路径 + 各自的单次重试矩阵 + 部分成功的 session 计数降级）+ `provider_scope.go`（session 行解析、canonical attribution 替换、scope 源稳定性断言）。
- [x] 注册：`providers.go` 引入 codex 包（`register.go` 把 `collect.Options` 适配到 `codex.Options`），`preview/sync/warm-hooks --source codex` 可用。
- 影子 diff 抓到的移植缺陷（已修，均有回归测试）：
  - **ccusage 调用漏 `--config`**：provider 直接调 `PackageRunner.RunPackageArgs`，而 TS 把 `appendCcusageConfig` 拼在 `runPackageArgs` 内部，Go 的 config 拼接在 `PackageRunner.Args` 上。结果每次 codex 调用都退回 ccusage 内置价目表，混合模型日 `deepseek-v4-flash` 成本 0.003609（Go）vs 0.005091（TS）。改为统一走 `runnerArgs`。
  - **子进程环境只传 6 个 key**：TS 传 `{ ...process.env, CODEX_HOME }`，Go 的 `environOf` 只物化 6 个变量，`npx` shim 找不到 `node`（`exit status 127`）。改为「继承进程环境 + 覆盖 codex 相关键且空值即清除」。
  - **`NormalizeSubagentSessions` 只认 `map[string]any`**：真实 runner 解码出的是 `*ccusage.orderedRecord`，投影后 `extractSubagentRows` 恒返回 0 行，subagent 修正在生产路径**从未生效**（`codex-subagent-usage-cache.json` 一直是空 `entries`），而所有 map 型 stub 单测全绿。修法：`ccusage` 导出 `OrderedObject`/`RecordWith`/`DecodeOrderedJSON`，投影与行标记都按有序对象处理（键序即文档序，多模型分摊余数依赖它）。
  - **`tagSessionRow` 丢 home 标记**：同一根因——多 profile 行打不上 `__tokenboardCodexHomeIndex`，`rowHomeIndex` 恒 -1，重复相对路径时会跨 home 误解析。
- [x] **M5 codex 影子 diff（2026-10-18，diff=0）**：自建 codex home fixture（`sessions/` 两日两会话、cached input、一个 `turn_context` 从 deepseek-v4-flash 切到 gpt-5.6-sol 的混合模型会话、一个带 `payload.source.subagent` 的子会话、一个 `archived_sessions/` 归档会话），`TOKENBOARD_CCUSAGE_BIN` 指向 `packages/collector/node_modules/.bin/ccusage`（20.0.33），两侧各自独立 `TOKENBOARD_STATE_DIR`，比较时剔除 `collectedAt`：
  - `--since all`、默认窗口、`--since 20260616`、`--until 2026-10-16`、`--since … --until …`：snapshot 逐字段一致（含 `sessionCount`，`costUsd` 逐位相等）。
  - 多 profile（`TOKENBOARD_CODEX_HOMES_JSON` 两个 home，其中一份含同名相对路径）：一致。
  - `archived_sessions` 为符号链接：无 allowlist 时两侧同一 fail-closed 文案与退出码；`TOKENBOARD_CODEX_SYMLINK_ROOTS_JSON` 放行后一致。
  - hook 模式：以 TS 写出的 cursor 作 seed，第二轮增量 snapshot 一致，`codex-cursor.json` / attribution cache / subagent cache 除 `updatedAt` 外逐字段一致；第三、四轮（无变化）输出一致。`warm-hooks --source codex` 的 cursor 除 `lastScanHighWaterMs`/`updatedAt` 外一致。
  - 已知差异（不影响 snapshot）：Go 无 clone 原语，多打一行 `Codex copy-on-write clone is unavailable; using a bounded standard file copy` 诊断；cursor/attribution JSON 的对象键序不同（TS 固定顺序，Go 按 map 排序），逐字段一致。
- [x] M5 出口验收：`internal/collect/providers/codex` 共 379 条 Go 测试（TS codex 全家 356 条，逐文件 1:1 平移：context-pricing 90、subagent-json 28→`jsonl_reader_test.go`、codex 36、subagent-usage 31、session-scope/bounds/race 53、multi-profile-hook 26、scoped-scan 13、attribution-cache 15、session-cloner 9、subagent-cache 9、symlink/homes 13、bounded-retry+attribution-batches 7、hook-race+scoped-reconciliation 6、worker-pool 5、cost-projection/math 15）；`gofmt -l .` 干净、`go vet ./...` 通过、`go test ./...` 与 `-race`（codex/ccusage/cli）全绿、`GOOS=windows|linux go build ./...` 通过。
- 与 TS 的已知边界：
  - `codexFileStat.ctimeMs` 由反射取平台字段（Linux `Ctim`、Darwin `Ctimespec`、Windows 无），Windows 上退化为 mtime，change detection 弱于 Node。
  - Go 侧 context pricing 的规则来源是 `DefaultRules()` + 动态目录，与 TS 的内联常量表同源但表体由 `BuildCodexContextPricingRules` 生成，影子 diff 已逐模型核对（`gpt-5.6-sol` 重定价两侧一致）。

**ccusage 工具族移植（2026-10-25，关闭 PR #25 合并后的 parity 缺口）**：

- 背景：上游 PR #25 把 12 个 ccusage 工具来源（amp、droid、codebuff、hermes、goose、kilo、copilot、gemini-cli、kimi、qwen、openclaw、zcode）加进了 TS 侧，Go 契约层仍停在 9 个来源——`--source amp` 报 `Invalid source`，`--source all` 静默漏采这 12 个（不在 `AllSources()` 里，连 skip 提示都没有）。spec §1 的等价性要求因此被破坏，而金样本生成器只覆盖 hash payload，CI 钉不住。
- 契约层：`contract` 新增 12 个 `Source` 常量、`usageSources` 集合、`ccusageToolCommandNames` 映射、`CcusageToolCommand`/`CcusageToolSources`，并把 `allSources` 扩到 21 项（顺序与 usage-core 的 `usageSources` 逐位一致）。`TestUsageSourcesMatchUsageCore` 硬编码同一份 21 项序列，两侧任一改动先红。
- Provider：`internal/collect/providers/ccusagetool` 单个参数化实现服务 12 个来源，`init()` 逐个 `collect.Register`。行为对齐 TS：`<tool> daily --json` → `<tool> session --json`，`gemini-cli` 走 `gemini` 子命令，空 daily 报告直接返回空结果、不发起 session 调用；不做动态定价 prepare（TS 同样不做），ambient `TOKENBOARD_CCUSAGE_CONFIG` 仍经 package runner 传给 ccusage。
- 共享层：`sessionusage.AssertValidDateFilterRange` 从 claudecode 的私有实现上提，claudecode 与 ccusagetool 共用一份；`ccusage.HasDailyRows` 是 `hasDailyRows` 的移植，刻意比 normalize 的行提取严格（只认 `daily` 数组），否则「工具未安装」会退化成多跑一次 session。
- 验证：`ccusagetool_test.go` 9 条覆盖 TS 的 7 条用例（参数向量、gemini 映射、since/until 透传、空报告短路、非工具源拒绝）外加反向窗口拒绝与「12 个来源都已注册」；`go test ./... -race` 全绿，`GOOS=windows go vet ./...` 干净。CI `shadow` job 与 `shadow-dual-run.mjs` 的源列表都补上这 12 个。
- 证据边界：本机未安装这 12 个工具，双跑只能得到 `empty`（两侧一致的空结果）——它能抓住子命令名漂移，但**不构成有数据的等价性验证**。真实数据验证要等某台机器装了其中之一。

**M6 状态（GoReleaser / self-update / skill 改造，2026-10-18）**：

> **发版暂停（2026-10-23）**：发布通道已跑通，但客户端开发测试未完成，`v0.1.0` 已转为 draft、本机已回滚 `git`。详见「未覆盖边界」下第一条。

- [x] `internal/release`：发布通道的读侧。**不碰 api.github.com**——该端点对匿名调用按 IP 限流 60 次/小时，同一 NAT 后的多台机器共用一个额度，定时自更新会随机失败。改为走 `/releases/latest` 的 302 跳转解析 tag（最多 5 跳，超限即报循环；相对 Location 按当前 URL 解析），再按 `releases/download/<tag>/<asset>` 拼下载 URL，两者与普通资产下载同一 CDN、无配额。`Repo` 校验 owner/repo；`Platform` 只接受构建矩阵的六组（`darwin|linux|windows` × `amd64|arm64`；D4 原先写「5 平台」，已订正为 3×2=6）；`Checksums` 对畸形行 fail-closed（不是跳过）；`Verify` 要求 manifest 含该资产名（未列出即拒绝安装）。
- [x] `internal/selfupdate`：`self-update` 的写侧。顺序固定为 解析 → 下载 archive+checksums → 验 checksum → 解包 → 写 `<dir>/tokenboard.new` → 执行 `version` 验证 → rename 换入（旧版留 `.backup-<UTC>`）。先替换后验证会让机器上的 collector 彻底跑不起来，而「负责升级的东西」正是它自己，定时任务永远修不回来，所以验证必须在 swap 之前。`verifyExecutable` 按**整 token** 匹配版本号（`1.2.30` 不含 `1.2.3`），避免把截断下载当成合格版本。scheduled 路径失败时 CLI 返回 0（离线是正常状态，调度器无法处置升级失败）。
- [x] `.goreleaser.yaml`：6 平台 tarball（3 OS × 2 arch；Windows 也强制 tar.gz，因为 `extractBinary` 只读 gzip tar）+ `checksums.txt` + `-ldflags` 注入 `internal/cli.Version`。已用真实 GoReleaser v2.12.7 跑 `check` 与 `release --snapshot` 验证：产物名恰为 `tokenboard_<os>_<arch>.tar.gz`、`checksums.txt`、包内可执行文件名为 `tokenboard`，与 `release.Platform()`/`ArchiveName()`/`ChecksumsName()`/`binaryFileName()` 逐项对齐。
- [x] skill 二进制客户端（`clientType`，缺省 `'git'`）：
  - `scripts/client-binary.mjs`：**仅用于首次引导**（此时还没有二进制可以执行 `self-update`）。它实现与 `internal/release` 同口径的三条规则（跳转解析、无 checksums 即拒、`version` 验证后换入），解包用平台自带 `tar`（与 archive fallback 用 `unzip` 同思路）。
  - `config.mjs` 增 `readClientType`（flag > `TOKENBOARD_CLIENT` > `clientType` > `'git'`），未知值报错而非静默按 git 跑；`clientType` 进入 profile-scoped 键集。
  - `sync.mjs`：`buildSyncInvocation` 在 `binary` 下 spawn `~/.tokenboard/bin/tokenboard <preview|sync|warm-hooks> --source …`，env 契约与 git 客户端共用同一份构造（`sharedEnv`），只少一个 `TOKENBOARD_CCUSAGE_CONFIG`（Go 侧自行 materialize baseline）。升级入口抽成 `runPreCollectUpgrade`：binary 走 `self-update`（hook 模式不升级），git 保持原 checkout 升级，两者失败都只告警不中断采集。
  - `install-collector.mjs --client binary` / `setup.mjs --client git|binary`：干净机安装直接装二进制，不 clone。
  - `upgrade.mjs --to-binary`：迁移分支——装二进制 + 写 `clientType: 'binary'`，**不删旧 checkout**（改回 `'git'` 即回滚）；安装失败时不改配置（否则下次 sync 会去 spawn 一个不存在的二进制）。
  - `status.mjs` 输出 `clientType`。
- 端到端实测（2026-10-18，本机 darwin/amd64，本地 stub 发布端点）：GoReleaser 快照产物 → `installClientBinary` 引导安装 → `tokenboard version` 报 `0.0.0-SNAPSHOT-cfe61a0` → 自更新到 9.9.9（校验通过、`.backup-…` 保留旧版、再次运行为 no-op）→ `sync.mjs --mode preview` 以 binary 客户端跑通（同一 grok fixture 下与 TS 侧 `--since all` 均 1 条 snapshot）。顺带修掉一个只在真实路径暴露的缺陷：binary 分支曾把 `cwd` 设成不存在的 collector checkout，spawn 报 `ENOENT` 并被读成「客户端未安装」。
- 2026-10-19 收尾修复（`34d5371`、`ae64125`、`ebbce64`）：
  - `self-update` 的 `--tag`/`--repo` 曾解析后丢弃，现在都进 `Input`，且 flag 优先于环境变量（与 skill 的 `flags['release-repo'] || env.…` 同序）。
  - 安装时指定的发布源此前只用于那一次安装，后续自动更新回落到默认仓库。现在 `migrateToBinaryClient` 把非默认的 `releaseRepo`/`releaseBaseUrl` 写入配置，`buildSyncInvocation` 经 `sharedEnv` 传给 client，`runPreCollectUpgrade` 也把 invocation 的 env 传给 self-update spawn（此前完全没传，用了 ambient env）。`release-tag` 刻意不持久化——它只钉住一次安装。
  - `swap` 注释曾声称两次 rename 之间没有空窗，实际目标路径在该窗口缺失。注释订正；skill 侧新增 `recoverOrphanedBinary`，在目标缺失时从最新 `.backup-*` 恢复（前缀取自配置路径的 basename，与 Go 的 `backupPath` 同源）。
- 2026-10-21 发布链路预检：workflow 新增 `release-dry-run` job——`bundle-ccusage` + `goreleaser check` + `goreleaser release --snapshot --clean --skip=publish`，并断言产物契约（恰好 6 个 `tokenboard_<os>_<arch>.tar.gz` + `checksums.txt`；每个归档含 `tokenboard[.exe]`、`ccusage[.exe]`、`README.md`、`LICENSE.ccusage`；Linux 归档内二进制 `version` 必须是 `tokenboard (go) 0.0.0-SNAPSHOT-<sha>`，不是 `dev`）。`release` 以 `needs: [test, deps, shadow, release-dry-run]` 前置，首次真实 tag 不再是对该流水线的第一次执行。同一 job 末尾跑 `clients/go/scripts/e2e-self-update.mjs`：本地起 GitHub 形状的发布端点（`/releases/latest` 302 → tag 页 → 资产），用 snapshot 二进制作为「旧版」、用带 `9.9.9` 版本戳的重新构建作为发布资产，断言自更新完成换入、保留一份 backup、装上捆绑 ccusage、且第二次运行不再下载。首跑即抓到一个真实缺陷：`setup-node` 因 `package.json` 的 `packageManager` 字段默认启用 pnpm 缓存，缺少 `pnpm/action-setup` 时直接失败——`release` job 有同样形状，首次真实 tag 会以同样方式失败，两处已一并补上。
- 2026-10-20 发布链路（`.github/workflows/go-client.yml`）：
  - `test`：ubuntu/macos/windows 三平台 × `go-version-file: clients/go/go.mod`，跑 `gofmt -l`（非 Windows）、`go vet`、`go test -race`；Linux 上额外做 windows/linux/darwin arm64 交叉构建，把「3 OS × 2 arch」的另一半也纳入编译门禁。
  - `deps`：spec §5 的 ccusage 契约门禁。`pnpm install --filter @tokenboard/collector` 后跑 `clients/go/scripts/check-deps.sh`，金样本不一致即失败。本地已实测通过（`ccusage 20.0.33 output matches the goldens`）。
  - `release`：仅 `refs/tags/v*` 触发，`needs: [test, deps]`，权限 `contents: write`，GoReleaser **固定 v2.12.7** 而非 `~> v2`——archive/checksum 命名是与 `internal/release` 的契约，跨 minor 的模板变化必须是人工审视的升级。发布前先跑 `node clients/go/scripts/bundle-ccusage.mjs`（见下条）。
  - 触发条件：GitHub **不对 tag push 应用 path 过滤**（官方 workflow syntax：「Path filters are not evaluated for pushes of tags.」），所以 `push.branches + paths` 只约束分支/PR 运行，打 tag 一定会发布。
  - Windows 矩阵第一次真跑就暴露了 30 个失败（2026-10-20，commit `e2c1178`）：25 个早于 ccusage 捆绑工作——这些测试从未在 Windows 上跑过，fixture 里写死了 POSIX 假设；另 5 个来自捆绑提交。**产品代码每一条都是对的**，改的全是 fixture：捆绑 ccusage 路径用 `binaryName(runtime.GOOS)`（Windows 是 `ccusage.exe`）、codex homes 的 JSON 用 `json.Marshal` 编码（Windows 临时路径的反斜杠不是合法 JSON 转义）、home/root 期望值用 `filepath.Join`、包管理器期望值带平台后缀（`npm.cmd`/`pnpm.cmd`）、Windows shim fixture 把 argv 写文件并输出合法 JSON、`TMPDIR` fixture 补设 `TMP`/`TEMP`（`os.MkdirTemp` 在 Windows 读这两个）、可执行位断言是 POSIX 概念。
    - `selfupdate` 的 run 测试要真的执行暂存文件，而 shell 脚本 fixture 在 Windows 不是合法 Win32 程序（`%1 is not a valid Win32 application`）。为此加了一个包级 `verifyStaged` 变量作为测试替换点：Windows 换成同契约的内容检查，Unix 仍端到端跑真实的 `verifyExecutable`。
    - 5 个测试在 Windows 上按能力缺失跳过并写明原因：子进程 SIGTERM、`chmod 000` 拒访、dev/ino 文件身份（等长替换检测）、ctime 指纹。这些降级产品侧本来就有注释说明。
  - 本地复现：`goreleaser check` 通过；`goreleaser release --snapshot --clean --skip=publish` 产出 6 个 `tokenboard_<os>_<arch>.tar.gz` + `checksums.txt`，包内为 `README.md` 与 `tokenboard`，二进制 `version` 报 `tokenboard (go) 0.0.0-SNAPSHOT-<sha>`（`-ldflags` 注入生效）。
- 2026-10-20 ccusage 捆绑（spec §4 第 1 层）：
  - `clients/go/scripts/bundle-ccusage.mjs`：从 registry 取 6 个 `@ccusage/ccusage-<npm-os>-<npm-arch>@<版本>`（版本读自 `internal/ccusage/version.go`），逐个按 `dist.integrity` 的 sha512 校验后落到 `dist-ccusage/ccusage_<goos>_<goarch>/ccusage[.exe]`，另取主包 `LICENSE` 为 `dist-ccusage/LICENSE.ccusage`。npm 平台段与 Go 不同（windows→win32、amd64→x64），Windows 包内成员是 `package/bin/ccusage.exe`。
  - `.goreleaser.yaml` 用 `src: dist-ccusage/ccusage_{{ .Os }}_{{ .Arch }}/*` + `dst: .` + `strip_parent`：**`dst` 不接受模板**（实测 `ccusage{{ if … }}.exe` 被原样写成目录名），因此重命名放在 bundle 的目录布局里，归档内文件名天然就是 `ccusage` / `ccusage.exe`。
  - Go `selfupdate`：tarball 里有 ccusage 就装到 `BundledBinDir`（与 skill 引导安装同一位置），没有则跳过（旧版本发布仍可更新）。ccusage 写入失败只告警、不撤销已成功的客户端更新——探测与下载层仍覆盖该机器。
  - skill `installClientBinary`：首次引导同样安装捆绑 ccusage 到 `<configDir>/bin/` 并 `chmod 0755`；「成员缺失」的判定依赖「整个 tarball 已先过 checksums.txt」，所以 `tar` 的非零退出只可能是成员不存在。
  - 实测：bundle 后 snapshot 的 6 个归档内分别是 `ccusage`/`ccusage.exe`，`file` 报出的架构与平台一一对应，本机原生 ccusage 跑出 `ccusage 20.0.33`、`tokenboard version` 为 snapshot 版本；本地 HTTP 发布端点分别跑 `installClientBinary` 与 Go `self-update`，两者都把客户端与 ccusage 装到位并可执行。
  - 捆绑目录口径统一（2026-10-20）：`ccusage.Resolve` 原来只看写死的 `~/.tokenboard/bin`，而 skill 装到 `configDir()/bin`（`config.mjs` 的 `configDir()` = `TOKENBOARD_CONFIG_DIR || ~/.tokenboard`），`selfupdate` 则装到「客户端同级目录」——三者在设了 `TOKENBOARD_CONFIG_DIR` 的机器上互相对不上，捆绑层落空后会掉进下载层，而 hook 模式不能联网。现在 Go 侧统一走 `ccusage.BundledBinDir(env, home)`（`TOKENBOARD_CONFIG_DIR/bin`，否则 `~/.tokenboard/bin`），`selfupdate` 写同一个位置；旧安装在默认 home 下的那份仍会被找到（legacy fallback）。`TOKENBOARD_STATE_DIR` 刻意不参与：它是游标与运行锁的状态目录，skill 从不往那里装二进制。
    - 顺带修掉一个测试污染：`selfupdate` 的测试曾把 stub ccusage 写进真实 `~/.tokenboard/bin`（`BundledBinDir` 在 `CONFIG_DIR` 未设时回落到真实 home）。现在测试显式注入 `TOKENBOARD_CONFIG_DIR` 指向临时目录。
  - 同轮审查修复：
    - `bundle-ccusage.mjs` 用 `renameSync` 把临时目录里的产物移到 `dist-ccusage/`。临时目录在 `os.tmpdir()`，Linux CI 上常与 checkout 不同挂载，`rename(2)` 会 `EXDEV`；改为 `copyFileSync`。另加 `cleanOwnedOutputs`：重跑前只清理本脚本管理的路径，避免上一次失败留下的旧版本二进制被 GoReleaser 静默打包。
    - 主模块守卫改成 `realpathSync` 比较（与 `skills/tokenboard/scripts/is-main.mjs` 同口径）。原来的 ``import.meta.url === `file://${process.argv[1]}` `` 经 symlink 调用会静默不执行；实测 symlink 调用旧守卫 `matches=false`、新守卫 `matches=true`。
    - LICENSE 下载补上 `dist.integrity` 的 sha512 校验，与六个平台包同口径。
    - skill `installClientBinary` 改为**先解包 ccusage、再换入客户端**：畸形条目在机器未被改动前失败（此前会留下「已换入但安装报错」的半成品）。客户端换入后的 ccusage 写入失败只记日志、不报安装失败，与 Go `selfupdate` 一致；`install-collector.mjs` 补传 `log`，否则该警告会被默认空函数吞掉。
    - `version.go` 注释里引用的 `version_test.go` 不存在（实际校验在 `package_runner_test.go` 的 `TestPackageSpecifierMatchesCollectorPackageJSON`），已订正。
- 未覆盖边界：~~尚未打过真实 tag~~（2026-10-23 由 fork 打出 `v0.1.0`，但**已转为 draft、不对发布**，见下）、brew/scoop/winget（spec §8 列为二期）、D8（与上游作者对齐）仍未确认。
- **发版状态：暂停（2026-10-23）**——客户端开发与测试验证未完成，不发版。
  - **已执行**：`gh release edit v0.1.0 --draft` 把 v0.1.0 转为草稿。核实结果：`releases/download/v0.1.0/checksums.txt` 返回 **404**（draft 资产对外不可达），`/releases/latest` 302 → `/releases`（已无 published release），`gh api .../releases` 显示 `draft: true`。**tag `v0.1.0` 保留**（指向 `a1816f3`，含 `3aee717`）——tag 只是提交标记，草稿 release 持有它但不分发。
  - **本机已回滚**：`~/.tokenboard/config.json` 的 `clientType` 由 `binary` 改回 `git`（**必须用 `mergeConfig`**，见下条陷阱）；`resolveClientForSource` 对 claude-code / codex / all 均解析为 `git`；二进制仍留在 `~/.tokenboard/bin/` 作为再次切换的现成产物。
  - **踩到的坑（值得记）**：直接改配置文件的**根级** `clientType` 无效。本机配置有 `activeServer` + `servers` 多服务器结构，`normalizeActiveServerConfig` 会把根字段替换成 active profile 的 `profileScopedFields`，而 `clientType` 就在 profile-scoped 键集里（`config.mjs:390`）。第一次手改根字段后 `status.mjs` 仍报 `binary`，改用 `mergeConfig({ clientType: 'git' })` 才同时更新根与 profile。**回滚指令不能写成「手改 JSON」**，脚本里统一走 `mergeConfig`。
  - **无 published release 时的行为（已实测）**：`tokenboard self-update` exit 1，报 `release lookup did not land on a tag page: /MisonL/TokenBoard/releases`——**fail-closed，不会把机器误降级或误装**。而在 `sync.mjs` 里自更新失败只是 warning（`runPreCollectUpgrade` 的 catch），采集照常进行——所以即便有人留在 binary 通道，也只是每次定时同步多一行告警，不会中断上传。
  - **解除暂停的条件（缺一不可）**：
    1. 真实数据覆盖：**按 21 个来源计，当前有数据的只有 7 个**——`claude-code`（350 快照）、`codex`（4）、`grok-build`（4）、`deepseek-harness`（4）、`amp`（4）、`kimi`（2）、`zcode`（2），全部双跑 match（2026-10-25 实测，`--since all`）。另外 9 个 ccusage 工具源在本机是两侧一致的 `empty`（能证明子命令映射与「未安装→空」语义，但不是有数据的对比）；`opencode` / `pi` / `antigravity-cli` 三源目录不存在（`~/.local/share/opencode/opencode.db`、`~/.pi/agent/sessions`、`~/.gemini/antigravity-cli/conversations`）。**「9 个源里覆盖 8 个」这条原始写法的比例已失去意义**，实际口径应是「有数据的源逐个双跑 match，无数据的源明确列为 not-installed 或 empty 而不是伪装成覆盖」。
       - **2026-10-23 复核（此前把这条写宽了）**：`grok-build` / `deepseek-harness` 并非「恒 0 快照」，而是**默认 7 天窗口内无数据**：`~/.grok/sessions` 最新 `updates.jsonl` 是 2026-10-09，`~/.dsh/sessions` 最新 `session.jsonl.zstd` 是 2026-09-18。用 `--since all` 重跑后两者都拿到数据且 **match**（各 4 快照）。因此这两源在本机**是有可观测验证的**，只是必须用全历史窗口——默认窗口会静默给出「0 快照 match」这种无信息量的结果。
    2. GUI 两源（antigravity / antigravity-ide）拿到真实 language-server 数据并双跑 match；CI 不跑 language server，这是当前唯一完全没有端到端证据的路径。
    3. Windows 换入语义有真人验证。目前只有 `GOOS=windows go build` 与源码级论证（见本文件末「Windows 换入语义」条），首个 Windows 用户仍未出现。
    4. ~~03:41 的 `sessionCount` 瞬态 diff 定性~~ —— **2026-10-24 已定性**：会话首条 usage 行落在两次 `session` 扫描之间（活写竞态，非语义缺陷；见 M7 台账「定性结论」）。
    5. 观察期从「真正启用 binary」起重新起算 2 周，且期间 `shadow-dual-run.jsonl` 无未定性 `diff`。
  - **当前可交付的验证结论**：`go test ./... -race` 全绿（35 个包中 31 个有测试），语句覆盖率 **77.4%**；三 OS CI 矩阵通过；ci shadow 门禁覆盖 6 个文件型源 + claude-code/codex（含 `--hook`）+ 12 个 ccusage 工具源。这些是「代码正确性」的证据，**不等于**「产品可发布」——上面 5 条是后者。
- **上游如何接管发布（操作指引）**：前提是 PR #24（+#25）先合并进上游 master，且上游作者同意接管发布节奏——这两步都只能由上游作者本人完成。
  1. **模块路径**：`clients/go/go.mod` 是 `github.com/MisonL/TokenBoard/clients/go`，127 个文件 import 它。两个选项——(a) 保留 fork 路径（能工作，但上游发的版本内部带着 fork 模块名，只影响 `go install` / 源码引用）；(b) 一次性改名成 `github.com/evepupil/TokenBoard/clients/go`。**改名时 `.goreleaser.yaml` 的 `ldflags` 里的 `-X` 路径必须同步改**（`:36`），否则版本戳静默失效，构建出来的二进制永远报 `dev`，自更新每次都会重装同一版本。
  2. **默认发布源**：两处硬编码必须一起改——`clients/go/internal/release/release.go:29` 的 `DefaultRepo` 与 `skills/tokenboard/scripts/client-binary.mjs:30` 的 `defaultReleaseRepo`。注意测试里的耦合方式不同：Go 的 `release_test.go:172` 比较的是**常量本身**（改值不会红），但 `release_test.go:18`、`selfupdate_test.go:101` 与 `client-binary.test.mjs:63` 的 **stub 服务器把 `/MisonL/TokenBoard/...` 路径写死了**——只改常量不改这些路径，测试会以「找不到 release」的形式失败，而不是给出「默认仓库改了」的提示。
  3. **改默认值会静默迁移存量用户**：`upgrade.mjs:65` 只在 `repo !== defaultReleaseRepo` 时持久化 `releaseRepo`，默认通道用户的配置里**没有**该字段。因此把默认改到上游后，所有默认通道的 binary 客户端在下一次 self-update 时自动转向上游 feed——这正是想要的迁移，但必须确认上游 feed 已有兼容资产再改，否则这些机器会拿到 404 并每轮告警。显式设过 `releaseRepo` 的用户不受影响，需手工迁移。
  4. **打第一个上游 tag**：`git tag vX.Y.Z && git push origin vX.Y.Z`。workflow 在 `refs/tags/v*` 触发且 GitHub 不对 tag 应用 path 过滤；release job 以 `needs` 前置全部检查，任一失败只 `skipped`，不会留下半成品。
  5. **fork 上的 v0.1.0 草稿**：上游接管后应**删除**这份 draft，不要在客户端代码已经变化后再发布它——它的资产对应 `a1816f3`，与之后的代码不同步。若想把 fork 通道保留给自部署用户，则应以明确的 prerelease 标签发布，并在 README 写明「非官方通道」。
  6. **用户可自行指定 feed**：不改代码也能切换——`install-collector.mjs` / `upgrade.mjs` 接受 `--release-repo`，环境变量 `TOKENBOARD_RELEASE_REPO` 同等生效；非默认值会持久化进配置。
- **首次真实发布（2026-10-23，`v0.1.0`）**：tag 打在 `feat/model-pricing-maintenance` 分支，CI 全 8 job 通过，release 产出 6 个 `tokenboard_<os>_<arch>.tar.gz` + `checksums.txt`，资产名与 `internal/release` 的 `Platform()`/`archiveName()` 构造规则逐字一致；`checksums.txt` 为单行一文件的 sha256 清单。
  - **首跑即暴露并修掉一个缺陷**：`release-dry-run` 的版本断言硬编码 `^tokenboard \(go\) 0\.0\.0-SNAPSHOT-`，而 GoReleaser 的快照版本取自最近 tag——仓库无 tag 时恒为 `0.0.0-SNAPSHOT-<sha>`，打了 `v0.1.0` 后变成 `0.1.0-SNAPSHOT-<sha>`，于是**首个真实 tag 被自己的预检拦下**。预检此前只在无 tag 的分支上跑过，永远看不到这个分支。修复改为断言版本形态 `^tokenboard \(go\) [0-9]+\.[0-9]+\.[0-9]+-SNAPSHOT-`：两种快照形态均通过，`dev` 与裸发布版本仍被拒（`3aee717`）。
  - 发布流程需要重打 tag 时：`git tag -d v0.1.0 && git push fork :refs/tags/v0.1.0`，在新提交上重建并推送；release job 以 `needs` 前置全部检查，任一失败只会 `skipped` 而不产生 release，因此失败前不会留下半成品。
  - **版本号标识的是客户端，不是整个仓库**（2026-10-23 订正）：tag 打在**包含了大量服务端与文档提交**的分支上，首个 release 的 changelog 因此混进 646 行与客户端无关的提交。但版本语义只约束客户端——`ldflags` 打戳 `{{ .Version }}`（tag 去掉 `v`），`tokenboard version` 打印 `tokenboard (go) 0.1.0`，`selfupdate` 拿它与 `release.Version(tag)` 做**字符串**比较（`selfupdate.go:282`）。`release.Version` 只剥 `v` 前缀，所以 `v0.1.0`、`v0.1.1` 这类纯 semver tag 与打戳值逐字一致；**改动 tag 格式（加前缀、加构建元数据）必须同步改这条比较**，否则每次定时自更新都会重装同一版本。`internal/release` 的 `TestVersionStripsTheTagPrefix` 钉住该映射（2026-10-23 补）。
  - **release notes 缺切换说明**（2026-10-23 订正）：首个 release 的正文是 GoReleaser 自动生成的提交清单，不含「怎么把本机 collector 切到二进制客户端」与「服务端不在这个 release 里」，操作者只能翻仓库。`.goreleaser.yaml` 的 `release.header` 已补上这一段（tag ↔ `tokenboard version` 的映射、`upgrade.mjs --to-binary`、`--release-repo` 覆盖、回滚、服务端走 `pnpm run deploy`），下个 tag 起生效；v0.1.0 的正文**不再改写**——重新发布一次已交付的版本会让下载计数与「首个 release」记录对不上。
  - **发布应在哪一侧（2026-10-23 核对）**：上游 `evepupil/TokenBoard` **至今没有任何 tag**（`git ls-remote --tags upstream` 为空），也没有发布工作流的历史；Go 客户端（`clients/go`、`.goreleaser.yaml`、`skills/tokenboard` 的二进制通道）整体仍在上游未合并的 PR #24 里。因此由上游出正式 release 的前提是 PR #24 先合并、且上游同意接管发布节奏——这两步都需上游作者本人。当前 `MisonL/TokenBoard` 的 v0.1.0 是**私人通道**：skill 的 `defaultReleaseRepo` 指向它，供本机与自部署用户使用；它不构成正式发布，也不应被表述成「已发布给所有用户」。上游合并后应按同一 `.goreleaser.yaml` 从上游仓库打 tag 另发一版，并同步 `defaultReleaseRepo`。
- **二进制安装与切换（2026-10-23，当日晚已回滚）**：`upgrade.mjs --to-binary` 走真实 GitHub 端点（`MisonL/TokenBoard` 的 `/releases/latest` 302 → tag 页 → 资产）安装 `0.1.0` 与捆绑 `ccusage 20.0.33` 到 `~/.tokenboard/bin/`，`config.json` 的 `clientType` 由 `git` 翻为 `binary`。安装后 `tokenboard preview --source claude-code` exit 0；`shadow-dual-run.mjs --client ~/.tokenboard/bin/tokenboard --source claude-code --until 2026-10-22` 119 快照 match。**随后因「客户端未完成开发测试验证」回滚为 `git`**（见上文「发版状态：暂停」）——二进制与捆绑 ccusage 仍留在原处，随时可再切。
**M7 状态（per-source 灰度 + 双跑，2026-10-21）**：

- [x] `tokenboard shadow` 命令（§6.2）：TS `preview` 与 Go 采集同 env 对比，按 hash payload 做键序规范化 diff，结构化输出 + exit 1；两侧独立临时 state dir，真实 cursor 不可达。
- [x] CI 门禁：`shadow` job 覆盖 grok-build / pi / deepseek-harness / opencode / claude-code / codex / antigravity-cli 七个源（`cmd/shadow-fixtures` 生成六个文件型源的 fixture；antigravity-cli 用 `scripts/antigravity-fixture.mts` + HOME 替换），2026-10-25 起再加上 12 个 ccusage 工具源（干净 HOME 下两侧一致空，用作子命令映射的漂移哨兵）；`release` 以 `needs: [test, typecheck, baseline-test, deps, shadow, release-dry-run]` 前置。GUI 两源因 language-server 不进 CI。
  - **基线测试门禁（2026-10-23 补，`736d0bd`）**：此前 CI **从不运行 TS collector 的 1218 条测试**——`typecheck` 只证明类型自洽，`shadow` 只跑 fixture。一条破坏 collector 自身测试的改动会绿灯通过，并静默移动 shadow 的对比基线。新增 `baseline-test` job：`pnpm --filter @tokenboard/usage-core --filter @tokenboard/collector test` + `pnpm format:check`，并加入 `release.needs`。**作用域刻意只覆盖这两个包**——它们是本 workflow 的 `paths` 过滤所触发的那两个；`apps/web` 同样没有 CI，但不属这条基线，写进来会让 job 声称的范围大于它的触发范围。
  - **手动触发（`a14d728`）**：`push` 只匹配 `master` 与 `v*` tag，feature 分支上的 workflow 改动**无法由 CI 自验证**——这正是本轮遇到的：改完 workflow 推上去，CI 一次都没跑。加 `workflow_dispatch` 后可在任意分支跑同一批 job；`release` 仍由 `if: startsWith(github.ref, 'refs/tags/v')` 把住，手动触发不可能发布。
  - **跨平台测试树类型检查（2026-10-23 补，`4e7af76`）**：`go build ./...` **不编译 `_test.go`**，而原生测试矩阵的每个 runner 只为自己那个 GOOS 编译——所以「某个测试文件在别的平台编不过」两边都看不见。`go vet` 会 typecheck 测试文件，按目标逐个跑即覆盖测试树。本机对 windows/amd64+arm64、darwin/arm64、linux/arm64 全部干净。**已在 CI 验证**：上游 PR #24 的 run `39958268161`（`4e7af76`）全 8 job 通过，含新增的 `collector and usage-core test`，`Release` 按 tag 条件 skip。
- [x] per-source 映射（§7）：`config.perSource` 校验与客户端选择；具名 source 跟随映射，未映射沿用 `clientType`；`all` 运行要求映射与 `clientType` 一致（TS collector 无子集参数），否则 fail-closed。
- [x] 真实数据双跑：codex 近 14 天 3 条快照 match；claude-code 排除当天 184 条快照 match（当天差异为活写竞态，已记录）。2026-10-21 复测（`shadow-dual-run.mjs`）：claude-code 277、codex 3、grok-build 4、deepseek-harness 4，全部 match；同时修掉一个真实缺陷——Grok Build 与 DSH 在未设 home 变量时扫的是 `~` 而不是 `~/.grok` / `~/.dsh`，CI fixture 永远显式设变量所以从未暴露，真实数据双跑一眼看穿（`21b9433`）。
- [x] hook 路径覆盖（2026-10-21）：`tokenboard shadow --hook` 让两侧都走 hook 增量路径，`shadow-dual-run.mjs --hook` 透传。实现时发现并修掉一个真实缺陷：Go provider 自己从 `TOKENBOARD_HOOK_MODE` 环境变量读 hook 模式，而 `--hook` 最初只设置了 `Options.HookMode`（只影响 source 展开与 fail-fast），没能传到 provider——Go 侧仍在跑全量 preview，TS 子进程却已走 hook 路径，这样的「对比」比的是两条不同代码路径。修复后本机实测 codex hook 3 条快照 match；claude-code 因当天有活跃写入单独验证。仍未覆盖的是热 cursor 增量（shadow 两侧都用全新 state dir），见 §6 限制。
- [ ] **M7 出口未达成：TS collector 尚未 deprecated。** 原始出口标准是「全 source 走 Go，TS deprecated」，两者都未发生——本机 `clientType: git`，TS 仍是生产主路径，Go 客户端只在本机以 `shadow` 对照方式运行过。达成该出口需要「发版状态：暂停」的 5 个条件全部解除，并完成 2 周稳定观察。
- [x] 逐源切换机制本身已可用（2026-10-23 实测切换并回滚）：`upgrade.mjs --to-binary` → `clientType: binary` → 所有源由 Go 二进制执行 → 当日回滚为 `git`，两条路径都在真机上走通。`perSource` 保留为逐源开关（注意：`all` 运行要求映射与 `clientType` 一致，混合映射会 fail-closed）。**切换动作本身已验证，持续运行未验证**——见下条。
- [ ] 「全部 source 走 Go 稳定 2 周」：**未开始，且不以上述 2026-10-23 起算**。真实启用与观察都排在「发版状态：暂停」的 5 个解除条件之后；解除后从真正启用那天重新起算 2 周。
  - **观察期有效性的证据边界**：本机有可观测数据的源是 7 个——`claude-code`、`codex`、`grok-build`、`deepseek-harness`、`amp`、`kimi`、`zcode`（后五个须用 `--since all`，默认 7 天窗口内无数据，见 2026-10-25 双跑）。其余 9 个 ccusage 工具源两侧一致空、`opencode` / `pi` / antigravity 三源的目录不存在。这些源的双跑结果不构成有效证据，其正确性只能依赖 CI fixture 的 shadow 门禁。
  - **空集匹配不再伪装成 match（2026-10-23，`0db6775`）**：上条的现象有工具层根源——`classifyShadowRun` 把「两侧一致地为零快照」也记成 `match`，于是默认窗口下 grok-build / DSH 每天都产出一条绿色记录，日志尾部看起来像这些源有覆盖。现在该情形记为 **`empty`**（`summarizeDualRun` 单独计数，exit code 仍为 0——没有东西失败，只是没有东西可比），`--help` 与 SKILL.md 都写明 `empty` 不是覆盖、要用 `--since all` 重跑该源。实跑验证：`2 match, 2 empty, 3 not installed, 0 diff`。
  - **`--summary` 补齐（同提交）**：`readRecentRecords` 及其注释声称的「趋势」此前从未接线——检查日志走向只能整跑一遍或手读 JSONL。现在 `shadow-dual-run.mjs --summary [--limit N]` 打印尾部记录的分状态计数，并列出最近的 `diff`/`error` 条目（带时间戳），不再运行任何比较。生产日志实跑输出：`19 match, 0 empty, 3 diff, 9 not installed`，三条历史 diff 正确列出。
  - **双跑趋势并入 `status.mjs`（2026-10-24）**：趋势只能靠单独跑一个命令看到，就等于日常体检看不到它——而这份趋势恰恰是「哪个源可以切 Go」的判据。现在 `status.mjs` 输出 `shadowDualRun` 块：末 50 条记录按状态计数 + 覆盖的时间跨度 + `lastDiffAt`/`lastErrorAt`。计数与时间戳由 harness 自己的 `summarizeDualRunTrend` 产出，`status` 与 `--summary` 读的是同一份实现，不会各说各话；**记录内容一律不进 status**——记录的 `message` 可能带着客户端错误原文（含本地路径），所以只留计数与时间戳。日志路径由 `dualRunLogPath()` 统一解析，`TOKENBOARD_SHADOW_DUAL_RUN_LOG` 移过位置也照样被读到；没有日志时该块整体省略，而不是报一个空趋势。本机实跑：`31 records（2026-10-21 → 2026-10-23），19 match, 0 empty, 3 diff, 9 not installed, lastDiffAt 2026-10-23T03:41:16.038Z`。
  - **`api-request-blob` 超限行与噪声过滤器拼写缺陷（2026-10-24）**：本机 `recentRuns` 的 33 次 error 追到两个真实缺陷。① Claude Code 的 `api-request-blob` 记录（请求负载 + 内容 hash，`message` 只有 `role`/`content`，无 usage）不在超限行丢弃白名单里，一个 1.15 MiB 的实例让 claude-code 的 hook 同步从 2026-10-23 起每次都失败——与 `attachment`/`result` 同一类风险（平时不可见，一超限就整源失败）。TS 与 Go 两侧白名单同步补上该类型，并各加两条测试：无 usage 时跳过、`message.usage` 存在时仍 fail-closed。真实文件直读验证：13684 行全部读完、仅跳过 1 条超限行。② `notify.mjs` 的噪声前缀写成 `/^TokenBoard model pricing /`（空格），而 collector 所有回退诊断都是 `TokenBoard model pricing: ...`（冒号），于是良性的定价回退被当成终止错误、真实失败原因被降级进 `diagnostics`——08ceca8 引入该过滤器以来 291 条 error run 的原因字段都是错的（其中 10-23/24 的 10 条真实原因是上述超限行）。前缀改为 `[: ]` 覆盖两种拼写。**验证**：TS 侧 `preview --source claude-code` 完整跑通、无超限行报错；用含修复的 Go 二进制跑 `shadow-dual-run.mjs --client <新二进制> --source claude-code --hook` 得 **334 快照 match、0 diff**（修复前的已安装发布二进制在同一命令下直接报 `oversized line with an unknown record type`，正是两台机器上「旧代码必然失败、新代码通过」的对照）。
  - **切换依据（2026-10-23）**：二进制安装后 `shadow-dual-run.mjs --client ~/.tokenboard/bin/tokenboard --source claude-code --until 2026-10-22` 得 119 快照 match（`logs/shadow-dual-run.jsonl` 的 `04:16:46Z`、`06:36:25Z` 两条）。其余六源沿用 2026-10-22 的全源复验（见下条），本次未重跑。
  - **瞬态 diff 已定性（2026-10-23T03:41:16Z，2026-10-24 定性为活写竞态）**：默认窗口（含当天）双跑 124 快照、`liveWrite` 2、`differing` 1——`claude-code` / `2026-10-23` / `deepseek-v4.1-flash`（双跑日志里记原始拼写 `DeepSeek-V4.1-Flash`）的 `sessionCount` TS=31、Go=30，其余字段一致。两侧 `getSessionCounts`/`readSessionCountModel` 逐行同构，命令参数（`claude session --json --single-thread` + 同一 range）一致；双跑窗口内没有新建会话文件（唯一 11:30:26 早于 11:34 启动），但有 34 个会话文件在活跃追加。`isLiveWriteDifference` 按设计不放行 `sessionCount`（第三条件只覆盖 token 与 `costUsd`），因此该行被计为 `diff`。

  - **定性结论：会话列表在两次 `claude session` 扫描之间增长，而非读取端解析不稳定（2026-10-24）**。本机排查锁定该桶下唯一一条「首条 usage 行落在双跑时刻」的会话——`~/.claude/projects/-Users-mison/69cfe9f6-dd7f-41df-b067-0eb675a03eb8.jsonl`，其首条 usage 行时间戳 `2026-10-23T03:32:10Z`、模型正是 `deepseek-v4.1-flash`、文件 mtime `03:32:53Z`，落在两次 session 扫描之间。一个会话文件只有累计到首条可解析的 usage 行后才进入 `claude session` 清单（实测：把文件截断到无 usage 行它就消失，往已有文件追加一个新 `sessionId` 行却不增加条目）。所以这个会话在 Go 侧扫描时还没有 usage 行（未计入），TS 侧扫描时已有（计入）——一侧多计一条、另一侧尚未计入，且**只动该桶、token 字段全等**，与观测逐位吻合。合成 fixture 排除了「读取端解析不稳定」这条旧假设：把文件尾部截断（1/2、1/4、1/8 且无尾换行）并不改变已有会话的计数，差异来自「会话是否已产生首条 usage 行」而非「读取撕裂」。**这是活写竞态的第三种形态**（区别于 `liveWrite` 三条件覆盖的 token/成本反向）：`isLiveWriteDifference` 按设计不放行 `sessionCount`，故该行仍计 `diff`、exit 1，属 fail-closed 正确行为——会话计数增减无法用 token 单调性证明是活写，放宽需另加「差异字段仅 `sessionCount` 且两扫描间隔 ≥ 阈值」并交叉核对 mtime，当前不做。定性后端点：解除暂停条件 4 已满足（该瞬态 diff 已归因于活写竞态，非语义缺陷）。
  - **03:41 差异的进一步排查（2026-10-23T11:00Z，当时未定性、范围收窄）**：绕开 shadow harness，直接连跑 ccusage 本身——
    - 同一固定窗口连跑两次、三次成对读取，**会话归属零翻转**（57 会话 / 1858 行，`deepseek-v4.1-flash` 桶恒为 39）。这排除了「同一份输入两次解析不一致」。
    - 差异期间**只有 3 个会话在增长**（token 数变大），其余完全静止。
    - 会话内两个模型拼写（`deepseek-v4.1-flash` 与 `DeepSeek-V4.1-Flash`）在 29 个会话里同时存在，但冠亚军差距最小的也有 4.35%——**没有接近平票的会话**，所以「主模型归属翻转」需要单次写入跨过 4% 以上，与「仅 3 个会话在增长」不符。
    - 因此最可能的机制仍是**扫描时读到文件尾部不完整**（ccusage 在读取某个正在追加的 jsonl 时拿到半行/半会话），但这需要在那 3 个会话正在写入的当刻复现，本次未捕捉到。**当时的结论：未定性，但已排除「归属翻转」与「解析不确定」两条**（2026-10-24 已定性，见下条「定性结论」）。
  - **该行一度被误记为「未能复现」**：紧随其后的两次 match 用的是 `--until 2026-10-22` 沉降窗口，**不覆盖当天**，所以并没有重测这一行——正确说法是「未复测」。
  - **低负载复测（2026-10-23T13:15Z，本地 21:15，load 5.5）**：当天 load 首次落到个位数，又用默认窗口（含当天）复跑一次：125 快照 **match、0 diff、`liveWrite` 12**。这是第三次覆盖当天窗口的 match，且负载条件与 03:41 那次（load 90+，双跑与两台 shadow 并发）明显不同。**仍然不宣布已消除**：`liveWrite` 有 12 行说明当天确有并发写入，而这正是 03:41 的疑似成因；没有在写入当刻抓到，机制就还没被看到。
  - **含当天窗口复测（2026-10-23T06:56Z，本地 14:56）**：用默认窗口（含当天，lookback 口径）复跑，128 快照 **match、0 diff**——03:41 那一行这次两侧一致。这是第一次真正覆盖当天的重测；但**单次 match 不能据此宣布「已消除」**：活写竞态是随机的，03:41 那次是双跑与两台 `--single-thread` shadow 并发时出现，复测时负载已回落（load 约 25→17）。后续的 ccusage 直连排查（见上条）已排除「归属翻转」与「解析不确定」，「文件尾部不完整」当时仍未捕捉到。**当时结论维持：未定性**（2026-10-24 定性为「会话首条 usage 行落在两次扫描之间」的活写竞态）。
  - **切换后首次真实上传（2026-10-23T07:01:00Z→07:06:52Z，当日晚已回滚）**：一次 claude-code hook 触发的真实 `sync` 由 Go 二进制执行（`sync.mjs --hook` → `~/.tokenboard/bin/tokenboard sync --source claude-code`），`runs/2026-10-23T07-01-00.628Z-wdmvyt.json` 记 `status: success`，claude-code 与 codex 两个 cycle 均 `exitCode: 0`，总耗时 352 s（hook 上限 30 min）。服务端 `/api/v1/ingest/check` 对 `claude-code` / `2026-10-23` / `deepseek-v4.1-flash` 返回已有快照（`snapshotHash 5ed1a234…`），证明写入落库。**证据边界**：该快照同日 04:00 的 TS 定时同步也可能写过，`ingest/check` 只证明「服务端有这条」，不能单独归因于 Go 那次；归因依据是 15:01 前后只有 Go 客户端在跑。
  - **Go 客户端 all 源 preview（2026-10-23T07:07Z）**：`tokenboard preview --source all` exit 0，`claude-code` 产出快照；未安装的 opencode/pi/antigravity 三源按 unavailable 跳过（stderr 有 `Skipping unavailable …` 行），不是静默丢弃。
  - **已知未变的环境限制**：chaosyn 生产仍无 `/api/public/model-pricing` 路由，日志持续报 `refresh failed (HTTP 404); using bundled static pricing`，导致 41 个 Claude Code 模型无动态定价（`costUsd` 走 bundled/0）。这要等上游合并 PR #24 并部署，不在本机可修范围。
  - **切换前复验（2026-10-22，Go 侧含 `--single-thread` 的新二进制）**：`shadow-dual-run.mjs --client <新二进制>`，默认 7 天窗口（`20261015` 起，与生产 lookback 同口径），claude-code / codex 额外传 `--until 2026-10-21` 排除当天活写竞态。grok-build、deepseek-harness、opencode、pi、antigravity-cli、claude-code（111 条快照）、codex（2 条快照）全部 match，0 diff。该次复验的必要性在于 ccusage 调用参数两侧必须同步：`--single-thread` 只加在 Go 侧会造成假 diff，加在两侧则输出逐字节一致。
  - **`--single-thread` 的真实代价（2026-10-23 复测，load 25–45）**：同一固定窗口（`--since/--until 20261020`）连跑两轮，并行峰值 RSS 5.55–5.67 GB / 26–31 s，单线程 2.43–2.47 GB / 46–53 s。即内存降约 57%，墙钟升约 1.7×（不是先前在 load 800+ 时测到的 5–6×——那组数字是负载噪声，已作废）。据此判断该 flag 可安全保留：hook 的 30 分钟上限对 1.7× 有余量，而单线程把峰值压到 hook 场景可接受的水平。
  - **活写竞态根因（2026-10-22 实测定位）**：hook 口径不能传 `--until`，当天必然进对比，此前每次双跑都报 `diff`。逐层排查后确认不是移植缺陷，而是两个叠加机制：① 两次扫描顺序执行（Go 先、TS 后），当天被写入的会话文件在两次读取之间增长，后扫一侧 token 更多；② ccusage 对 `cost=0` 的模型行（订阅/免费额度，本机 7 个）由 collector 按 `父行总成本 × 该行 token / 父行总 token` pro-rata 分摊，当天总 token 变化会连带改变这些行的成本——这也解释了为何这些行在单次运行内共享同一个精确比值（4.4e-16 内一致）。两侧 `readCostUsd` 逐行等价，同一份 ccusage 输入算出同一结果；22 天里只有当天漂移，21 个已沉降日期在两次运行间完全一致。
  - **因此新增的判定（2026-10-22）**：`shadowReport.liveWrite` 把可归因于活写的行单列，`isLiveWriteDifference` 要求三条同时成立才放行——① 行日期等于该行时区的今天；② 差异字段只有 token 计数与 `costUsd`（`sessionCount`/`correction` 任一不同即不算）；③ 每个 token 字段都满足「后扫的 TS ≥ 先扫的 Go」（追加只能增加用量，反向减少说明两次读取本身不一致）。`costUsd` 不约束方向：零成本行的分摊会随分母反向移动，属同一成因。只在一侧出现的行永远不放行。任何条件不满足仍是 `diff` + exit 1。`shadow-dual-run.mjs` 记录 `liveWrite` 计数但不算失败，避免活跃机器上双跑恒红。

**本机 hook 负载实测（2026-10-21，7 天 run 记录 + ccusage 计时）**：

- 频率：7 天 458 次运行、311 次真正调用 ccusage（其余是 cooldown skip 与「无变更快速返回」），累计 634 分钟墙钟，约 91 min/天；3 天窗口内 TokenBoard 进程占墙钟 4.9%。
- 冷却有效：311 次真实重算里只有 10 次（3%）发生在「前 30 分钟已有成功记录」的情况下，即冷却机制本身没有失效。其余 301 次发生在失败之后——失败不写 `last-success.json`，冷却无从生效，这是失败放大的机制而非配置错误。
- 单次成本：`ccusage claude session` 在本机 18 GB / 10328 个会话文件上峰值 RSS **4.6–7.6 GB**、耗时 20–68 s；`claude daily` 另有 4.7 GB / 32 s。**`--since/--until` 只过滤输出、不减少扫描量**（窄窗口 68 s vs 30 天窗口 63 s，实测）。
- 失败放大的根因（2026-10-14 高峰 188 次运行 / 156 次失败）：`TokenBoard model pricing: hook mode has no usable cache` 被当作 hook 失败上抛。该行本身是「回退到 bundled 静态定价并继续」的提示，不属于致命错误；当时它让每次 hook 都 exit 1，于是冷却永不生效、重算不断。已在后续版本不再表现为失败（3 天内该错误 0 次）。
- 与采集实现无关的部分：`ccusage` 的全树扫描是外部依赖的限制，Go 侧调用同一个二进制，实测峰值 RSS 7.0 GB 与 TS 侧同量级。要真正降低内存只能等 ccusage 提供增量/流式接口，或改由 collector 自己投影——后者会偏离「两侧同口径」的迁移前提，不在本次范围。
- **已实施的优化（2026-10-21，`70f981a`，TS 与 Go 两侧同步）**：① oversized Codex 行摘要按 scan 折叠——原来一次运行打印十条近义行（日志里 3475 行、570 个连续块），现在按家族（child session / context pricing）合并成一条汇总，同时兼容「单 scan」与「across N scans」两种既有形态；② stale canonical attribution skip 折叠成计数（525 行 / 69 次运行，平均每次 7.6 行）；③ 定价目录按进程 memo——`--source all` 下 claude-code 与 codex 各加载一次，在端点无定价路由时两次请求都白付（实测每次 ~0.8 s），现降为一次（实测 2 → 1）。memo 只覆盖「本轮已尝试」这一情形：成功刷新本就落共享磁盘缓存并跨运行复用，抛错会清除 memo 以免下一个 provider 继承一次可能瞬时的失败。
- **经实测否决的两条**：① 给 claude 侧加 `--offline`——它用的是 ccusage 内置/过期价表，实测会让 GLM-5.3-Flash 成本偏低 14%、deepseek-v4.1-flash 逐日偏差，破坏 `costUsd` 口径，不能用；② 给 `ccusage` 传 `--id`/缩小窗口减少扫描量——实测不减少全树扫描（1 天窗口 68 s vs 30 天 63 s）。

- Windows 换入语义：`os.Rename` 在 Windows 上走 `MoveFileEx(..., MOVEFILE_REPLACE_EXISTING)`（Go 1.27 GOROOT `internal/syscall/windows/syscall_windows.go:357`），能覆盖已存在的目标文件；`swap` 的两步 rename 顺序（先 current→backup，再 staged→current）之所以在 Windows 也可行，是因为第一步只移动**正在运行的镜像**（Windows 允许对运行中的 exe 改名），第二步的目标 `current` 此时已不存在，不依赖覆盖语义。**未在本机（darwin）实测 Windows**，只做了 `GOOS=windows go build` 与源码级论证；这条留给首个 Windows 二进制用户验证。

**M3 调研要点（2026-10-16，未写入实现）**：antigravity 三源在 TS 侧共 ~11.5k 行（含测试），分四层：

- 纯/无依赖（可直接平移，对应 Go 侧新包 `antigravityscan`）：`antigravity-file-scan.ts`（173 行，SHA-256 键 + 热/冷混合选择 + 从两端取样）、`antigravity-since.ts`（87 行，`since@时区` scope 解析 + `includesTimestamp/includesFileMtime` 谓词）。两者测试仅 3 条，但逻辑密集。
- 数据层：`antigravity-history-db.ts`（632 行，SQLite `gen_metadata.data` 投影 + cursor 高水位 + 完整目录扫描断言）、`antigravity-history-protobuf.ts`（298 行，`.pb` 解析，M0 硬约束禁止直接作上传来源）。
- Cursor 层：`antigravity-cli-cursor.ts`(543)、`antigravity-gui-cursor.ts`(543)、`antigravity-cli-db-cursor.ts`(154)、`antigravity-cli-history-authority.ts`(266)——legacy 迁移/重建/回滚。
- Provider：`antigravity-cli.ts`(250，含 CLI 源 + status line 侧约束)、`antigravity-gui.ts`(529)、language server client `antigravity-gui-client.ts`(555，JSON-RPC over stdio)。
- 注意：TS 侧 provider 把 cursor 读写内联进 `session-cursor-store.ts`，Go 侧 M0 已有 `internal/collect/sessioncursor`，三源 provider 须复用而非另写。
- 风险：protobuf 层（298 行 + 529 行测试）和 language-server 层是 M3 主体工作量；「不落盘专项」= 硬约束「raw content 不得进 cursor/snapshot/日志/payload」需逐层测试覆盖（TS 已有 antigravity-gui-parser 66 行测试 + client 631 行测试可对照）。
- [x] 数据层：`antigravityscan`（f0d7f5a + 6f478b7 目录列表 helper）、`antigravitymeta`（51b2426 parser + protobuf + 金样本级 blob 解析）、`antigravityhistory`（6f478b7），影子 diff 见下
- [x] Cursor 层（CLI 侧）：`antigravity-cli-db-cursor`（62616f9，scope 复用/迁移/剪枝 + 无锚检测逐位对齐 TS 比较）、`antigravity-cli-cursor` + `antigravity-cli-history-authority`（83c6963，event/session/aggregate 三族键 + pending 重发 + 压缩边界 fail-closed + metering version 迁移 + 全量重建 prepare/restore + 零 correction）；`antigravity-gui-cursor` 待做
- [x] 共享层：`sessioncursor.SelectPendingCursorSnapshotGroups` / `ShouldIncludeCursorSnapshot`（dcf2b51，pending 重试轮转 + 分组过滤）
- [x] **antigravity-cli 源完成、可切换**（e6a221e + f6bf049）：provider 编排（range → migration → rebuild → 读库 → push → mark → restore → 重发 → 校验 → 写 cursor，全程 fail-closed）、`collect.Options.StateDir/HomeDir` 贯通、optional-source 分类补齐三条 Antigravity unavailable 消息、`clearPendingUploadCursors` 的 Go 版（分组确认 + session marker 匹配 + 90 天保留期压缩进 daily aggregate + compacted frontier 持久化）、CLI 上传成功后确认 cursor；集成测试覆盖真实 SQLite fixture 的首跑/重发/确认/增量追加（重发**完整日总量**而非增量）/bounded 扫描 fail-closed/目录缺失 unavailable
- [x] Cursor 层（GUI 侧）：`antigravity-gui-cursor`（bb5baba，event/session/aggregate 三族键 + antigravityOrigin 标记 + bounded scope 迁移 + language-server cascade cursor/empty frontier + db 重置双重 fail-closed + 零 correction）
- [x] Provider 层（GUI）：`antigravity-gui-local-db`（e4a1086）、`antigravity-gui-environment`（unavailable 分类：DB 侧在 support.go，language-server 匹配器在 `antigravitymeta/ls_unavailable.go` 以便 CLI 复用）、`antigravity-gui` 编排 + db-reset 恢复 + partial-usage 契约（226176f）、`antigravity-gui-client`（96af34c，语言服务器进程单次 Wait 所有权 + 32MiB 限流中读）、`antigravity`/`antigravity-ide` 注册 + GUI 侧 ack（per-origin 聚合 + compacted 重放标识）
- [x] 「不落盘专项」测试覆盖（07d4e9e + 86 项 GUI 包测试）：raw content（prompt/completion/promptSections/conversationHistory/path/email）贯穿 GUI 全链后逐层断言其不存在——解析后 event、snapshot、cursor 文件、stderr 诊断、序列化 payload；SQLite 路径在 blob 层同口径钉住（prompt/path protobuf 字段与 usage 块同排）。另 `TestCollectGuiNeverPersistsRawIdentifiers` 覆盖原始 conversation/response/execution/session id 不进 cursor
- [x] 六 agent 复核修复（f372645..ecf6395）：cascade 列表只认 `.pb`/`.db` 且 stat 非 ENOENT 错误上抛（f372645）；`--since all` 下 DB 读失败先于完整性断言上抛（d28f6ba）；CLI source-failure/exit-code 契约对齐 TS（fatal 标志、concrete-source partial 上传后 exit 1、all-source fatal 失败、零 snapshot partial 仍算 collected、`ignoreLanguageServerUnavailable`）+ Antigravity 失败按 category 脱敏进调度日志（8aedd83）；partial 快照上传前逐条 Validate（805a45f）；metadata 字符串按 UTF-16 code unit 限长 + nil Env 回落进程环境（6ae34d5）；db-reset 恢复链/跨轮日总量重发/未变日不重传三条集成测试（ecf6395）；语言服务器请求门控 4 场景 + db-reset 修正语义 3 场景端到端覆盖（84dfa36、86bab96、0260ce2）；cascade 平局按原始 id（901a3c9）、PATH 查找 spawn ENOENT（a8b1a1b）、partial 路径保留扫描状态（91a91b2）、拒绝重定向 + SIGTERM 宽限关闭（c4b1ba9）

**M3 数据层影子 diff 口径（6f478b7）**：`clients/go/scripts/antigravity-fixture.mts` 生成 5 个 cascade DB（含 placeholder model、稀疏 usage、空 blob/NULL、损坏 blob、别名）；`antigravity-shadow-ts.mts` / `antigravity-shadow-incremental.mts` 跑 TS 侧，`cmd/tb-shadow-antigravity` 跑 Go 侧。六个场景全部一致（canonical 化后逐字段）：无界直读、有界直读（maxDbFiles=2）、三段携带状态增量（每段向 TS 自己写出的 state 追加一行到最热已处理库，另有未读库参与竞争）、删除已确认行后的 fail-closed（两侧抛同一 "metadata cursor reset detected …; rerun with --since all" 错误）。mtimeMs 必须与 Node `fs.Stats#mtimeMs` 逐位一致（写入共享 cursor 文件），故 `internal/collect/mtime` 复刻 Node 的先秒后纳秒算术；`UnixNano()/1e6` 单步除法末位差一 ulp（实测 1792153999246.4922 vs …492）。
- [x] M0 契约层（6cca203；金样本 `clients/go/internal/contract/goldens/snapshot-hash.json`，由 `scripts/clients-go-gen-goldens.mjs` 从 TS 侧再生成；cursor 双向兼容验证在 50c4157）
- [x] 确认 Go 工具链版本基线：`clients/go/go.mod` 声明 `go 1.27`，依赖为 `golang.org/x/sys` 与 `github.com/klauspost/compress`（M2 引入，Go 标准库的 `internal/zstd` 不可导入）
- [x] M1 上传/运行锁/瞬态分类/sync CLI（9286438 + 9d6f6c4 + 50c4157；provider registry 尚为空，M2 起填充）
- [x] M2 grok/dsh/pi/opencode + zstd 分帧 —— 完成：
  - [x] grok-build provider + 共用 scan/aggregate 层（bb22885）
  - [x] deepseek-harness provider + zstd 分帧（37e0aa1）
  - [x] pi provider
  - [x] opencode provider + 嵌入式 SQLite 读写（modernc.org/sqlite）
  - [x] `clients/go/scripts/check-deps.sh`（§5 依赖闸门；**本属 M4**，提前完成——金样本是 M4 编写解析器时的契约，先钉上游形状再写解析器是正确顺序）

**M2 影子 diff 口径**：每来源一个 fixture（grok：真实 `updates.jsonl` 事件形状；DSH：同目录 plain+zstd 双编码去重 + 跨帧 UTF-8 + 尾部撕裂帧 + cache read/write + 跨日期；Pi：fork 同 id 去重 + toolResult/compaction/branch_summary 三类 carrier + 跨日期；opencode：真实 `opencode.db` 行 + `gpt-4o`/`GPT-4o` 大小写排序陷阱）分别跑 `tsx src/cli.ts preview --source <s>` 与 Go `tokenboard preview --source <s>`，除 `collectedAt`（墙钟）外逐字段、逐序一致。

**M2 新增的共享层**（TS 侧分散在 `session-cursor.ts` 等文件中，Go 归入独立包）：

- `internal/collect/collate`：镜像 JS 默认 `localeCompare`。ICU 主级比较忽略大小写、次级小写在前，且标点自带主级权重（`_` 在 `-` 之前），与字节序不同；`Aggregate.Snapshots()` 与 `MergeSnapshots` 的排序若与 TS 分叉，同一批 snapshot 会以不同顺序输出，而 cursor 契约是按字节比较的。可打印 ASCII 的排序表由 Node 实测导出（见包注释），非 ASCII 退化为码点序并在注释中声明该边界。
- `internal/collect/sqlite`：移植 `sqlite-reader.ts`。嵌入式 modernc 驱动对应 `node:sqlite`，外部 `sqlite3` 二进制仍由 `TOKENBOARD_SQLITE_BIN` 强制（保持 TS 的环境契约：该变量选读法，不改变行为）。两条路径均只读，且有 `-json` 输出上限对齐的字节预算检查与「两读法结果一致」的实测测试。


**与 §2 布局的已发生偏离（回写于此）**：

- cli 未用 cobra：`internal/cli/cli.go` 手写子命令分发，零第三方依赖。
- §4 的 ccusage 三层集成（捆绑/探测/下载）与 §8 的 GoReleaser/self-update 通道归 M4/M6；本轮仅提前落地了 §5 的 check-deps 闸门。
- `contract/contract.json`（JSON Schema 生成类型）未采用：契约以手写 Go 结构 + TS 生成的金样本（`goldens/`）钉住，等价性由字节级测试保证。
