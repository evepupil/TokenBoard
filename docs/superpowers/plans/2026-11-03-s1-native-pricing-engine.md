# S1：Go 原生定价引擎与 parity/bench 骨架 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Go 客户端内实现自足的定价引擎（冻结 ccusage 20.0.33 的四层语料与计费语义），并提供 parity 与 benchmark 工具，使后续每个来源适配器都能立即验证数值一致性与性能差异。

**Architecture:** 新增 `internal/nativepricing`（纯计算，无网络、无文件）承载费率查找与计费公式；语料 vendor 到 `internal/nativepricing/data/` 并在构建期嵌入；`cmd/parity` 与 `cmd/bench-collect` 作为 dev-only 命令（不进入 goreleaser 产物）。现有 `internal/pricing`（动态目录与 ccusage 配置生成）保持不变，`nativepricing` 只消费它已产出的 overrides。

**Tech Stack:** Go 1.27、`compress/flate`（解压嵌入快照）、`encoding/json`（语料解析）、`getrusage`（bench 内存）、`testing`（TDD）。

**Spec:** `docs/superpowers/specs/2026-11-03-native-usage-sources-design.md`

## Global Constraints

- 语义冻结在 ccusage **v20.0.33**（commit `1308c416`）；派生源码头注明出处与 MIT 署名。
- LiteLLM 快照固定 rev `6e0f0f7adb3083fb6681e636c947e3d6b8f53b26`（BerriAI/litellm），
  上游 URL `https://raw.githubusercontent.com/BerriAI/litellm/<rev>/model_prices_and_context_window.json`，
  本次实测 sha256 前缀 `c718a7b2f7a8d1009cb3bcf6`，体积 2,828,373 字节，4,116 个模型。
- `models-dev-pricing.json` 3,074 个模型；`fast-multiplier-overrides.json`、
  `flex-multiplier-overrides.json` 同属冻结语料。
- 计费公式必须逐分支复刻（见 Task 3 的算法块），包括对非分档模型的 marginal `tiered_cost`
  与对分档模型的整请求切档。
- 浮点：`float64`，运算顺序与 ccusage 一致；goldens 用 `FormatJSONFloat` 比对，避免 1 ULP 分叉。
- 纯 Go、无 CGO；三平台（darwin/linux/windows × amd64/arm64）构建通过。
- 不修改 `internal/pricing`、`internal/ccusage`、`contract`、`usage-core`。
- dev-only 命令不得加入 `.goreleaser.yaml` 的构建列表。

## Review Focus

以下五类输入最容易在使用时咬人，每个都在所属任务的测试中钉住：

1. **模型名带 provider 前缀或大小写变体**——用户期望拿到合理费用，而不是 0；
   覆盖：Task 2 的模糊匹配与大小写测试。
2. **上下文刚好跨过档位阈值**——用户期望整请求按高档计费（而非分段），
   覆盖：Task 3 的 `threshold±1` 边界测试。
3. **只覆盖 input 单价而未覆盖 cache 价**——用户期望缓存价按比例跟随，
   覆盖：Task 4 的比例缩放测试。
4. **未知模型**——用户期望费用为 0 且被标记，而不是崩溃或编造价格；
   覆盖：Task 3 的 `MissingPricing` 测试。
5. **巨额 token 计数（溢出）**——期望饱和计算而非回绕；
   覆盖：Task 3 的饱和加法测试。

---

## File Structure

| 文件 | 职责 |
|------|------|
| `clients/go/internal/nativepricing/pricing.go` | `Pricing` 结构、费率解析、overrides 应用 |
| `clients/go/internal/nativepricing/find.go` | 三级查找：精确 → 归一化模糊 → `exactOnly` 保护 |
| `clients/go/internal/nativepricing/cost.go` | 计费：分档、乘数、饱和加法、`MissingPricing` |
| `clients/go/internal/nativepricing/corpus.go` | 嵌入快照的加载与解析 |
| `clients/go/internal/nativepricing/data/*.json` | vendor 的语料（LiteLLM、models.dev、两个乘数表） |
| `clients/go/internal/nativepricing/*_test.go` | 对应测试 |
| `clients/go/cmd/parity/main.go` | 对指定来源/窗口比较 native 与 ccusage |
| `clients/go/cmd/bench-collect/main.go` | 性能基准（wall/RSS/字节数） |
| `clients/go/scripts/fetch-native-pricing.mjs` | 按固定 rev 拉取并校验 sha256 的语料生成器 |
| `clients/go/internal/nativepricing/goldens/` | 费率查找与计费的期望值金样本 |

---

### Task 1: 语料 vendor 与嵌入加载

**Files:**
- Create: `clients/go/scripts/fetch-native-pricing.mjs`
- Create: `clients/go/internal/nativepricing/data/litellm.json`（生成物）
- Create: `clients/go/internal/nativepricing/data/models-dev.json`（从 ccusage 仓库复制）
- Create: `clients/go/internal/nativepricing/data/fast-multipliers.json`
- Create: `clients/go/internal/nativepricing/data/flex-multipliers.json`
- Create: `clients/go/internal/nativepricing/corpus.go`
- Create: `clients/go/internal/nativepricing/corpus_test.go`
- Create: `clients/go/THIRD_PARTY_NOTICES.md`

**Interfaces:**
- Produces: `nativepricing.Corpus`、`nativepricing.LoadEmbeddedCorpus() (Corpus, error)`、
  `Corpus.Models map[string]CorpusModel`

- [ ] **Step 1: 写生成脚本的失败测试（校验和守卫）**

```js
// clients/go/scripts/fetch-native-pricing.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LITELLM_REV, LITELLM_SHA256, verifySnapshot } from './fetch-native-pricing.mjs'

test('the pinned revision and digest are recorded', () => {
  assert.equal(LITELLM_REV, '6e0f0f7adb3083fb6681e636c947e3d6b8f53b26')
  assert.match(LITELLM_SHA256, /^[0-9a-f]{64}$/)
})

test('verifySnapshot rejects bytes whose digest differs', () => {
  assert.throws(() => verifySnapshot(Buffer.from('nope'), '0'.repeat(64)), /sha256/i)
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test clients/go/scripts/fetch-native-pricing.test.mjs`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现生成脚本**

导出 `LITELLM_REV`、`LITELLM_SHA256`、`verifySnapshot(bytes, expected)`；默认行为按固定 URL 下载、
校验、写 `data/litellm.json`；支持 `--from <path>` 用本地副本（离线场景）。从 ccusage 仓库复制
`models-dev-pricing.json`、`fast-multiplier-overrides.json`、`flex-multiplier-overrides.json` 到 `data/`。

- [ ] **Step 4: 运行脚本生成语料，记录实际 sha256**

Run: `node clients/go/scripts/fetch-native-pricing.mjs`
Expected: 写出 `data/litellm.json`；打印实际 sha256 并写入脚本常量。

- [ ] **Step 5: 写 Corpus 加载的失败测试**

```go
func TestLoadEmbeddedCorpusParsesEverySnapshot(t *testing.T) { /* Models 非空且含 "claude-opus-4-6" */ }
func TestLoadEmbeddedCorpusRejectsATruncatedSnapshot(t *testing.T) { /* 注入坏字节，期望 error */ }
```

- [ ] **Step 6: 运行测试确认失败**

Run: `cd clients/go && go test ./internal/nativepricing/ -run Corpus -v`
Expected: FAIL（`LoadEmbeddedCorpus` 未定义）

- [ ] **Step 7: 实现 `corpus.go`**

```go
//go:embed data/litellm.json data/models-dev.json data/fast-multipliers.json data/flex-multipliers.json
var embeddedCorpus embed.FS

type CorpusModel struct {
    Input, Output, CacheRead, CacheCreate       float64
    InputAbove, OutputAbove                     *float64
    CacheReadAbove, CacheCreateAbove            *float64
    LongContextThreshold                        *int64
    FastMultiplier, FlexMultiplier              float64
    CacheReadExplicit, CacheCreateExplicit      bool
    ExactOnly                                   bool
}

type Corpus struct { Models map[string]CorpusModel }

func LoadEmbeddedCorpus() (Corpus, error)
```

LiteLLM 字段名映射：`input_cost_per_token`、`output_cost_per_token`、`cache_read_input_token_cost`、
`cache_creation_input_token_cost`，以及 `*_above_200k_tokens` 变体；models.dev 的 `cost.{input,output,cache_read}`、
`limit.context`、`exactOnly`。派生默认：`cache_create` 缺省 = `input × 1.25` 且 `CacheCreateExplicit=false`；
`cache_read` 缺省 = `input` 且 `CacheReadExplicit=false`。

- [ ] **Step 8: 运行测试确认通过**

Run: `cd clients/go && go test ./internal/nativepricing/ -run Corpus -v`
Expected: PASS

- [ ] **Step 9: 记录体积与署名**

写 `THIRD_PARTY_NOTICES.md`（ccusage MIT、litellm MIT、models.dev 数据来源与日期）。
测试断言嵌入语料的模型数与记录值一致（4,116 / 3,074），漂移即失败。

- [ ] **Step 10: Commit**

```bash
git add clients/go/scripts/fetch-native-pricing.mjs clients/go/scripts/fetch-native-pricing.test.mjs \
        clients/go/internal/nativepricing/data clients/go/internal/nativepricing/corpus.go \
        clients/go/internal/nativepricing/corpus_test.go clients/go/THIRD_PARTY_NOTICES.md
git commit -m "feat(nativepricing): vendor and embed the frozen pricing corpus"
```

---

### Task 2: 三级费率查找

**Files:**
- Create: `clients/go/internal/nativepricing/find.go`
- Test: `clients/go/internal/nativepricing/find_test.go`

**Interfaces:**
- Consumes: `Corpus`、`CorpusModel`（Task 1）
- Produces: `(Corpus) Find(model string) (CorpusModel, bool)`；`normalizePricingKey(string) string`

- [ ] **Step 1: 写失败测试（精确 / 归一化 / exactOnly / 大小写）**

```go
func TestFind_prefersAnExactMatch(t *testing.T)                        // "gpt-5" 不会配到 "gpt-5-mini"
func TestFind_normalizesSeparators(t *testing.T)                       // "vendor/model.v2@x" ≡ "vendor-model-v2-x"
func TestFind_doesNotFoldAVersionSuffix(t *testing.T)                  // "gpt-5.5" 不匹配 "gpt-5"
func TestFind_exactOnlyModelsAreNotPrefixMatched(t *testing.T)         // exactOnly 模型只精确命中
func TestFind_isCaseSensitiveButHonoursCaseVariantAliases(t *testing.T)
```

- [ ] **Step 2: 运行确认失败**

Run: `cd clients/go && go test ./internal/nativepricing/ -run Find -v`
Expected: FAIL

- [ ] **Step 3: 实现查找**

精确命中优先；否则对键做 `@`/`.`/`/` → `-` 归一化后按长度降序做最长前缀匹配，
跳过 `ExactOnly` 模型作为前缀目标；版本后缀保护：匹配候选后，若模型名在匹配位置之后紧跟
数字或 `-数字`，拒绝该候选（`gpt-5.5` 不得落到 `gpt-5`）。

- [ ] **Step 4: 运行确认通过**

Run: `cd clients/go && go test ./internal/nativepricing/ -run Find -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add clients/go/internal/nativepricing/find.go clients/go/internal/nativepricing/find_test.go
git commit -m "feat(nativepricing): add the three-level pricing lookup"
```

---

### Task 3: 计费公式

**Files:**
- Create: `clients/go/internal/nativepricing/cost.go`
- Test: `clients/go/internal/nativepricing/cost_test.go`

**Interfaces:**
- Consumes: `CorpusModel`
- Produces: `type Usage struct { Input, Output, CacheCreate, CacheRead, CacheCreate1h int64 }`；
  `func Cost(u Usage, p CorpusModel, fast, flex bool) (cost float64, missingPricing bool)`

- [ ] **Step 1: 写失败测试（分档 / 乘数 / 饱和 / 缺价）**

```go
func TestCost_switchesTheWholeRequestAboveTheThreshold(t *testing.T)   // context = threshold+1 → 全高档
func TestCost_isMarginalForTheDefault200kTier(t *testing.T)            // 无阈值模型 → 分段
func TestCost_billsOneHourCacheCreationAtDoubleInput(t *testing.T)     // 1h = input×2
func TestCost_appliesFastAndFlexMultipliers(t *testing.T)
func TestCost_saturatesInsteadOfWrapping(t *testing.T)                 // MaxInt64 输入
func TestCost_reportsUnknownModelsAsMissingPricing(t *testing.T)
```

- [ ] **Step 2: 运行确认失败**

Run: `cd clients/go && go test ./internal/nativepricing/ -run Cost -v`
Expected: FAIL

- [ ] **Step 3: 实现计费（逐分支复刻）**

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

- [ ] **Step 4: 运行确认通过**

Run: `cd clients/go && go test ./internal/nativepricing/ -run Cost -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add clients/go/internal/nativepricing/cost.go clients/go/internal/nativepricing/cost_test.go
git commit -m "feat(nativepricing): port the ccusage cost formula"
```

---

### Task 4: overrides 应用（含缓存率比例缩放）

**Files:**
- Create: `clients/go/internal/nativepricing/overrides.go`
- Test: `clients/go/internal/nativepricing/overrides_test.go`

**Interfaces:**
- Consumes: `Corpus`、`CorpusModel`
- Produces: `func (c Corpus) WithOverrides(overrides map[string]any) (Corpus, error)`

- [ ] **Step 1: 写失败测试**

```go
func TestWithOverrides_scalesCacheRatesWhenOnlyInputChanges(t *testing.T)
    // 原 input=1e-6, cache_read=2e-7；覆盖 input=2e-6 → cache_read 期望 4e-7
func TestWithOverrides_keepsExplicitCacheRates(t *testing.T)      // 显式给了 cache_read 就不缩放
func TestWithOverrides_appliesFastAndFlexMultipliers(t *testing.T)
func TestWithOverrides_parsesAbove200kSuffixKeys(t *testing.T)    // *_above_200k_tokens
func TestWithOverrides_isIdempotent(t *testing.T)
```

- [ ] **Step 2: 运行确认失败**

Run: `cd clients/go && go test ./internal/nativepricing/ -run WithOverrides -v`
Expected: FAIL

- [ ] **Step 3: 实现**

键名与 ccusage `config_schema.rs:596-605` 对齐：`input_cost_per_token`、`output_cost_per_token`、
`cache_read_input_token_cost`、`cache_creation_input_token_cost`、`*_above_200k_tokens`、
`fast_multiplier`、`flex_multiplier`。仅当覆盖了 `input_cost_per_token` 且**未**显式覆盖 cache 率时，
按 `new = old × newInput / oldInput` 缩放（`oldInput == 0` 时跳过缩放）。覆盖键走与 Task 2 相同的
归一化匹配。

- [ ] **Step 4: 运行确认通过**

Run: `cd clients/go && go test ./internal/nativepricing/ -run WithOverrides -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add clients/go/internal/nativepricing/overrides.go clients/go/internal/nativepricing/overrides_test.go
git commit -m "feat(nativepricing): apply pricing overrides with cache-rate scaling"
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
JSONL 夹具运行 `claude daily --json`，记录每个用例的 `(model, tokens, cost)` 三元组，
写成 `cost-cases.json`。夹具覆盖：普通模型、above-200k 模型（阈值下/上各一）、
custom threshold 模型（272k）、1h cache creation、fast/flex、未知模型。

- [ ] **Step 2: 生成金样本**

Run: `node clients/go/scripts/gen-native-pricing-goldens.mjs`
Expected: 写出 `goldens/cost-cases.json`；打印每个用例的 cost。

- [ ] **Step 3: 写失败测试**

```go
func TestCostMatchesTheCcusageGoldens(t *testing.T) {
    // 逐用例 Compare(got, goldens[i].Cost) —— 用精确相等（同一 float64 运算序列）
    // 失败时打印 model/tokens/got/want，便于定位是哪个分支漂移
}
```

- [ ] **Step 4: 运行确认失败**

Run: `cd clients/go && go test ./internal/nativepricing/ -run Goldens -v`
Expected: FAIL（实现未对齐前）

- [ ] **Step 5: 修正实现至全绿**

按失败信息定位差异分支（通常是运算顺序或默认 cache 率），修正后重跑。

Run: `cd clients/go && go test ./internal/nativepricing/ -v`
Expected: PASS，且 0 个用例被跳过。

- [ ] **Step 6: Commit**

```bash
git add clients/go/scripts/gen-native-pricing-goldens.mjs \
        clients/go/internal/nativepricing/goldens clients/go/internal/nativepricing/goldens_test.go
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
```

- [ ] **Step 2: 运行确认失败**

Run: `cd clients/go && go test ./cmd/parity/ -v`
Expected: FAIL

- [ ] **Step 3: 实现**

native 侧调 `collect.Lookup(source).Collect`；ccusage 侧 exec 指定二进制并走现有
`ccusage.NormalizeCcusageDailyJSON`（过渡期两者都可用）。比较键为 `(usageDate, model)`，
值比较 `HashPayload()`；输出 count 摘要与逐行差异；存在非 liveWrite 差异时 exit 1。

- [ ] **Step 4: 运行确认通过，并在本机做一次真实冒烟**

Run: `cd clients/go && go test ./cmd/parity/ -v`
Run: `cd clients/go && go run ./cmd/parity -source claude-code -since 2026-11-01 -until 2026-11-01 -ccusage-bin ~/.tokenboard/bin/ccusage`
Expected: 测试 PASS；冒烟输出差异摘要（此时 native 尚未实现来源，预期 `native` 侧报 not implemented，记录该边界）

- [ ] **Step 5: Commit**

```bash
git add clients/go/cmd/parity
git commit -m "feat(cmd): add a parity harness comparing native collectors with ccusage"
```

---

### Task 7: `cmd/bench-collect` 性能基准

**Files:**
- Create: `clients/go/cmd/bench-collect/main.go`
- Create: `clients/go/cmd/bench-collect/rss_unix.go`
- Create: `clients/go/cmd/bench-collect/rss_windows.go`
- Test: `clients/go/cmd/bench-collect/main_test.go`

**Interfaces:**
- Produces: CLI `bench-collect -source S -scenario single|30d|full|hook -rounds 5 [-ccusage-bin P]`；
  输出每轮 wall/RSS/读取字节与中位数

- [ ] **Step 1: 写失败测试**

```go
func TestMedianOfOddAndEvenCounts(t *testing.T)
func TestScenarioWindowsProduceTheExpectedRanges(t *testing.T)   // single→1天, 30d→30天, full→空, hook→cursor
func TestReportMarksRegressions(t *testing.T)                    // native 比 ccusage 慢时标记而非隐藏
```

- [ ] **Step 2: 运行确认失败**

Run: `cd clients/go && go test ./cmd/bench-collect/ -v`
Expected: FAIL

- [ ] **Step 3: 实现**

每场景 ≥5 轮；RSS 用 `getrusage(RUSAGE_SELF).Ru_maxrss`（unix 为 KB，Windows 需换
`GetProcessMemoryInfo`）；墙钟用 `time.Now()` 包裹；读取字节数由适配器的计数器提供
（S1 阶段记录 0 并标注 pending）。输出 JSON + 人类可读摘要，含中位数与最大值。

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

方法学、每轮原始值、中位数、最大值、load 记录；明确 native 侧尚未实现、本报告只是 ccusage 基线。

- [ ] **Step 3: Commit**

```bash
git add docs/research/2026-11-03-native-vs-ccusage-baseline.md
git commit -m "docs: record the ccusage performance baseline measured through bench-collect"
```

---

### Task 9: CI 接线与 dev-only 保证

**Files:**
- Modify: `.github/workflows/go-client.yml`
- Test: `clients/go/cmd/bench-collect/main_test.go`（沿用）

- [ ] **Step 1: 写守护测试**

```go
func TestDevCommandsAreNotInTheGoreleaserBuildList(t *testing.T)
    // 读 ../../../../.goreleaser.yaml，断言不含 cmd/parity 与 cmd/bench-collect
```

- [ ] **Step 2: 运行确认通过**

Run: `cd clients/go && go test ./cmd/bench-collect/ -run Goreleaser -v`
Expected: PASS

- [ ] **Step 3: 加 CI job**

在 `go-client.yml` 增加 `native-pricing` job：跑 `go test ./internal/nativepricing/...` 与
`node --test clients/go/scripts/fetch-native-pricing.test.mjs`；再跑一次 `go build ./...`。

- [ ] **Step 4: 跑全量验证**

Run: `cd clients/go && go test ./... -count=1 && go vet ./... && gofmt -l .`
Expected: 全绿、输出为空

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/go-client.yml clients/go
git commit -m "ci: gate the native pricing engine and keep dev commands out of releases"
```

---

## 完成标准（S1 出口）

- `go test ./internal/nativepricing/...` 全绿，含与 ccusage 的 cost 金样本零差异。
- `cmd/parity` 与 `cmd/bench-collect` 可用且不在发布产物中。
- 嵌入语料的模型数与来源 rev/sha256 有测试钉住。
- `docs/research/2026-11-03-native-vs-ccusage-baseline.md` 含真实原始数据。
- 三平台构建通过；`internal/pricing`、`internal/ccusage`、`contract` 未被修改。