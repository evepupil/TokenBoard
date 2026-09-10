# TokenBoard 发布前复核记录

日期：2026-08-05（复核更新）

## 范围

以下范围和本地验证表格是 2026-08-01 的首次复核快照，后续章节记录更新后的事实。

- 分支：`fix/post-merge-reliability-followups-ui`
- 基线：`upstream/master`
- 分支关系：领先 18 个提交，落后 0 个提交
- 首次快照（2026-08-01）：未提交修改包含 15 个跟踪代码/测试文件，以及 1 个未跟踪审查记录文件
- 首次快照（2026-08-01）：未执行提交、推送、PR 更新或部署

## 本地验证

| 命令 | 结果 |
| --- | --- |
| `pnpm test` | 通过，usage-core 9、Web 582、collector 654，共 1245 项 |
| `node --test skills/tokenboard/scripts/*.test.mjs` | 通过，426 项 |
| `pnpm typecheck` | 通过 |
| `pnpm build` | 通过，Web client 和 Worker production build 均完成 |
| `pnpm audit --audit-level=high` | 通过，无已知高危漏洞 |
| `git diff --check` | 通过 |
| 变更敏感值扫描 | 未发现凭证、授权头或密钥值 |

## 外部复核

- OMP 调度重试和状态兼容复核：明确返回 `NO_FINDINGS`。
- OMP hooks、sync、Windows command 和 upgrade 复核：明确返回 `NO_FINDINGS`。
- Claude Code 使用本机已配置的 DeepSeek 渠道和 `deepseek-v4-flash` 执行只读复核，明确返回 `NO_FINDINGS`；此前默认 Claude 渠道的空输出不计入证据。
- CodeRabbit 已认证；第一轮未提交审查发现 1 个 `all` retry 主锁清理问题，已修复并补回归测试。第二轮未提交审查完成，返回 0 个问题。

## 本轮修复

- 保留按 source 隔离的 scheduled retry 锁和状态文件。
- 对旧版固定路径的活动锁增加兼容保护，避免升级期间并发运行。
- status 对来源专属状态文件仅在 source 精确匹配时读取，并保留 `all` 旧版状态兼容，防止跨来源误读。
- 保留损坏的旧版 retry 状态为 `invalid`，避免状态命令隐藏迁移故障。
- 在来源锁获取失败时释放已取得的旧版锁，并聚合清理失败信息。
- 使用过渡锁协调 `all` 与来源专属 scheduled retry 的获取顺序，避免检查与加锁之间的竞态。
- 保留旧版 `source=all` retry 状态的兼容读取，并在 `all` retry 过渡锁释放失败时登记主锁，确保异常清理不会遗留主锁。
- 让 notifier 的 trailing/dispatch 锁清理失败影响最终退出码，避免报告成功但遗留锁。
- 让生成 hook 在主 dispatch 锁释放异常时继续清理 token 级 worker 标记，并让 `notify.mjs` 在主锁释放失败时继续清理 worker 标记。
- 让 `status.mjs` 直接区分重试状态文件不存在和读取异常，权限或其他读取错误显示为 `invalid`，不再静默当作不存在。
- 对生成 hook 的错误日志统一脱敏执行路径，避免本地诊断文件暴露命令路径。
- 为旧版锁、状态回退、跨来源隔离和 notifier 清理失败补充回归测试。

## 未覆盖边界

- 未证明上游 PR 合并后的生产 Cloudflare、D1、OAuth 和真实多用户数据链路健康。
- 未证明 Windows 实机 tasklist、计划任务和 Node 版本组合的运行结果；相关行为由离线测试覆盖。
- 当前候选仍未提交、未推送、未部署。

## 2026-08-02 修复后复核

- 定向 hook、notify、status、scheduled-retry、sync 和 upgrade 测试通过；新增 dispatch worker 清理回归通过。
- 重新执行 workspace 测试、skill 脚本测试、类型检查、生产构建、高危审计和 `git diff --check`，均通过；当前候选仍未提交、未推送、未部署。

## 2026-08-02 最终外部复核

- Claude Code `2.1.220` 使用 `deepseek-v4-flash` 进行只读复核，返回 `NO_FINDINGS`。
- OMP `17.1.8` 使用 `newapi-chat-completions/grok-4.5`、最大思考深度进行只读复核，返回 `NO_FINDINGS`。
- 两次复核均限制为当前 diff，未修改文件、未提交、未推送、未部署；外部复核未发现新的 P0-P3 可操作问题。

## 2026-08-02 当前会话复核

- 受影响 collector 定向测试：`pnpm exec vitest run packages/collector/src/command.test.ts`，8/8 通过。
- 受影响 skill 定向测试：hooks、notify、scheduled-retry、status、sync-runner、upgrade，共 164/164 通过。
- workspace 测试：usage-core 9、Web 582、collector 654，共 1245 项通过。
- skill 脚本全量测试：426/426 通过。
- `pnpm typecheck`、`pnpm build`、`pnpm audit --audit-level=high` 和 `git diff --check` 均通过；audit 报告无已知高危漏洞。
- CodeRabbit CLI `0.7.1` 尝试使用 `coderabbit review --uncommitted --include-untracked --agent` 审查当前 15 个 tracked 未提交文件和 1 个未跟踪审查记录，但返回 `rate_limit`；未产生 `review_completed` 或 `findings: 0`，因此本次外部复核未完成，不计为通过证据。
- 本轮仅更新本审查记录，未修改业务源码、未提交、未推送、未部署；CodeRabbit 限流状态与本地验证结果分开记录。

## 2026-08-02 Unix Node 运行时路径修复

- 修复生成 `notify.cjs` 固定安装时 Node 路径的问题：Unix 运行时使用当前 `process.execPath`，Windows 保留安装时配置的绝对路径。
- 新增回归断言，分别验证 Unix（macOS/Linux）和 Windows 分支的 Node 路径选择。
- 受影响 hooks/handler 定向测试 60/60、skill 脚本全量测试 426/426、workspace 测试 1245 项、类型检查、生产构建、高危审计和 `git diff --check` 均通过。
- 本节变更仍未提交、推送或部署。

## 2026-08-02 scheduled retry 兼容性修复

- 来源专属 scheduled retry 现在在准备阶段无条件取得固定 legacy 锁，并持有到整个 retry 生命周期结束，避免旧版进程在检查与加锁之间插入并发 retry；同一 Node 进程内的不同来源使用引用计数共享兼容锁。
- `status.mjs` 回退读取来源专属配置时接受合法的 legacy `source: "all"` 状态，同时继续拒绝其他具体来源的状态，确保定时任务使用 `--source all` 时进度可见。
- 新增 legacy 锁生命周期、准备阶段竞态和 all-source 状态可见性回归测试；定向 scheduled-retry/status 测试 26/26 通过。
- 本节变更仍未提交、推送或部署。

## 2026-08-02 本轮最终本地复核

- 单独重跑此前偶发超时的 `packages/collector/src/providers/codex-session-scope-bounds.test.ts`，13/13 通过；未复现超时。
- `pnpm test` 通过：usage-core 9、Web 582、collector 654，共 1245 项。
- `node --test skills/tokenboard/scripts/*.test.mjs` 通过：429/429 项。
- `pnpm typecheck`、`pnpm build`、`pnpm audit --audit-level=high` 和 `git diff --check` 均通过；构建和测试仅输出 Node `DEP0205 module.register()` 弃用警告，无失败或高危漏洞。
- 本轮未执行提交、推送、PR 更新或部署；工作树仍保留既有未提交代码及本审查记录。

## 2026-08-03 scheduled retry 跨进程并发修复

- 修复不同 Node 进程的来源专属 retry 仍争抢同一个 legacy 文件、导致第二来源被跳过的问题。
- 固定 legacy 路径在当前版本中作为目录栅栏，目录内按进程写入独立 marker；不同来源可以并发，旧版本仍无法取得同一路径的文件锁。
- marker 保存 PID 和 token，过渡锁保护 marker 增删；已退出进程的 marker 会在下一次准备阶段回收，最后一个 marker 释放后恢复固定文件路径兼容旧版本。
- 新增不同 PID 跨进程并发测试和停止进程 marker 回收测试；scheduled retry 定向测试 18/18、skill 全量测试 431/431 通过。
- 本节变更仍未提交、推送、更新 PR 或部署。

### 兼容边界

- 当前版本的 `coordinator-lock` 会把活动的 legacy 目录栅栏识别为已占用，返回正常的锁竞争结果；新增回归测试覆盖 `EISDIR`。
- 尚未升级的旧版客户端只认识固定的普通文件锁，在新版本来源专属 retry 持有目录栅栏期间可能输出 `EISDIR` 并跳过本次 retry；它不会进入采集或上传，因此不会与新版本并发重复执行。旧版客户端需要完成一次升级后才能使用跨进程来源隔离协议。

## 2026-08-03 目录栅栏错误路径复核

- 修复通用锁读取在真实 Node 文件系统中先收到 `EEXIST`、再读取目录收到 `EISDIR` 的路径；获取和释放均保持目录栅栏不变，并返回锁占用结果。
- 定向 coordinator-lock 与 scheduled-retry 测试 36/36 通过；skill 脚本全量测试 434/434、workspace 测试 1245/1245、类型检查、生产构建、高危审计和 `git diff --check` 均通过。
- 使用真实临时目录探针验证来源 retry 完成后旧协议获取结果为 `occupied`，目录栅栏正常清理；未提交、未推送、未部署。

## 2026-08-03 legacy 栅栏未知项复核

- 目录扫描现在区分活动 marker 与未知目录项；未知项或清理竞态会抛出 `TOKENBOARD_LEGACY_RETRY_FENCE_CORRUPTED`，不再返回成功的 `active-legacy-retry`。
- 新增 all-source 和来源专属 retry 的损坏栅栏回归测试；定向 scheduled-retry 测试 20/20、skill 脚本全量测试 436/436、workspace 测试 1245/1245、类型检查、生产构建、高危审计和 `git diff --check` 均通过。
- 损坏目录及未知项会保留在原位供诊断和人工处理；本轮未提交、未推送、未部署。

## 2026-08-03 scheduled retry 清理竞争修复

- 修复 transition 锁竞争时提前移除 marker 内存所有权的问题；只有取得 transition 锁并完成 marker 清理后才遗忘所有权，竞争失败会保留可重试的待清理状态。
- 新增跨两次 retry 的 marker token 复用回归测试，覆盖成功采集后清理竞争、后续重试恢复和最终清理；定向 scheduled-retry 测试 21/21、skill 脚本全量测试 437/437 通过。
- `pnpm test`、`pnpm typecheck` 和 `git diff --check` 均通过；本轮未提交、未推送、未部署。

## 2026-08-03 retry marker 与状态并存修复

- marker 现在保存可跨进程校验的进程启动身份：Linux 使用 `/proc` 启动计数，macOS/Unix 使用 `ps` 启动时间，Windows 使用 PowerShell 进程创建时间；无法确认时保持占用，避免误删活动 marker。
- status 在来源专属与 legacy 状态文件并存时按合法来源和 `updatedAt` 选择较新状态，避免旧的 completed 状态遮蔽当前 all-source retry。
- 修正 Windows 路径分隔符测试模拟，并让活动 legacy-lock 回归测试真正进入 legacy fence 分支；新增 PID 复用回收测试。
- 定向 scheduled-retry/status 测试 33/33、skill 脚本全量测试 439/439、workspace 测试、类型检查、生产构建、高危审计和 `git diff --check` 均通过；本轮未提交、未推送、未部署。

## 2026-08-04 scheduled retry 最终边界修复

- 来源专属 retry 状态文件存在但损坏或不可读时，`status.mjs` 保持该 `invalid` 状态为权威结果，不再被有效的 legacy 状态覆盖；仅在来源专属文件不存在或来源不匹配时回退。
- Linux legacy retry marker 的进程身份现在绑定 `/proc/sys/kernel/random/boot_id` 与 `/proc/<pid>/stat` 启动 tick。boot ID 无法读取时返回 `unknown` 并保持 fail-closed，避免系统重启后的 PID 和 tick 复用误认活动进程。
- 新增状态优先级、Linux boot ID 和 boot ID 读取失败回归测试；skill 脚本全量测试 `442/442` 通过。
- 将 `brace-expansion` override 从 `5.0.8` 更新到 `5.0.9`，将 `miniflare` 使用的 `undici` 从 `7.28.0` 更新到 `7.29.0`，并将 Web 的 Hono 依赖提升到已修复 ReDoS 的 `4.13.0`；冻结锁文件安装成功，`pnpm audit --audit-level=high` 和完整 `pnpm audit --audit-level=moderate` 均通过，分别未报告已知高危及以上、或中危及以上漏洞。
- 本轮最终验证：依赖更新后的 workspace 测试 usage-core `9`、Web `582`、collector `654` 全部通过；`pnpm typecheck`、`pnpm build`、`git diff --check` 均通过。当前仍未提交、未推送、未部署。

## 2026-08-04 legacy marker 保守互斥修复

- 进程启动身份探测失败时不再生成 `fallback:` 可比较值；marker 省略未知身份字段，后续扫描回退到保守的 PID liveness 判断，避免与原生身份不一致时误删活动 marker。
- 截断、非法 JSON 或字段无效的 `source-*.json` marker 现在保留在目录中并报告 `TOKENBOARD_LEGACY_RETRY_FENCE_CORRUPTED`，不会被当作陈旧 marker 删除后继续 retry。
- 新增未知身份 marker 落盘、活动未知身份 marker 阻塞 all-source retry、all/source 两条路径损坏 marker 保留回归测试。
- 最终验证：skill 脚本 `447/447`，workspace usage-core `9`、Web `582`、collector `654`，`pnpm typecheck`、`pnpm build`、`pnpm audit --audit-level=moderate`（未报告已知中危及以上漏洞）和 `git diff --check` 全部通过；仍未提交、未推送、未部署。

## 2026-08-04 最终收口复核（历史快照）

- 同 PID 的无身份 marker 不再仅因当前进程内没有 token 记录而被判为陈旧；该场景回退到保守的 PID liveness 判定，避免 PID 复用或身份探测不可用时误删栅栏。
- scheduled retry 的内存文件系统目录枚举改用宿主路径分隔符，Windows 断言不再因为固定 `/` 分隔符而遗漏嵌套 marker。
- Web manifest 将 Hono 的最低允许版本固定为 `^4.13.0`，与锁文件中的已验证版本一致，避免非冻结安装再次接受已修复前的版本范围。
- 本轮验证：冻结锁安装通过；定向 process-liveness、scheduled-retry、status 测试 `42/42` 通过；skill 脚本全量测试 `448/448` 通过；workspace usage-core `9`、Web `582`、collector `654` 全部通过；`pnpm typecheck`、`pnpm build`、`pnpm audit --audit-level=moderate` 和 `git diff --check` 均通过。
- CodeRabbit CLI `0.7.1` 已认证，发起 `coderabbit review --uncommitted --include-untracked --agent` 后在多个轮询周期内没有产生输出、findings 或完成状态，已主动停止；此次外部复核未完成，不计为通过证据。
- 当前 checkout 的 `git status --short --branch` 为干净工作树；相对 fork 基线的 `git diff --stat` 仅包含本记录所述 4 个提交，`git diff --check` 通过。
- 当前候选未部署；生产 Cloudflare、D1、OAuth 和真实多用户链路仍不在本地审查覆盖范围内。

## 2026-08-04 当前会话全面复核

- CodeRabbit CLI `0.7.1` 首轮相对基线 `c160d455a12f7c49fed1ba2ddd84dfa103d6018b` 发现 1 个 Windows 进程身份探测问题：PowerShell 的 `Get-Process -ErrorAction SilentlyContinue` 会把权限或查询错误误判为 PID 不存在。
- 已修复 `process-liveness.mjs`：使用 `-ErrorAction Stop`，仅将明确的 `ObjectNotFound` 或 `NoProcessFoundForGivenId` 映射为 dead，其它异常保持 unknown；新增缺失 PID 与查询失败两条回归断言。
- 修复后 CodeRabbit 同一基线复核完成，返回 `findings: 0`，覆盖当前变更范围（含本轮修复）。
- 本轮验证：workspace 测试 usage-core `9`、Web `582`、collector `655`，共 `1246/1246`；skill 脚本测试 `452/452`；`pnpm typecheck`、`pnpm build`、`pnpm audit --audit-level=moderate`、`pnpm install --frozen-lockfile --offline`、脚本语法检查和 `git diff --check` 均通过。
- 基线与范围命令：执行 `git log --oneline c160d455a12f7c49fed1ba2ddd84dfa103d6018b..HEAD`、`git diff --stat c160d455a12f7c49fed1ba2ddd84dfa103d6018b...HEAD`、`git status --short --branch` 和 `git diff --check`。
- 脚本语法命令：执行 `node --check skills/tokenboard/scripts/scheduled-retry.mjs`、`node --check skills/tokenboard/scripts/scheduled-retry-legacy-fence.mjs`、`node --check skills/tokenboard/scripts/process-liveness.mjs`、`node --check skills/tokenboard/scripts/coordinator-lock.mjs`、`node --check skills/tokenboard/scripts/notify.mjs`、`node --check skills/tokenboard/scripts/hooks.mjs`、`node --check skills/tokenboard/scripts/sync.mjs` 和 `node --check skills/tokenboard/scripts/upgrade.mjs`。
- 本轮未推送、未更新 PR、未部署；修复和本记录已作为本地独立提交保存。Windows 实机、Cloudflare/D1、OAuth 和真实多用户链路仍未在本地验证范围内。

### 复杂度审查豁免

- `hooks.mjs` 为 782 行，其中 `notifyHandlerHelpers` 是生成单个自包含 CJS hook 的声明式模板。生成结果内已按 dispatch、liveness、错误处理和 signal 写入函数分区；将模板再拆为多个生成器不会减少生成程序复杂度，反而会增加跨模板拼接和作用域一致性风险，因此保留该内聚实现。
- `notify.mjs` 为 542 行，职责仍限定为 notifier dispatch、trailing lock 和 worker 标记生命周期；未发现超过阈值的独立生产函数。
- `scheduled-retry.mjs` 的 `runScheduledRetry` 和 `executeScheduledRetry` 分别覆盖一个完整的锁获取/清理事务与一个完整的重试状态转换事务。拆分会把异常聚合与状态写入的原子边界分散，现有回归已覆盖这些边界，故保留。
- `upgrade.mjs` 的 `runUpgrade` 覆盖 checkout、依赖、skill 刷新和配置合并的单一升级事务；拆分会增加部分升级后配置未写入的风险，故保留。
- `hooks.test.mjs`（957 行）、`notify.test.mjs`（894 行）和 `scheduled-retry.test.mjs`（853 行）均为一个模块的跨平台状态机契约测试，依赖共享 private fake 和生命周期断言，审查后不拆分。
- `upgrade.test.mjs` 为 1353 行，超过 1000 行强制治理阈值。本次仅增加默认分支诊断回归；该文件覆盖完整升级事务及 archive fallback，拆分会重复大量同步 fake 与调用序列断言。明确豁免本次重构，后续若扩展 upgrade 行为，应将 archive fallback 场景迁至独立测试文件。

## 2026-08-04 Codex 冻结范围最终复核

- 修复 bounded Codex canonical attribution 的 live/frozen 文件竞态：缓存未命中的 canonical 子批次现在从同一批已冻结的临时 `CODEX_HOME` 派生，并通过显式映射回原始 source file；不再在 canonical 扫描阶段重新读取 live 文件。移除已不再使用的 `codexHomes` 参数，避免误导调用方。
- 新增回归覆盖：第二次有界采集期间 live 文件继续增长时，canonical 子批次仍读取冻结内容，并校验各批次实际 token 尾值；未发现跨 profile 映射丢失或重复归因路径。
- 本轮本地验证：`pnpm test` 的 usage-core `9`、Web `582`、collector `655` 共 `1246/1246` 通过；skill 脚本 `452/452` 通过；`pnpm typecheck`、`pnpm build`、`pnpm audit --audit-level=high`（未报告已知高危及以上漏洞）、`pnpm install --frozen-lockfile --offline`、`git diff --check` 均通过。
- CodeRabbit CLI `0.7.1` 执行 `coderabbit review --agent --base-commit c160d455a12f7c49fed1ba2ddd84dfa103d6018b -c AGENTS.md` 完成，返回 `review_completed`、`findings: 0`，覆盖当前基线差异及未提交修改涉及的文件。
- OMP `17.1.8` 使用指定的 `grok-4.5` 模型完成只读复核，结论为未发现可操作缺陷；Claude Code `2.1.220` 的标准与 `--bare` 只读调用均在超过 10 分钟内无输出，已停止且不计为通过证据。
- 追加上述外部复核记录后再次执行同一 CodeRabbit 命令时返回 `rate_limit`，没有产生新的 `review_completed` 或 `findings: 0`；该限流结果不作为通过证据。此前成功复核覆盖的业务/测试差异未被修改，本节新增内容仅为审查记录。
- 当前工作树仅有本节对应的审查记录、Codex 实现和 Codex 回归测试 3 个未提交修改；本轮未推送、未更新 PR、未部署。Windows 实机、Cloudflare/D1、OAuth 和真实多用户链路仍未在本地验证范围内。

## 2026-08-05 retry 锁进程身份与 macOS 精度修复

- `coordinator-lock` 的新锁记录现在在 runtime 提供启动身份时写入 `processStartIdentity`；transition lock、来源 guard 和 cleanup guard 会在身份可验证时同时校验 PID 与启动身份，旧版无该字段的锁继续走 PID liveness 兼容路径，身份探测失败保持占用而不静默回收。
- macOS 不再使用秒级 `ps lstart` 作为可比较身份，改用系统 `libproc` 的 `proc_pidinfo` 读取 `pbi_start_tvsec` 和 `pbi_start_tvusec`；原生探测失败返回 `unknown`，通用 POSIX `ps` 输出也不再被当作唯一启动身份。
- 新增 coordinator 锁身份写入、PID 复用、身份未知保守互斥，以及 Darwin 微秒级解析和损坏数据回归；来源 retry 回归确认 transition/source 锁均携带启动身份。
- 本轮验证：workspace 测试 usage-core `9`、Web `582`、collector `655`，共 `1246/1246`；skill 脚本测试 `460/460`；`pnpm typecheck`、`pnpm build`、`pnpm audit --audit-level=moderate`、关键脚本 `node --check` 和 `git diff --check` 均通过。另以本机当前 Node PID 实测 Darwin 原生身份格式为 `darwin:<seconds>:<microseconds>`。
- 本轮未推送、未部署、未执行外部审查；Windows 实机、Cloudflare/D1、OAuth 和真实多用户链路仍不在本地验证范围内。
