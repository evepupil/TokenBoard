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

- 工具：`clients/go/cmd/bench-collect`（dev-only），同一进程内跑 native；ccusage 侧 exec 20.0.33。
- 指标：wall time、max RSS（`getrusage`）、读取字节数；每场景 ≥5 轮，取中位数与最大值。
- 场景：S1 近 3 天窗口；S2 2026-01-01 至今；S3 全量；S4 hook 增量（cursor 命中）。
- 诚实预期：Rust 与 Go 解析吞吐相当；native 的收益主要来自**无进程启动、无 JSON 往返、
  增量扫描、内存上限可控**。若某场景 native 反而更慢，如实记录并分析。

## 10. 风险与缓解

| 风险 | 等级 | 缓解 |
|------|------|------|
| Claude 去重语义偏差 | 高 | 结构化键 + 逐条 golden 用例（sidechain/gateway/重复写） |
| Codex 差分/重放偏差 | 高 | 用真实 session 文件做 parity 夹具；与现有 context_pricing 对账 |
| 浮点 1 ULP 分叉 | 中 | 固定运算顺序；goldens 比对 snapshotHash |
| 定价键匹配细节 | 中 | 移植 `exact_only`/大小写/版本后缀保护；用目录样本做表驱动测试 |
| 工具格式漂移 | 中 | 冻结 20.0.33 语义；格式变更由我们维护并补测试 |
| 大文件内存 | 中 | 流式 + 上限；基准里记录 max RSS |
| Windows 路径/编码 | 中 | 三平台 CI；沿用既有 path 工具 |

## 11. 留给实施者的决定

- 去重键的具体表示（建议结构化字符串键，绕开散列碰撞语义）。
- 内嵌定价基线快照的 vendor 方式（从 ccusage 仓库的 `models-dev-pricing.json` +
  生成脚本拉取的 LiteLLM 快照，校验和固定）。
- parity/bench 工具的 CLI 形状与报告格式。
- 12 个适配器的包布局（每工具一包 vs 单包内多文件）。
