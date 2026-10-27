// Generates the cross-language golden for the dynamic ccusage pricing overrides.
//
// The TypeScript collector is the reference implementation, so it produces both
// halves of the fixture: the raw `/api/v1/model-pricing` response the catalogue
// is parsed from, and the overrides it must yield. The Go client parses the same
// response and must reproduce the same map (clients/go/internal/pricing).
//
// Regenerate after any intentional change to catalogue parsing, the collapse of
// ambiguous model ids, the official anchor, or the case-variant aliases:
//
//   node_modules/.bin/tsx scripts/clients-go-gen-pricing-goldens.mts \
//     > clients/go/internal/pricing/goldens/ccusage-overrides.json
//
// Never hand-edit the output: the whole point is that TypeScript defines the
// expected values.
import { createCcusagePricingOverrides, validateModelPricingResponse } from '../packages/collector/src/model-pricing.ts'

type Row = Record<string, unknown>

const row = (provider: string, modelId: string, input: number, output: number, extra: Row = {}): Row => ({
  provider,
  modelId,
  inputCostPerMillion: input,
  outputCostPerMillion: output,
  cacheReadCostPerMillion: null,
  cacheWriteCostPerMillion: null,
  contextWindow: 200_000,
  maxInputTokens: null,
  pricing: {},
  ...extra
})

const tiers = (...values: Array<[number, number, number, number?, number?]>) => ({
  tiers: values.map(([size, input, output, cacheRead, cacheWrite]) => ({
    tier: { type: 'context', size },
    input,
    output,
    ...(cacheRead === undefined ? {} : { cache_read: cacheRead }),
    ...(cacheWrite === undefined ? {} : { cache_write: cacheWrite })
  }))
})

// Every group below is a shape the override builder has to get right. They are
// deliberately small: the fixture is a contract, not a catalogue dump.
const models: Row[] = [
  // 1. Two spellings of one id, disagreeing only on a $0 placeholder. The
  //    priced row wins and the alias has to reach the other spelling.
  row('zai', 'glm-5.3-flash', 0.15, 0.5, { cacheReadCostPerMillion: 0.03 }),
  row('amd', 'GLM-5.3-Flash', 0, 0),

  // 2. Unresolved base id: the reseller rows disagree, so the id is dropped and
  //    only the folding key `xiaomi/mimo-v2.6-flash-uncensored` can price a
  //    plain `mimo-v2.6-flash` day. The official row anchors it, and the anchor
  //    has to be aliased to the catalogue's other spelling.
  row('xiaomi', 'mimo-v2.6-flash', 0.14, 0.28),
  row('reseller-a', 'mimo-v2.6-flash', 0.12, 0.25),
  row('reseller-b', 'MiMo-V2.6-Flash', 0.2, 0.4),
  row('xiaomi', 'xiaomi/mimo-v2.6-flash-uncensored', 0.5, 1.5),

  // 3. Official vendor publishes a $0 placeholder next to a real reseller price.
  row('nvidia', 'step-5-preview', 0, 0),
  row('stepfun-ai', 'step-5-preview', 1, 2.7),

  // 4. Agreeing group where the official vendor row still represents it.
  row('reseller', 'gpt-6', 1, 2),
  row('openai', 'gpt-6', 1, 2),

  // 5. A single 200k tier is expressible: the above-200k fields must appear.
  row('anthropic', 'claude-opus-4-6', 15, 75, {
    contextWindow: 200_000,
    cacheReadCostPerMillion: 1.5,
    cacheWriteCostPerMillion: 18.75,
    pricing: tiers([200_000, 15, 75, 1.5, 18.75])
  }),

  // 6. Changing prices across later tiers cannot be expressed by one 200k
  //    threshold: the merged override must drop the above-200k fields.
  row('openai', 'gpt-5.5-sol', 1.25, 10, {
    contextWindow: 400_000,
    pricing: tiers([200_000, 1.25, 10], [272_000, 2.5, 15])
  }),

  // 7. Cache prices absent: no cache keys at all.
  row('deepseek', 'deepseek-flash', 0.15, 0.6, { contextWindow: 1_000_000 }),

  // 8. Fast multiplier carried through.
  row('xai', 'grok-4.5', 2, 6, {
    contextWindow: 500_000,
    pricing: { ...tiers([200_000, 2, 6, 0.3]), fastMultiplier: 2 }
  }),

  // 9. Every row free: the agreeing group is emitted at zero.
  row('local', 'free-model', 0, 0),
  row('local-2', 'free-model', 0, 0),

  // 10. Non-ASCII id, reached through a provider prefix.
  row('local', 'módel/中文-模型', 0.3, 0.9),

  // 11. Two official vendors disagree, listed in the opposite of provider order.
  //     The anchor must pick the alphabetically first official provider, so the
  //     catalogue's row order cannot decide what every collector bills.
  row('zhipuai', 'glm-9-flash', 0.12, 0.42),
  row('zai', 'glm-9-flash', 0.15, 0.5),
  row('vendor', 'vendor/glm-9-flash-uncensored', 5, 10),

  // 12. Rows agreeing on price but disagreeing on context window. The collapse
  //     keeps one representative and its window becomes maxInputTokens, so the
  //     pick has to be the alphabetically first provider rather than whichever
  //     row the catalogue listed first.
  row('zeta', 'order-model', 1, 2, { contextWindow: 128_000 }),
  row('alpha', 'order-model', 1, 2, { contextWindow: 400_000 })
]

const response = { models, nextCursor: null }
const { models: parsed } = validateModelPricingResponse(response)
// The fallback config plays the static bundled layer. It carries above-200k keys
// for two models so the merge's strip is exercised in both directions: the
// unrepresentable model must lose them, the representable one must keep them.
const fallback = {
  defaults: {
    pricingOverrides: {
      'gpt-5.5-sol': {
        inputCostPerTokenAbove200kTokens: 9e-6,
        outputCostPerTokenAbove200kTokens: 9e-5
      },
      'deepseek-flash': {
        inputCostPerTokenAbove200kTokens: 3e-7,
        outputCostPerTokenAbove200kTokens: 1.2e-6
      }
    }
  }
}
const overrides = createCcusagePricingOverrides(parsed, fallback)

// Sort every object's keys by code point so the committed file is byte-stable
// regardless of merge order or the machine's locale/ICU data.
const sortedJson = (value: unknown) =>
  JSON.stringify(
    value,
    (_key, entry: unknown) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry
      const pairs = Object.entries(entry as Record<string, unknown>).sort(([left], [right]) =>
        left < right ? -1 : left > right ? 1 : 0
      )
      return Object.fromEntries(pairs)
    },
    2
  )

process.stdout.write(`${sortedJson({ catalogue: response, fallback, overrides })}\n`)
