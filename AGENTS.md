# Repository Guidelines

本文件是 TokenBoard 仓库的 AI Agent 与贡献者执行指南。它同时记录项目架构约束、开发命令、测试口径和交付前检查要求。执行任务时以当前代码、测试结果、Git 记录和真实运行证据为准。

## Contributor Quick Reference

### 常用命令

```bash
pnpm install
pnpm dev
pnpm test
pnpm typecheck
pnpm build
pnpm preview
pnpm deploy
pnpm format
pnpm format:check
```

- `pnpm dev`：启动 Web 开发服务，等价于 `pnpm --filter @tokenboard/web dev`。
- `pnpm test`：运行 workspace 测试，包含 Web、collector、usage-core。
- `pnpm typecheck`：运行所有包的 TypeScript 类型检查。
- `pnpm build`：构建 Web Worker 客户端与服务端产物。
- `pnpm preview`：通过 Wrangler 本地预览 Worker。
- `pnpm run deploy`：执行生产部署脚本，包含配置校验、构建、D1 migration 和 Worker 发布。注意必须写 `pnpm run deploy`——`pnpm deploy` 会被 pnpm 内置同名命令拦截，不会执行本仓库脚本。
- `pnpm format`：按根目录 Prettier 配置格式化 JavaScript、TypeScript 和 JSON 源文件。
- `pnpm format:check`：检查上述文件是否符合统一格式，不修改工作树。
- `cd clients/go && go test ./... -race`：运行 Go 客户端（M0+M1 阶段）的测试；`go vet ./...` 与 `GOOS=windows go build ./...` 是跨平台改动的最小验证。
- `cd clients/go && go run ./cmd/tokenboard shadow --source <s>`：同 env 下跑 TS `preview` 与 Go 采集并做规范化 diff（需 `TOKENBOARD_COLLECTOR_DIR` 指向本仓库；正被写入的源用 `--until <昨天>` 避开活写竞态）；CI 的 `shadow` job 用 `cmd/shadow-fixtures` 生成的 fixture 跑 grok-build/pi/deepseek-harness/opencode 四个源，外加 claude-code/codex 与 12 个 ccusage 工具来源（后者在干净 HOME 下两侧都应报空，用来钉住子命令名映射）。
- `node scripts/clients-go-gen-goldens.mjs`：从 `packages/usage-core` 重新生成 Go 契约层的金样本（`clients/go/internal/contract/goldens/snapshot-hash.json`）；仅在 TS 侧 schema 变更时运行，输出需 diff 审查后提交。
- `node_modules/.bin/tsx scripts/clients-go-gen-pricing-goldens.mts`：从 TS 定价实现重新生成 Go 侧的 ccusage override 金样本（`clients/go/internal/pricing/goldens/ccusage-overrides.json`）；改动 catalogue 解析、歧义折叠、官方锚点、大小写别名或 above-200k 剥离后运行，输出需 diff 审查后提交。CI 会重跑两个生成脚本并对提交版做 diff，漂移即失败。
- `node skills/tokenboard/scripts/status.mjs`：检查本机 collector、设备身份、hook、计划任务和最近同步状态；输出应脱敏。
- `node skills/tokenboard/scripts/shadow-dual-run.mjs [--until <昨天>]`：生产双跑（spec §6.3）——逐源跑 `tokenboard shadow` 比较真实数据的 TS 与 Go 实现，结果追加进 `~/.tokenboard/logs/shadow-dual-run.jsonl`；不安装计划任务、不上传、不碰真实 cursor，只有 `diff`/`error` 才 exit 1。`shadow` 会把本机 `model-pricing-cache.json` 播种进两侧的临时 state 目录（缺失或损坏时两侧一起退回静态配置），所以动态定价路径也在比较范围内。
- `node --test skills/tokenboard/scripts/*.test.mjs`：运行 skill 脚本的 Node 测试；CI 在 `baseline-test`（ubuntu）与 `skill-windows`（windows-latest，只跑这套测试）各跑一遍，Windows 上 POSIX 权限类断言按设计跳过。

### 目录速览

- `apps/web/`：HonoX + Cloudflare Workers Web/API 应用。
- `apps/web/app/features/`：按业务 feature 组织的服务、查询、schema、组件和测试。
- `packages/collector/`：本地 Node.js collector，负责调用 `ccusage`、读取各工具本地 usage 记录并上传 snapshot。
- `packages/usage-core/`：跨端共享的 usage schema、normalize、hash 和工具函数。
- `clients/go/`：Go 客户端（M0–M6 已落地：`internal/contract` 契约与金样本、`internal/upload` 上传与 backoff、`internal/state` 运行锁、`internal/cli` 子命令、`internal/collect` 全部 21 个来源 provider（九个核心来源 + 12 个 ccusage 工具来源，后者由 `providers/ccusagetool` 参数化实现）与共享扫描/cursor 层、`internal/pricing` 动态定价目录、`internal/ccusage`/`codexusage` 外部工具调用、`internal/release` + `internal/selfupdate` 发布通道）。与 TS collector 共用 `collector-run.lock`、cursor 文件名和 `upload-backoff.json`，改动这些协议必须两侧同时验证（`docs/specs/go-client-spec.md`）。发布侧另有仓库根 `.goreleaser.yaml`（构建矩阵 3 OS × 2 arch）与 skill 的 `clientType`（`git`|`binary`，缺省 `git`）。
- `skills/tokenboard/`：Codex / Claude Code 安装、同步、hook、schedule 脚本。
- `apps/web/app/components/ui/`：通用 UI 原语；业务组件不要放这里。
- `apps/web/db/migrations/`：按序执行的 D1 migration；部署前必须核对 migration、Drizzle schema 和 `db/verify-*.sql`。
  migration 链是**手工维护**的（`meta/_journal.json` 被 gitignore 且为空），禁止对真实目录运行 `drizzle-kit generate`——它会无视现有编号另起一套 `0000_` 全量基线。已 apply 到生产的 migration 视为不可变：wrangler 只按文件名去重，不比对内容 hash，事后修改不会被察觉。
  已知偏差：`webhook_subscriptions`/`webhook_delivery_logs`/`daily_report_history`/`model_pricing_sync_state`/`usage_summary_backfill_state`/`user_usage_totals` 的 `TEXT PRIMARY KEY` 在 SQLite 终态里可空，而 `app/db/schema.ts` 声明 NOT NULL；所有写入都是手写 SQL 且显式绑非空主键，故无运行时影响，但不要依赖 `drizzle-kit generate` 的基线（它会据此产出重建表的假迁移）。
- `docs/model-pricing.md`：动态模型定价目录、缓存、回退、分页和部署说明。

### 提交与 PR

- 提交信息优先使用历史风格：`fix(...)`、`test(...)`、`docs:`、`feat(...)`。
- 每个 PR 必须说明改动范围、验证命令和风险边界。
- UI/Webhook 改动需要附截图或真实 webhook 发送验证结果。
- client/collector 改动需要覆盖 `pnpm -r test`、`pnpm -r typecheck`，并说明可复现的验证口径。

### Agent 工作基线

- 先读代码和配置，再改动；不要凭记忆推断当前状态。
- 修改前说明将改哪些文件和原因。
- 每次只处理一个原子任务，避免顺手改无关问题。
- 禁止静默降级、mock 成功、吞错继续或为了测试硬编码路径。
- 完成前必须运行最小充分验证，并用 `git diff` / `git status` 检查残留改动。

## 项目目标

TokenBoard 是一个面向多用户的 AI token 使用统计平台，而不是个人自部署工具。用户通过 TokenBoard skill 安装本机 collector，由 collector 采集 Claude Code、Codex 等 AI 工具的 usage 数据，并上传到托管在 Cloudflare Workers 上的 TokenBoard 后端。平台负责多租户存储、统计聚合、排行榜、公开展示和 README 接口。

第一阶段目标：

- 支持用户注册或创建个人上传 token。
- 支持 Claude Code、Codex、Antigravity CLI、Antigravity、Antigravity IDE、OpenCode、Pi、Grok Build、DeepSeek Harness，以及 amp、droid、codebuff、hermes、goose、kilo、copilot、gemini-cli、kimi、qwen、openclaw、zcode 十二个 ccusage 工具类 usage 来源（`packages/usage-core` 共 21 个来源枚举）。
- 通过 TokenBoard skill + collector CLI 调用 `ccusage`、`@ccusage/codex`，并从 Antigravity 三类本地历史中提取 token 元数据。
- Antigravity CLI 可额外通过官方 `statusLine.command` 写入脱敏本地诊断事件；该路径不参与 collector snapshot 或上传计量。
- 后端接收标准化后的 usage snapshot，并按用户、日期、来源、模型聚合。
- 提供统计 dashboard、公开 JSON API、GitHub README SVG 卡片。
- 提供每日、每月排行榜，例如 token 总量、费用、连续同步天数、模型使用分布等。

非目标：

- 不读取或上传原始对话内容。
- 不在 Cloudflare Worker 中直接访问用户本机 usage 文件。
- 第一版不做团队空间、付费订阅、复杂权限和实时同步。

## 技术栈

### Web 与 API

- Framework: HonoX
- Runtime: Cloudflare Workers
- Language: TypeScript
- Styling: Tailwind CSS
- UI components: shadcn/ui-compatible source components in `apps/web/app/components/ui`
- UI utilities: `class-variance-authority`, `clsx`, `tailwind-merge`
- Icons: Lucide via the `lucide` package, wrapped for Hono JSX in `apps/web/app/components/ui/icon.tsx`.
- Auth: Better Auth with GitHub OAuth as the only web sign-in method
- Validation: Zod
- ORM / SQL builder: Drizzle ORM
- Database: Cloudflare D1
- Cache / public config: Cloudflare KV
- Scheduled jobs: Cloudflare Cron Triggers

### 本地采集端

- TokenBoard skill: Codex / Claude Code 通知 hook 安装入口，以及 Antigravity CLI status line 采集安装入口
- CLI runtime: Node.js
- Usage source:
  - Claude Code: `ccusage`
  - Codex: `@ccusage/codex`
  - Antigravity CLI: `~/.gemini/antigravity-cli/conversations/*.db` 的 `gen_metadata.data` token 元数据；`~/.gemini/antigravity-cli/settings.json` 的 `statusLine.command` 仅写入本地脱敏诊断日志
  - Antigravity: `~/.gemini/antigravity/conversations` 的 SQLite token 元数据和 bounded language-server metadata projection
  - Antigravity IDE: `~/.gemini/antigravity-ide/conversations` 的 SQLite token 元数据和 bounded language-server metadata projection
  - OpenCode: `~/.local/share/opencode/opencode.db` 的 `message` 表，SQL 内投影 token 字段（`XDG_DATA_HOME` 可覆盖）
  - Pi: `~/.pi/agent/sessions/**/*.jsonl` 的 `usage` 与 `cost`（`PI_CODING_AGENT_DIR`、`PI_CODING_AGENT_SESSION_DIR` 可覆盖）
  - Grok Build: `~/.grok/{sessions,archived_sessions}/**/updates.jsonl` 的 `turn_completed` 事件（`GROK_HOME` 可覆盖）
  - DeepSeek Harness: `~/.dsh/sessions/**/session.jsonl[.zstd]` 的 `assistant/message` 事件（`DSH_HOME`、`DSH_SESSION_ROOT` 可覆盖）
- 数据上传：HTTPS `POST /api/v1/ingest`

### 部署

- Hosting: Cloudflare Workers
- Database migrations: Drizzle migrations for D1
- Secrets: Cloudflare Worker secrets
- Public assets and SVG responses should be generated by Worker routes unless static assets are clearly better.
- Model pricing is sourced from `https://models.dev/api.json`, synchronized into D1, and exposed at `/api/public/model-pricing`; `/api/v1/model-pricing` is the collector compatibility alias.
- The public `model-pricing` slug is reserved. Fixed API routes must take precedence over user slugs, and migration `0032_reserved_model_pricing_slug.sql` must be applied before deployment.

## 架构原则

### Worker 只做服务端能力

Worker 负责：

- 用户身份与上传 token 校验。
- 接收 usage snapshot。
- 校验、去重、upsert 聚合数据。
- 查询 dashboard 数据。
- 生成公开 JSON 和 SVG。
- 计算排行榜。

Worker 不负责：

- 扫描用户本地文件。
- 执行 `ccusage`。
- 保存原始聊天内容。
- 保存明文上传 token。

### 采集端只做本地能力

本地 skill/collector 负责：

- 调用 `ccusage` 或 `@ccusage/codex`。
- 从 Antigravity 三类本地历史中只提取 token、model、timestamp 和去重所需 hash。
- 通过 Antigravity CLI status line handler 读取 stdin，严格限长解析后只保存脱敏 JSONL。
- 将不同来源的数据 normalize 成 TokenBoard 的标准格式。
- 预览本地统计数据。
- 上传 snapshot。
- 记录最近同步状态。

Antigravity 三类来源特殊约束：

- `source` 固定使用 `antigravity-cli`、`antigravity`、`antigravity-ide`，不要用 `agy` 等别名上传。
- Antigravity CLI 展示名为 `Antigravity CLI (agy)`。
- status line 安装必须显式 opt-in，不包含在默认 `--source all` hook 安装中；但 `--source all` 可以读取本地 history metadata。
- status line handler 只能本地写入脱敏 JSONL，不能联网、上传、调用 sync，也不能保存 prompt、completion、cwd、workspace、email、plan_tier、工具参数、文件路径或原始 conversation_id。
- 脱敏 JSONL 仍包含稳定 conversation hash，应视为本机私有状态文件，不得作为公开 artifact 上传。
- SQLite `gen_metadata.data` 和 language-server response 只能投影 token 元数据字段；禁止保存 prompt、completion、promptSections、conversationHistory、路径、邮箱、工具参数、原始 conversation ID、原始 response ID 或完整 blob。
- `.pb` 文件仍不得直接作为上传来源；当前仅通过本地 language server 的 `GetCascadeTrajectoryGeneratorMetadata` 读取已结构化 metadata，并在 collector 内裁剪到 usage 字段。
- GUI/IDE language-server 扫描必须 bounded 且 cursor-based，默认 `--source all` 不得无界遍历全部历史。
- language-server response 中的 raw content 字段不能进入 cursor、snapshot、日志或上传 payload；测试必须覆盖原文不落盘。
- Antigravity placeholder model ID 可以保留为 model fallback；若 responseModel 存在，优先使用 responseModel。
- Antigravity 三类来源费用不可用，`costUsd` 只能置为 `0`，所有 Web、日报和排行榜费用展示必须标注该来源费用不可用，禁止从 credits 推算成本。

OpenCode / Pi / Grok Build / DeepSeek Harness 约束：

- `source` 固定使用 `opencode`、`pi`、`grok-build`、`deepseek-harness`。
- 本地读取位置：OpenCode 读 `~/.local/share/opencode/opencode.db`；Pi 读 `~/.pi/agent/sessions`；Grok Build 读 `~/.grok/{sessions,archived_sessions}`；DSH 读 `~/.dsh/sessions`。各自支持官方环境变量覆盖。
- 只投影 token、model、timestamp 和会话标识；禁止读取或保存 prompt、completion、回复正文、`replayState`、本地路径。
- OpenCode 的 `message.data` 同时含 prompt、回复和本地 `path`，必须在 SQL 内用 `json_extract` 投影 token 字段，禁止把整个 blob 读进 collector；查询必须以只读方式打开。
- SQLite 读取优先使用 Node 内置 `node:sqlite`（无需额外安装），运行时缺失时回退外部 `sqlite3`；显式设置 `TOKENBOARD_SQLITE_BIN` 表示强制走外部二进制。两条路径必须产出一致结果并有测试覆盖。
- 费用可用性：OpenCode 和 Pi 自报费用，可以直接使用；Grok Build 和 DSH 不提供费用，`costUsd` 只能置 `0`，禁止用定价表推算。
- 费用不可用来源统一由 `usage-core` 的 `costUnavailableSources` 声明；Web、SVG、日报、排行榜等**消费方**（标签、展示、费用列）必须由该常量派生，禁止硬编码来源列表。各 provider 在采集侧直接置 `costUsd: 0` / `costAvailable: false` 即可，`usageSnapshotSchema` 的校验会对这些来源的 `costUsd > 0` fail-closed 报错。
- Grok Build 的 `turn_completed` 是逐轮独立总量而非累计快照，必须按面值入账；禁止对相邻事件做差分。其 `inputTokens` 含 `cachedReadTokens`，必须减出 fresh input；`reasoningTokens` 已包含在 `outputTokens` 内，不得重复累加。
- Pi 的 session 文件是 `id`/`parentId` 树，fork 会复制共享历史，必须按 entry id 去重；usage 载体包含 assistant message、toolResult、compaction、branch_summary 四类。
- Pi 的 cache write 按 TTL 分两档：`cacheWrite` 与 `cacheWrite1h`，两者都属 cache creation，必须同时累加，漏掉后者会少记用量。订阅额度模型的 `cost` 各项为真实的 0。
- DSH 日志默认 zstd 且为拼接帧，Node 的 `zstdDecompress` 对整段拼接流只解第一帧（24.22 起改为全解，不能依赖任一行为），必须自行按帧头定界后逐帧解压；尾帧被写入截断属正常情况，不得视为错误。
- 扫描用户主目录下的 session 必须 bounded：限制递归深度、不跟随 symlink、跳过超限文件、逐行流式读取。
- 这四类来源不安装 hook，不得进入 hook mode 采集，也不得参与 hook cursor warm。
- 未安装的来源在 `--source all` 中按 unavailable 跳过；真实读取失败必须报错，禁止静默丢数据。

ccusage 工具类来源约束（amp、droid、codebuff、hermes、goose、kilo、copilot、gemini-cli、kimi、qwen、openclaw、zcode）：

- 这 12 个来源由参数化 provider 统一采集：`<tool> daily --json` 取总量、`<tool> session --json` 取 session 数，两侧实现都只有一份代码（TS `providers/ccusage-tools.ts`，Go `providers/ccusagetool`）。
- 子命令名固定为来源同名，唯一例外是 `gemini-cli` → `gemini`（ccusage 没有 `gemini-cli` 子命令，传错名会 exit 2 使整源失败）。命令名映射表两侧必须同时改。
- 工具未安装时 ccusage 以 exit 0 返回空 daily 报告（`{"daily":[],...}`），provider 据此直接返回空结果、**不发起 session 调用**；这条短路只认 `daily` 数组，比 normalize 的行提取更严格。
- 这 12 个来源不做动态定价 prepare（TS 侧同样不做），自报费用直接使用；它们不安装 hook，也不参与 hook cursor warm。
- `--until` 只对 `claude-code` 和 `codex` 生效，工具类来源传 `--until` 是用法错误（两侧 CLI 一致 fail-fast）。
- Go 侧 `contract.CcusageToolCommand`/`CcusageToolSources` 与 TS 的 `ccusageToolCommandNames`/`ccusageToolSources` 是同一契约；`TestUsageSourcesMatchUsageCore` 与 CI shadow 的 12 源循环钉住漂移。

### 跨端协议不变量（2026-10-28 审查后新增）

这些不变量一旦破坏就是静默计费分叉，两侧改动必须同步验证：

- **ccusage 子进程环境必须剥离凭据**（TS `command.ts` 经 `childProcessEnv`，Go `ccusage.scrubCredentialEnv`）。`npx`/`pnpm dlx` 会下载执行第三方包，`TOKENBOARD_UPLOAD_TOKEN`/`TOKENBOARD_PAIRING_CODE` 不得出现在其 env 里；新增 provider 时不要绕过这个过滤。
- **Codex 静态费率用运行时除法**：`internal/collect/providers/codex/context_pricing.go` 的 `codexDivisor` 是 `var` 而非 `const`——Go 对无类型常量表达式精确求值后舍入一次，JS 是 double 除法再舍入一次，`0.2/1e6` 一类字面量两边差 1 ULP，会让 `snapshotHash` 分叉、shadow 报 diff。`TestStaticRatesMatchTheJavaScriptDoubles` 钉住位模式。
- **公开端点 `/api/public/model-pricing` 有 IP 限流**（`publicModelPricingRead` 120/60s）。Worker Cache 只存 200，所以带随机 `cursor` 的请求每次都直达 D1，不能撤掉这道闸。
- **上传端点强制 https**，loopback（`localhost`/`127.0.0.1`/`::1`）例外（TS `endpoint.ts`，Go `cli/endpoint.go`）。上传请求一律 `redirect: 'manual'` / `CheckRedirect`（Go 同 host 异 port 会带 Authorization 转发）。
- **上传前过滤 usageDate 越界行**（usage-core `uploadIsoDateIssue`，Go `contract.UploadIsoDateIssue`）。服务端对整批 fail-closed，一行坏日期会把同批 30 行全堵死并触发 24h 上传暂停。
- **cursor 条目在「所有根都解析成功且未见于本次扫描」时回收**（TS `preserveMissingCursorEntries` 的 `allRootsResolved`，Go 同名参数）。pending 条目永不回收；根解析失败时全部保留。
- **ccusage 折叠语义是双向后缀剥离**，比 `foldToBaseModelId` 宽得多；两端实现必须保持同序同次数（见 `docs/model-pricing.md` 的「Known limitation」一节）。

### 新增 usage 来源的检查单

来源枚举有四处独立副本，任何一处漏改都是静默漂移（新来源能采集但漏比较、漏互斥或前端显示原始 slug）：

1. `packages/usage-core/src/schema.ts` 的 `usageSources`（唯一权威）与 `ccusageToolSources`（若属工具族）。
2. `skills/tokenboard/scripts/usage-sources.mjs` 的镜像。skill 脚本从 git checkout 直接跑、没有构建步骤，无法 import `@tokenboard/usage-core`，所以这份镜像必须手工同步；`usage-sources.test.mjs` 会解析 usage-core 的声明并在漂移时报错。定时重试的互斥锁集合与 `shadow-dual-run.mjs` 的可比源清单都由它派生，漏一处的后果是并发重试重复采集。
3. `clients/go/internal/contract/contract.go` 的 `Source` 常量、closed set 与 `allSources`，同时补 `contract_test.go` 里硬编码的 `usageCoreSources`。
4. 采集侧：TS 在 `providers/` 加 provider 并在 `cli.ts` 的 `collectAllSnapshots` 注册；Go 在 `providers/` 加包并加进 `collect/providers/providers.go` 的 blank import（漏这一步 `--source all` 会静默跳过并 exit 0，`TestEveryContractSourceHasAProvider` 专门守这条）。

另外别忘：`apps/web/app/features/usage/source-format.ts` 的展示名（漏了会显示原始 slug）；费用不可用来源必须由 `costUnavailableSources` 派生而不是硬编码。

## 数据模型规范

所有上传数据必须先标准化为统一 usage snapshot。后端只接收标准格式，不在 API route 中写来源特定解析逻辑。

标准字段建议：

```ts
type UsageSource =
  | "claude-code"
  | "codex"
  | "antigravity-cli"
  | "antigravity"
  | "antigravity-ide"
  | "opencode"
  | "pi"
  | "grok-build"
  | "deepseek-harness"
  | "amp"
  | "droid"
  | "codebuff"
  | "hermes"
  | "goose"
  | "kilo"
  | "copilot"
  | "gemini-cli"
  | "kimi"
  | "qwen"
  | "openclaw"
  | "zcode";

type UsageSnapshot = {
  source: UsageSource;
  usageDate: string;
  timezone: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  costUsd: number;
  sessionCount: number;
  collectedAt: string;
};
```

D1 聚合表 `daily_usage` 以 `(user_id, device_id, source, usage_date, model)` 五元键作为幂等 upsert key（`device_id` 自 0004 起，缺省 `legacy`），避免重复上传造成重复累计；跨设备的读侧聚合表 `daily_usage_summary` 才是 `(user_id, usage_date, source, model)` 四元键。

排行榜数据应优先从聚合表计算。只有当查询成本过高时，才增加 leaderboard snapshot 表或 KV cache。

## API 规范

API 使用 `/api/v1` 前缀。公开接口使用 `/api/public` 前缀。

建议路由：

```txt
POST /api/v1/ingest
GET  /api/v1/me
POST /api/v1/device/pairing-codes
POST /api/v1/device/pair
GET  /api/v1/summary
GET  /api/v1/daily
GET  /api/v1/models
GET  /api/v1/leaderboards/daily
GET  /api/v1/leaderboards/monthly
GET  /api/public/:slug.json
GET  /api/public/:slug.svg
```

当前还包括：`GET /api/v1/health`、`POST /api/v1/ingest/check`、`GET /api/v1/model-pricing`、
`POST /api/v1/model-pricing/sync`、`GET /api/public/model-pricing`、`POST /api/v1/public-card/preview`
以及设备配对/重连接口。具体行为以 `apps/web/app/routes/` 和对应
feature service 为准，不要只依据本节示例添加路由。

其中 `GET /api/v1/summary`、`GET /api/v1/daily`、`GET /api/v1/models`、
`GET /api/v1/leaderboards/{daily,monthly}` **尚未实现**（线上返回 404）：dashboard 与排行榜的数据由
HonoX 页面路由和 `/leaderboards/fragment` 直接渲染，不经这些 JSON 端点。它们只是保留的候选路径，
不要假设可用。

接口规则：

- 所有写接口必须鉴权。
- 上传接口使用 `Authorization: Bearer <upload_token>`。
- token 只保存 hash，不保存明文。
- 所有请求 body、query、params 必须用 Zod 校验。
- API 错误返回稳定结构：

```ts
{
  error: {
    code: string;
    message: string;
  };
}
```

## 鉴权规范

项目统一使用 Better Auth 作为 Web 用户鉴权框架。选择原因：

- Better Auth 是 TypeScript-first 的鉴权框架。
- Better Auth 有官方 Hono 集成方式。
- Hono 官方示例包含 Better Auth on Cloudflare Workers，和当前 HonoX + Cloudflare Workers 技术栈匹配。

鉴权边界：

- Web dashboard、settings、profile 使用 Better Auth session。
- 上传 usage 的采集端不使用用户网页登录 session，而使用用户生成的 upload token。
- upload token 必须绑定用户，只展示一次，服务端只保存 hash。
- public JSON、SVG、排行榜接口不要求登录，但必须遵守用户公开配置。

建议路由：

```txt
/api/auth/*
/settings/profile
/settings/devices
/settings/notifications
/settings/install
```

Better Auth 相关代码必须集中在 `apps/web/app/features/auth`，不要散落在业务 feature 中。业务代码通过封装后的 `requireUser`、`getOptionalUser`、`verifyUploadToken` 使用鉴权能力。

## 多用户与隐私规范

- 每条 usage 记录必须绑定 `user_id`。
- 默认统计数据为私有。
- 公开 JSON、SVG、排行榜展示必须由用户显式开启。
- 排行榜默认只展示公开用户。
- 公开用户名、头像、slug 等 profile 字段必须和认证身份分离。
- 不上传原始 prompt、completion、文件路径或会话正文。
- 如需展示模型明细，应只展示模型名、token、费用、日期等统计数据。

## 排行榜规范

第一版支持：

- Daily token leaderboard
- Monthly token leaderboard
- Daily cost leaderboard
- Monthly cost leaderboard
- Source split leaderboard，例如 Claude Code / Codex 使用占比

排行榜必须考虑：

- 只统计公开参与排行榜的用户。
- 以用户配置的 timezone 归属日期。
- 防止重复上传，依赖 daily aggregate upsert。
- 对异常值预留标记能力，例如未来加入 anti-abuse 审核字段。

## 前端页面规范

页面应以产品实际功能为第一屏，而不是营销落地页。

Dashboard 第一版包含：

- 今日 tokens / 今日费用
- 本月 tokens / 本月费用
- Claude Code 与 Codex 来源分布
- 模型分布
- 最近 30 天趋势
- 最近同步时间
- 公开资料和 README card 配置入口

排行榜页面包含：

- Daily / Monthly tabs
- Tokens / Cost tabs
- 用户名、排名、token、费用、主要模型、来源占比
- 当前用户排名高亮

UI 规范：

- 信息密度适中，优先清晰可扫读。
- 使用表格、tabs、segmented controls、tooltips、icon buttons。
- 避免装饰性过强的 card 堆叠。
- 不在页面里写大段说明性文案。
- 统计图表必须有空状态、加载状态和错误状态。

## 目录结构规范

项目目录采用 feature-based 风格。业务代码优先按功能域组织，而不是按技术类型平铺。每个 feature 内部可以包含自己的 route、组件、查询、schema、service 和测试。

共享代码只放真正跨 feature 复用的能力，例如 DB client、通用 UI、日期金额格式化、错误类型、配置读取。

```txt
apps/web/
  app/
    routes/
      api/
        v1/
        public/
        auth/
      dashboard/
      leaderboards/
      reports/
      settings/
    features/
      auth/
        auth.ts
        middleware.ts
        service.ts
      device/
        schema.ts
        service.ts
        components/
      ingest/
        schema.ts
        service.ts
        repository/
          upsert.ts
          backfill.ts
      notifications/
        schema.ts
        service.ts
        queries/
        components.tsx
      model-pricing/
        service.ts
        repository.ts
        validation.ts
      usage/
        schema.ts
        queries.ts
        service.ts
        components/
      leaderboards/
        schema.ts
        queries.ts
        service.ts
        components/
      public-card/
        svg.ts
        service/
        config.ts
      settings/
        schema.ts
        service/
        components/
  app/db/
    schema.ts
  db/
    migrations/
  lib/
    db.ts
    errors.ts
    http.ts
    time.ts
    timezone.ts
    money.ts
    crypto.ts
    rate-limit.ts
    security-headers.ts
    theme.ts
    usage-cost.ts
    usage-metrics.ts
  components/
    ui/
    charts/

packages/usage-core/
  src/
    schema.ts
    normalize.ts
    money.ts
    dates.ts
    index.ts

packages/collector/
  src/
    providers/
      claude-code.ts
      codex.ts
      opencode.ts
      pi.ts
      grok-build.ts
      deepseek-harness.ts
      ccusage-tools.ts
      bounded-session-scan.ts
      session-usage-aggregate.ts
      session-jsonl-parser.ts
      session-cursor-store.ts
      hook-incremental.ts
      sqlite-reader.ts
      zstd-frames.ts
      antigravity-cli.ts
      antigravity-cli-cursor.ts
      antigravity-cli-history-authority.ts
      antigravity-gui.ts
      antigravity-gui-cursor.ts
      antigravity-gui-client.ts
      antigravity-history-db.ts
      antigravity-history-protobuf.ts
    upload.ts
    config.ts

skills/tokenboard/
  SKILL.md
  scripts/
    setup.mjs
    sync.mjs
    install-collector.mjs
    install-schedule.mjs
    coordinator.mjs
    client-binary.mjs
    usage-sources.mjs
    antigravity-hook.mjs
    antigravity-statusline.mjs
    uninstall.mjs
    upgrade.mjs
    status.mjs
```

目录规则：

- 新业务优先新增或扩展 `features/<feature-name>`。
- route handler 只负责 HTTP 输入输出、调用 feature service、返回 response。
- feature service 放业务流程；repository 或 queries 放数据库访问。
- 不允许在多个 feature 中复制相同业务逻辑，应上提到 `usage-core` 或 `apps/web/app/lib`。
- `app/lib` 只放无业务归属或跨 feature 的基础设施代码。
- `app/components/ui` 放通用 UI 原语，具体业务组件放各自 feature 的 `components/`。
- `packages/usage-core` 不依赖 HonoX、Cloudflare 或数据库。

## TypeScript 规范

- 开启 strict mode。
- 公共数据结构放在 `packages/usage-core`。
- 外部输入一律用 Zod parse 后再进入业务逻辑。
- 不在 route handler 中堆业务逻辑，复杂逻辑下沉到对应 feature 的 `service.ts`、`queries.ts` 或 package。
- 金额统一用 USD number 存储和展示，计算时保留必要精度，展示时格式化。
- 日期统一用 ISO date string，例如 `2026-04-28`。
- 后端聚合必须显式传 timezone，不依赖 Worker 运行环境时区。

## 命名规范

- 数据库字段使用 snake_case。
- TypeScript 字段使用 camelCase。
- route path 使用 kebab-case。
- usage source 使用稳定枚举值（全集以 `packages/usage-core/src/schema.ts` 的 `usageSources` 为准，共 21 个）：`claude-code`、`codex`、`antigravity-cli`、`antigravity`、`antigravity-ide`、`opencode`、`pi`、`grok-build`、`deepseek-harness`、`amp`、`droid`、`codebuff`、`hermes`、`goose`、`kilo`、`copilot`、`gemini-cli`、`kimi`、`qwen`、`openclaw`、`zcode`。
- user-facing slug 必须全局唯一。

## 测试规范

优先覆盖：

- usage normalize
- ingest schema validation
- idempotent upsert
- timezone date attribution
- leaderboard ranking
- public/private visibility rules
- SVG generation output

测试不需要依赖真实 `ccusage` 输出时，应使用 fixture JSON。

## 安全规范

- 上传 token 只显示一次。
- 服务端只保存 token hash。
- 公开接口必须避免泄露邮箱、内部 user id、上传 token、同步元数据中的敏感字段。
- 对 ingest 接口加 rate limit 或等价保护。
- 模型价格手动同步接口必须先做可用性限流检查，再验证 bearer token；无效凭证和有效同步 token 使用不同限流策略。
- 对 README SVG route 设置合理 cache header。
- 对排行榜查询设置分页或 limit。

## 开发流程

- 先确定数据模型，再实现接口。
- 先实现 `usage-core`，再实现 collector，最后接 Worker route。
- 每个来源 provider 必须只负责采集和 normalize，不直接操作数据库。
- 任何新增公开字段，都要同时检查 dashboard、public JSON、SVG 和排行榜的隐私影响。
- 重要行为变更需要补测试。
- 动态定价只作用于新采集；不得自动重算历史 `costUsd`。hook 模式不得发起网络请求，应使用缓存或 bundled 静态配置。
- 部署模型定价前，`deploy.mjs` 的实际顺序是：配置校验 → build → dry-run → **生产路由检查** →
  按序应用全部待执行 migration（当前到 `0038`）→ 四项 schema 校验（`verify-critical-schema.sql`、
  `verify-rate-limit-index.sql`、`verify-retention-index.sql`、`verify-foreign-keys.sql`）→ 发布。
  每步 fail-fast（`spawnSync` 非零即 `process.exit`）。

## 交流约定

- 默认使用简体中文沟通。
- 修改代码前先说明将修改的文件和意图。
- 遇到读取错误或乱码文件时，使用 `jiemi.exe <文件路径>` 解密后再读取。
- 不确定的外部 API、第三方库行为或 Cloudflare 平台限制，需要查官方资料后再下结论。

## AI Agent Coding Practices

### 证据优先

- 回答“是否同步上游”“是否还有问题”“client 是否正常”前，必须重新执行相关检查命令。
- 上游状态检查使用：

```bash
git fetch --all --prune
git status --short --branch
git rev-list --left-right --count master...upstream/master
git rev-list --left-right --count master...origin/master
```

- 运行状态结论必须基于真实命令输出，例如 `node skills/tokenboard/scripts/status.mjs`、`ccusage --version`、`curl -I` 或调度器状态。
- macOS 计划任务位于 `~/Library/LaunchAgents/com.tokenboard.daily-sync.plist`；Linux 使用 systemd user timer，Windows 使用按时段拆分的计划任务。同步状态保存在配置目录的 `scheduled-sync-state.json`（非 `all` 来源可能带来源后缀）。

### 验证闭环

- Web/API 改动至少运行相关测试；跨 feature 改动运行 `pnpm test` 和 `pnpm typecheck`。
- collector 或 skill 改动至少运行 `packages/collector`、`packages/usage-core` 和 `skills/tokenboard/scripts` 相关测试。
- Cloudflare/D1/Better Auth/Webhook 行为不要只靠类型检查；需要 HTTP、浏览器或真实 webhook 验证。
- 生产验证必须区分本地测试、隔离 Worker、私人 Cloudflare 和真实生产渠道；HTTP 200、旧部署或空 reviewer 输出不能替代当前候选验收。
- 修复网络或服务问题时，同时验证进程状态、路由/DNS、真实请求和 TokenBoard 业务命令。

### 配置与安全

- 不要把用户提供的 webhook、token、OAuth secret、Cloudflare secret 写入源码或文档。
- 调试时可以临时使用用户提供的密钥，但输出日志和总结时必须脱敏。
- `WEBHOOK_ENCRYPTION_KEY` 必须作为 Worker secret 配置，不要提交本地生产配置文件。

### Client 与兼容性注意事项

- collector 依赖外部 usage 工具；升级相关依赖时必须同步更新 provider 测试、package-runner 测试和 `pnpm-lock.yaml`。
- 判断 client 健康状态时，区分 client 代码问题、主机网络问题和用户未配置问题。
- TokenBoard 定时同步日志默认位于用户配置目录下的 `logs/daily-sync.out.log` 和 `logs/daily-sync.err.log`。
- 项目要求 Node.js `^22.23.4 || ^24.22.1 || >=26.12.1`、pnpm `10.21.0`；根 `.npmrc` 设 `engine-strict=true`，且 `setup.mjs`/`sync.mjs`/`install-collector.mjs` 入口会硬拒更低版本（安全下限，见 `skills/tokenboard/scripts/node-version.mjs`）。改这条线要同步四个 `package.json` 的 `engines`、`.npmrc`、README 和 SKILL.md 的排障文案，`node-floor-docs.test.mjs` 会守住一致性。collector 依赖外部 `ccusage`/`@ccusage/codex`，缺少本地来源应按 unavailable 处理，不能创建空目录伪造成功。
