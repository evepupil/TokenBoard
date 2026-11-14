# 2026-11-09 工具适配器（S4a）原生 parity 与证据报告

- 日期：2026-11-09（UTC）
- 分支：`feat/native-usage-sources`
- 计划：`docs/superpowers/plans/2026-11-08-s4-tool-adapters.md`
- 二进制：ccusage `20.0.33`（`~/.tokenboard/bin/ccusage`），Go `go1.27.3 darwin/amd64`
- 范围：S4a（11 个 ccusage 工具来源——amp、droid、codebuff、hermes、goose、kilo、gemini、kimi、qwen、zcode、openclaw），含 goldens、unit tests、native provider 接线、CI 门禁。S4b（copilot）下一轮单独处理。

> 本文所有命令输出来自当前工作树的实际执行。明确区分「已验证」「推断」「未覆盖」边界。

## 1. 测量口径

### 1.1 TDD 验证

所有修复采用 RED→GREEN 循环确认：

| 修复项 | RED 撤销 | GREEN 恢复 | 验证输出 |
|--------|----------|------------|----------|
| session 元数据门控 | 8 源传 `true`→goldens 含多余键 | 仅 qwen/openclaw/zcode 传 `true` | 44/44 goldens |
| qwen `LastActivity` 未赋值 | 撤销赋值 → goldens qwen/session: `sessions.length: golden 2, port 0` | 恢复赋值 | goldens 全绿 |
| qwen provider daily 误过滤 | 把 daily 也走 FilterQwenSessionRows → daily 返回 2 行而非 1 行 | 恢复为 entry 级 filter | `TestQwenNativeWindow` 双向 RED→GREEN |
| totals 行序重算 | 用旧 entry 累加 + 删除 `totalsOf` → 金样本 diff | 恢复 | 44/44 goldens |
| amp `find_at` | 改回 `time.Time{}` → cost=0.15 vs 期望 0.44 | 恢复 `PriceAt(entry.Timestamp)` | `TestAmpPricesAtTheEventTimestamp` |
| zcode override 先于 provider guard | 将 override 循环移到守卫后 → `MissingPricing = true` | 恢复 | `TestZcodeUserOverrideBeatsTheCustomProviderGuard` |

### 1.2 金样本

- **配方**：11 源 × daily + session × auto + calculate = 44 子测试，0 SKIP，0 FAIL
- **金样本生成器**：`goldens_test.go` 的 `toolReport` 使用与 provider 完全相同的代码路径（包括 `FilterQwenSessionRows`、`RichSessionMetadata` 门控）
- **命令**：`go test ./internal/collect/adapters/tools/ -run TestToolAdaptersMatchTheGoldens -count=1 -v | grep "PASS\|FAIL"`

### 1.3 被影响包

```
go test ./internal/collect/adapters/tools/    → ok
go test ./internal/nativepricing/             → ok
go test ./internal/collect/providers/ccusagetool/ → ok
gofmt -l × go vet  → 干净
```

## 2. 1 ULP 分叉（已知边界，非移植缺陷）

| 配置 | native | ccusage --offline | ccusage 在线 |
|------|--------|-------------------|-------------|
| 工具来源 `costUSD` | 冻结语料 | 逐位一致 | 查 LiteLLM 实时费率 |
| 带动态定价模型的二元 | `deepseek-v4-flash` 等 | 逐位一致 | 差 1 ULP（字面量位模式差） |

根因：LiteLLM 在线返回 `input_cost_per_token: 2e-07`（$2.2^-7$ 字面量）而冻结语料写入 `0.2/1e6`（$2.0^-7$）。`2e-07` (~0x3e8ad7f29abcaf48) 与 `0.2/1e6` (~0x3e8ad7f29abcaf49) 差 1 ULP，经 cache creation ×1.25 放大。这是 `docs/research/2026-11-05-claude-native-parity.md` 已记录的 online-vs-offline 边界。生产中 ccusage 默认联网获取费率，所以真机 parity 在带 DeepSeek V4 分时定价的模型上会观测到 1 ULP 差异。**金样本 mint 时带 `--offline`，与 native 逐位一致，故 goldens 不受影响。**

## 3. parity 结果（本机数据覆盖）

- 11 个工具来源中本机有数据的 3 个方向已验证差异为零；其余来源（未安装）无法验证，由 **金样本全绿 + `toolKnownGapSkips` 已清空** 担保正确性。

结论：未发现表明移植有误的证据。自然地，`useNativeTools` 保持 `false` 直到 S4b 完成后的正式开关翻转。

## 4. 已知边界与 Rulings

| # | 项目 | 描述 | 代价 |
|---|------|------|------|
| R1 | `CCUSAGE_MODEL_ALIASES` | spec §6.1.2/D2 冻结「空别名表」；生产路径 ccusage 也不设置该变量 | 用户手动设置会导致两侧路径分叉 |
| R2 | zcode `projectPath` | 保留完整目录名，未截断为 basename（与 ccusage 逐字一致） | normalize 忽略该字段，不上传，无隐私风险 |
| R3 | `--open-claw-path` CLI flag | provider 从不传该参数，未接线 | 需用时按 paths.rs 补齐 |
| R4 | Rust 源码路径 | `/tmp/ccusage-src-1308c416` 早被清理 | 计划文档的该路径引用已失效 |
| R5 | amp/zcode FindAt 测试 | 使用现有 corpus 调度窗口而非自建夹具 | 若 S1 `find_at` 自身回归，S4a 测试不会单独报警 |
| R6 | `CollectFiles` 深度上限 | 16 层、每目录 10 万项，远高于真实布局 | 极端深树少收，需 S4 报告记边界 |
| R7 | `breakdown` 排序用 `>` | ±0 边界与 `total_cmp` 语义不同 | 非 NaN 数据路径无影响 |

## 5. 审查覆盖

| 轮次 | 审批者 | 报告路径 | 发现与处置 |
|------|--------|----------|------------|
| 1 | 3 个 general-purpose agent | `review-tools-adapters.md` / `review-wiring-docs.md` / `review-pricing-codex.md` | 2 Critical / 8 Important / 若干 Minor，全部 RED→GREEN 修复 |
| 1 | Codex gpt-6.1-sol（max reasoning） | `review-codex.md` | 3 Important（qwen 相关）+ 6 Minor，与 agent 高度重叠 |
| 2 | fresh general-purpose agent | 本会话输出 | 0 Critical / 0 Important；4 Minor |
| 2 | Codex gpt-6.1-sol（max reasoning） | `review-codex-round2.md` | 0 Critical / 0 Important；5 Minor |

第二轮去重后的 5 类 Minor 全部修复，各自带 RED→GREEN 测试：

| 项 | Rust 依据 | 修复 | 测试 |
|----|-----------|------|------|
| zcode REAL 时间戳越界应拒绝而非饱和 | `loader.rs:311-316` | `zcodeTimestampValue` 恢复 ±2^63 范围门 | `TestZcodeOutOfRangeRealTimestampDropsTheRow` |
| qwen session projectPath 取最新条目 | `summary.rs:133-156` | `Summarize` 用显式 latest 标记 | `TestSummarizeSessionProjectPathComesFromTheLatestEntry` |
| display 模式仍输出 unpricedModels | `output.rs:79-136`（无 mode 参数） | `ReportJSON` 删除 display 门控与 mode 参数 | `TestHermesKeepsMissingPricingDiagnosticsInDisplayMode`、`TestReportJSONEmitsEveryUnpricedBreakdown` |
| amp 整文件解析（尾部垃圾即失败） | `amp/parser.rs:95-98` | Decode 后要求 EOF | `TestAmpRejectsTrailingGarbage` |
| gemini thoughts-only 行不被丢弃 | `gemini/parser.rs:337-345`、`summary.rs:19-37` | 删除 `Summarize` 的空条目过滤 | `TestGeminiKeepsAThoughtsOnlyDisplayRow` |

另清理了 `goldens_test.go` 的 3 个死代码辅助（`rowOrderTotals`、`toolRichSessionMetadata`、`applySessionMetadataGate`）与 CI workflow 里过时的 "two known gaps as skips" 注释。修复后金样本仍 44/44、0 SKIP；三个受影响包的定向测试、`gofmt`、`go vet`、`go build ./...` 全部通过。

## 6. 撮要

S4a 的 11 个工具来源适配器通过金样本（44/44）、单元测试全线与定向真机 parity 验证。无未修复的 Critical 或 Important 缺陷。下一步：S4b（copilot 适配器）。

## 7. 2026-11-10 复审④（6 维度 agent + Codex）

范围为 S1 定价引擎、Claude/Codex、11 个工具来源、copilot、接线/CI/文档与当时未提交改动。
Claude/Codex 维度与未提交改动自审均无缺陷。已修复且各有可触发输入：

| 缺陷 | Rust 依据 | 修复与证据 |
|------|-----------|------------|
| `Corpus.FindExact` 读合并表，kilo 的 provider 前缀候选与 openclaw 的装饰名会看到 models.dev 独有键（真实语料 1799 个带 `/` 的键，如 `deepinfra/inkling`：9.5e-7 vs 主表裸名 1.0888e-6） | `pricing.rs:1484-1486`（方法在 primary map 上）、`kilo/src/parser.rs:243-258`、`openclaw/src/parser.rs:382` | 改为只读 primary；`TestFindExactReadsThePrimaryMapOnly` |
| 工具适配器 u64→int64 裸转，`Output+Extra` 或单桶超 2^63-1 变负→费用 0 | `cost.rs:143-152`（u64 计数） | 新增 `tools.TokenCount`，pricing.go 与 droid/codebuff/goose/hermes/openclaw/zcode 统一使用；`TestPriceEntrySaturatesCountsPastInt64` |
| `saturatingAdd` 跳过负数，与 u64 饱和语义不符 | `cost.rs:126` | 负数 operand 饱和到 MaxInt64；`TestCost_saturatesInsteadOfWrapping` 补断言 |
| amp 整文件经 string 解码，非法 UTF-8 被替换为 U+FFFD 后保留 | `amp/src/parser.rs:96`（`from_slice` 拒绝非 UTF-8） | `utf8.Valid` 门；`TestAmpDropsAFileThatIsNotUTF8` |
| kimi `timestamp_from_seconds` 在 2^63 边界依赖 float→int 未定义转换 | `kimi/src/parser.rs:277-286`（`as i64` 饱和） | 显式钳制；`TestKimiSecondsToMillisSaturatesAtTheBound` |

被证伪的审查项（不改）：gemini「total 缺口应进 extra」（`parser.rs:460-462` 由 `total − 各桶` 重算，
repo 已如此，`TestGeminiReportExtraIsRecomputedFromTotal` 钉住）；gemini `HasTotal` 比较（Go 已判
`HasTotal`）；主表模糊扫描「应排除 exact-only 候选」（LiteLLM loader 不填 `exact_only`，
`pricing.rs:1598` 对主表是空集，Go 现有行为正确）。

覆盖缺口：`gen-claude-goldens.mjs` 现补 `--check` 并接入 `check-deps.sh`，四个生成器的漂移门同构。
