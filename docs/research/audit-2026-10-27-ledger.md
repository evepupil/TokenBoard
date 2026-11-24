# 2026-10-27 全维度审查台账（fix/post-merge-audit-followups @ a72bbff + 私人 CF）

## 已确认（我本人复现，非仅 agent 报告）

### A1. 上传 token 进入 ccusage 子进程环境（P2，安全）
- 证据：`sync.mjs:577` 把 `TOKENBOARD_UPLOAD_TOKEN` 放进 collector 子进程 env；TS `claude-code.ts:46` 用 `{...env}` 构造 `commandEnv`；`command.ts:34` 原样传给 `execFile`。Go 侧 `packageCommandOptions` 不设 `Env`，`command.go:111` 的 `if len(env) > 0` 使 `cmd.Env = nil` → 继承 `os.Environ()`。
- 实测：fake ccusage 打印 `token_len=22`（TS 真实 provider 路径，两次调用）；Go 同构。
- 影响：`npx ccusage@20.0.33` / `pnpm dlx` 会下载并执行第三方包，其进程可读取 Bearer token 并以本设备身份上传。
- 修复方向：为 ccusage 子进程构造白名单 env，显式剔除 `TOKENBOARD_UPLOAD_TOKEN`（两侧同改）。

### A2. `-free` / `:free` 零价键遮蔽付费基础模型（P2，费用正确性；master 已存在，非本分支引入）
- 机制：ccusage 的 override 键匹配是「模糊折叠」，比我们实现的 `foldToBaseModelId` 宽得多。实测（session=`base-model`，key 变化）：
  - 命中：`base-model`、`base-model-free`、`base-model:free`、`base-model-thinking`、`base-model-preview`、`base-model-latest`、`base-model-mini`、`base-model-high`、`base-model-pro`、`base-model-lite`、`base-model-air`、`base-model-v1`、`base-model-v2`、`base-model-1`、`base-model-2`、`base-model-instruct`、`base-model-chat`、`base-model-20250101`、`base-model-2025-01-01`、`base-model-x-y-z`、`provider/base-model`、`base.model`（点号也折叠）
  - 不命中：`BASE-MODEL`（大小写敏感，与既有结论一致）、`xbase-model`、`base-modelx`、`base_model`
  - 反向（短 key 命中长 session）也成立：session=`base-model-extra`、key=`base` → 命中
  - 即：**任何以 `-` 或 `.` 分隔的后缀都会被折叠掉**，而我们只处理 `-uncensored`/`-abliterated`。
- 可达性：真实 catalogue 8541 行 → 合并出 3037 键，其中 103 个 `-free`/`:free` 键全为 0 价，**全部**是 catalogue 里的真实 modelId（合法免费变体）；其中 54 个的 base id 没有精确 override。
- 实测影响（真实动态配置 vs ccusage 内置）：31 个有真实 catalogue 行的 base 里 14 个成本改变，5 个被归零：`inclusionai/ling-3.1-flash` 1.2→0、`liquid/lfm-2.5-2.6b` 0.85→0、`nvidia/nemotron-3.5-content-safety` 0.2→0、`nvidia/nemotron-3.5-super-vl` 0.41→0、`poolside/laguna-xs-2.1` 0.3→0。
- 因果验证：从动态配置移除 103 个零价 `-free`/`:free` 键后，`inclusionai/ling-3.1-flash` 恢复 1.2、`liquid/lfm-2.5-2.6b` 恢复 0.85、`nvidia/nemotron-3.5-content-safety` 恢复 0.2、`poolside/laguna-xs-2.1` 恢复 0.3。
- A/B：master 2849 键、103 个零价 `-free` 键；本分支 3037 键、同样 103 个。**零价 `-free` 键集合完全相同，本分支未新增也未消除**。
- 本机用量：114 个模型成本全为 0（订阅额度），无法量化真实费用影响。

### A3. Go 未移植 TS 的「只在 costUsd 为 0 时告警」过滤（P2，诊断噪音；本分支引入的漏移植）
- `bcd4004`（2026-10-26）只改了 TS（`claude-code.ts:241`、`codex.ts:207` 的 `.filter((s) => !(s.costUsd > 0))`）。
- Go `claudecode.go:324-341`、`provider_pricing.go:445-461` 无该过滤。
- Go 测试 `claudecode_test.go:641-686` 用 `costUSD: 0.01` 并断言告警出现——把旧行为钉死了。
- 影响：Go 客户端每个 run 每模型多打一行假的「pricing unavailable」；TS 提交信息实测本机从 44 行降到 0。

### A4. Codex 静态费率 1 ULP 跨语言差异（P2，哈希/影子门禁；本分支之前已存在）
- Go 无类型常量 `0.2 / 1_000_000` 按精确有理数求值后舍入一次；JS 是 `double(0.2) / 1e6` 的运行时二次舍入。
- 位级实测：Go const `3e8ad7f29abcaf48` vs JS `3e8ad7f29abcaf49`，差 1 ULP。
- 真实可达：`gpt-5.6-terra`（standard.cacheRead、longContext.cacheRead）、`gpt-5.6-luna`（standard.input、longContext.input、longContext.output）共 5 处。这两个 id 在 catalogue 里分别有 8/9 个不同报价 → 不会折叠 → 静态规则必然生效。
- 影响：同一天同一会话两侧 `costUsd` 不是同一个 double → `HashPayload()` 不同 → shadow 报 diff、换客户端会重复上传。相对误差 ~1e-16。

### A5. 动态 ccusage 配置写失败时 Go 保留 Codex 动态规则，TS 丢弃（P2，两侧定价分叉）
- TS `model-pricing.ts:250-257` catch 分支用 `buildCodexContextPricingRules([])` 重建，只留静态规则。
- Go `pricing/config.go:138-158` 只回退 `ConfigPath`，`PreparedConfig` 无「已回退」标志；`codex/provider.go:136` 无条件用 `pricing.PreparedConfig.Catalogue.Models` 建规则。
- 触发：state dir 不可写（只读 home、磁盘满、`TOKENBOARD_STATE_DIR` 指向文件）。
- 附带：该分支下若无 explicit config，Go `ConfigPath` 为 `""`（ccusage 无 `--config`），TS 返回 bundled 路径 → Go 还丢 48 条 bundled override。

### A6. 公开定价端点匿名无速率限制（P2，成本/滥用）
- `server.ts:67-74` 的 `createCachedModelPricingResponse` 在 `enforceRateLimit`（`:83`）之前返回。
- Worker Cache 只存 200；`?cursor=<random>` 每次都是新的 cache key 且必然 400 → 400 不缓存 → 每次直达 D1。
- 对照：`/api/v1/model-pricing` 有 `modelPricingRead` 120/60s；`/api/public/[slug]` 有 `publicCardRead` 120/60s。

### A7. `usageDate` 窗口只在服务端校验，客户端不镜像（P2，可用性）
- `usage-core/dates.ts`：`minUploadIsoDate='2023-01-01'`、`maxUploadIsoDate=now+24h`；`ingest/schema.ts` 用它做 fail-closed 校验。
- 客户端（TS `upload.ts`、Go `upload.go`）零引用。
- 后果：单个越界日期使整批 30 条 400 → 非瞬时错误 → `recordUploadFailure` → 连续 5 次后 24h 暂停上传（`upload-backoff.ts:59-60`）。

### A8. Windows `renameatomic.IsBusy` 是死代码（P2，跨平台）
- `renameatomic.go:40` `errors.Is(err, syscall.EPERM) || errors.Is(err, syscall.EBUSY)`。
- Go 1.27 Windows：`APPLICATION_ERROR = 1 << 29`，`EBUSY`/`EPERM` 是 `APPLICATION_ERROR + iota` 的**发明值**；真实 `MoveFileEx` 失败返回 `ERROR_ACCESS_DENIED(5)` / `ERROR_SHARING_VIOLATION(32)` / `ERROR_LOCK_VIOLATION(33)`。`Errno.Is` 只映射 `ErrPermission/ErrExist/ErrNotExist/ErrUnsupported`。
- 测试 `renameatomic_test.go:40` 只断言 `IsBusy(syscall.EPERM)`，在 Windows 上自证成立但与真实错误无关。
- 影响：Windows 上 OneDrive/Defender 短暂占用导致 rename 失败时不重试，直接失败整个状态写入。TS 侧按 `error.code === 'EPERM' | 'EBUSY'` 判断，Node 在 Windows 上正确映射，故 TS 无此问题。

### A9. Go ccusage 子进程 stderr 无上限（P2，资源）
- `ccusage/command.go:118-119`：stdout 用 `limitedWriter{limit: maxBufferBytes}`，stderr 是裸 `bytes.Buffer`。
- 对照 TS `command.ts:33` `maxBuffer: 128 MiB` 同时约束两条流。
- agent 实测：假 ccusage 写 100 MB stderr → 483.8 MB RSS、44.3s。

### A10. 会话 cursor 无保留策略（P2，资源；两侧一致既有设计）
- 本机 `claude-code-cursor.json`：14,274 条，4,349 条（30.5%）指向已不存在的文件，占 2.40 MB / 15.20 MB。
- Go `sessioncursor/scan.go:471` 与 TS `session-cursor.ts:378-407`：只有 `pendingUpload && snapshots.length===0` 才清；否则 `next.files[rel] ??= entry` 无条件复制回。
- agent 实测：同一 cursor 使 hook 单次 RSS 14→130 MB、耗时 0.22→2.0s。

### A11. TS `readSessionLines` 无单行上限（P2，有界性；违反 AGENTS.md「扫描必须 bounded」）
- `bounded-session-scan.ts:141-152` 用 readline 逐行无上限；消费方 `pi.ts:85`、`grok-build.ts:86`、`deepseek-harness.ts:163` 直接 `JSON.parse` 整行。
- 文件上限 256 MiB → 单行可达 256 MiB。
- 对照：claude-code/codex 走 `session-jsonl-line-reader.ts`，有 1 MiB 行上限 + 64 MiB 丢弃预算；Go 对应路径有 64 MiB/行上限。

### A12. 上传不拒绝重定向，Go 同 host 异 port 仍转发 Authorization（P3）
- 定价侧两侧都拒绝重定向（TS `model-pricing.ts:521` `redirect:'manual'`；Go `catalogue.go:355` `CheckRedirect`）。
- 上传侧：TS 无 redirect 配置（默认 follow，但 fetch 跨源会剥离 Authorization）；Go `upload.go:83` 用 `http.DefaultClient` → 同 host 异 port 不剥离。
- agent 实测：Go 转发 `Bearer SECRETVALUE` 到同 host 异 port。

### A13. `client-binary.mjs` 版本探测无 timeout（P2）
- `verifyExecutable`（:304）、`runsVersion`（:500）`spawn(path, ['version'], {...})` 无 `timeout`；`readVersion`（:517）有 `timeout: 5000`。
- Go 对位 `selfupdate.go:354` `versionProbeTimeout = 10s`。
- 路径：中断的 self-update 留下 `tokenboard.new` → `bafd350` 让 `runPreCollectUpgrade` 走到 `recoverOrphanedBinary → runsVersion(staged)` → 该调用在 `runWithSyncLock` 内 → 卡死的二进制会一直持有 `sync.lock`。

### A14. `sync.mjs` hook 超时只杀直接子进程（P3）
- `sync.mjs:363-366`、`:395-398`：`child.kill('SIGKILL')` 只杀直接子进程；`drainPipes` 注释自己承认「orphaned grandchild (ccusage, tsx) that inherited them is still running」。
- 同仓 `antigravity-statusline-original.mjs` 做了 detached + 组杀，属遗漏。

### A15. `TOKENBOARD_HOOK_SYNC_TIMEOUT_MS` 无上界（P3）
- `sync.mjs:44-50` 只校验 `/^[1-9][0-9]*$/`。实测 `setTimeout(…, 2**31)` → `TimeoutOverflowWarning` → 被钳到 1 ms → hook 立即被杀。
- `coordinator.mjs:539` 对 cooldown 路径记录了同一个 32 位钳制，sync.mjs 未防护。

### A16. Go `foldToBaseModelID` 与 TS 的叠加后缀语义不同（P3，当前不可达）
- Go 循环 `TrimSuffix` 两个后缀；TS `replace` 只替换一次。只有 `…-abliterated-uncensored` 形状分叉。
- 真实 catalogue 0/8541 行命中；两侧 override 3037 键全等。
- 现有 golden fixture 无该形状 → 金样本咬不住。

### A17. `priceRowSignature` 的 pricing 键序 Go 排序 / TS 保序（P3，当前不可达）
- Go `json.Marshal` 排序键；TS `JSON.stringify` 保插入序。
- 真实 catalogue 1080 个多行 id 全部一致判定（0 差异）。

### A18. 端点不强制 HTTPS（P2，安全）
- `model-pricing.ts:284-291` `endpointOriginFromEndpoint` 接受 `http:` 和 `https:`；两侧上传也无 scheme 断言。
- 触发：用户把 `TOKENBOARD_ENDPOINT` 设为 `http://…` → token 与 usage 明文过网。

### A19. `gpt-5.6-sol` 的 override 在 272k 以上完全不生效（P2，定价正确性；两侧同）
- ccusage 20.0.33 对 `gpt-5.6-sol` 在 `requestContextTokens > 272000` 时**忽略配置里的单价**，强制用内置分档价 8/M（input）。
- 实测（override `inputCostPerToken=1e-6`，1M input）：`200000→0.2`、`262144→0.262144`、`272000→0.272`（全部 1.0/M，override 生效），`272001→2.176`、`300000→2.4`、`1000000→8.0`（全部 8.0/M，override 被丢弃）。
- 影响：bundled pin 的 5/30 与锚点的 4/20 在 272k 以上都不生效。docs/model-pricing.md 说的「272k 边界改由 Codex token_count 事件处理」只覆盖 Codex 路径，Claude Code 路径没有等价处理。（opencode/其他 ccusage 工具来源同样走 ccusage 定价，ditto。）

### A20. bundled 静态层与 catalogue 冲突（P2，定价一致性）
- 25 个 bundled pin 的 id 在 catalogue 里存在与 pin 不一致的行；其中只有 3 个最终让 merged 与 pin 不同：
  - `gpt-5.6-sol` pin 5/30 → merged 4/20（且如上，272k 以上都无效）
  - `LongCat-2.5-Preview` / `longcat-2.5-preview` pin 0.75/2.95 → merged 0.3/1.2
- LongCat 三层实测（100k input，反推每百万价）：ccusage 内置 0.3/M、bundled pin 0.75/M、本分支动态 0.3/M。
  - 即 bundled pin 是 reseller（nano-gpt）价，官方 longcat 行是 0.3/1.2；本分支锚点把价改回官方价，与 ccusage 内置一致。
  - master 上该 id 在动态层 absent（未折叠），故离线（bundled 0.75）与联网（内置 0.3）本来就不一致；本分支让联网侧与内置一致，离线侧仍是 reseller 价。
  - **真正的修法是改 bundled pin，不是改锚点**（锚点的方向是对的）。

### A21. 锚点实际开火面（信息级）
- `officialAnchorOverrides` 的候选集 926 个 base id；其中只有 **145** 个在 catalogue 里有官方（`officialVendorProviderIds`）且正价的行 —— 只有这 145 个真正产出锚点，其余 781 个是空转（`pickAnchorOfficialRow` 返回 null）。这也解释了我早前把「767 个被恢复」更正为 145 的原因。

## 已查但未发现问题

- 顺序无关性：反转/洗牌 8541 行后 override 0 差异、Codex 规则 0 差异。
- 本分支 A/B：master 2849 键 → 分支 3037 键；`-free` 零价键集合完全相同。
- 两侧 fold 差异、`priceRowSignature` 键序差异：真实数据 0 命中。
- 全量测试：collector 1240 通过、skill 853 通过、`go test ./...` exit 0、`go vet` 通过。
- 线上（tokenboard.431695.xyz）：health 200、定价 200/304、无 token ingest 401、无效 cursor 400、limit 超界 400、`cache-control: public, max-age=0, must-revalidate`。

## 端到端联调（隔离 Wrangler + 本地 D1，E2E agent 执行，我复核了关键口径）

- 环境：`wrangler dev --port 8811 --persist-to /tmp/tb-e2e/state`，本地 D1 应用 migration 0–38 全部成功。
- 通过的关键路径（实测 HTTP 状态码 + D1 行数）：单条/多条 ingest、幂等（二次 `upserted:0`）、token 数变化时更新、cost-unavailable 来源 `costUsd>0` → 整个批次 400、`/check` 的设备维度隔离（token A 看得到，token B / legacy 看不到）、跨设备 summary 求和、rate limit（ingest 120/60s 第 121 次起 429 + `Retry-After`；ingest-check 240/60s；IP 300/60s）、分批中途失败不留半提交（65 条里第 35 条坏 → 64 行精确一次）、`correction: 'codex-context-pricing'` 允许 cost 跟随而 token 归零、usageDate 越界整批 400 且在 DB 不留半条。
- 我复核并更正的结论：
  - agent 报的「`Bearer <token>   ` 尾空格仍 200 → P2」**不成立**。`/^Bearer\s+(\S+)$/` 本身拒绝尾空格（我实测 `Bearer abc   ` → null）；观察到 200 是因为 HTTP 头解析器在读入时已 trim 了值，不是正则宽松。降为「查过但没问题」。
  - agent 报的「chunked 40MB → 200 绕过 content-length 预检」属实，但 `maxIngestBodyBytes` 只是头部预检（`ingest.ts:26`），真正的边界是 Zod 的 `max(500)` 与 `c.req.json()` 的平台限制；实际影响是把 40MB 交给 Worker 解析器的 CPU/内存成本，配合 ingest 120/60s 限流可接受。定为 P3。
  - agent 报的「tool 类来源 `--since/--until` 未拦截」不成立：`cli.ts:333-350` 的 `assertSupportedUntil` 对 `--until` 做了 fail-fast，`--since` 对工具族是合法的（AGENTS.md 只要求 `--until` 受限）。
- 未覆盖：定价游标过期、设备重连完整链路、公开卡片 unavailable-cost 标注、dashboard 时区口径、ccusage 工具未安装时的降级、Windows 调度器、并发延迟分布。

## 未覆盖边界

- 本机 114 个模型成本全为 0（订阅额度），A2/A20 的真实费用影响无法用本机数据量化。
- 生产 chaosyn 的 catalogue 行分布未核对（本报告用 431695 缓存）。
- Go `internal/upload` / `internal/state` / `internal/ccusage` 只做了与定价相关的接口对照，未逐行审查。

## 修复状态（2026-10-28 全部实现；2026-10-29 已按层提交到本分支）

| 编号 | 处理 | 落点 |
| --- | --- | --- |
| A1 | 已修 | `packages/collector/src/child-env.ts`（新）+ `command.ts`；`clients/go/internal/ccusage/credentials.go`（新）+ `command.go` |
| A2 | **不修**（见下） | `docs/model-pricing.md` 的 Known limitation |
| A3 | 已修 | `claudecode.go` `reportUnpriced`、`codex/provider_pricing.go` 增加 `CostUSD > 0` 跳过 |
| A4 | 已修 | `codexDivisor` 改为 `var`（强制运行期除法）+ 26 处静态费率替换 + 位级测试 `TestStaticRatesMatchTheJavaScriptDoubles` |
| A5 | 已修 | `pricing.PreparedConfig.ContextPricingModels`；两个回退分支置 nil |
| A6 | 已修 | `rate-limit.ts` 新增 `publicModelPricingRead`；`server.ts` 在缓存响应之前限流 |
| A7 | 已修 | TS `upload.ts` 分区 + `rejectedUsageDates`；Go `contract.UploadIsoDateIssue` + `upload.go` |
| A8 | 已修 | `renameatomic` 拆 `busy_posix.go` / `busy_windows.go`（5/32/33） |
| A9 | 已修 | `command.go` 用 `limitedWriter` 限制 stderr |
| A10 | 已修 | 两侧 `preserveMissingCursorEntries(..., allRootsResolved)`，仅当全部 root 解析成功才回收 |
| A11 | 已修 | `readSessionLinesBounded`（64 MiB 单行上限），pi/grok-build/deepseek-harness 接入 |
| A12 | 已修 | TS `redirect: 'manual'`；Go `CheckRedirect: http.ErrUseLastResponse` |
| A13 | 已修 | `client-binary.mjs` `versionProbeTimeoutMs = 10_000` |
| A14 | 已修 | `sync.mjs` `spawnOptionsFor` + `killProcessTree`（POSIX 走进程组） |
| A15 | 已修 | `maxHookSyncTimeoutMs = 2_147_483_647` |
| A16 | 已修 | TS `foldToBaseModelId` 补 `-uncensored`/`-abliterated` 叠加循环，与 Go 对齐 |
| A17 | 已修 | TS `priceRowSignature` 递归 `sortJsonKeys` |
| A18 | 已修 | `packages/collector/src/endpoint.ts`（新）+ `clients/go/internal/cli/endpoint.go`（新），http 仅放行 localhost |
| A19 | **不修**（ccusage 内部行为，配置层无法覆盖） | 台账记录 |
| A20 | 已修（含 sol） | 见下 |
| A21 | 信息级，无需改动 | 台账记录 |

### A20 的第三例：gpt-5.6-sol 也是 reseller 价

LongCat 之外，`gpt-5.6-sol` 的 bundled pin 与两侧静态表同样写着 reseller 价（5/30/0.5/6.25，长上下文 10/45/1/12.5）。2026-10-28 用 `~/.tokenboard/bin/ccusage`（20.0.33 静态二进制）对合成 Claude Code session 实测，builtin 表是 **4/20/0.4/5，超过 272k 时整条请求按 8/30/0.8/10**：

- 100k input + 100k output → 2.4（4+20=24，5+30=35 不符）
- 100k cacheCreation + 100k cacheRead → 0.54（5+0.4=5.4，6.25+0.5=6.75 不符）
- 300k input + 100k output + 100k/100k cache → 6.48，正好是全部 token 按 8/30/0.8/10 计价（若按 10/45/1/12.5 应为 8.85）

models.dev 的 `openai` 行（`gpt-5.6-sol` 与 `gpt-5.6` 同价）也是 4/20/0.4/5 + 8/30/0.8/10 档，且 vercel 的 `openai/gpt-5.6-sol-fast` 行 8/40 恰为 4/20 的 2 倍，与 `fastMultiplier: 2` 自洽。5/30 只出现在 302ai / ai-router / commandcode / opper / pioneer / vivgrid / merge-gateway 这些 reseller 行。

改动：`packages/collector/ccusage.json` 与 `clients/go/internal/pricing/ccusage.json` 的 pin、TS `codex-context-pricing.ts`、Go `codex/context_pricing.go` 四处同改；`maxInputTokens` 保持 1050000（动态路径按 contextWindow 发，两侧仍一致）。测试期望按新费率重算，浮点差异处改用 `closeTo`/`assertCloseTo`。

### A2 为什么仍然不修

`-free`/`:free` 零价键遮蔽的是**合法免费变体**（catalogue 里的真实 modelId），而 ccusage 的键匹配是双向折叠：删掉这些键会让免费变体按付费价计费。master 与本分支的 103 个零价 `-free` 键集合完全相同，属既有行为。已在 `docs/model-pricing.md` 记为 Known limitation。

## 二轮收尾（2026-10-28 下午，升级与巡检）

### 已修

- **Go CLI 的 `Usage: Usage:` 重复前缀**：`parseArgsWithLookup` 对未知命令 `fmt.Errorf("Usage: %s", usageLine())`，而 `usageLine()` 本身已带 `Usage: `，导致每个未知命令都打印 `Usage: Usage: tokenboard ...`。改为 `errors.New(usageLine())`，与 TS 侧（单次前缀）一致；`TestUnknownCommandIsUsageError` 增加「不得重复前缀」断言，已验证改回旧写法即失败。exit 2（`ExitUsage`）为有意设计（见 `cli.go` 注释），与 TS 的 1 不同是**诊断性差异**，技能脚本只区分 0/75/其他，不属于协议。
- **本机 Go 对照二进制过期**：`~/.tokenboard/bin/tokenboard` 是 2026-10-23 的 0.1.0，只认 9 个来源，早于 12 个工具来源移植；影子双跑把它当 Go 侧，导致 12 个工具源全部报 `Invalid source`。已从当前分支构建并安装（`0.1.0-dev+a72bbff`），双跑变成 **3 match（claude-code 125 快照、codex 1、zcode 3）/ 13 empty / 0 diff / 0 error**，`--hook --source codex` 也 match。旧二进制备份挪到 `~/.tokenboard/deploy-backups/`（`bin/` 下 `tokenboard.backup-*` 前缀会被 `recoverOrphanedBinary` 在目标缺失时自动恢复，留着等于把旧版装回去）。
- **本机 `~/.tokenboard/ccusage.bundled.json` 是 10-18 的旧静态层**（sol 5/30）。Go 静态回退路径会按字节比较重写（`materializeBundledConfig`），已用一次性测试证明预置旧值会被覆盖；现直接刷新为 4/20。
- **431695 服务器 profile 的 `repoRef` 指向已删除分支**（`docs/device-identity-reconnect-plan`，origin/fork/upstream 上都不存在）。当前 activeServer 是 chaosyn 所以无影响，但切回 431695 再升级时 git fetch 与 archive 回退都会失败。已用 `mergeConfig` 把该 profile 的 `repoRef` 改为 `master`（与 chaosyn profile 一致），改动前备份在 `~/.tokenboard/deploy-backups/config-backup-*.json`；验证两个 profile 的 `uploadToken` 均保留、root 的 `clientType`/`activeServer`/`repoRef` 未变。

### 巡检确认正常（不改）

- `notify.cjs` 与当前源码 `buildNotifyHandler` 输出逐字节一致（mtime 旧不代表内容旧）。
- `~/.tokenboard/bin/ccusage` = 20.0.33，与两侧 pin 一致。
- `runs/` 1024 条上限生效（1025 个条目含 `.bounded-v1` marker）。
- 定时同步 2026-10-28 01:00/01:33/12:00 均成功，err 日志无 error/fatal 行。
- 旧 Go 二进制备份放在 `~/.tokenboard/deploy-backups/` 而非 `bin/`：`bin/` 下的 `tokenboard.backup-*` 会被 `recoverOrphanedBinary` 在目标缺失时当作已知可用版本恢复，留着等于把过期版本装回去。
