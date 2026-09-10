# Private model pricing deployment verification

文件名中的 `2026-08-07` 为原始创建日期；本记录的验证期间为 2026-08-09 至 2026-08-16（Asia/Shanghai）。

验证日期：2026-08-09 至 2026-08-16（Asia/Shanghai）

## 范围

- Worker：`<private-worker-origin>`
- D1：`<private-d1-database>`
- 价格源：`https://models.dev/api.json`
- 同步方式：Worker Cron 每 15 分钟触发，D1 状态行限制实际同步间隔为 24 小时；另有受保护的手动同步接口
- 本次验证没有创建 GitHub commit 或 pull request 自动化任务

## 本地门禁

- `pnpm test`（macOS）：通过；usage-core 9/9、Web 634/634、collector 708 通过，3 个既有平台测试跳过
- `pnpm typecheck`：通过
- `pnpm build`：通过
- `node --test skills/tokenboard/scripts/*.test.mjs`：470/470 通过
- `ccusage`：npm 最新版本核对为 `20.0.20`，与 collector 依赖一致；真实 CLI `--config`、Codex `--speed auto` 参数可用
- Codex 字段契约：真实 `token_count` 记录确认 `last_token_usage` 为单次请求增量；collector 同时兼容旧格式和缓存字段独立的新格式，不重复扣减；纯 metadata 总量行不参与计价
- 生产配置检查：通过（默认生产配置和私人配置）
- `wrangler deploy --dry-run --config <private-wrangler-config>`：通过，确认 DB、ASSETS、价格源变量和 `*/15 * * * *` Cron
- `git diff --check HEAD`：通过
- 部署快照当时的 models.dev 探针：171 个 provider、5816 个含数字 input/output 价格的模型，最新模型更新时间为 `2026-08-06`；2026-08-09 重新探针为 172 个 provider、5823 个模型，说明上游已在部署快照之后新增目录项，等待下一次 24 小时 Cron 刷新
- 官方文档 URL 防 SSRF 回归：拒绝 `0.0.0.0/8`、`100.64.0.0/10`、IPv6 回环/未指定地址，以及 IPv4-mapped/compatible、6to4 IPv6 指向的私网、回环地址；Web source 测试 16/16 通过
- Codex archived_sessions 稳定扫描：278 个文件、29 个 context-pricing 汇总行，覆盖 18 个日期和 5 个模型；活动 sessions 全量扫描因文件在读取期间变化按设计中止，不作为全量扫描通过证据

## 私人 Worker 部署

- D1 migration `0030_model_pricing.sql` 和 `0031_model_pricing_staging.sql`：已应用
- 远程关键 schema 检查：通过，staging 表当前为 0 行
- Worker 版本（历史快照）：私人版本标识已省略；2026-08-09 收尾发布版本见下文
- Cron：`*/15 * * * *`
- `TOKENBOARD_MODEL_PRICING_SYNC_TOKEN`：已配置；本文不记录 Secret 值
- Cron 已真实执行价格同步：模型数量从 58 增至 5816，`last_success_at` 为 `2026-08-08T07:00:12.000Z`，`last_source_updated_at` 为 `2026-08-06`，`last_error` 为 null

## 真实接口验证

- `GET <private-worker-origin>/api/v1/health`：HTTP 200，返回 `ok: true`
- `GET /api/public/model-pricing?limit=2`：HTTP 200；响应只包含 `models` 和 `nextCursor`，不泄露同步状态、错误或锁信息
- `GET /api/v1/model-pricing?limit=2`：HTTP 200，与公开路径兼容，响应字段相同
- `GET /api/public/model-pricing?provider=openai&limit=2`：HTTP 200，provider 过滤生效
- `GET /api/public/model-pricing?includeInactive=1&limit=2`：HTTP 200，历史目录分页生效
- 首屏 ETag 配合 `If-None-Match`：HTTP 304；首屏游标请求下一页：HTTP 200
- 伪造游标：HTTP 400，返回 `BAD_REQUEST`，不会错误映射为 500
- 线上健康探针：`GET /api/v1/health` HTTP 200；公开价格目录和兼容别名均 HTTP 200，公开响应键仅为 `models`、`nextCursor`
- 分页游标：首屏、后续页、provider 筛选、`includeInactive=1` 和重复请求探针均通过；游标过滤条件不匹配时显式报错
- `gpt-5.6-sol`：输入 `$5/M`、输出 `$30/M`、cache read `$0.5/M`、cache write `$6.25/M`；context window `1,050,000`，max input `922,000`，max output `128,000`
- `gpt-5.6-sol` 的 272K 上下文分层价格保留在 `pricing` 和 `pricingJson` 中，没有误写成 128K 或模型上下文窗口
- 国产模型目录：已随 5816 条全量目录同步，provider、模型 ID、价格、上下文和官方文档链接均保留

## 2026-08-09 收尾发布复核

- 私人配置 dry-run：通过；读取 10 个静态资源，确认 D1、ASSETS、价格源变量和 `*/15 * * * *` Cron 绑定。
- 私人 Worker 发布：成功，域名已脱敏。
- 证据分类：本次发布来自当时的 dirty worktree，只能作为私人环境验证和运行态探针；它不是
  可复现的 release artifact，也不能证明某个 Git commit 已发布。正式 release 必须从固定 commit
  或不可变 artifact 部署，并单独记录其来源摘要。
- 现网健康探针：`GET /api/v1/health` HTTP 200。
- 现网价格目录：首屏 HTTP 200，响应键仍仅为 `models`、`nextCursor`；DeepSeek provider 过滤返回 4 个模型；`gpt-5.6-sol` 返回 input `$5/M`、output `$30/M`、context `1,050,000`，并保留 272K 分层价格对象。
- 现网缓存：`Cache-Control: public, max-age=60, stale-while-revalidate=300`；使用同一 ETag 的条件请求返回 HTTP 304；大写 provider 返回 HTTP 400。
- D1 同步状态：当前 active generation 仍为上一次成功的 5816 条快照（最后成功时间 `2026-08-08T07:00:12.000Z`），尚未达到 24 小时同步间隔；本次发布未强制改写历史价格代次。

## 费用语义复核

- Antigravity 三类来源的 `costUsd: 0` 不被当作免费价格
- dashboard、详情、CSV、日报和 webhook 均保留费用不可用标记
- public JSON 和 SVG 保留来源级费用可用性字段
- 排行榜费用聚合排除 Antigravity 成本；周期内只要混入 Antigravity 来源，费用列标记为不可用，不将部分可计费金额误报为完整费用
- webhook 日报查询和格式化测试覆盖同一模型同时来自 Codex 与 Antigravity 的场景

## 部署与外部复核边界

- 直连 Cloudflare API 曾因 SSL 超时；本轮部署只在当前进程临时使用本机代理，未写入项目或全局配置。
- 一次未显式指定配置的部署尝试使用了未配置的 Worker 域名，Cloudflare 返回找不到 zone，Worker 上传但未绑定该路由；未切换私人 Worker 流量。随后使用私有 Wrangler 配置成功发布到已脱敏的私人 Worker，版本见上文。
- Claude Code `2.1.220` 完成当前差异的只读审查，结论为 `NO_ACTIONABLE_FINDINGS`；其列出的低风险建议已逐项核对。本轮进一步补强 IPv4-mapped/compatible IPv6 文档 URL 防御、分页 LIMIT 参数绑定，并让 Codex 复用唯一模型 ID 规范化函数。
- OMP `17.1.8` 使用 `newapi-responses/grok-4.5` 完成只读复核，进程退出码为 0 并读取了当前工作树。其报告提出的迁移 wiring、D1 批处理竞态、Codex priority 费率、重复 token_count、分页游标、官方 URL SSRF 和费用消费者建议均逐项对照代码与回归测试：迁移 0030/0031 已按 Wrangler migrations_dir 顺序部署，SQLite 测试已加载两份迁移，分页游标已做十六进制和 UTF-8 fail-closed 校验，priority 与 fast 采用同一 provider multiplier 是当前定价契约，重复同值事件保留 occurrence 是避免合法同时间请求漏计的设计，费用不可用语义已有 dashboard、日报、webhook、public JSON、SVG、CSV 覆盖；未确认可复现的新增缺陷，不将未证实建议当作通过依据。

## 本轮增量验证

- Web 价格 API、SQLite 分页和同步限流定向测试：通过；Codex context pricing 与多 profile hook 定向测试：通过。
- workspace 全量测试（macOS）：usage-core 9/9、Web 634/634、collector 708 通过，3 个既有平台测试跳过；类型检查、生产构建、skill 脚本测试 470/470 和高危依赖审计均通过。
- 本轮新增回归：多 profile 同名匿名会话隔离、子代理累计首行基线（含缺失 parent id）、过期同步 owner 不得删除新 generation staging、原始 JSONL 删除后 context-priced pending 快照不得以零费用上传；定向测试全部通过。
- `listModelPricing` 使用绑定参数传递 `LIMIT`，不再把经过校验的页大小拼接进 SQL 文本；分页行为由 SQLite 合同测试覆盖。

## 结论

价格源抓取、D1 staging 原子替换、Cron 自动同步、手动刷新鉴权、分页公开接口和所有已核对的费用消费者均已完成本地及私人 Worker 验证。`models.dev` 是维护型机器注册表，不是厂商自有 API；系统同时保存官方文档链接，后续价格变化由 Worker 直接更新 D1，不需要提交 PR。

## 三端与文本格式门禁

- macOS：workspace 测试、类型检查、生产构建、高危依赖审计和 skill 脚本测试均通过。
- Linux 远程测试主机（地址已脱敏）：Node `v24.14.0`、pnpm `10.21.0`；workspace 测试、类型检查、生产构建和 `node --test skills/tokenboard/scripts/*.test.mjs`（470/470）通过。
- Windows 远程测试主机（地址已脱敏，早期完整测试批次）：Node `v24.14.0`、pnpm `10.13.1`；workspace 测试（usage-core 9/9、Web 630/630、collector 683/703，20 个既有平台测试跳过）、类型检查和生产构建通过，collector binary 与 Windows command runner 实机用例通过。该批次与下方仅运行时探针的版本记录分开，不将两者混作同一次测试。
- Windows skill 验证需要区分两次运行：早期宿主夹具运行曾为 402/470 通过、4 个跳过、64 个失败，失败集中在将 POSIX 虚拟路径、Unix notifier 文本或 POSIX archive mock 当作 Windows 宿主路径的测试夹具；随后在修正宿主路径和运行器边界后对当前快照复跑为 466/470 通过、4 个跳过、0 个失败。生产 collector、binary、workspace 测试和显式 Windows 运行器用例均通过；早期夹具失败仍作为历史证据保留，不作为当前生产兼容性失败。
- 本轮对当前变更文件执行 `git diff --check HEAD`，未发现空白错误；扫描未发现 UTF-8 BOM 或 CRLF。源码和配置保持 ASCII/UTF-8，文档中的中文使用 UTF-8，生成的 JSON、TOML、SQL 和脚本保持 LF 换行。

## 2026-08-11 续接复核

- `pnpm test`：通过；usage-core 9/9、Web 634/634、collector 712 通过，3 个既有平台测试跳过。
- `pnpm typecheck`：通过；`pnpm build`：通过；`node --test skills/tokenboard/scripts/*.test.mjs`：472/472 通过。
- `pnpm audit --audit-level=high`：通过，报告 `No known vulnerabilities found`；`git diff HEAD --check`：通过。
- OMP 只读复核返回未发现确定性问题，但明确未运行测试、类型检查或真实 D1 并发验证，因此只作为静态交叉意见，不替代本地门禁。
- Claude `claude ultrareview --json` 本轮返回 `Ultrareview is currently unavailable`，不计为复核通过；本轮没有新的 CodeRabbit 完成报告。

## 2026-08-14 当前候选复核（部署前快照）

本节只记录当前 `feat/model-pricing-maintenance` dirty worktree 在本轮部署前的可复验结果，
不修改或重述此前私人 Worker 的部署版本。下方“Edge 运行态修复与当前候选部署”记录了随后
完成的部署和真实 Cron 验证；本节中的未部署边界仅适用于本节采集时刻。

- 实时 `https://models.dev/api.json` 探针（2026-08-14 15:25，Asia/Shanghai）：原始 payload 为
  185 个 provider、6,319 个模型记录；使用当前 Worker normalizer 后接受 175 个 provider、
  5,900 个含数字 input/output 价格的模型，最新模型更新时间为 `2026-08-14`。
- 当前本机门禁：`pnpm test` 为 usage-core 9、Web 636、collector 727（3 个既有平台测试跳过）；
  `pnpm typecheck`、`pnpm build`、`node --test skills/tokenboard/scripts/*.test.mjs`
  （476/476）、`pnpm audit --audit-level=high` 和 `git diff --check HEAD` 均通过。
- 本机 Node `v24.19.0`、pnpm `10.21.0`；`node skills/tokenboard/scripts/status.mjs` 显示现有
  server profile、collector、device identity、四个 schedule、Codex/Claude hooks 和 Antigravity
  GUI/IDE 本地历史均正常，scheduled retry 为 `completed`。
- Claude、OMP 和 CodeRabbit 本轮没有产生可作为当前候选通过收据的完整结果；任何限流、不可用、
  空输出或旧缓存均不计为审查通过。

## 2026-08-14 Edge 运行态修复与当前候选部署

- 当前候选已通过私人配置检查、Wrangler dry-run、远程迁移检查和关键 schema 校验；D1 无待应用迁移，
  `model_pricing`、`model_pricing_staging` 和 `model_pricing_sync_state` 结构与当前迁移一致。
- 首次发布后，私人 Worker 的 Cron 暴露了实际兼容性问题：
  Cloudflare Workers 不接受 `fetch` 的 `redirect: "error"`，同步状态记录为失败，旧 active generation
  保持不变。
- 修复将价格源请求改为 `redirect: "manual"`，并对所有 3xx 响应显式失败，不读取或跟随未校验的
  `Location`；价格源回归测试覆盖请求选项和 302 拒绝语义。
- 修复后版本已发布到私人 Worker，域名已脱敏；其 D1 绑定数据库和名称均已脱敏，Cron 仍为 `*/15 * * * *`。
- 真实 Cron 于 `2026-08-13T18:30:56.000Z` 成功执行：D1 状态为 `success`，`model_count=5877`，
  `last_source_updated_at=2026-08-13`，`last_error=null`，active generation 已更新。
- 修复后现网健康接口 HTTP 200；公开价格分页、ETag 304、DeepSeek 过滤、OpenAI `gpt-5.6-sol`
  的 272K 分层价格和 `/api/v1/model-pricing` 兼容别名均通过验证。
- 本轮本地门禁：workspace usage-core 9、Web 636、collector 727（3 个既有平台测试跳过）；
  类型检查、生产构建、skill 脚本 476/476、高危依赖审计和 `git diff --check HEAD` 均通过。
- Claude `2.1.231` 因 API 连接被防火墙/代理拒绝，未产生审查报告；OMP `17.3.0` 使用配置的
  `newapi-chat-completions/grok-4.6` 连续重试后渠道不可达，未产生 finding；两者均不计为外部复核通过。

## 2026-08-16 当前候选最终复核与部署

- 本轮新增输入边界加固：价格源拒绝模型 ID 和 displayName 中的控制、格式及代理字符；Codex
  模型日期后缀仅在组成真实 `YYYYMMDD` 日历日期且模型前缀非空时归一化；价格分页游标采用同等
  Unicode fail-closed 校验。新增及相关回归测试通过。
- 本机质量门禁：`pnpm test` 通过，usage-core 9/9、Web 646/646、collector 751 通过，3 个既有
  平台场景按设计跳过；`pnpm typecheck`、`pnpm build`、`node --test skills/tokenboard/scripts/*.test.mjs`
  482/482、`pnpm audit --audit-level=high` 和 `git diff --check` 均通过。未发现 UTF-8 BOM 或 CRLF。
- Wrangler 已升级并实际安装为 `4.123.0`，`@cloudflare/workers-types` 配套升级为 `5.20260815.1`；
  锁文件已刷新，peer 依赖一致。
- 私人配置检查和 Wrangler dry-run 通过；远程 D1 无待应用迁移，关键 schema 校验通过。当前候选已
  发布到私人 Worker，Worker 版本标识、域名和 D1 名称均已脱敏，Cron 为 `*/15 * * * *`。
- 部署追溯：Cloudflare 记录的发布时间为 `2026-08-16T16:01:28.731437Z`；不在文档保存私人
  deployment/version ID。基于部署时间、私有 Wrangler 配置文件名、Cron、价格源和内部部署记录生成的
  不可逆指纹为 `sha256:e597fa418e472a46576fb4695af904ecbbd8e4ff288166db5fa95b93015e6908`，用于将本节
  线上探针与同一部署记录关联。该部署来自当时的 dirty worktree，属于非 release 验证证据，不能伪称
  为单一 Git commit 或不可变发布物。
- 线上探针通过：`GET /api/v1/health` 返回 200；公开价格目录和 `/api/v1/model-pricing` 兼容接口
  返回 `models`、`nextCursor`；首屏 ETag 条件请求返回 304；DeepSeek provider 过滤只返回 DeepSeek；
  `gpt-5.6-sol` 返回 context `1,050,000` 和 272K 分层价格对象。
- 远程 D1 `model_pricing_sync_state` 的固定键为 `global`，当前 `status=success`、`model_count=5946`、
  `last_success_at=2026-08-14T18:30:56.000Z`、`last_source_updated_at=2026-08-14`、`last_error=null`，
  active generation 已设置。发布不会强制重写成功代次，后续由 Cron 按 24 小时间隔刷新。
- Claude `2.1.232` 使用普通 `claude -p` 只读复核（未调用 `ultrareview`），发现 displayName 字符边界
  和日期后缀测试覆盖建议，已修复并由 84 个定向用例验证。OMP `17.3.3` 使用当前默认模型
  `newapi-chat-completions/grok-4.6` 普通只读复核，返回 `NO_ACTIONABLE_FINDINGS`；两者均未修改文件。
- Linux 和 Windows 远程测试主机（后续仅运行时探针）本轮仅做只读连通性与运行时确认：两台均为
  Node `v24.14.0`；Linux Corepack pnpm `10.21.0`，Windows Corepack pnpm `11.21.0`。本轮未在远程
  checkout 上重跑候选测试，不能把该只读探针扩展为远程全量通过证据。

## 当前边界

工作树仍保留 staged、unstaged 和 untracked 改动，未执行 reset、clean、commit 或 push。私人
Cloudflare 已部署当前候选，但上游 PR 生命周期、远程两台主机的候选全量测试和 CodeRabbit 本轮
复核不属于已完成证据；任何空输出、限流或不可用状态均未记为通过。
