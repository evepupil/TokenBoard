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
  验收：`git grep -n 'ccusage' clients/go` 仅剩 parity/bench 工具与文化性注释；
  **binary 安装**（`clientType: binary`，无网络、无 ccusage）跑 `tokenboard preview --source all` 全量成功。
  口径边界：**git 安装仍会拉 ccusage**（`install-collector.mjs` 会 `pnpm install` workspace 依赖，
  `packages/collector/package.json` 含 `ccusage`），该组合在 M7 前不作为验收对象。
- **G2 对「完全钉死的输入」确定性一致**（2026-11-03 重定义）：parity 的基准不是「线上 ccusage 的产物」，
  而是「**冻结语料（20.0.33 构建期快照）+ 我们服务端下发的目录 override**」这一组完全确定的输入。
  native 对固定输入必须逐字段可复现（`snapshotHash` 一致），且与 `ccusage --offline --config <我们的配置>`
  在同一固定夹具上一致。
  **为什么这样重定义**：生产 claude 路径不传 `--offline`（`claudecode.go:291`），ccusage 默认联网拉
  LiteLLM `main` 分支**当天**定价并在内嵌快照之前使用在线 models.dev——实测同一天 online
  `totalCost=1451.10` vs offline `1349.06`，5 个模型行不同。因此「与线上 ccusage 逐字节一致」在定义上
  不可达；可达且有意义的目标是「对确定输入的确定性产出」。
  另设**迁移闸门**：落地前在真机上做一次 `native vs 生产线上 ccusage` 的 diff，每一处差异逐条列出并解释
  （预期差异只落在未被我们目录覆盖的模型上，来源是「实时 main vs 冻结快照」），形成台账后 D7 才成立。
  顺带说明：旧的「不重算历史」表述针对服务端主动重算；客户端重传覆盖是既有语义，见 §9.4.1。
- **G3 全部来源原生**：claude-code、codex 以及 12 个工具来源（amp、droid、codebuff、hermes、goose、
  kilo、copilot、gemini-cli、kimi、qwen、openclaw、zcode）均由 Go 直接读本地数据。
- **G4 成本引擎自足**：Auto/Calculate/Display 三种费用模式、cache creation 两档（5m/1h）、
  长上下文分档、fast/flex 乘数、`pricingOverrides` 合并（含缓存率按比例缩放）、
  DeepSeek V4 按时段定价（按事件时间戳查询定价的 `FindAt` 接口承载，不能只保留「当前时刻」查询），
  全部在 Go 内完成。
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
| `internal/nativepricing/` | 内存 `PricingMap`（冻结语料 + 服务端 overrides 合并），提供 `Cost(c, model, usage, at, mode, fast, flex)`；含模糊键匹配、分档、乘数、时段定价（`at` 形参 S2 接入） |
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

G2 要求成本逐字段一致，而 ccusage 的 `PricingMap` 由以下层叠加（2026-11-03 逐文件核对：

- **五份嵌入资产**：① LiteLLM 构建期快照（`flake.lock` pin 的 rev，经 `is_embedded_model`
  白名单过滤 + 字段压缩 + deflate）；② `models-dev-pricing.json`；③ `models-dev-catalog-rules.json`
  （离线运行期仍被 `is_token_priced` 读取）；④ `fast-multiplier-overrides.json`；
  ⑤ `flex-multiplier-overrides.json`。
- **代码内置基础费率表**（`put_builtin_pricing`，约 37 个模型 id，含 `put_builtin_glm` 的
  cache 字段补丁）——不是 JSON 资产，但同属冻结范围。
- **派生 pass**：`fill_long_context_rates_from_models_dev` 把 models.dev 的 `cost.tiers`
  嫁接到 LiteLLM 平面条目上（LiteLLM 不发布 OpenAI/xAI 的长上下文价）。
- 运行时 `CCUSAGE_MODEL_ALIASES` 环境变量参与查找；本仓库生产路径不设置它（实测为空），
  故冻结范围为「空别名表 + 上述五资产 + 内置表 + 派生 pass」。**缺任一层成本即分叉。**

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

- `PricingMap::find` 三级：精确 → 模糊（`normalized_pricing_key` 只把 `.` 和 `@` 换成 `-`，
  **不换 `/` 或 `_`**；边界按非字母数字判定、最长前缀、版本后缀保护、`exact_only` 保护、大小写敏感）；
  时间相关定价（DeepSeek V4，按事件时间戳 `FindAt`）。
- 费率来源优先级：LiteLLM 平面条目 → 内置基础费率表（只补缺）→ models.dev 快照（只补缺）→
  运行时 override（最高优先级）。
- 派生默认：`cache_create = 显式值 ?? input × 1.25`；`cache_read = 显式值 ?? input × 0.1`
  （**不是 `input`**）。models.dev 的 `cost.*` 是每百万 token，加载时 `/1e6`，其 cache write 字段名是
  `cost.cache_write`。
- 长上下文：阈值只来自 models.dev 的 `cost.tiers`（`tier.type == "context"`，多档取最小 `size`）。
  有阈值 → **整请求切档**；无阈值 → 200k 边际 `tiered_cost`。`max_input_tokens`/`limit.context`
  只是上下文窗口，不是档位阈值。
- override 合并：字段级；缩放闸门是 `覆盖了 input && base.input > 0 && !base.cache_read_explicit`
  —— 即只在 base 缓存价是**派生值**时才按 `new = old × new_input / old_input` 缩放；
  LiteLLM 显式给了 cache 价的模型（sonnet、gpt-4o）不缩放。override 键名是 camelCase。
- 乘数：Claude 路径 `cost × fast_multiplier`（仅 `speed == Fast`，不用 flex）；
  Codex 路径按 service_tier 分桶，`flex`/`fast` 以 `× (multiplier - 1.0)` 的增量叠加。
  乘数来源：`provider_specific_entry.{fast,flex}` 优先，其次 override 文件（`exact` + `normalized_prefix`）。
- 缺价模型记 0 并标记 `missingPricing`。

### 12 个工具来源

按 ccusage adapter 语义：路径、格式、token 字段、是否有自报 cost、session 判定；
简单 JSON/JSONL 与 SQLite 两类，copilot 最复杂（OTel + session-state + credit gap）。

## 8. 交付拆分（按子项目分别计划）

| 子项目 | 内容 | 独立可交付 |
|--------|------|-----------|
| S1 | `internal/nativepricing` + parity/bench 骨架 + 契约金样本生成器 | 是 |
| S2 | Claude Code 适配器（最难：去重/成本/增量） | 是 |
| S3 | Codex 适配器（差分/重放/tier；含 Codex 的 flex 增量乘数与 service_tier 分桶） | 是 |
| S4 | 12 工具适配器 + provider 重接线（工作量按 2026-11-03 复核上调，见 §9.4.2） | 是 |
| S5 | 移除获取层/捆绑/环境变量；CI 与文档收尾；性能报告 | 是 |

**阻塞项（S5 前必须完成）**：在移除 ccusage 获取层之前，必须先对 claude-code、codex 与 12 个
工具来源逐一**固化行级金样本**（ccusage 20.0.33 对固定夹具树的 `--json` 原始输出，一次性生成提交）。
ccusage 一旦从仓库移除，金样本就永久冻结、无法再生成；没有这批金样本，后续任何语义漂移都无从发现。
金样本生成器属 S1（见 S1 计划 Task 5），但**逐来源固化**须在各自的 S2/S3/S4 落地时同步完成，
S5 移除前做一次总盘点确认 14 个来源齐全。

- [x] **总盘点（2026-11-10，S5 移除获取层之后补做）**：14/14 来源齐全，均有由真实
  `ccusage 20.0.33` 读取固定夹具树后生成的原始 `--json` 报告，Go 侧逐字段严格比对、无豁免列表。
  - claude-code：`adapters/claude/goldens/claude-reports.json`（daily auto/calculate 各 12 行、session 4 行）。
  - codex：`adapters/codex/goldens/codex-reports.json`（auto 11 / calculate 11 / session 13 / unbounded 12 行）。
  - 11 个工具来源：`adapters/tools/goldens/tool-reports.json`（`gemini` 子命令对应 `gemini-cli`）；
    copilot 单独在 `providers/ccusagetool/copilot-goldens/copilot-reports.json`（另含 2 份 upstream 快照）。
  - 生成方式仍可复现，但**依赖仓库外的 ccusage 20.0.33**（默认 `~/.tokenboard/bin/ccusage`，`CCUSAGE_BIN` 可覆盖；
    CI 的 `deps` job 通过 `check-deps.sh` 跑四个 `--check`）。一旦 TS collector 退役、pnpm 不再提供 ccusage，
    这条复现路径就断——届时金样本只能作为只读基线使用，这是 S5 有意接受的取舍。
  - 已知覆盖深度缺口（不阻塞 S5，记在此处以免被当成已覆盖）：多数工具来源每个报告只有 1–3 行；
    claude 金样本只覆盖 parser 接受路径、不含线级拒绝与窗口剪枝（见 `adapters/claude/goldens_test.go` 头条注释）。

### 8.1 S1 结转义务（2026-11-05 最终审查后登记）

S1 的整分支终审留下七项义务，其中三项已写进代码注释（`clients/go/internal/nativepricing/cost.go:122-130`
的 missingPricing 零 token 门与无效的 `at` 形参、`clients/go/internal/nativepricing/builtin.go:27-35`
的 builtin context limits），其余四项仅由本节记载；S1 不读这些路径，所以当时只标注、不修；分派如下。

**S2 必须处理**

- `Find` 没有 memoization（ccusage 有 `find_cache`，`clients/go/internal/nativepricing/find.go:53`）：把
  `collect.LookupNative` 接进热路径前必须先决策。**S2 已落地**：`adapters/claude/cost.go` 的
  `memoizeFind` 在每次 collection 建一个按模型名缓存的 finder（`f60ddf3`），`internal/nativepricing`
  本身仍不缓存。
- `parityEnv`（`clients/go/cmd/parity/main.go:432`）只剥离 `TOKENBOARD_HOOK_MODE`；S2 起的原生 provider
  子进程必须沿用 `internal/ccusage.ScrubCredentialEnv`（`clients/go/internal/ccusage/credentials.go:45`）
  的同一名单，即 AGENTS.md「ccusage 子进程环境必须剥离凭据」这条跨端不变量。**S2 复核结论**：
  原生 provider 完全 in-process，不 spawn ccusage，因此 parity 的 `execCcusage` 子进程仍是唯一
  需要脱敏的路径，沿用该名单即可；`parityEnv` 保持只剥离 hook mode。
- `Cost` 的 `at time.Time` 形参在 S1 无效（`clients/go/internal/nativepricing/cost.go`）：`FindAt` 与
  时段费率资产都还没有实现。**DeepSeek 时段定价推迟到 S3**——但它是**定价引擎层**的缺口，不是
  Codex 适配器专属：ccusage 的 claude daily 也会对带时段费率的模型名（经代理网关出现在
  Claude transcript 里的 deepseek 行）按事件时间计价，所以 S3 落地前 claude 路径在这类行上
  本来就与上游不一致，与适配器对错无关（2026-11-06 复核确认，Codex 发现 4）。S3 计划
  （`docs/superpowers/plans/2026-11-06-s3-codex-adapter.md` Task 7）已把 `FindAt`、时段表与
  每模型长上下文档位阈值列为独立可交付，并要求 claude 金样本的交叉回归。
- parity 的 ccusage 侧目前比较 raw normalize 输出（无 codex corrections、无动态定价）：S2 扩展。
  S2 已改：`cmd/parity` 通过 `pricing.Prepare` 把同一份 merged config 交给 ccusage 的 `--config`
  与 native 的作用域解析（`f113539`；作用域与 mode 见 2026-11-06 复核）。两侧共享的只是
  **override 文件**：不在 override 与冻结语料里的模型仍分别是 ccusage 的在线 LiteLLM 表与
  native 的冻结语料，319 条 costUsd diff 就是这么来的（报告 §3）。codex 扩展推迟到 S3。
- **配置作用域与计费 mode**（2026-11-06 复核）：ccusage 按 `ConfigContext::option_maps` 合并
  root `defaults`、`commands["claude daily"]`、`commands["daily"]`、`commands["claude:daily"]`、
  `claude.defaults`、`claude.commands["daily"]` 六层，`defaults.mode` 决定 auto/calculate/display。
  **S2 已落地**：`pricing.PreparedConfig.ResolveScope` 逐层字段合并，native 按 `claude daily`
  作用域计价；只读根 `defaults.pricingOverrides` + 固定 `ModeAuto` 的旧实现会在作用域配置下
  与 ccusage 分叉。

**S4 必须处理**

- builtin context limits 未移植（`clients/go/internal/nativepricing/builtin.go:27-35`）：ccusage 的三档
  limit 会被 `Corpus.ContextLimits` 的单张合并表压平，移植 `context_limit` 时须补齐三档。
- `missingPricing` 折叠了 ccusage 的零 token 诊断门（`clients/go/internal/nativepricing/cost.go:122-126`）：
  适配器须自行补上空 usage 例外与别名解析后的诊断文案。S2 的 Claude 适配器把这条放在
  `adapters/claude/cost.go` 的 `NewCostFunc` 里补齐（不修改 `nativepricing`）；S4 的工具适配器仍需
  各自处理，或届时把该判定上提到 `nativepricing`。
- `find_exact_with_fallback`（exact + normalized，**无 fuzzy**）未移植：ccusage Rust 侧的
  `adapters/hermes`、`adapters/antigravity` 与 CLI 的 `context_limit` 路径需要它；本仓库的落点是 S4 的
  `internal/collect/adapters/tools/*`（12 个工具适配器）入口，不是 S1 `Cost` 的需求。

以上七项由 S1 最终整分支审查产出；首个记录它们的计划工作区台账已按流程删除，本节是其唯一留存处。

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
- 指标：wall time、max RSS、读取字节数；每场景 **≥5 轮取中位数**并记最大值
  （本机单轮误差可达 2×）。
- **RSS 采集口径**：测 native 自身用 `RUSAGE_SELF`；测 ccusage **子进程**必须用
  `RUSAGE_CHILDREN`（或 `wait4`），否则测到的是 bench 进程。`Ru_maxrss` 单位**按平台分支**：
  darwin 是**字节**、Linux 是 **KB**（实测本机一个极简 Go 程序 `Ru_maxrss = 2,633,728` 即字节）。
  跨平台实现必须用 `//go:build` 约束拆文件（仅改文件名不构成构建约束，同包两个 `rss_*.go`
  会 `redeclared`）。Windows 侧（`OpenProcess` + `K32GetProcessMemoryInfo`）由
  `cmd/bench-collect/rss_windows_test.go` 在 CI `test` job 的 `windows-latest` 矩阵腿里真实执行，
  不再只是编译通过；§9.1 的基线数字测于 macOS，不受影响。
- 场景（均在本机真实语料上）：
  - A 单日窗口：测「空跑成本」——进程启动 + JSON 往返占比最高。
  - B 近 30 天窗口：典型定时同步。
  - C 全量（无 `--since`）：测吞吐与峰值内存。
  - D hook 增量（cursor 命中，仅少量文件变更）：native 增量 vs ccusage 全窗口。
  - E 冷启动到首字节（进程 spawn + 二进制加载）单独计时。
- 诚实预期：**native 不保证单轮更快**；收益来自无进程启动、无下载、无 JSON 往返、真增量、内存可控。
  若某场景 native 反而更慢，如实记录并分析（例如 Go GC 或逐行解析差异）。
- 交付物：`docs/research/2026-11-03-native-vs-ccusage-baseline.md`（S1，只有 ccusage 基线，
  native 侧尚未实现）与后续 `docs/research/<date>-native-vs-ccusage-benchmark.md`（S2+ 落地后
  的 native vs ccusage 对比），均含方法学、原始数据表（每轮值 + 中位数 + 最大值）、结论与反例。

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
| 浮点 1 ULP 分叉 | 中 | 固定运算顺序；**禁用 FMA 融合**（arm64 上 `a*b+c` 会融合）；goldens 用 `math.Float64bits` 位级比对 snapshotHash |
| 定价键匹配细节 | 中 | 移植 `exact_only`/大小写/版本后缀保护；用目录样本做表驱动测试 |
| 工具格式漂移 | 中 | 冻结 20.0.33 语义；格式变更由我们维护并补测试 |
| 大文件内存 | 中 | 流式 + 上限；基准里记录 max RSS |
| 二进制体积膨胀 | 低 | 五份定价语料嵌入后测体积，纳入 S1 基准指标 |
| MIT 署名缺失 | 低 | 仓库内 `THIRD_PARTY_NOTICES.md`；派生源码头注明出处 |
| Windows 路径/编码 | 中 | 三平台 CI；沿用既有 path 工具 |

## 10.1 回滚设计（过渡期保持 ccusage 可切换）

移除获取层之前，任何阶段都必须能**一键退回 ccusage 路径**，否则一次语义偏差就会让生产同步
停摆且无退路。规则：

1. **providers 保持可切换**：`providers/claudecode`、`providers/codex`、`providers/ccusagetool`
   在 S2/S3/S4 期间同时保留「原生」与「ccusage」两条实现，用一个内部分支开关选择
   （编译期常量或未导出的构建变量，**不作为新的用户可见环境变量**）。切换开关只在原生路径
   parity 全绿后默认指向原生。
2. **获取层最后移除**：`internal/ccusage` 的三层获取（捆绑 / `TOKENBOARD_CCUSAGE_BIN` /
   package runner）保留到 S5，且移除动作本身是独立的可回滚提交（一个 commit 只删获取，不夹带语义改动）。
3. **每个子项目单独可回滚**：S2/S3/S4 各自合并即产出一个可回滚点；回滚到上一个 tag 时原生开关
   退回 ccusage 分支，采集行为与当前生产一致。
4. **口径闸门**：每个来源默认切到原生之前，`tokenboard shadow`（TS 侧仍走 ccusage）必须全绿；
   `cmd/parity` 对固定窗口全 match；`--source all` 全量预览与 ccusage 基线差异逐条进台账
   （§9.4.1）。任一不满足则该来源保持 ccusage 分支。

## 11. 已定的架构决策（builder 复核后锁定，可否决）

| # | 决策 | 影响 |
|---|------|------|
| D1 | 原生适配器产出 **ccusage 报表形状的行**，由现有 normalize 路径转 Snapshot（§6.1.1） | 消费层不重写；S2/S3 只换数据生产者 |
| D2 | 定价语料**全部冻结**：五份嵌入资产（LiteLLM/两 models.dev 快照/两乘数表）+ 代码内置基础费率表 + 派生 pass + 空别名表（§6.1.2） | 体积与移植量增加，但 G2 可达 |
| D3 | hook 双源和解改为**同实现内两路交叉**（增量 vs 整窗重算）（§6.1.3） | S2 需实现并测试该重算校验 |
| D4 | oracle 分两层：行级金样本（永久冻结，S5 前须 14 来源齐全）+ 端到端 snapshotHash 影子双跑（§6.1.4、§8 阻塞项） | 定 S1 生成器与 CI 门禁 |
| D5 | 12 工具适配器**全部原生**（用户 2026-11-03 决定：彻底移除） | S4 立项 |
| D6 | TS collector 保持 legacy 至 M7，本设计不涉及 TS 侧移除 | 过渡期天然提供对照基线 |
| D7 | 接受「重传覆盖历史 cost」为既有语义，不加新保护层；首次全量前 parity 全绿（§9.4.1） | 无需改服务端；差异逐条进台账 |
| D8 | copilot 按「复杂来源」单独排期，不并入参数化工具族（§9.4.2） | S4 拆分与测试口径 |
| D9 | 过渡期 ccusage 路径**保持可切换**，获取层最后移除且独立成 commit（§10.1） | 每个子项目都是可回滚点 |

## 12. 留给实施者的决定

- 去重键的具体表示（建议结构化字符串键，绕开散列碰撞语义）。
- 内嵌定价基线快照的 vendor 方式（**五份资产**：从 ccusage 仓库取 `models-dev-pricing.json`、
  `models-dev-catalog-rules.json`、`fast-multiplier-overrides.json`、`flex-multiplier-overrides.json`，
  以及按 `flake.lock` rev 取并经 `is_embedded_model` 过滤 + 字段压缩的 LiteLLM 快照；
  校验和固定、保留 MIT 署名）。**内置基础费率表**（`put_builtin_pricing`）从
  `pricing.rs:2015-2560` 抄成 Go 常量，不经 JSON。
- parity/bench 工具的 CLI 形状与报告格式。
- 12 个适配器的包布局（每工具一包 vs 单包内多文件）。
