# 用 Go 原生实现取代 ccusage（设计文档）

- 日期：2026-11-03
- 状态：待批准（draft）
- 分支：`feat/native-usage-sources`
- 相关调研：本设计基于 4 份并行调研（ccusage v20.0.33 上游架构、Go 侧消费面、TS 侧耦合与定价、Claude/Codex/12 工具解析语义），
  原始结论暂存于对话记录，实施计划落地时补 `docs/research/` 引用。

## 1. 动机

Go 客户端当前通过外部 `ccusage` 可执行文件获取三类来源的数据，形成一条不可控的外部依赖链：
三层二进制获取（bundled > PATH > npx/pnpm dlx 下载）、版本 pin（20.0.33）、凭据剥离、跨端语义对齐。
ccusage v20.0.33 是 MIT 许可的 Rust 实现（~70K LOC），语义可完全在我方复刻。

用户决定（2026-11-03）：**彻底移除 ccusage 依赖，全部用 Go 重新实现，并量化性能差异。**
本机实测的 ccusage 成本基线见 §9.1（单次全量扫 ~30 s、峰值 RSS 7.7–9.3 GB，且 `--since/--until`
不减少扫描量）。

调研确认的关键事实：

- **自主解析基础已存在**：hook 增量路径（`sessioncursor`/`sessionfile`/`sessionusage`）已直接读原始 JSONL，
  生产验证；Go 侧 Codex 上下文定价与子代理修正也直接读原始文件。
- **真正依赖 ccusage 的只剩三块**：Claude Code 日聚合+成本、Codex 日聚合、12 个工具来源。
- **本机语料规模**：Claude Code 9,828 个 JSONL / 23 GB（单文件最大 1.25 GB）；Codex 13 文件 / 5.5 GB。
  任何实现必须走增量/cursor 路径，全量重扫不可接受。
- **ccusage 内部无 pro-rata 分摊**；TokenBoard 的按 token 占比分摊是自有语义，保留不动。

## 2. 目标（可验证）

- **G1 生产路径零 ccusage**：Go 二进制在 `sync`/`preview`/`hook` 中不 exec、不下载、不捆绑 ccusage。
  验收：`git grep -n 'ccusage' clients/go -- '*.go'` 仅剩 parity/bench 工具与文化性注释；
  从零机器（无 ccusage、无网络）跑 `tokenboard preview --source all` 全量成功。
- **G2 逐字段一致**：同一语料、同一 `--timezone`/`--since`/`--until` 下，原生实现的产物经现有 normalize
  路径后与 ccusage 20.0.33 的产物 `snapshotHash` 完全一致。任何差异须进入台账并逐条解释。
- **G3 全部来源原生**：claude-code、codex 以及 12 个工具来源（amp、droid、codebuff、hermes、goose、
  kilo、copilot、gemini-cli、kimi、qwen、openclaw、zcode）均由 Go 直接读本地数据。
- **G4 成本引擎自足**：Auto/Calculate/Display 三种费用模式、cache creation 两档（5m/1h）、
  长上下文分档、fast/flex 乘数、`pricingOverrides` 合并（含缓存率按比例缩放）、
  DeepSeek V4 按时段定价，全部在 Go 内完成。
- **G5 性能量化**：基准工具对同一语料、同一窗口输出 ccusage vs native 的 wall time、max RSS、
  读取字节数；每场景 ≥5 轮取中位数；报告提交到 `docs/research/`。
- **G6 依赖面删除**：`internal/ccusage/{acquire,package_runner,version,credentials,command,normalize,orderedjson}`
  中仅 parity 所需部分保留在 dev-only 路径；三层获取、捆绑脚本、`TOKENBOARD_CCUSAGE_BIN`/
  `TOKENBOARD_FORCE_PACKAGE_RUNNER`/`TOKENBOARD_DYNAMIC_CCUSAGE_CONFIG` 等环境变量退役并写入迁移说明。

## 3. 非目标

- 不实现 ccusage 的 CLI 展示面：monthly/weekly/blocks/statusline、表格渲染、`--jq`、`--by-agent`。
- 不改上传契约、`usage-core` schema、API。
- 不重写已自主的来源：opencode、pi、grok-build、deepseek-harness、antigravity 三源（它们不经过 ccusage）。
- **TS collector 保持 legacy（仍用 ccusage）直到 M7 退役**；`packages/collector` 的 npm 依赖在此期间保留。
  本设计的「零依赖」指 Go 客户端（发布物）；TS 侧的移除属于 M7 独立议题。

## 4. 反目标

- 静默数值漂移：任何与 ccusage 的差异必须有解释、有台账；不允许「大概齐」。
- 削弱 fail-closed：损坏行、未安装来源、时区解析失败、超限文件等行为必须保持现行语义。
- 用全量重扫替代增量：hook/cursor 路径不得退化为全量解析。

## 5. 约束

- 语义冻结在 ccusage **v20.0.33**（commit `1308c416`）；派生逻辑在源码头注明出处与 MIT 署名。
- AGENTS.md 的跨端不变量继续有效：snapshotHash 两侧一致；hook 模式零网络；Windows/Linux 构建通过。
- 数值用 `float64` 且运算顺序与 ccusage 一致（`codexDivisor` 式 1 ULP 教训）。
- 大语料流式、有界读取（沿用 `sessionscan`/`sessionfile` 的上限与超大行策略）。
- 定价数据不新增运行时网络请求：内嵌基线快照 + 服务端下发的动态目录（现有行为）。

## 6. 架构

### 6.1 新增组件

| 组件 | 职责 |
|------|------|
| `internal/pricing/engine.go` | 内存 `PricingMap`（内置基线 + overrides 合并），提供 `Cost(model, usage, at)` 纯函数；含模糊键匹配、分档、乘数、时段定价 |
| `internal/collect/adapters/claude` | 路径发现、JSONL 流式解析、去重（结构化键）、sidechain/advisor 规则、日/会话聚合 |
| `internal/collect/adapters/codex` | `.jsonl[.zst]` 读取、事件状态机（累积→差分、replay/compacted、service_tier）、日聚合 |
| `internal/collect/adapters/tools/*` | 12 个工具适配器，按 ccusage 语义读取各自本地格式，产出统一 `Row` |
| `internal/collect/adapters/agg` | 共享聚合：`Row` → `contract.Snapshot`（timezone 归属、sessionCount、collectedAt） |

### 6.1.1 适配器的产出边界（2026-11-03 决策，builder 复核后锁定）

**原生适配器产出「ccusage 报表形状」的行，不直接产出 `contract.Snapshot`。**

理由与影响：

- `internal/ccusage/normalize.go`（699 行）被 claudecode / codex / ccusagetool 三个 provider 共用；
  `providers/codex` 共 28,716 行，其中 `provider_scope.go`、`session_scope.go`、`attribution_cache.go`、
  `subagent_usage*.go`、`hook_profiles.go` 全部以 ccusage 的 **session 报表行**为输入
  （`ccusage.SessionRows`、`ReadSessionFileRow` 的 `directory`/`sessionFile`/`sessionId`、
  `ReadCcusageSessionAttribution`、home index）。连已自主的 Codex context-pricing 也经由
  `canonicalModelsByScopedFileFromSessionRows` 依赖这批行。
- 若改为直接产出 Snapshot，上述消费层全部要重写，S3 从「写解析器」膨胀为「重写 28K 行消费层」，
  且 G2 的比对基准失去参照。
- 因此原生适配器的契约是：**与 ccusage 20.0.33 的 `--json` 报表行同形状**
  （Claude/工具族：`daily[]` + `sessions[]` + `modelBreakdowns[]`；
  Codex：`daily[]` 的 `models` map 形状 + session 行的 `directory`/`sessionFile`/`sessionId`/
  `lastActivity`/`modelBreakdowns`），由现有 normalize 路径转为 Snapshot。
- 后果：pro-rata 分摊、session 归属、日期语法容错等 normalize 语义**原样保留**，S2/S3 只换数据生产者；
  §5 的「如无必要不改会计口径」自然成立。

### 6.1.2 定价语料的冻结范围

G2 要求成本逐字段一致，而 ccusage 的 `PricingMap` 由四层叠加：LiteLLM 构建期快照
（`flake.lock` pin 的 rev）、内置基础费率、models.dev 快照（含 `exactOnly`/`limit.context`）、
`fast-multiplier-overrides.json` + `flex-multiplier-overrides.json`，另有运行时
`CCUSAGE_MODEL_ALIASES` 参与查找。**四层语料与别名语义全部在冻结范围内**，缺一层成本即分叉。
TokenBoard 服务端下发的动态目录继续叠加在最高优先级（现有行为），保证新模型仍能定价。

### 6.1.3 hook 路径的双源和解

现状是 fail-closed 的独立交叉校验：hook 自解析得到窗口 → ccusage 取同窗口报表 →
`AssertHookReconciliationSnapshots` 断言覆盖一致。原生实现后不再有第二个外部数据源，
改为**同实现内的两路交叉**：增量解析结果 vs 对同一日期窗口做整窗重算的结果，覆盖的
`(date, model)` 必须一致，否则 fail-closed。语义等价、校验强度不变，但必须在 S2 中显式实现与测试。

### 6.1.4 对照基准（oracle）的层级

1. **行级金样本**：ccusage 20.0.33 对固定夹具树产出的原始 `--json` 行，一次性生成并提交，
   CI 只跑 native 比对——ccusage 从仓库移除后金样本永久冻结，演化由人工审查提交。
2. **端到端金样本**：TS collector（M7 前仍用 ccusage）产出的 snapshotHash，用于 Go native vs TS 的
   影子双跑，作为第二道校验。

### 6.2 复用（不改接口）

- `sessioncursor`（增量扫描/cursor/pending）、`sessionwalk`/`sessionscan`（有界遍历）、
  `sessionfile`（行读取/指纹/Claude·Codex 解析器）、`sessionusage`（快照构建）、
  `pricing/catalogue.go`（动态目录与 override 生成）。

### 6.3 Provider 重接线

`providers/claudecode`、`providers/codex`、`providers/ccusagetool` 内部改调原生适配器；
`collect.Provider` 接口与注册机制不变，`contract.Source` 不变。

### 6.4 过渡期 parity 工具

- `tokenboard shadow` 保持不变：过渡期 TS collector 仍调 ccusage，天然提供对照基线。
- 新增 dev-only `cmd/parity`（不进入生产构建）：对指定来源/窗口分别跑 native 与
  指定 `--ccusage-bin`，输出逐字段 diff 与统计。
- CI 的 `check-deps.sh` 门禁改造为「原生解析契约金样本」：固定输入树 → 期望快照（由 ccusage
  20.0.33 一次性生成并提交），CI 只跑 native 比对，不再需要 ccusage。

### 6.5 数据流

```
本地文件（JSONL/SQLite/…）
  → adapter.Scan(opts) → []Row{Date, Model, Tokens(4), Cost, Priced}
  → 聚合（timezone 归属、sessionCount、pro-rata 保留）
  → contract.Snapshot → 现有 upload / cursor
```

## 7. 必须复刻的语义（以 ccusage v20.0.33 源码为准）

### Claude Code

- 去重键：`message_id + request_id`（两者都在时）；缺 `request_id` 时追加 `session_id`，
  且 `message_id` 非 `msg_` 前缀时再追加 `timestamp`。冲突解决：非 sidechain > sidechain；
  token 总数大者 > 小者；带 `speed` 者优先。
- sidechain replay 与跨会话副本的两级附加去重桶。
- `advisor_message` 拆分独立计费；`<synthetic>` 过滤；fast 模式模型名加 `-fast` 后缀。
- 空 `sessionId`/`requestId`/`message.id`/`model`、非 semver `version` 的行跳过。
- 日期归属用 `--timezone` 本地日；时间戳解析为 epoch 毫秒。
- `--since` 按文件 mtime 剪枝（append-only 假设，留 1 天边距；session 任一文件活着则整组保留）。

### Codex

- 累积 `total_token_usage` → 逐桶饱和差分；`token_usage_record` + `compacted` 配对；
  fork 重播 `MatchingParent` 精确匹配与 `SkippingRewrittenBurst`（1s 静默）兜底。
- 字段别名归一（`input_tokens|prompt_tokens|input` 等）；cache 读 ≤ input、cache 写 ≤ input−cache 读。
- service_tier 分桶与乘数；`codex-auto-review` → `gpt-5` 模型回退。
- 输出中 `inputTokens` = non-cached。

### 定价

- `PricingMap::find` 三级：精确 → 模糊（`@./_`→`-` 归一、最长前缀、`exact_only` 保护、大小写敏感）；
  时间相关定价（DeepSeek V4）。
- override 合并：字段级；仅覆盖 input 时缓存率按比例缩放（`new = old × new_input / old_input`）。
- 计费：cache create 默认 `1.25 × input`（1h 档按 2×）；长上下文整请求切档；
  fast/flex 乘数；缺价模型记 0 并标记 `missingPricing`。

### 12 个工具来源

按 ccusage adapter 语义：路径、格式、token 字段、是否有自报 cost、session 判定；
简单 JSON/JSONL 与 SQLite 两类，copilot 最复杂（OTel + session-state + credit gap）。

## 8. 交付拆分（按子项目分别计划）

| 子项目 | 内容 | 独立可交付 |
|--------|------|-----------|
| S1 | `pricing/engine` + parity/bench 骨架 + 契约金样本生成器 | 是 |
| S2 | Claude Code 适配器（最难：去重/成本/增量） | 是 |
| S3 | Codex 适配器（差分/重放/tier） | 是 |
| S4 | 12 工具适配器 + provider 重接线 | 是 |
| S5 | 移除获取层/捆绑/环境变量；CI 与文档收尾；性能报告 | 是 |

## 9. 性能测量方法

### 9.1 ccusage 当前基线（2026-11-03 本机实测，load ≈ 59）

| 场景 | 命令 | 墙钟 | 峰值 RSS |
|------|------|------|---------|
| claude daily，单日窗口 | `claude daily --json --offline --since 20261101 --until 20261101` | 35.8 s | 7.7 GB |
| claude daily，全量 | `claude daily --json --offline` | 31.5 s | 9.3 GB |
| claude session，全量 | `claude session --json --offline` | 32.4 s | 8.9 GB |

**关键反直觉事实**：单日窗口与全量的耗时/RSS 几乎相同——`--since/--until` **只过滤输出，不减少扫描量**，
ccusage 每次都全量扫 ~9,828 文件 / 23 GB。此结论与 `docs/specs/go-client-spec.md` §5 的既有记录一致。

既有实测（已复核，见 `go-client-spec.md` §5）：

- `--single-thread` 把峰值 RSS 从 5.55–5.67 GB 降到 2.43–2.47 GB（−57%），墙钟升 1.7×。
- 一次真实的 Go 二进制 hook 同步 **352 s**（hook 上限 30 min）。Go 与 TS 调同一二进制，**两侧性能无差别**，
  瓶颈在 ccusage 本身。
- 本机语料：Claude Code 9,828 JSONL / 23 GB（单文件最大 1.25 GB）；Codex 13 文件 / 5.5 GB。

> 注意：`~/.tokenboard/logs/daily-sync.out.log` 里 300–950 ms 的 `ccusageDaily` 计时出自 2026-09-21 的
> 旧日志（该文件时间跨度止于当日），**不能**用于估计当前成本。

### 9.2 native 预期（待 S1 基准校准）

| 维度 | 预期 | 依据 |
|------|------|------|
| 峰值内存 | 大幅下降（GB → 数十~数百 MB） | 流式 + 有界读取，只驻留 (date,model) 聚合行 |
| 增量场景 | 大幅下降（30 s 级 → 亚秒级） | 复用 cursor，hook 只读变更文件；ccusage 每次都全扫 |
| 进程启动 | 消除 | 否则每次 exec + Node/二进制加载 |
| JSON 往返 | 消除 | 否则序列化/解析 128 MB 级报表 JSON |
| 全量吞吐 | **大致相当或略慢** | Rust 解析吞吐强（`memchr` SIMD）；Go GC/逐行可能不如 |

### 9.3 测量协议

- 工具：`clients/go/cmd/bench-collect`（dev-only），同进程跑 native；ccusage 侧 exec 20.0.33。
- 指标：wall time、max RSS（`getrusage`）、读取字节数；每场景 **≥5 轮取中位数**并记最大值
  （本机单轮误差可达 2×）。
- 场景（均在本机真实语料上）：
  - A 单日窗口：测「空跑成本」——进程启动 + JSON 往返占比最高。
  - B 近 30 天窗口：典型定时同步。
  - C 全量（无 `--since`）：测吞吐与峰值内存。
  - D hook 增量（cursor 命中，仅少量文件变更）：native 增量 vs ccusage 全窗口。
  - E 冷启动到首字节（进程 spawn + 二进制加载）单独计时。
- 诚实预期：**native 不保证单轮更快**；收益来自无进程启动、无下载、无 JSON 往返、真增量、内存可控。
  若某场景 native 反而更慢，如实记录并分析（例如 Go GC 或逐行解析差异）。
- 交付物：`docs/research/2026-11-XX-native-vs-ccusage-benchmark.md`，含方法学、原始数据表
  （每轮值 + 中位数 + 最大值）、结论与反例。

## 9.4 跨项目注意事项（2026-11-03 补充）

### 9.4.1 历史 costUsd 会被重新上传覆盖（需决策）

**事实**：AGENTS.md 规定「动态定价只作用于新采集；不得自动重算历史 `costUsd`」。但服务端
ingest 的 upsert（`apps/web/app/features/ingest/repository/upsert.ts:141-155`）在
`snapshot_hash` 变化时用 `excluded.cost_usd` 覆盖既有行：

```sql
ON CONFLICT(user_id, device_id, source, usage_date, model) DO UPDATE SET
  cost_usd = CASE ... ELSE excluded.cost_usd END,
  ...
WHERE (daily_usage.snapshot_hash IS NULL OR daily_usage.snapshot_hash <> excluded.snapshot_hash)
```

而 `snapshotHash` 的 payload **包含 `costUsd`**（`contract.go:193-222`）。因此 native 算出的
成本只要与 ccusage 差一个字节，hash 就变，该历史行的 cost 就会被 native 重算值替换。

**决策 D7（我的判断，可否决）**：**接受这个行为，不为它加新的保护层**。理由：

- 这不是 native 引入的新机制——它一直是 upsert 的既有语义；任何一次客户端成本口径变化
  （含历史上升级 ccusage、改 pricingOverrides）都会触发同样的覆盖，只是过去没有大规模发生。
- 覆盖发生在「同一 (source, date, model) 被重新上传」时，即该行本来就处于活跃重算范围；
  native 冻结 20.0.33 语义后，同一输入的产出是稳定的，不会来回抖动。
- 真正的风险是**一次性批量覆盖**：native 首次全量上传会把所有可见日期的 cost 换成 native 值。
  缓解：G2 要求首次上线前 parity 全绿（snapshotHash 逐行一致），差异必须在台账中逐条解释，
  从而让这次覆盖是「已知且有意」的，而非静默。
- AGENTS.md 那句「不重算历史」原本针对的是「**服务端**主动批量重算」；客户端重传覆盖是另一回事。
  实施时同步在 AGENTS.md/文档中澄清这一区分（避免后人误读）。

**替代方案（备选，若实施时判断风险过高）**：客户端在 `costUsd` 变化的行上打一个 `correction`
标记（`correction` 字段已在 contract 里，目前只有 `codex-context-pricing` 一个合法值），
让服务端可区分「口径修正」与「常规重传」。此方案需改 `usage-core` schema 与服务端，成本更高，
暂不采用。

### 9.4.2 copilot 的工作量显著高于其余 11 个工具来源

copilot 在来源枚举里属 12 工具族（`packages/usage-core/src/schema.ts:20,39,53`；
`contract.go:69,85`），但我们通过 `ccusage copilot daily --json` 调用它。而 ccusage 对 copilot
走的是**完整 adapter**（OTel JSONL + `session-state/*/events.jsonl` 粗粒度信用快照 +
credit gap 对账），并非简单工具族格式。**S4 里 copilot 单独按「复杂来源」排期与测试**，
不得按参数化工具族一刀切。

## 10. 风险与缓解

| 风险 | 等级 | 缓解 |
|------|------|------|
| Claude 去重语义偏差 | 高 | 结构化键 + 逐条 golden 用例（sidechain/gateway/重复写） |
| Codex 差分/重放偏差 | 高 | 用真实 session 文件做 parity 夹具；与现有 context_pricing 对账 |
| 历史 cost 被重传覆盖（§9.4.1） | 中 | 首次全量前 parity 全绿；差异逐条进台账；必要时上 `correction` 标记 |
| copilot 复杂度被低估（§9.4.2） | 中 | S4 单独排期，独立 parity 夹具 |
| 浮点 1 ULP 分叉 | 中 | 固定运算顺序；goldens 比对 snapshotHash |
| 定价键匹配细节 | 中 | 移植 `exact_only`/大小写/版本后缀保护；用目录样本做表驱动测试 |
| 工具格式漂移 | 中 | 冻结 20.0.33 语义；格式变更由我们维护并补测试 |
| 大文件内存 | 中 | 流式 + 上限；基准里记录 max RSS |
| 二进制体积膨胀 | 低 | 四层定价语料嵌入后测体积，纳入 S1 基准指标 |
| MIT 署名缺失 | 低 | 仓库内 `THIRD_PARTY_LICENSES`；派生源码头注明出处 |
| Windows 路径/编码 | 中 | 三平台 CI；沿用既有 path 工具 |

## 11. 已定的架构决策（builder 复核后锁定，可否决）

| # | 决策 | 影响 |
|---|------|------|
| D1 | 原生适配器产出 **ccusage 报表形状的行**，由现有 normalize 路径转 Snapshot（§6.1.1） | 消费层不重写；S2/S3 只换数据生产者 |
| D2 | 定价语料**四层全部冻结**（LiteLLM rev + 内置费率 + models.dev + fast/flex overrides）+ 别名（§6.1.2） | 体积与移植量增加，但 G2 可达 |
| D3 | hook 双源和解改为**同实现内两路交叉**（增量 vs 整窗重算）（§6.1.3） | S2 需实现并测试该重算校验 |
| D4 | oracle 分两层：行级金样本（永久冻结）+ 端到端 snapshotHash 影子双跑（§6.1.4） | 定 S1 生成器与 CI 门禁 |
| D5 | 12 工具适配器**全部原生**（用户 2026-11-03 决定：彻底移除） | S4 立项 |
| D6 | TS collector 保持 legacy 至 M7，本设计不涉及 TS 侧移除 | 过渡期天然提供对照基线 |
| D7 | 接受「重传覆盖历史 cost」为既有语义，不加新保护层；首次全量前 parity 全绿（§9.4.1） | 无需改服务端；差异逐条进台账 |
| D8 | copilot 按「复杂来源」单独排期，不并入参数化工具族（§9.4.2） | S4 拆分与测试口径 |

## 12. 留给实施者的决定

- 去重键的具体表示（建议结构化字符串键，绕开散列碰撞语义）。
- 内嵌定价基线快照的 vendor 方式（从 ccusage 仓库的 `models-dev-pricing.json`、
  `fast-multiplier-overrides.json`、`flex-multiplier-overrides.json`，以及按 `flake.lock`
  rev 取的 LiteLLM 快照，校验和固定、保留 MIT 署名）。
- parity/bench 工具的 CLI 形状与报告格式。
- 12 个适配器的包布局（每工具一包 vs 单包内多文件）。
