# S1：Go 原生定价引擎与 parity/bench 骨架 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Go 客户端内实现自足的定价引擎（冻结 ccusage 20.0.33 的语料与计费语义），并提供 parity 与 benchmark 工具，使后续每个来源适配器都能立即验证数值一致性与性能差异。

**Architecture:** 新增 `internal/nativepricing`（纯计算，无网络、无文件）承载费率查找与计费公式；语料 vendor 到 `internal/nativepricing/data/` 并在构建期嵌入；`cmd/parity` 与 `cmd/bench-collect` 作为 dev-only 命令（不进入 goreleaser 产物）。现有 `internal/pricing`（动态目录与 ccusage 配置生成）保持不变，`nativepricing` 只消费它已产出的 overrides（**camelCase 键**）。

**Tech Stack:** Go 1.27、`encoding/json`（语料解析）、`math`（`Float64bits` 位级比对、FMA 抑制）、`getrusage`/`GetProcessMemoryInfo`（bench 内存）、`testing`（TDD）。

**Spec:** `docs/superpowers/specs/2026-11-03-native-usage-sources-design.md`

## S1 非目标（明确推迟，避免"设计说了但计划没任务"的误判）

- 三种成本模式（`auto`/`calculate`/`display`）——S1 的 `Cost` 只实现 `calculate` 口径；
  模式选择在 S2/S3 适配器层。
- DeepSeek V4 的按时段定价——S1 的 `Cost` 预留 `at time.Time` 形参但忽略它，S2 接入。
- 日期/时区归属、sessionCount、pro-rata 分摊——S2/S3/S4 适配器层。
- `check-deps.sh` 门禁改造为原生契约金样本——S5。
- 移除 `internal/ccusage` 获取层——S5（S1 不动它）。

## Global Constraints

- 语义冻结在 ccusage **v20.0.33**（commit `1308c416`）；派生源码头注明出处与 MIT 署名。
- **冻结语料是 5 份资产，不是 4 份**（`build.rs` + `pricing.rs:24-29` 的实际嵌入集）：
  1. LiteLLM 快照（`flake.lock` pin 的 rev `6e0f0f7adb3083fb6681e636c947e3d6b8f53b26`），
     **构建期经 `is_embedded_model` 白名单过滤 + 字段压缩 + deflate**，不是原始文件；
  2. `models-dev-pricing.json`（3,074 条，deflate）；
  3. `models-dev-catalog-rules.json`（15,688 字节，deflate；**运行期也读**，见下）；
  4. `fast-multiplier-overrides.json`（`{exact, normalized_prefix}` 两段结构）；
  5. `flex-multiplier-overrides.json`（同上）。
  另有 **代码内置基础费率表**（`put_builtin_pricing`，约 37 个模型 id，含 `put_builtin_glm`
  的 cache 字段补丁），不是 JSON 资产但同属冻结范围。
- **LiteLLM 必须按 ccusage 的派生规则嵌入，不能直接嵌原始文件**：`build.rs:203-220` 的
  `is_embedded_model` 只保留 `claude-`/`anthropic.`/`anthropic/`/`us.|eu.|global.|jp.|au.anthropic.`/
  `gpt-`/`o3`/`o3-`/`o4-mini`/`openai/`/`azure/`/`zai/`/`openrouter/openai/` 前缀；字段压缩为
  `i/o/cc/cr/ia/oa/cca/cra/ctx` 并对 `provider_specific_entry.{fast,flex}` 取 `fast`/`flex` 两键。
  直接嵌原始 4,116 条会让 `gemini-2.5-pro`、`deepseek-*` 等在 LiteLLM 层命中，与 ccusage
  （这些模型只从 models.dev 取价）分叉。
- **`models-dev-catalog-rules.json` 在离线运行期仍被读取**：`models_dev_usable_cost` →
  `rules.is_token_priced` 对平面快照同样生效，用于排除按资产计价（按秒/张）的模型并把
  authored 模型钉成 token 计价。缺这份资产会让图像/音频类模型按 token 价漏进语料。
- **config override 的 JSON 键名是 camelCase**：`inputCostPerToken`、`outputCostPerToken`、
  `cacheReadInputTokenCost`、`cacheCreationInputTokenCost`、`inputCostPerTokenAbove200kTokens`、
  `cacheCreationInputTokenCostAbove200kTokens`、`cacheReadInputTokenCostAbove200kTokens`、
  `outputCostPerTokenAbove200kTokens`、`maxInputTokens`、`fastMultiplier`、`flexMultiplier`。
  `config_schema.rs` 里的 `input_cost_per_token` 是 Rust serde 的重命名注解，**不是** JSON 键名；
  写 snake_case 会被 `additionalProperties:false` 之外的反序列化静默忽略，成本全 0。
  来源：`clients/go/internal/pricing/config.go:559-586` 与 `packages/collector/node_modules/ccusage/config-schema.json`。
- **价格派生默认以源码为准**：LiteLLM 与 models.dev 两条路径都是
  `cache_create = cache_creation_input_token_cost ?? input × 1.25`、
  `cache_read = cache_read_input_token_cost ?? input × 0.1`（`pricing.rs:1088-1093, 1295-1301`）。
  **`cache_read` 缺省是 `input × 0.1`，不是 `input`。** models.dev 的 `cost.*` 是**每百万 token**，
  必须 `/1e6`；其 cache write 字段名是 `cost.cache_write`。
- **长上下文阈值只来自 models.dev 的 `cost.tiers`**（`tier.type == "context"`、`tier.size`，
  多个档取最小值），不是 `max_input_tokens`/`limit.context`——后者只是上下文窗口（`context_limit`），
  两者不能混用。有阈值时整请求切档；无阈值时用 200k 的边际 `tiered_cost`。
- **override 缩放只在 base 的缓存价是「派生值」时发生**：
  `should_scale = 覆盖了 input && base.input > 0 && !base.cache_read_explicit`
  （`pricing.rs:1838-1845`）。LiteLLM 里显式给了 `cache_read_input_token_cost` 的模型
  （如 sonnet、gpt-4o）`cache_read_explicit = true`，**覆盖 input 不会缩放其 cache 价**。
- **fast 乘数是成本乘数、flex 在 Codex 侧是增量乘数**：Claude 路径
  `cost = calculate_cost_from_pricing(usage, pricing) × fast_multiplier`（仅 `speed == Fast`，
  从不使用 flex）；Codex 路径
  `cost += flex成本 × (flex_multiplier - 1.0) + fast成本 × (fast_multiplier - 1.0)`
  （`adapters/codex/src/report.rs:273-274`）。两者的乘数来源是 `provider_specific_entry.{fast,flex}`
  优先，其次 override 文件（含 `exact` + `normalized_prefix` 解析）。
- 计费公式必须逐分支复刻（见 Task 3 的算法块），包括对非分档模型的 marginal `tiered_cost`
  与对分档模型的整请求切档。
- **禁止 FMA 融合**：Go 在 arm64 上会把 `a*b + c` 融合成 `FMADDD`（Rust/ccusage 不融合），
  产生 1 ULP 差异并使 `snapshotHash` 分叉。所有「乘后累加」必须经
  `math.Float64bits` 往返（或拆成独立语句并阻止编译器融合）后再相加；goldens 测试在
  arm64 上必须跑过。
- 浮点：`float64`，运算顺序与 ccusage 一致；goldens 用**位级相等**（`math.Float64bits`），
  不用 `FormatJSONFloat`——后者是 JS `Number#toString` 语义，二者判定不同。
- 纯 Go、无 CGO；三平台（darwin/linux/windows × amd64/arm64）构建通过。
- 不修改 `internal/pricing`、`internal/ccusage`、`contract`、`usage-core`。
- dev-only 命令不得加入 `.goreleaser.yaml` 的构建列表。
- `clients/go/**/*.json` 会被根 `pnpm format:check`（`'**/*.{...,json,jsonc}'`）覆盖；
  新增的 `data/*.json` 与 `goldens/*.json` 要么按 Prettier 格式化，要么加进 `.prettierignore`
  （后者需在该文件写清理由）。

## Review Focus

以下五类输入/条件最容易在使用时咬人，每个都在所属任务的测试中钉住：

1. **模型名带 provider 前缀或换一种分隔符写法**——用户期望拿到同一模型的合理费用，
   而不是 0 或被 `exactOnly` 误挡；覆盖：Task 2 的归一化（`.`/`@`）与前缀匹配测试，
   Task 1 的「LiteLLM 只嵌白名单前缀」测试。
2. **上下文刚好跨过档位阈值**——有 `cost.tiers` 的模型期望整请求按高档计费，
   无阈值的模型期望分段边际；覆盖：Task 3 的 `threshold±1` 边界测试，
   Task 1 的 `tiers`→LongContextThreshold 映射测试。
3. **只覆盖 input 单价**——用户期望缓存价按语料实际（派生值才缩放，显式值不动）；
   覆盖：Task 4 的条件缩放测试。
4. **未知模型 vs 免费模型**——前者期望标记 `missingPricing`，后者期望 cost=0 但不标记；
   覆盖：Task 3 的 `distinguishesUnknownFromFreeModel` 测试。
5. **数值精度与单位**——arm64 上 `a*b+c` 的 FMA 融合会 1 ULP 分叉；models.dev 的每百万价
   漏除会差 1e6 倍；RSS 平台单位写反会差 1024 倍；
   覆盖：Task 3 的 FMA 位级测试、Task 1 的 `/1e6` 映射测试、Task 7 的平台单位测试。

---

## File Structure

| 文件 | 职责 |
|------|------|
| `clients/go/internal/nativepricing/find.go` | 三级查找：精确 → 归一化模糊 → `exactOnly` 保护 |
| `clients/go/internal/nativepricing/alias.go` | 硬编码别名表（`pricing_alias`）+ 日期后缀剥离 + 键归一化 |
| `clients/go/internal/nativepricing/builtin.go` | 内置基础费率表（`put_builtin_pricing` 的 Go 常量） |
| `clients/go/internal/nativepricing/cost.go` | 计费：分档、乘数、饱和加法、`MissingPricing` |
| `clients/go/internal/nativepricing/overrides.go` | 服务端下发 override 的应用（camelCase + 缓存率条件缩放） |
| `clients/go/internal/nativepricing/multipliers.go` | fast/flex 乘数解析（`exact` + `normalized_prefix`） |
| `clients/go/internal/nativepricing/corpus.go` | 嵌入快照的加载、过滤与派生（含 models.dev `exactOnly`/`tiers` 映射） |
| `clients/go/internal/nativepricing/data/*.json` | vendor 的语料（LiteLLM 过滤版、两个 models.dev 快照、两个乘数表） |
| `clients/go/internal/nativepricing/*_test.go` | 对应测试 |
| `clients/go/cmd/parity/main.go` | 对指定来源/窗口比较 native 与 ccusage |
| `clients/go/cmd/bench-collect/main.go` | 性能基准（wall/RSS/字节数） |
| `clients/go/cmd/bench-collect/rss_unix.go` | `//go:build !windows`：`RUSAGE_SELF`/`RUSAGE_CHILDREN` |
| `clients/go/cmd/bench-collect/rss_windows.go` | `//go:build windows`：`GetProcessMemoryInfo` |
| `clients/go/scripts/fetch-native-pricing.mjs` | 按固定 rev 拉取、过滤、校验 sha256 的语料生成器 |
| `clients/go/internal/nativepricing/goldens/` | 费率查找与计费的期望值金样本 |

---

### Task 1: 冻结语料 vendor 与嵌入加载

**Files:**
- Create: `clients/go/scripts/fetch-native-pricing.mjs`
- Create: `clients/go/scripts/fetch-native-pricing.test.mjs`
- Create: `clients/go/internal/nativepricing/data/litellm.json`（生成物，已过滤+压缩字段）
- Create: `clients/go/internal/nativepricing/data/models-dev-pricing.json`（从 ccusage 仓库复制）
- Create: `clients/go/internal/nativepricing/data/models-dev-catalog-rules.json`（同上）
- Create: `clients/go/internal/nativepricing/data/fast-multipliers.json`
- Create: `clients/go/internal/nativepricing/data/flex-multipliers.json`
- Create: `clients/go/internal/nativepricing/corpus.go`
- Create: `clients/go/internal/nativepricing/corpus_test.go`
- Create: `clients/go/THIRD_PARTY_NOTICES.md`

**Interfaces:**
- Produces: `nativepricing.Corpus`、`nativepricing.LoadEmbeddedCorpus() (Corpus, error)`、
  `Corpus.Models map[string]CorpusModel`、`Corpus.Counts map[string]int`（每来源条数）

- [ ] **Step 1: 写生成脚本的失败测试（校验和守卫）**

```js
// clients/go/scripts/fetch-native-pricing.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  LITELLM_REV, LITELLM_SHA256, LITELLM_EMBEDDED_COUNT, LITELLM_EMBEDDED_SHA256,
  verifySnapshot, filterLitellmSnapshot, compactLitellmSnapshot,
} from './fetch-native-pricing.mjs'

test('the pinned revision and both digests are recorded in full', () => {
  assert.equal(LITELLM_REV, '6e0f0f7adb3083fb6681e636c947e3d6b8f53b26')
  assert.match(LITELLM_SHA256, /^[0-9a-f]{64}$/)   // 原始文件
  assert.match(LITELLM_EMBEDDED_SHA256, /^[0-9a-f]{64}$/) // 过滤压缩后的产物
  assert.ok(Number.isInteger(LITELLM_EMBEDDED_COUNT) && LITELLM_EMBEDDED_COUNT > 0)
})

test('verifySnapshot rejects bytes whose digest differs', () => {
  assert.throws(() => verifySnapshot(Buffer.from('nope'), '0'.repeat(64)), /sha256/i)
})

test('filterLitellmSnapshot keeps only the prefixes ccusage embeds', () => {
  const filtered = filterLitellmSnapshot({
    'claude-opus-4-6': { input_cost_per_token: 5e-6, output_cost_per_token: 25e-6 },
    'gemini-2.5-pro': { input_cost_per_token: 1.25e-6, output_cost_per_token: 10e-6 },
    'openai/gpt-5': { input_cost_per_token: 1e-6, output_cost_per_token: 2e-6 },
  })
  assert.deepEqual(Object.keys(filtered).sort(), ['claude-opus-4-6', 'openai/gpt-5'])
})

test('compactLitellmSnapshot renames fields and hoists service tiers', () => {
  const out = compactLitellmSnapshot({
    'gpt-x': {
      input_cost_per_token: 1e-6, output_cost_per_token: 2e-6,
      cache_read_input_token_cost: 1e-7, max_input_tokens: 200000,
      provider_specific_entry: { fast: 2, flex: 0.5 },
    },
  })
  assert.deepEqual(out['gpt-x'], { i: 1e-6, o: 2e-6, cr: 1e-7, ctx: 200000, fast: 2, flex: 0.5 })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test clients/go/scripts/fetch-native-pricing.test.mjs`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现生成脚本**

导出 `LITELLM_REV`、`LITELLM_SHA256`（原始文件）、`LITELLM_EMBEDDED_SHA256`、
`LITELLM_EMBEDDED_COUNT`、`verifySnapshot(bytes, expected)`、`filterLitellmSnapshot(obj)`、
`compactLitellmSnapshot(obj)`。默认行为：按
`https://raw.githubusercontent.com/BerriAI/litellm/${LITELLM_REV}/model_prices_and_context_window.json`
下载、校验原始 sha256、**按 `is_embedded_model` 白名单过滤**、
**字段压缩为 `i/o/cc/cr/ia/oa/cca/cra/ctx` 并对 `provider_specific_entry.{fast,flex}` 取 `fast`/`flex`**、
写 `data/litellm.json`、打印产物 sha256 与条数。支持 `--from <path>` 用本地副本（离线场景）。
从 ccusage 仓库 `rust/crates/ccusage-core/src/` 复制 `models-dev-pricing.json`、
`models-dev-catalog-rules.json`、`fast-multiplier-overrides.json`、`flex-multiplier-overrides.json`
到 `data/`（保持原样，加载时再解析）。
**注意**：原始文件 sha256 与产物 sha256 都要钉进常量，Step 4 用真实下载值回填后必须复核是否与
首次记录一致（防错误下载）。

- [ ] **Step 4: 运行脚本生成语料，记录实际 sha256 与条数**

Run: `node clients/go/scripts/fetch-native-pricing.mjs`
Expected: 写出 `data/litellm.json`；打印原始 sha256、产物 sha256、产物条数，写入脚本常量。

- [ ] **Step 5: 写 Corpus 加载的失败测试**

```go
func TestLoadEmbeddedCorpusParsesEverySnapshot(t *testing.T) {
    c, err := nativepricing.LoadEmbeddedCorpus()
    // 期望 Models 非空；Counts["litellm"]/["models-dev"] 等于脚本记录的条数；
    // "claude-opus-4-6" 命中。
}
func TestLoadEmbeddedCorpusRejectsATruncatedSnapshot(t *testing.T) {
    // 经内部接缝 loadCorpus(fsys fs.FS) 注入坏字节，期望 error（不是 panic）。
}
func TestCatalogRulesExcludeAssetPricedModels(t *testing.T) {
    // models-dev-catalog-rules.json 的 assetPricedModelIds 里的模型不得作为 token 计价进 Models。
}
```

- [ ] **Step 6: 运行测试确认失败**

Run: `cd clients/go && go test ./internal/nativepricing/ -run Corpus -v`
Expected: FAIL（`LoadEmbeddedCorpus` 未定义）

- [ ] **Step 7: 实现 `corpus.go`**

```go
//go:embed data/litellm.json data/models-dev-pricing.json data/models-dev-catalog-rules.json \
//           data/fast-multipliers.json data/flex-multipliers.json
var embeddedCorpus embed.FS

type CorpusModel struct {
    Input, Output, CacheRead, CacheCreate  float64
    InputAbove, OutputAbove                 *float64
    CacheReadAbove, CacheCreateAbove        *float64
    LongContextThreshold                    *int64   // 只来自 models.dev cost.tiers
    FastMultiplier, FlexMultiplier          float64
    CacheReadExplicit, CacheCreateExplicit  bool
    ExactOnly                               bool
}

type Corpus struct {
    Models        map[string]CorpusModel
    ContextLimits map[string]int64   // maxInputTokens / limit.context，只作窗口，不当档位阈值
    Counts        map[string]int          // 每来源条数，供测试钉住
}

func LoadEmbeddedCorpus() (Corpus, error)
func loadCorpus(fsys fs.FS) (Corpus, error)   // 测试接缝
```

字段映射（LiteLLM 压缩键 → `CorpusModel`）：`i`→Input、`o`→Output、`cc`→CacheCreate、
`cr`→CacheRead、`ia/oa/cca/cra`→各 Above、`ctx`→（仅 context limit，不进 LongContextThreshold）、
`fast/flex`→乘数。**派生默认按 ccusage**：`cache_create = cc ?? i × 1.25`（`cc` 缺失时
`CacheCreateExplicit=false`）；`cache_read = cr ?? i × 0.1`（**0.1，不是 1**）。
models.dev 映射：`cost.input/output` 是**每百万**，必须 `/1e6`；`cost.cache_write`→CacheCreate、
`cost.cache_read`→CacheRead（同样 `/1e6`）；`cost.tiers` 里 `tier.type=="context"` 的最小
`size` → LongContextThreshold、该档 `input/output/cache_write/cache_read` → `*Above`；
`exactOnly`→ExactOnly。**必须读 `models-dev-catalog-rules.json` 的
`authoredModelIds`/`assetPricedModelIds`/`owners`/`platforms` 来实现 `is_token_priced`
过滤**（否则图像/音频模型会按 token 价漏进语料）。加载后跑 `fill_long_context_rates_from_models_dev`
的等价 pass：对每个尚无 Above 字段的 LiteLLM 条目，按 `model_without_date_suffix` + 别名
到 models.dev 精确取 tiers 嫁接。

- [ ] **Step 8: 运行测试确认通过**

Run: `cd clients/go && go test ./internal/nativepricing/ -run Corpus -v`
Expected: PASS

- [ ] **Step 9: 记录体积与署名**

写 `THIRD_PARTY_NOTICES.md`（ccusage MIT、litellm MIT、models.dev 数据来源与日期）。
测试断言 `Counts` 与脚本记录值一致（`litellm` 过滤后条数 / `models-dev` 3,074），漂移即失败。

- [ ] **Step 10: Commit**

```bash
git add clients/go/scripts/fetch-native-pricing.mjs clients/go/scripts/fetch-native-pricing.test.mjs \
        clients/go/internal/nativepricing/data clients/go/internal/nativepricing/corpus.go \
        clients/go/internal/nativepricing/corpus_test.go clients/go/THIRD_PARTY_NOTICES.md
git commit -m "feat(nativepricing): vendor and embed the frozen pricing corpus"
```

---

### Task 2: 三级费率查找 + 别名/日期后缀

**Files:**
- Create: `clients/go/internal/nativepricing/find.go`
- Create: `clients/go/internal/nativepricing/alias.go`
- Test: `clients/go/internal/nativepricing/find_test.go`
- Test: `clients/go/internal/nativepricing/alias_test.go`

**Interfaces:**
- Consumes: `Corpus`、`CorpusModel`、`ModelSource`（Task 1）
- Produces: `(Corpus) Find(model string) (CorpusModel, bool)`；`normalizePricingKey(string) string`；
  `modelWithoutDateSuffix(string) string`；`pricingAlias(string) (string, bool)`

**复用 Task 1 的 helper**：`corpus.go` 已有 `normalizePricingKey`、`baseModelWithoutDateSuffix`、
`pricingAliasOf`、`matchesModelSuffix`（未导出）——**复用或提升，不要重复声明**。

**关键：`Find` 必须是「主表段 → models.dev 段」的两段式扫描，不能全局「精确优先」。**
ccusage 的 `find_with_fallbacks`（`pricing.rs:1404-1455`）是：
1. 主表（`Source != SourceModelsDev`）精确（+别名）→ 命中即返回；
2. 主表模糊（`Fuzzy::Denied` 之外的每次尝试都要过 exact-only 门）；
3. 主表全 miss 后，才用 `models.dev` 段重复①（精确+别名）②（模糊）。
Task 1 已把来源导出为 `ModelSource`，用它分段。反例（必须由测试钉住）：
`databricks-gpt-5-6-luna` 是 models.dev-only key，ccusage 走主表模糊命中 `gpt-5.6-luna`
（i=2e-7），**不是** models.dev 行（i=1e-6）；`anthropic/claude-opus-5.5-fast` → `claude-opus-5-5`
（4e-6），不是 models.dev 精确（8e-6）。
**exact-only 门**：`ExactOnly` 是两表并集，作用是「请求名门」——`gpt-5.6-luna` 虽在 models.dev
里 exact-only，主表模糊仍要能命中它；但请求名本身落在 exact-only 集合时拒绝整次模糊
（`is_exact_only_lookup_with_fallback`）。**不要**把并集当成「模糊候选过滤器」。

- [ ] **Step 1: 写失败测试（精确 / 归一化 / exactOnly / 大小写 / 别名 / 日期后缀 / 版本边界）**

```go
func TestFind_prefersAnExactMatch(t *testing.T)                 // "gpt-5" 不会配到 "gpt-5-mini"
func TestFind_normalizesDotsAndAtOnly(t *testing.T)             // "v.v2@x" ≡ "v-v2-x"；"/" 与 "_" 不归一
func TestFind_doesNotFoldAVersionSuffix(t *testing.T)           // "gpt-5.5" 不匹配 "gpt-5"
func TestFind_exactOnlyModelsAreNotPrefixMatched(t *testing.T)  // exactOnly 模型只精确命中
func TestFind_isCaseSensitive(t *testing.T)                     // "GPT-5" 不匹配 "gpt-5"
func TestFind_resolvesHardcodedAliases(t *testing.T)            // "gpt-5.6" → "gpt-5.6-sol"
func TestFind_stripsDateSuffixBeforeTierLookup(t *testing.T)    // "claude-3-5-haiku-20241022" 共享基准
func TestFind_primaryFuzzyBeatsModelsDevExact(t *testing.T)     // databricks-gpt-5-6-luna → gpt-5.6-luna（主表段）
func TestFind_modelsDevOnlyReachedAfterPrimaryMisses(t *testing.T) // models.dev-only key 无主表模糊命中时才用 models.dev 段
```

- [ ] **Step 2: 运行确认失败**

Run: `cd clients/go && go test ./internal/nativepricing/ -run 'Find|Alias' -v`
Expected: FAIL

- [ ] **Step 3: 实现查找与别名**

`normalizePricingKey`：**只**把 `.` 和 `@` 换成 `-`（源码 `pricing.rs:2725`），`/`、`_` 原样保留。
分段顺序见 Interfaces：主表（精确→别名→模糊），全 miss 后 models.dev 段（精确→别名→模糊）。
模糊匹配：归一化后按长度降序做最长前缀匹配，候选需满足「边界为非字母数字」且「后缀不紧跟
数字版本」（`suffix_starts_with_numeric_model_version`，`MODEL_DATE_SUFFIX_DIGITS=8`）。
版本边界行为的**权威判据是 ccusage 的实际输出**（Task 5 金样本），不是计划文字或直觉：
先按源码逐行移植，再对不一致处用金样本定案，并在代码注释里记录该 case 的实测结论。
**大小写敏感**（无数值大小写折叠）。
`alias.go`：硬编码 `pricingAlias`（`gpt-reserve`→`gpt-5.6-luna`、`gpt-5.6`→`gpt-5.6-sol`、
`gpt-5.3-spark`→`gpt-5.3-codex-spark`）；`modelWithoutDateSuffix` 去掉尾部 `-YYYY-MM-DD` 或 `-YYYYMMDD`。

- [ ] **Step 4: 运行确认通过**

Run: `cd clients/go && go test ./internal/nativepricing/ -run 'Find|Alias' -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add clients/go/internal/nativepricing/find.go clients/go/internal/nativepricing/find_test.go \
        clients/go/internal/nativepricing/alias.go clients/go/internal/nativepricing/alias_test.go
git commit -m "feat(nativepricing): add the three-level pricing lookup and alias resolution"
```

---

### Task 3: 计费公式

**Files:**
- Create: `clients/go/internal/nativepricing/cost.go`
- Create: `clients/go/internal/nativepricing/builtin.go`
- Test: `clients/go/internal/nativepricing/cost_test.go`
- Test: `clients/go/internal/nativepricing/builtin_test.go`

**Interfaces:**
- Consumes: `CorpusModel`
- Produces: `type Usage struct { Input, Output, CacheCreate5m, CacheCreate1h, CacheRead int64; ReportedCost *float64 }`；
  `func Cost(c Corpus, model string, u Usage, at time.Time, mode CostMode, fast, flex bool) (cost float64, missingPricing bool)`；
  `type CostMode int`（`ModeAuto`/`ModeCalculate`/`ModeDisplay`）；
  `func CostFromPricing(u Usage, p CorpusModel, fast bool) float64`（无副作用的核心公式，
  供 Codex 分桶调用）

- [ ] **Step 1: 写失败测试（分档 / 乘数 / 饱和 / 缺价 / 模式 / 免费模型）**

```go
func TestCost_switchesTheWholeRequestAboveTheThreshold(t *testing.T)   // 有 threshold，context = threshold+1 → 全高档
func TestCost_isMarginalForTheDefault200kTier(t *testing.T)            // 无 threshold、有 Above → 分段边际
func TestCost_billsOneHourCacheCreationAtDoubleInput(t *testing.T)     // 1h = input×2
func TestCost_appliesFastMultiplierToWholeCost(t *testing.T)           // Claude 语义：× fast，不用 flex
func TestCost_saturatesInsteadOfWrapping(t *testing.T)                 // MaxInt64 输入
func TestCost_distinguishesUnknownFromFreeModel(t *testing.T)          // 未找到 → missingPricing=true；免费模型 → false 且 cost=0
func TestCost_displayModeUsesReportedCost(t *testing.T)                // ModeDisplay 用 u 上报 cost
func TestCostFromPricing_isFMAFreeOnArm64(t *testing.T)                // 位级比对：与逐项 mul-then-add 结果一致
```

- [ ] **Step 2: 运行确认失败**

Run: `cd clients/go && go test ./internal/nativepricing/ -run Cost -v`
Expected: FAIL

- [ ] **Step 3: 实现计费（逐分支复刻）**

`CostFromPricing` 核心（对齐 `cost.rs:118-172`）：

```
cacheCreate1hRate      = input × 2   (分档时用 inputAbove × 2)
contextTokens          = saturatingAdd(input, cacheRead, cacheCreate5m, cacheCreate1h)

若有 LongContextThreshold:
    long = contextTokens > threshold
    rate(base, above) = long ? (above ?? base) : base
    返回 Σ bucket × rate(...)      // 整请求切档
否则:
    threshold = 200_000
    返回 Σ tiered(bucket, base, above, threshold)   // 分段边际
```

`tiered(n, base, above, t) = n <= t ? n×base : t×base + (n-t)×above`（`above == nil` 时全程 base）。
乘数：`CostFromPricing` 内**只对 Fast 乘 `fast_multiplier`**（Claude 语义）。`Cost` 包一层：
按 `mode` 决定是否使用 `u` 上报的 cost（Display）、是否在缺价时计算（Auto），
未找到模型 → `missingPricing=true`。
**`builtin.go`**：从 `pricing.rs:2015-2560` 抄约 37 个内置模型 id 的费率常量
（含 `claude-opus-4-5/4-6/4-7/4-8`、`claude-haiku-4-5`、`gpt-5`/`gpt-5.5`、`grok-4.3`、
`moonshot/kimi-k2.5|2.6`、`zai/glm-*`、`glm-5*` 等），以**只补缺**方式并入 Corpus
（`put_builtin_entry` 语义：已存在则不覆盖）。**但「已存在」只算主表（`Source != SourceModelsDev`）
条目**：内置表属主表段，Task 1 的 `SourceModelsDev` 条目对内置表等同「不存在」，否则 11 个
models.dev-only id（`glm-5`、`moonshot/kimi-k2.5`、`claude-opus-4`、`grok-4.3` 等）会保留 models.dev
费率而不被内置表纠正。内置表插入后要对新条目重跑一次 `applyLongContextRates`
（内置条目同属主表段，也需要嫁接）。**FMA 抑制**：所有 `a*b+c` 累加处，先
`math.Float64bits` 往返或拆成独立语句，确保 arm64 不退化为 `FMADDD`。

- [ ] **Step 4: 运行确认通过**

Run: `cd clients/go && go test ./internal/nativepricing/ -run 'Cost|Builtin' -v`
Expected: PASS（**在 arm64 上跑**，FMA 测试必须过）

- [ ] **Step 5: Commit**

```bash
git add clients/go/internal/nativepricing/cost.go clients/go/internal/nativepricing/cost_test.go \
        clients/go/internal/nativepricing/builtin.go clients/go/internal/nativepricing/builtin_test.go
git commit -m "feat(nativepricing): port the ccusage cost formula and builtin rates"
```

---

### Task 4: overrides 应用（camelCase 键，含条件式缓存率缩放）

**Files:**
- Create: `clients/go/internal/nativepricing/overrides.go`
- Create: `clients/go/internal/nativepricing/multipliers.go`
- Test: `clients/go/internal/nativepricing/overrides_test.go`
- Test: `clients/go/internal/nativepricing/multipliers_test.go`

**Interfaces:**
- Consumes: `Corpus`、`CorpusModel`
- Produces: `func (c Corpus) WithOverrides(overrides map[string]any) (Corpus, error)`；
  `func (c Corpus) WithServerOverrides([]byte) (Corpus, error)`（解析 `pricingOverrides`）

- [ ] **Step 1: 写失败测试**

```go
func TestWithOverrides_parsesCamelCaseKeys(t *testing.T)
    // 直接喂 packages/collector/ccusage.json 的形状：{"inputCostPerToken":1e-6,...}
    // 断言生效；喂 snake_case 断言被忽略（防回归）
func TestWithOverrides_scalesCacheRatesOnlyWhenBaseIsDerived(t *testing.T)
    // base cache_read 派生（explicit=false）+ 覆盖 input → 缩放；
    // base cache_read 显式（explicit=true，如 sonnet/gpt-4o）→ 不缩放
func TestWithOverrides_keepsExplicitCacheRates(t *testing.T)
func TestWithOverrides_parsesAbove200kSuffixKeys(t *testing.T)   // inputCostPerTokenAbove200kTokens 等
func TestWithOverrides_setsMaxInputTokens(t *testing.T)          // maxInputTokens → context limit，不改档位阈值
func TestWithOverrides_isIdempotent(t *testing.T)
func TestWithOverrides_rejectsMalformedJSON(t *testing.T)
func TestMultiplierFor_resolvesExactAliasAndNormalizedPrefix(t *testing.T)
```

- [ ] **Step 2: 运行确认失败**

Run: `cd clients/go && go test ./internal/nativepricing/ -run 'WithOverrides|Multiplier' -v`
Expected: FAIL

- [ ] **Step 3: 实现**

键名**一律 camelCase**（见 Global Constraints）：`inputCostPerToken`、`outputCostPerToken`、
`cacheReadInputTokenCost`、`cacheCreationInputTokenCost`、`inputCostPerTokenAbove200kTokens`、
`outputCostPerTokenAbove200kTokens`、`cacheReadInputTokenCostAbove200kTokens`、
`cacheCreationInputTokenCostAbove200kTokens`、`maxInputTokens`、`fastMultiplier`、`flexMultiplier`。
overrides 按**精确键**（+ 别名）匹配条目，**不走模糊归一化**（对齐 `apply_override`）。
缩放：`shouldScale = 覆盖了 inputCostPerToken && base.Input > 0 && !base.CacheReadExplicit`，
`new = old × newInput/base.Input`；仅对未被显式覆盖的 cache 字段生效。`maxInputTokens` 只写入
context limit（`Corpus.ContextLimits`），**不得**当作 LongContextThreshold。
`multipliers.go`：解析 `{exact, normalized_prefix}` 两段，查找顺序 = `exact` → 别名 → 按
`/`/`:` 切分后逐段试 `-` 归一化前缀匹配（对齐 `SpeedMultiplierOverrides::multiplier_for`）。

- [ ] **Step 4: 运行确认通过**

Run: `cd clients/go && go test ./internal/nativepricing/ -run 'WithOverrides|Multiplier' -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add clients/go/internal/nativepricing/overrides.go clients/go/internal/nativepricing/overrides_test.go \
        clients/go/internal/nativepricing/multipliers.go clients/go/internal/nativepricing/multipliers_test.go
git commit -m "feat(nativepricing): apply camelCase overrides with conditional cache-rate scaling"
```

---

### Task 5: 与 ccusage 的计费 parity 金样本

**Files:**
- Create: `clients/go/internal/nativepricing/goldens/cost-cases.json`（由 ccusage 20.0.33 生成）
- Create: `clients/go/scripts/gen-native-pricing-goldens.mjs`
- Create: `clients/go/internal/nativepricing/goldens_test.go`

**Interfaces:**
- Consumes: Task 1–4 的全部导出
- Produces: 无（测试资产）

- [ ] **Step 1: 写生成脚本**

`gen-native-pricing-goldens.mjs` 用 `~/.tokenboard/bin/ccusage`（或 `--ccusage-bin`）对构造好的
JSONL 夹具树运行
`claude daily --json --breakdown --offline --config packages/collector/ccusage.json -z UTC -s <固定日> -u <固定日>`
（对齐 `clients/go/scripts/check-deps.sh:92-104` 的成熟做法），记录每个用例的
`(model, tokens, cost, costUsd上报值)` 四元组，写成 `cost-cases.json`。
**`--offline` 是必须的**：生产 claude 路径不带它（`claudecode.go:291`），会联网拉当天价；
而金样本必须对冻结语料确定，`--offline` 走的正是 ccusage 内嵌快照——即我们要移植的那套。
**夹具 JSONL 必须写成紧凑 JSON（冒号后无空格）**：ccusage 20.0.33 对冒号后带空格的行
会返回**空 `daily` 数组**（Task 4 实测），紧凑写才正常计价，否则金样本会静默为空。
生成脚本要断言产出非空（每个夹具应有对应行），否则 fail-closed。
夹具覆盖：普通模型、above-200k 模型（阈值下/上各一）、**真实整请求切档模型**（如
`gemini-2.5-pro`，其 models.dev 有 `cost.tiers`）、1h cache creation、fast 乘数、未知模型、
**免费模型**（cost 全 0）。**不要**造「272k custom threshold」夹具——ccusage 20.0.33 的
Above200k 只在 `threshold==200000` 时发出，且 `max_input_tokens` 不是档位阈值。
**必须加一个 `gpt-5.codex`（点号拼写）探针**：它是 Task 1 合并表无法表达的已知分歧
（该 id 两表都有且都是 exact-only，ccusage 的 `id_spelled_by` 走 models.dev 费率
`cache_read=1.3e-7`，合并表返回主表 `1.25e-7`）。金样本要么如实记录这条差异并在测试里
显式排除（附注释与出处），要么在 Step 5 回头改 Task 1 的数据模型——不能让这道闸门无声漏过。
**并系统地覆盖同类**：对每个 exact-only id 也测其分隔符变体拼写（`.`/`@`），把这一族分歧
作为**一组**记进台账（附 `id_spelled_by` 的源码出处），而不是逐个加探针。已量化的分歧仅
出现在「合并表碰撞且费率不同」的少数 id 上（LiteLLM×models.dev 碰撞 190 个中 10 个费率不同；
另有内置表覆盖 models.dev 行的少数 id，如 `gpt-5.1.codex` 的 cache-create 1.25e-6 vs
ccusage 1.5625e-6）。**共同前提**：只有「请求写成 exact-only id 的分隔符变体」才会触发——
规范拼写两边一致。若 Task 5 发现真实夹具里出现此类拼写且差异不可接受，则该步骤是回头重构
Corpus 为两张表的决策点。

- [ ] **Step 2: 生成金样本**

Run: `node clients/go/scripts/gen-native-pricing-goldens.mjs`
Expected: 写出 `goldens/cost-cases.json`；打印每个用例的 cost。

- [ ] **Step 3: 写失败测试**

```go
func TestCostMatchesTheCcusageGoldens(t *testing.T) {
    // 逐用例比对 math.Float64bits(got) == math.Float64bits(want)（位级相等）
    // 失败时打印 model/tokens/got/want，便于定位是哪个分支漂移
}
```

- [ ] **Step 4: 运行确认失败**

Run: `cd clients/go && go test ./internal/nativepricing/ -run Goldens -v`
Expected: FAIL（实现未对齐前）

- [ ] **Step 5: 修正实现至全绿（改 Task 1–4 的代码）**

按失败信息定位差异分支（通常是运算顺序、FMA 融合或默认 cache 率），修正后重跑。
**`git add` 必须包含被修改的 Task 1–4 实现文件**（`git diff --name-only` 核对），
否则修正会留在工作树未提交。

Run: `cd clients/go && go test ./internal/nativepricing/ -v`
Expected: PASS，且 0 个用例被跳过

- [ ] **Step 6: Commit**

```bash
git add clients/go/scripts/gen-native-pricing-goldens.mjs \
        clients/go/internal/nativepricing/goldens clients/go/internal/nativepricing/goldens_test.go
# 加上 Step 5 中被修改的 Task 1–4 实现文件
git add clients/go/internal/nativepricing/*.go
git commit -m "test(nativepricing): pin cost parity against ccusage goldens"
```

---

### Task 6: `cmd/parity` 比较工具

**Files:**
- Create: `clients/go/cmd/parity/main.go`
- Test: `clients/go/cmd/parity/main_test.go`

**Interfaces:**
- Consumes: `collect.Lookup`、`contract.Snapshot`、`Snapshot.HashPayload()`
- Produces: CLI `parity -source S -since D -until D [-ccusage-bin P] [-json]`

- [ ] **Step 1: 写失败测试（比较逻辑，不跑真 ccusage）**

```go
func TestCompareReportsOnlyTheDivergingRows(t *testing.T)   // 注入两组快照，断言 onlyInNative/onlyInCcusage/valueDiff
func TestCompareTreatsTodayAsLiveWrite(t *testing.T)         // 当日行差异归类为 liveWrite，不计入失败
func TestCompareReportsNativeProviderMissing(t *testing.T)   // native 接缝缺该来源时归类为 notImplemented
```

- [ ] **Step 2: 运行确认失败**

Run: `cd clients/go && go test ./cmd/parity/ -v`
Expected: FAIL

- [ ] **Step 3: 实现**

**native 侧必须走独立接缝**，不能直接用 `collect.Lookup`——当前 `collect.Lookup("claude-code")`
内部就是 exec ccusage（`providers/claudecode/claudecode.go:291`），会退化成「自己比自己」。
新增 `collect.LookupNative(source) (Provider, bool)`，S1 阶段恒返回 `(nil, false)`，
由 S2+ 逐个接入原生 provider；`cmd/parity` 用它取 native 侧，`notImplemented` 时如实报告。
ccusage 侧 exec 指定二进制并走现有 `ccusage.NormalizeCcusageDailyJSON`。比较键为
`(usageDate, model)`，值比较 `HashPayload()`；输出 count 摘要与逐行差异；存在非 liveWrite
差异时 exit 1。

- [ ] **Step 4: 运行确认通过，并在本机做一次真实冒烟**

Run: `cd clients/go && go test ./cmd/parity/ -v`
Run: `cd clients/go && go run ./cmd/parity -source claude-code -since 2026-11-01 -until 2026-11-01 -ccusage-bin ~/.tokenboard/bin/ccusage`
Expected: 测试 PASS；冒烟输出中 native 侧报 `notImplemented`（S1 尚无原生 provider），
ccusage 侧正常出数——记录该边界

- [ ] **Step 5: Commit**

```bash
git add clients/go/cmd/parity clients/go/internal/collect
git commit -m "feat(cmd): add a parity harness comparing native collectors with ccusage"
```

---

### Task 7: `cmd/bench-collect` 性能基准

**Files:**
- Create: `clients/go/cmd/bench-collect/main.go`
- Create: `clients/go/cmd/bench-collect/rss_unix.go`（`//go:build !windows`）
- Create: `clients/go/cmd/bench-collect/rss_windows.go`（`//go:build windows`）
- Test: `clients/go/cmd/bench-collect/main_test.go`

**Interfaces:**
- Produces: CLI `bench-collect -source S -scenario single|30d|full|hook -rounds 5 [-ccusage-bin P]`；
  输出每轮 wall/RSS/读取字节与中位数

- [ ] **Step 1: 写失败测试**

```go
func TestMedianOfOddAndEvenCounts(t *testing.T)
func TestScenarioWindowsProduceTheExpectedRanges(t *testing.T)   // single→1天, 30d→30天, full→空, hook→cursor
func TestReportMarksRegressions(t *testing.T)                    // native 比 ccusage 慢时标记而非隐藏
func TestPeakRSSReportsBytesOnDarwinAndKilobytesOnLinux(t *testing.T) // 平台单位归一
```

- [ ] **Step 2: 运行确认失败**

Run: `cd clients/go && go test ./cmd/bench-collect/ -v`
Expected: FAIL

- [ ] **Step 3: 实现**

每场景 ≥5 轮；墙钟用 `time.Now()` 包裹；读取字节数由适配器的计数器提供（S1 阶段记录 0 并标注
pending）。输出 JSON + 人类可读摘要，含中位数与最大值。
**RSS 采集**：`rss_unix.go` 用 `getrusage`——native 自身用 `RUSAGE_SELF`，ccusage **子进程**
必须用 `RUSAGE_CHILDREN`（否则测到的是 bench 进程，看不到 ccusage 的 7.7–9.3 GB）；单位按平台
分支：**darwin 是字节、Linux 是 KB**，统一归一到字节后再报告。`rss_windows.go` 用
`GetProcessMemoryInfo`。**两个文件必须带 `//go:build` 约束**（仅改文件名不构成构建约束，
同包会 `redeclared` 编译失败）。

- [ ] **Step 4: 运行确认通过**

Run: `cd clients/go && go test ./cmd/bench-collect/ -v`
Expected: PASS

- [ ] **Step 5: 三平台编译验证**

Run: `cd clients/go && GOOS=windows go build ./... && GOOS=linux go build ./... && go build ./...`
Expected: 全部 exit 0

- [ ] **Step 6: Commit**

```bash
git add clients/go/cmd/bench-collect
git commit -m "feat(cmd): add a benchmark harness for wall time and peak RSS"
```

---

### Task 8: 首次性能报告（ccusage 基线）

**Files:**
- Create: `docs/research/2026-11-03-native-vs-ccusage-baseline.md`

- [ ] **Step 1: 在低负载窗口跑基线**

Run: `uptime` 记录 load；然后
`cd clients/go && go run ./cmd/bench-collect -source claude-code -scenario single -rounds 5 -ccusage-bin ~/.tokenboard/bin/ccusage`
对 `30d` 与 `full` 各跑一次。

- [ ] **Step 2: 写报告**

方法学、每轮原始值、中位数、最大值、load 记录；明确 native 侧尚未实现、本报告只是 ccusage 基线
（不是 native vs ccusage 对比——那是 S2+ 的交付物）。

- [ ] **Step 3: Commit**

```bash
git add docs/research/2026-11-03-native-vs-ccusage-baseline.md
git commit -m "docs: record the ccusage performance baseline measured through bench-collect"
```

---

### Task 9: CI 接线与 dev-only 保证

**Files:**
- Modify: `.github/workflows/go-client.yml`
- Create: `clients/go/cmd/parity/release_guard_test.go`（守护测试放 parity，职责更贴切）

- [ ] **Step 1: 写守护测试**

```go
func TestDevCommandsAreNotInTheGoreleaserBuildList(t *testing.T)
    // 读 ../../../../.goreleaser.yaml，断言不含 cmd/parity 与 cmd/bench-collect
```

- [ ] **Step 2: 运行确认通过**

Run: `cd clients/go && go test ./cmd/parity/ -run Goreleaser -v`
Expected: PASS

- [ ] **Step 3: 加 CI job**

在 `go-client.yml` 增加 `native-pricing` job：`actions/checkout` + `actions/setup-node`
（跑 JS 测试必需）+ `setup-go`；跑 `go test ./internal/nativepricing/... -race` 与
`node --test clients/go/scripts/fetch-native-pricing.test.mjs`；再跑一次 `go build ./...`。
**把 `native-pricing` 加入 `release.needs`**（与既有 `test`/`typecheck` 并列），否则发版不经过
新门禁。

- [ ] **Step 4: 跑全量验证**

Run: `cd clients/go && go test ./... -count=1 -race && go vet ./... && gofmt -l .`
Expected: 全绿、输出为空

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/go-client.yml clients/go
git commit -m "ci: gate the native pricing engine and keep dev commands out of releases"
```

---

## 完成标准（S1 出口）

- `go test ./internal/nativepricing/...` 全绿（含 `-race`）：48 个 cost 金样本用例按 `math.Float64bits`
  位级比对，canonical 拼写与 ccusage 位级一致，分歧仅限 exact-only id 的分隔符变体拼写，16 条已逐条
  登记进 `goldens_test.go` 的 `knownDivergences`（两侧取值 + 依据）。
- 金样本生成脚本钉死 `--offline --config packages/collector/ccusage.json -z UTC -s/-u`，可复现。
- `cmd/parity` 与 `cmd/bench-collect` 可用且不在发布产物中；parity 的 native 接缝
  （`collect.LookupNative`）在 S1 恒报 `notImplemented`。
- 嵌入语料为**五份资产 + 内置费率表**，条数与来源 rev/sha256 有测试钉住；
  `.prettierignore` 或格式化处理已覆盖新增 JSON。
- `docs/research/2026-11-03-native-vs-ccusage-baseline.md` 含真实原始数据与 load 记录。
- 三平台构建通过；`internal/pricing`、`internal/ccusage`、`contract`、`usage-core` 未被修改。