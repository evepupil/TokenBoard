# 同步机制优化（2026-10-14 审查修订版）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地 2026-10-14 三 agent 审查确认的 10 项同步机制优化（可观测性 3 项、廉价性能/防御 4 项、中型 3 项），砍掉采集并行化与 cursor 全量分片。

**Architecture:** 全部改动局限在本地采集端三层——skill 脚本（notify/coordinator/sync/upgrade/status）、collector CLI 错误输出路径、collector providers 缓存层。不改上传协议、不改后端、不改 on-disk 格式（cursor 仍是单文件）。

**Tech Stack:** Node.js >=22.18（skill 脚本 .mjs）、TypeScript strict（collector）、vitest（collector）、node --test（skill）。

**Spec:** 本会话 2026-10-14 调研报告（两份，含修正后的行号）+ memory `sync-mechanism-review-2026-10-14`。行号以调研报告为准，与早期审查报告冲突时以本计划「现状」段为准。

## Global Constraints

- 分支 `feat/model-pricing-maintenance`，HEAD ba43dc1，工作树必须保持干净收尾。
- 每个任务独立提交，提交信息用 `feat(skill)/fix(collector)/feat(collector)` 历史风格，结尾 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`。
- skill 脚本新 const 必须放在 isMain 守卫之前（sync.mjs 历史 TDZ 坑）。
- status.mjs 输出永远不包含错误文本、本地路径、凭据（SKILL.md:118 脱敏承诺）。
- 所有缓存/cursor 文件保持 0600、状态目录 0700；原子写 = temp + rename + `assertCursorWriteOwnership`。
- 解析损坏（SyntaxError/schema 不符）与并发冲突（changed while reading）一律保持 fail-closed 抛错，只放宽「尺寸超限」一族。
- skill 测试：`node --test skills/tokenboard/scripts/*.test.mjs`；collector 测试：`pnpm --filter @tokenboard/collector test`；typecheck：`pnpm -r typecheck`。

## Review Focus

1. **终端错误被噪音淹没**（#1 的核心诉求）：诊断行必须先切分再压平；若 normalizeChildOutput 先跑，切分就不可能。测试：Task 1 步骤 1。
2. **fail-closed 语义被缓存悄悄削弱**（#8 最大风险）：指纹 memo 只作用于单次 collect 内的 context-pricing 发现循环；attribution cache 的 lookup/`assertObservedFilesUnchanged` 绝不 memo。测试：Task 9 步骤 1 的「改变检测仍触发」用例。
3. **dead-letter 静默丢数据**（#11）：backoff 期间 cursor/pending 必须原样保留、日志必须显式打印暂停与原因、status 可见。测试：Task 10 步骤 1。
4. **hook 超时误杀正常长尾**（#5）：默认 30 分钟；只作用于 `--hook` 路径；手动/preview 永不超时。测试：Task 4 步骤 1。
5. **status 聚合泄密**（#2）：runs 文件含本机路径与诊断全文，聚合只允许输出计数与时间戳。测试：Task 5 步骤 1 的脱敏断言。

---

### Task 1: pricing 噪音去重（原 #3）

**Files:**
- Modify: `packages/collector/src/cli.ts`（deps.stderr 包装处 :83 附近、run() 尾部 flush）
- Test: `packages/collector/src/cli.test.ts`

**Interfaces:**
- Produces: `createPricingDiagnosticDeduper(stderr)` 返回 `{ stderr: (line: string) => void, flush: () => void }`，供 run() 使用；provider 侧零改动。

- [ ] **Step 1: 写失败测试**

```ts
// cli.test.ts 新增
test('repeated unpriced-model stderr lines collapse into one summary per report kind', async () => {
  const lines: string[] = []
  // 通过现有 cli 入口注入 stderr 依赖，模拟 provider 打 3 条同族行 + 1 条异族行
  // 断言最终 lines 只含 1 条汇总 'TokenBoard model pricing unavailable for 3 Claude Code models; preserving ccusage results: a, b, c'
  // 与 1 条原样透传的非同族行（如 'TokenBoard model pricing: refresh failed ...'）
})
test('a single unpriced-model line passes through unchanged', async () => { /* 1 条时输出与原格式完全一致 */ })
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @tokenboard/collector exec vitest run src/cli.test.ts`
Expected: 新用例 FAIL（行为仍是逐行输出）。

- [ ] **Step 3: 实现 deduper**

```ts
// cli.ts 顶部新增（或独立小模块 src/pricing-diagnostics.ts）
const UNPRICED_RE = /^TokenBoard model pricing unavailable for (.+?) model (.+?); preserving/
export function createPricingDiagnosticDeduper(stderr: (l: string) => void) {
  const pending = new Map<string, { kind: string; models: Set<string> }>()
  return {
    stderr(line: string) {
      const m = UNPRICED_RE.exec(line)
      if (!m) return stderr(line)
      const key = m[1]
      const bucket = pending.get(key) ?? { kind: m[1], models: new Set<string>() }
      bucket.models.add(m[2])
      pending.set(key, bucket)
    },
    flush() {
      for (const { kind, models } of pending) {
        if (models.size === 1) stderr(`TokenBoard model pricing unavailable for ${kind} model ${[...models][0]}; preserving collected result`)
        else stderr(`TokenBoard model pricing unavailable for ${models.size} ${kind} models; preserving collected results: ${[...models].slice(0, 20).join(', ')}${models.size > 20 ? ', …' : ''}`)
      }
    }
  }
}
```

run() 里把 `deps.stderr` 换成 deduper.stderr 注入 context（standardContext/antigravityContext 共用同一实例），在 collect 完成后（成功与失败路径都要）调用 `flush()`——用 try/finally 保证 failFast 早退也能 flush。

- [ ] **Step 4: 跑测试通过 + collector 全量测试**

Run: `pnpm --filter @tokenboard/collector test`
Expected: 全绿。

- [ ] **Step 5: Commit** `fix(collector): collapse repeated unpriced-model diagnostics into one summary line`

---

### Task 2: 错误归因分离（原 #1）

**Files:**
- Modify: `skills/tokenboard/scripts/notify.mjs:304-319`（formatSyncFailure/normalizeChildOutput）、`:82`（throw 处附带 diagnostics）
- Modify: `skills/tokenboard/scripts/coordinator.mjs:287-291`（cycle 写入 diagnostics）
- Test: `skills/tokenboard/scripts/notify.test.mjs`、`skills/tokenboard/scripts/coordinator-run-log.test.mjs`

**Interfaces:**
- Produces: cycle 记录结构 `{ source, error: string, diagnostics?: string }`；`formatSyncFailure` 改为返回 `{ message, diagnostics }`（内部函数，无外部消费方）。
- 约束：diagnostics 截断 8192 字符；不进 status 输出。

- [ ] **Step 1: 写失败测试**

```js
// notify.test.mjs 新增
test('sync failure separates terminal error from expected diagnostic noise', () => {
  // 构造 spawnSync result：stderr 含 3 行：
  //   'TokenBoard model pricing unavailable for Claude Code model x; preserving collected result'
  //   'Skipped 310 oversized codex session JSONL rows ...'
  //   'ccusage exited with code 2: cannot read config'
  // 断言 thrown error.message === 'TokenBoard hook sync failed with exit code 1: ccusage exited with code 2: cannot read config'
  // 且 error.diagnostics 含前两行、总长 ≤ 8192
})
test('all-noise stderr still yields a message and empty diagnostics', () => { /* 全噪音 → terminal 行回退为默认 '...exit code N'、diagnostics=全部噪音 */ })
```

- [ ] **Step 2: 跑 `node --test skills/tokenboard/scripts/notify.test.mjs` 确认新用例失败。**

- [ ] **Step 3: 实现**

```js
// notify.mjs
const expectedDiagnosticPrefixes = [/^TokenBoard model pricing /, /^Skipped \d+ /, /^Skipping /]
function splitChildOutput(result) {
  const raw = Array.isArray(result.stderr) ? result.stderr.join('') : String(result.stderr || '')
  return raw.split('\n').map((l) => l.trim()).filter(Boolean)
}
function formatSyncFailure(result) {
  const exitCode = result.status ?? 1
  const lines = splitChildOutput(result).map((l) => redactUrlCredentials(l))
  const isNoise = (l) => expectedDiagnosticPrefixes.some((re) => re.test(l))
  const terminal = lines.find((l) => !isNoise(l))
  const diagnostics = lines.filter(isNoise).join('\n').slice(0, 8192)
  return {
    message: terminal ? `TokenBoard hook sync failed with exit code ${exitCode}: ${terminal}` : `TokenBoard hook sync failed with exit code ${exitCode}`,
    diagnostics
  }
}
```

注意：原实现用 `normalizeChildOutput` 把多行压平成单行消息——保留该函数给其他调用方（若有），但 failure 路径改用 splitChildOutput。`:82` 处改为：

```js
const failure = formatSyncFailure(result)
const error = new Error(failure.message)
if (failure.diagnostics) error.diagnostics = failure.diagnostics
throw error
```

coordinator `:287-291` catch 改为：

```js
cycles.push({ source, error: errorMessage(cause), ...(cause?.diagnostics ? { diagnostics: cause.diagnostics } : {}) })
```

- [ ] **Step 4: 修既有断言并跑全量 skill 测试**

Run: `node --test skills/tokenboard/scripts/*.test.mjs`
Expected: coordinator-run-log.test.mjs 的 cycles deepEqual（:292、:343、:383、:415-426）里带 stderr 噪音的用例补 `diagnostics` 字段；notify.test.mjs :1183/:1198 的 message 断言按新 message 调整（exit code 仍匹配）。全绿后提交。

- [ ] **Step 5: Commit** `feat(skill): separate terminal sync errors from diagnostic noise in run logs`

---

### Task 3: 升级 pin hash（原 #7）

**Files:**
- Modify: `skills/tokenboard/scripts/upgrade.mjs:202-210`（mergeConfigFile 处）、archive fallback 调用点
- Modify: `skills/tokenboard/scripts/status.mjs`（buildStatus 增加两个字段）
- Test: `skills/tokenboard/scripts/upgrade.test.mjs`、`skills/tokenboard/scripts/status.test.mjs`

**Interfaces:**
- Produces: config.json 根键 `upgradedCommit: string | null`（null = archive fallback 无法确定）；status 输出增 `lastUpgradedCommit`、`upgradedAt`。

- [ ] **Step 1: 写失败测试**

```js
// upgrade.test.mjs 新增
test('upgrade records the resolved commit and shows from/to in the log', async () => {
  // spawn fake 已有（:365-371 注入 readConfigFile/mergeConfigFile stub），扩展 spawn stub 使
  // `git rev-parse HEAD` 返回 'abc1234'；断言 mergeConfigFile 收到 upgradedCommit==='abc1234'
  // 且 log 含 'upgraded from abc1234（旧值）to abc1234' 形式的对比（旧值来自 readConfigFile 的 upgradedCommit）
})
test('archive fallback leaves upgradedCommit null when rev-parse fails', async () => { /* rev-parse 非零退出 → 字段为 null，不 throw */ })
```

- [ ] **Step 2: 跑 upgrade.test.mjs 确认失败。**

- [ ] **Step 3: 实现**：`runUpgrade` 开始时读旧 `config.upgradedCommit`；步骤循环完成后在 collectorDir spawn `git rev-parse HEAD`（失败容错→null）；`mergeConfigFile({..., upgradedCommit})`；log 行改为 `TokenBoard upgraded ... (commit ${old ?? 'unknown'} -> ${new ?? 'unknown'})`。archive fallback 路径同样尝试 rev-parse（解压目录可能非 git，容错）。

- [ ] **Step 4: status.mjs 增加输出**（带 status.test.mjs 断言：有值则展示、无值不出现键）：

```js
...(config.upgradedCommit ? { lastUpgradedCommit: config.upgradedCommit } : {}),
...(config.upgradedAt ? { upgradedAt: config.upgradedAt } : {})
```

- [ ] **Step 5: 跑 `node --test skills/tokenboard/scripts/*.test.mjs` 全绿；Commit** `feat(skill): record and surface the upgraded commit hash`

---

### Task 4: cooldown 配置化（原 #4）+ 本机设值

**Files:**
- Modify: `skills/tokenboard/scripts/notify.mjs`（`readNotifyCooldownMs` 增 config 层；`runNotify`/`runNotifyCli` 传入）
- Test: `skills/tokenboard/scripts/notify.test.mjs:26-70`

**Interfaces:**
- Produces: config.json 根级可选键 `notifyCooldownMs`（毫秒整数，60s–60min 校验与 env 相同）；优先级 explicit(测试注入) > env > config > 默认。

- [ ] **Step 1: 写失败测试**

```js
test('config notifyCooldownMs applies when env is unset', () => {
  // env 无 TOKENBOARD_NOTIFY_COOLDOWN_MS、config.notifyCooldownMs=1800000 → cooldownMs 1800000
})
test('env overrides config; invalid config value throws the existing range error', () => {
  // env=900000 + config=1800000 → 900000；config=100（<60s）→ throw 'must be between'
})
```

- [ ] **Step 2: 跑 notify.test.mjs 确认失败。**

- [ ] **Step 3: 实现**：`readNotifyCooldownMs(explicitValue, env, configValue)`——explicit 语义不变；env 未设置时若 configValue !== undefined 走同一 regex+范围校验（错误消息提到 config 键名）。`runNotifyCli`（:216 已读 config）把 `config.notifyCooldownMs` 传给 `runNotify`，`runNotify` 内 `readNotifyCooldownMs(options.cooldownMs, env, options.configCooldownMs)`。既有 explicit>env 断言（notify.test.mjs:26-70）不动。

- [ ] **Step 4: SKILL.md 的 cooldown 说明（:109-110 附近）补一句 config 键。跑 skill 全量测试。**

- [ ] **Step 5: Commit** `feat(skill): allow notify cooldown via config key`

- [ ] **Step 6: 本机生效**（合并后执行，不属于代码任务）：

```bash
node -e "const {mergeConfig}=await import('<HOME>/.tokenboard/TokenBoard/skills/tokenboard/scripts/config.mjs'); /* mergeConfig({notifyCooldownMs:1800000}) 具体调用以 config.mjs 导出为准 */"
```

并验证 `node skills/tokenboard/scripts/status.mjs` 仍正常。

---

### Task 5: hook 同步超时（原 #5，默认 30 分钟）

**Files:**
- Modify: `skills/tokenboard/scripts/sync.mjs:231-254`（runCollectorProcess）、顶部常量（守卫之前）
- Test: `skills/tokenboard/scripts/sync.test.mjs`、`skills/tokenboard/scripts/sync-runner.test.mjs`

**Interfaces:**
- Produces: hook 路径 spawnSync 增加 `{ timeout, killSignal: 'SIGKILL' }`；默认 `30 * 60 * 1000`，env `TOKENBOARD_HOOK_SYNC_TIMEOUT_MS`（正整数校验，0/负数报错）可覆盖；仅 `flags.hook === true` 时生效。

- [ ] **Step 1: 写失败测试**

```js
// sync.test.mjs 新增
test('hook-mode spawn carries a 30-minute default timeout and SIGKILL killSignal', () => { /* 断言 spawn stub 收到的 options.timeout === 1800000 */ })
test('non-hook invocations never receive a timeout option', () => { /* --mode preview / --scheduled 不带 timeout */ })
test('TOKENBOARD_HOOK_SYNC_TIMEOUT_MS overrides the default', () => { /* env=60000 → options.timeout===60000 */ })
test('timed-out spawn produces an explicit diagnostic and exit 1', () => { /* stub 返回 {status:null, signal:'SIGKILL', error:{code:'ETIMEDOUT'}} → stderr 含 'hook sync timed out after' */ })
```

- [ ] **Step 2: 跑确认失败。**

- [ ] **Step 3: 实现**：常量 `const defaultHookSyncTimeoutMs = 30 * 60 * 1000` 放在 isMain 调用之前；`runCollectorProcess(invocation, logs, options)` 接收 `hookTimeoutMs`（由 runSync 按 flags 计算，非 hook 传 undefined）；spawnSync options 条件展开 `...(hookTimeoutMs ? { timeout: hookTimeoutMs, killSignal: 'SIGKILL' } : {})`；`result.error?.code === 'ETIMEDOUT'` 或 `result.signal === 'SIGKILL'` 时 stderr 输出 `TokenBoard hook sync timed out after ${ms} ms` 后 return 1。env 读取放 sync.mjs（notify 已透传 env）。

- [ ] **Step 4: 全量 skill 测试 + 手动冒烟 `node skills/tokenboard/scripts/sync.mjs --help`。Commit** `feat(skill): bound hook-mode collector runs with a 30-minute timeout`

---

### Task 6: status.mjs 近 7 天聚合（原 #2）

**Files:**
- Modify: `skills/tokenboard/scripts/status.mjs`（buildStatus 参数 + runCli 聚合）
- Test: `skills/tokenboard/scripts/status.test.mjs`

**Interfaces:**
- Produces: status 输出可选块 `recentRuns: { windowDays: 7, total, success, error, skipped, invalid, lastErrorAt }`——仅计数与时间戳，无错误文本、无路径。

- [ ] **Step 1: 写失败测试**

```js
// status.test.mjs 新增（注入 readdir/readFile stub，模式参照现有 readRetryState 测试）
test('aggregates the last 7 days of run logs by filename prefix', () => {
  // 文件名跨 8 天：7 天内的计入，第 8 天的不计；status 字段计数正确
})
test('half-written or corrupt run files count as invalid and never surface content', () => {
  // 一个 JSON.parse 失败文件 → invalid+1；输出 JSON.stringify 全文不含 'path' 或错误片段
})
test('absent runs directory omits the block', () => { /* readdir ENOENT → 无 recentRuns 键 */ })
```

- [ ] **Step 2: 跑确认失败。**

- [ ] **Step 3: 实现**：`collectRecentRunSummary(runsDir, { now, readdir, readFile })`——文件名按 `2026-10-14T…` 前缀日期过滤 7 天；每文件 `JSON.parse` 后只取 `status` 字段（'success'/'error'/'skipped' 之外或 parse 失败计 invalid）；`lastErrorAt` 取 error 文件名时间戳最大值。runCli 里 runsDir = `join(dirname(configPath), 'runs')`，`.bounded-v1` marker 与目录名直接跳过。buildStatus 增 `recentRuns` 参数。

- [ ] **Step 4: 全量 skill 测试。Commit** `feat(skill): summarize the last week of sync runs in status`

---

### Task 7: scheduled 输出流式捕获（原 #10）

**Files:**
- Modify: `skills/tokenboard/scripts/sync.mjs:214-265`（runSync/runCollectorProcess/writeRedactedOutput 改异步逐行管道）
- Test: `skills/tokenboard/scripts/sync.test.mjs`、`skills/tokenboard/scripts/sync-runner.test.mjs`

**Interfaces:**
- Consumes: Task 5 的 hookTimeoutMs options 传递（保持同一入口）。
- Produces: `runCollectorProcess` 变 async，返回 `{ status }`；日志仍是逐行 redact 后写 fd；不再受 64MiB maxBuffer 限制。

- [ ] **Step 1: 写失败测试**

```js
// sync.test.mjs 新增
test('large output streams to the log without maxBuffer truncation', async () => {
  // spawn stub 返回 fake ChildProcess（EventEmitter + stdout/stderr 可写流），写入 >64MiB 行流
  // 断言日志文件包含全部行（redact 后）且无 'ENOBUFS'/'maxBuffer' 错误
})
test('per-line redaction matches the previous whole-buffer output', async () => {
  // 同一组含 tb_upload_ 凭据的行，流式写出的日志与旧 writeRedactedOutput 输出逐行一致
})
```

- [ ] **Step 2: 跑确认失败。**

- [ ] **Step 3: 实现**：`spawn(invocation.cmd, invocation.args, { stdio:['ignore','pipe','pipe'], env, windowsHide })`；stdout/stderr 各挂 `readline.createInterface` 逐行 `write(fd, redactUrlCredentials(line)+'\n')`；收集 exit code（`'exit'`/`'error'` 事件，error→1）；`runSync`/`runSyncInvocation` 调用链改 async（sync.mjs:88-222），`--scheduled` 主路径 await。守卫前新增 const 继续遵守 TDZ 规则。Task 5 的 timeout 用 async `child.kill('SIGKILL')` + 计时器实现（替代 spawnSync timeout）——与 Task 5 合并实现时统一。

- [ ] **Step 4: 全量 skill 测试（sync.test 38 例 + sync-runner 20 例的同步 stub 全部改 async fake）。Commit** `feat(skill): stream scheduled collector output instead of buffering 64 MiB`

---

### Task 8: cache 超限改淘汰（原 #6）

**Files:**
- Modify: `packages/collector/src/providers/codex-session-attribution-cache.ts`（读侧 :361-363、写侧 :385-387）
- Modify: `packages/collector/src/providers/codex-subagent-usage-cache.ts`（读侧 :237-239、写侧 :261-263，新增按字节 trim）
- Test: `packages/collector/src/providers/codex-session-attribution-cache.test.ts`、`codex-subagent-usage-cache.test.ts`

**Interfaces:**
- Produces: 读侧超限 → 返回空缓存重建（不再 throw）；写侧超限 → 沿用 usedKeys 优先 + updatedAt 降序，裁到 `0.75 * maxCacheBytes`；parse 损坏/changed-while-reading/篡改所有权校验保持 throw。

- [ ] **Step 1: 写失败测试**

```ts
// attribution-cache.test.ts：:411 的读侧 rejects 用例改写为
test('an oversized cache file is discarded and rebuilt instead of failing the sync', async () => {
  // 写入 >8MB 垃圾 → read 路径返回 emptyCache，后续 store 正常写入；不 throw
})
// subagent-usage-cache.test.ts：:61/:88-120 的两组 reject 用例改写为淘汰行为
test('a write that would exceed maxCacheBytes evicts the oldest unused entries to 75%', async () => {
  // 填满至 >8MB → store 成功 → 序列化后 ≤ 6MB 且最旧未用条目消失、usedKeys 条目保留
})
test('corrupt JSON still fails closed', async () => { /* SyntaxError 仍 throw（行为不变，防回归） */ })
```

- [ ] **Step 2: 跑确认失败。**

- [ ] **Step 3: 实现**：attribution 读侧 `readBoundedCacheFile` 对 size 超限 return `null`，调用方（:349-353 的 missing-file 分支旁）把 null 映射为 emptyCache；写侧把 `:385-387` throw 替换为 `cache.entries = trimCacheEntriesToSerializedSize(cache.entries, usedKeys, 0.75 * maxCacheBytes)`，裁后仍超（单条目 >8MB 极端）再 throw。subagent 侧同构：新增按字节 trim（仿 attribution `:437-454`），读侧/写侧同改。两个文件的 `assertCursorWriteOwnership` 与 0600 mode 不动。

- [ ] **Step 4: collector 全量测试。Commit** `fix(collector): evict oversized codex caches instead of failing the sync`

---

### Task 9: 指纹 per-collect memo（原 #8 低配版）

**Files:**
- Modify: `packages/collector/src/providers/codex-context-pricing.ts:586-601`（discover 的指纹循环）
- Modify: `packages/collector/src/providers/codex.ts:455-575`（三个 discover 调用共享一个 memo；attribution cache 调用**不**接入）
- Test: `packages/collector/src/providers/codex-context-pricing.test.ts`

**Interfaces:**
- Produces: `FingerprintMemo` 类型 `{ get(path): Promise<CodexSessionFileFingerprint> }`——collect 作用域内一次计算；attribution cache 的 lookup/`assertObservedFilesUnchanged` 保持每次真实重算（Review Focus 2）。

- [ ] **Step 1: 写失败测试**

```ts
// codex-context-pricing.test.ts 新增
test('fingerprints are computed once per file across repeated discovery in one collect', async () => {
  // 注入会计数的 fingerprint fake（或 spy on fingerprintCodexSessionFile 模块导出）
  // 走一次完整 collect（触发 3 次 discover）→ 断言每个文件恰好 fingerprint 1 次
})
test('fingerprint memo is scoped to a single collect', async () => {
  // 两次独立 collect → 第二次重新计算（不跨 run 缓存）
})
test('a file changed between discovery passes still trips the stability assertion', async () => {
  // memo 命中前后 stat 身份一致才复用；用 fake 改 size → 重算 → 断言仍能触发 'changed while fingerprinting' 族错误
})
```

- [ ] **Step 2: 跑确认失败。**

- [ ] **Step 3: 实现**：memo 实现为 `Map<path, Promise<fingerprint>>`，`get` 先 `lstat`（size/mtimeMs/ctimeMs/ino）与缓存值一致才复用，否则重算覆盖——stat 是 µs 级，语义等于现有 TOCTOU 校验，不降级。discover 函数签名加可选 `fingerprintMemo?: FingerprintMemo`；codex.ts 在 collect 入口创建一个 memo 传给三次调用。attribution-cache.ts 侧零改动。

- [ ] **Step 4: collector 全量测试 + 本机单来源冒烟 `pnpm --filter @tokenboard/collector exec tsx src/cli.ts preview --source codex --since 2026-10-13`（有界窗口）。Commit** `perf(collector): memoize codex session fingerprints within a single collect`

---

### Task 10: 上传连续失败降频（原 #11 降档版）

**Files:**
- Create: `packages/collector/src/upload-backoff.ts`
- Modify: `packages/collector/src/cli.ts`（upload 失败路径 :196-198 附近）
- Modify: `skills/tokenboard/scripts/status.mjs`（展示 uploadBackoff）
- Test: `packages/collector/src/upload-backoff.test.ts`、`packages/collector/src/upload-resilience.test.ts`

**Interfaces:**
- Produces: `loadUploadBackoff(stateDir)` / `recordUploadFailure(stateDir, {consecutive, lastErrorSummary})` / `recordUploadSuccess(stateDir)` / `isUploadPaused(stateDir, now)`——状态文件 `<stateDir>/upload-backoff.json`（0600），结构 `{ consecutiveFailures, lastErrorSummary, pausedUntil }`。
- 语义：仅统计**非瞬态**上传失败（4xx/响应解析错误，`isTransientError` 为 false 的）；连续 5 次 → `pausedUntil = now + 24h`；paused 期间**跳过上传但保留全部 cursor/pending**，stderr 显式打印 `TokenBoard upload paused until <ISO> after 5 consecutive failures: <summary>`；exit 0（采集数据已安全保留在 cursor）；任何一次上传成功 → 清零删除文件。transient 错误不计数、不受影响（仍走 75 重试链）。

- [ ] **Step 1: 写失败测试**

```ts
// upload-backoff.test.ts
test('records consecutive non-transient failures and pauses after five', () => { /* 1-4 次不 pause；第 5 次 pausedUntil=+24h */ })
test('a successful upload clears the counter and file', () => {})
test('transient failures never count', () => {})
test('paused state skips upload and preserves cursors', async () => {
  // cli 集成：注入 5 次失败历史 → run → 断言 upload 未被调用、cursor pending 未清、stderr 含 'upload paused'、exit 0
})
```

- [ ] **Step 2: 跑确认失败。**

- [ ] **Step 3: 实现**：upload-backoff.ts 纯函数 + 原子写；cli.ts 在 upload 循环前查 `isUploadPaused`（paused→stderr 提示、跳过上传段、正常 ACK 之外的路径不动）；上传 catch 里区分 `isTransientError` 决定是否 `recordUploadFailure`；成功路径 `recordUploadSuccess`。status.mjs 增 `uploadBackoff: { pausedUntil, consecutiveFailures }`（文件存在时）。

- [ ] **Step 4: collector + skill 全量测试。Commit** `feat(collector): back off uploads after repeated non-transient failures`

---

### Task 11: cursor 仅变化时写（原 #12 低配版）

**Files:**
- Modify: `packages/collector/src/providers/session-cursor.ts:112-121`（commit 增相等性短路）
- Test: `packages/collector/src/providers/session-cursor.test.ts`

**Interfaces:**
- Consumes: 现有 `writeCursor`（session-cursor-store.ts:86）不动。
- Produces: `cursorStatesEqual(a, b)`（导出，JSON.stringify 逐键比较）；commit 在 `cursorStatesEqual(current, next)` 时跳过 writeCursor 返回原值。

- [ ] **Step 1: 写失败测试**

```ts
// session-cursor.test.ts 新增
test('commit with no changes does not rewrite the cursor file', async () => {
  // 记录 stat.mtimeMs → 无任何新文件/变化的 collect → commit → mtime 不变、文件内容字节相同
})
test('commit with pendingUpload marks still writes', async () => { /* markPendingUpload 后 commit → 文件更新 */ })
test('changed-file reads still write the new cursor', async () => { /* 常规增量路径不回归 */ })
```

- [ ] **Step 2: 跑确认失败。**

- [ ] **Step 3: 实现**：`cursorStatesEqual` 用 `JSON.stringify(next) === JSON.stringify(current)`（9MB 字符串化 ~几十 ms，远低于 9MB 序列化写入+rename；两态都已是 plain JSON 对象）。commit 改为：

```ts
if (cursorStatesEqual(current, next)) return next
return writeCursor(input.cursorPath, next)
```

- [ ] **Step 4: collector 全量测试（session-cursor 5 个配套测试文件全绿）。Commit** `perf(collector): skip cursor rewrites when nothing changed`

---

## 收尾任务

### Task 12: 全量门禁 + 本机生效验证

- [ ] `pnpm test`（workspace 全量）、`pnpm -r typecheck`、`pnpm build`、`node --test skills/tokenboard/scripts/*.test.mjs`、`pnpm audit --audit-level=high`
- [ ] `git log --oneline ba43dc1..HEAD` 逐提交复核、`git status` 干净
- [ ] 本机 config 设置 `notifyCooldownMs: 1800000`（Task 4 Step 6），`node skills/tokenboard/scripts/status.mjs` 冒烟
- [ ] 更新 memory 台账（sync-mechanism-review 的实施状态）
