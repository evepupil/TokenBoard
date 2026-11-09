package nativepricing

// Event-time pricing: ccusage's find_at and everything only it needs -
// deepseek_v4_model_identity, has_time_dependent_pricing, the two DeepSeek V4
// schedule tables and apply_deepseek_v4_schedule
// (rust/crates/ccusage-core/src/pricing.rs:252-380, 1458-1483), plus
// long_context_split_threshold (pricing.rs:2753-2775).
//
// The schedule is the only place where a price depends on when a request ran
// rather than on what it asked for, so the tables below are transcribed
// verbatim and the peak windows are evaluated in UTC.

// deepSeekV4PricingCutoffMillis is DEEPSEEK_V4_PRICING_CUTOFF_MS
// (pricing.rs:252): before it, only the old rates apply.
const deepSeekV4PricingCutoffMillis int64 = 1_786_896_000_000

const (
	// millisPerHour and millisPerDay are MILLIS_PER_HOUR / MILLIS_PER_DAY
	// (date_utils.rs:6-8), spelled out so the window math stays exact.
	millisPerHour int64 = 3_600_000
	millisPerDay  int64 = 86_400_000
)

// deepSeekV4Rates is one DeepSeekV4Rates row (pricing.rs:256-261): USD per
// token for the four billed rates.
type deepSeekV4Rates struct {
	input, output, cacheCreate, cacheRead float64
}

// deepseekV4ModelIdentity is deepseek_v4_model_identity (pricing.rs:264-273):
// the normalized key, when it names one of the two scheduled models.
func deepseekV4ModelIdentity(model string) (string, bool) {
	switch normalizePricingKey(model) {
	case "deepseek-v4-flash":
		return "deepseek-v4-flash", true
	case "deepseek-v4-pro":
		return "deepseek-v4-pro", true
	}
	return "", false
}

// HasTimeDependentPricing is has_time_dependent_pricing (pricing.rs:275-282):
// whether a model's price depends on the event timestamp, either by its own
// name or through the configured aliases.
func HasTimeDependentPricing(model string) bool {
	if _, ok := deepseekV4ModelIdentity(model); ok {
		return true
	}
	_, ok := deepseekV4ModelIdentity(ResolveModelName(model))
	return ok
}

// deepSeekV4RatesFor is deepseek_v4_rates (pricing.rs:284-333).
func deepSeekV4RatesFor(scheduledModel string, millis int64) (deepSeekV4Rates, bool) {
	var old, offPeak, peak deepSeekV4Rates
	switch scheduledModel {
	case "deepseek-v4-flash":
		old = deepSeekV4Rates{input: 0.14e-6, output: 0.28e-6, cacheCreate: 0.14e-6, cacheRead: 0.0028e-6}
		offPeak = deepSeekV4Rates{input: 0.22e-6, output: 0.66e-6, cacheCreate: 0.22e-6, cacheRead: 0.007e-6}
		peak = deepSeekV4Rates{input: 0.44e-6, output: 1.32e-6, cacheCreate: 0.44e-6, cacheRead: 0.014e-6}
	case "deepseek-v4-pro":
		old = deepSeekV4Rates{input: 0.435e-6, output: 0.87e-6, cacheCreate: 0.435e-6, cacheRead: 0.003625e-6}
		offPeak = deepSeekV4Rates{input: 0.66e-6, output: 1.98e-6, cacheCreate: 0.66e-6, cacheRead: 0.022e-6}
		peak = deepSeekV4Rates{input: 1.32e-6, output: 3.96e-6, cacheCreate: 1.32e-6, cacheRead: 0.044e-6}
	default:
		return deepSeekV4Rates{}, false
	}
	if millis < deepSeekV4PricingCutoffMillis {
		return old, true
	}
	if deepSeekV4Peak(millis) {
		return peak, true
	}
	return offPeak, true
}

// deepSeekV4Peak is deepseek_v4_peak (pricing.rs:335-347): the published
// windows are in UTC and half-open, so hours 1-3 and 6-9 on weekdays (Sunday
// zero) are peak and weekends never are. Euclidean modulo keeps the mapping
// valid before the epoch as well.
func deepSeekV4Peak(millis int64) bool {
	daysSinceEpoch := floorDivMillis(millis, millisPerDay)
	weekdayFromSunday := ((daysSinceEpoch+4)%7 + 7) % 7
	if weekdayFromSunday < 1 || weekdayFromSunday > 5 {
		return false
	}
	hour := ((millis % millisPerDay) + millisPerDay) % millisPerDay / millisPerHour
	return (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10)
}

func floorDivMillis(value, divisor int64) int64 {
	quotient := value / divisor
	if value%divisor != 0 && (value < 0) != (divisor < 0) {
		quotient--
	}
	return quotient
}

// applyDeepSeekV4Schedule is apply_deepseek_v4_schedule (pricing.rs:349-370):
// the scheduled rates replace all four rates and all four above-threshold
// bands, and both cache rates become explicit.
func applyDeepSeekV4Schedule(scheduledModel string, millis int64, pricing CorpusModel) CorpusModel {
	rates, ok := deepSeekV4RatesFor(scheduledModel, millis)
	if !ok {
		return pricing
	}
	pricing.Input = rates.input
	pricing.Output = rates.output
	pricing.CacheCreate = rates.cacheCreate
	pricing.CacheRead = rates.cacheRead
	pricing.InputAbove = floatValue(rates.input)
	pricing.OutputAbove = floatValue(rates.output)
	pricing.CacheCreateAbove = floatValue(rates.cacheCreate)
	pricing.CacheReadAbove = floatValue(rates.cacheRead)
	pricing.CacheCreateExplicit = true
	pricing.CacheReadExplicit = true
	return pricing
}

// applyExplicitPricingOverride is apply_explicit_pricing_override
// (pricing.rs:372-404): only the keys the user set are written, and the two
// cache rates become explicit when they are written. A multiplier is applied
// there too, which is why it is replayed here alongside the rates.
func applyExplicitPricingOverride(pricing CorpusModel, fields overrideFields) CorpusModel {
	if fields.input != nil {
		pricing.Input = *fields.input
	}
	if fields.output != nil {
		pricing.Output = *fields.output
	}
	if fields.cacheCreate != nil {
		pricing.CacheCreate = *fields.cacheCreate
		pricing.CacheCreateExplicit = true
	}
	if fields.cacheRead != nil {
		pricing.CacheRead = *fields.cacheRead
		pricing.CacheReadExplicit = true
	}
	if fields.inputAbove != nil {
		pricing.InputAbove = floatValue(*fields.inputAbove)
	}
	if fields.outputAbove != nil {
		pricing.OutputAbove = floatValue(*fields.outputAbove)
	}
	if fields.cacheCreateAbove != nil {
		pricing.CacheCreateAbove = floatValue(*fields.cacheCreateAbove)
	}
	if fields.cacheReadAbove != nil {
		pricing.CacheReadAbove = floatValue(*fields.cacheReadAbove)
	}
	if fields.fastMultiplier != nil {
		pricing.FastMultiplier = *fields.fastMultiplier
	}
	if fields.flexMultiplier != nil {
		pricing.FlexMultiplier = *fields.flexMultiplier
	}
	return pricing
}

// FindAt is find_at (pricing.rs:1458-1483): the pricing that applies to one
// usage event, with the timestamp-aware DeepSeek schedule applied to the two
// direct ids and the aliases that resolve to them. Every other model resolves
// through Find, and callers that do not know when a request ran keep using
// Find.
func (c Corpus) FindAt(model string, millis int64) (CorpusModel, bool) {
	resolvedModel := ResolveModelName(model)
	scheduledModel, isScheduled := deepseekV4ModelIdentity(model)
	if !isScheduled {
		scheduledModel, isScheduled = deepseekV4ModelIdentity(resolvedModel)
	}
	if !isScheduled {
		return c.Find(model)
	}
	// ccusage's find resolves CCUSAGE_MODEL_ALIASES internally, so a request
	// that names a scheduled model through a user alias still finds it. Find
	// here deliberately does not read that table (see find.go); the two
	// spellings are tried explicitly instead.
	base, ok := c.Find(model)
	if !ok && resolvedModel != model {
		base, ok = c.Find(resolvedModel)
	}
	if !ok {
		return CorpusModel{}, false
	}
	pricing := applyDeepSeekV4Schedule(scheduledModel, millis, base)
	// ccusage reads the same override the user applied, by the request name,
	// then its alias, then the scheduled id.
	fields, ok := c.overrideFieldsFor(model)
	if !ok && resolvedModel != model {
		fields, ok = c.overrideFieldsFor(resolvedModel)
	}
	if !ok {
		fields, ok = c.overrideFieldsFor(scheduledModel)
	}
	if ok {
		pricing = applyExplicitPricingOverride(pricing, fields)
	}
	return pricing, true
}

// overrideFieldsFor returns the parsed override recorded for exactly this key.
func (c Corpus) overrideFieldsFor(model string) (overrideFields, bool) {
	if c.overrideFields == nil {
		return overrideFields{}, false
	}
	fields, ok := c.overrideFields[model]
	return fields, ok
}

// HasOverride reports whether an exact pricingOverrides record exists for this
// key. zcode's pricing_model checks `pricing_overrides.contains_key(candidate)`
// before its provider guard (parser.rs:161-171), and that lookup is by the
// candidate spelling alone - no alias resolution.
func (c Corpus) HasOverride(model string) bool {
	_, ok := c.overrideFieldsFor(model)
	return ok
}

// HasUserOverride is PricingMap::has_user_override (pricing.rs:1488-1494): a
// user override recorded for this model id or its configured alias.
func (c Corpus) HasUserOverride(model string) bool {
	if _, ok := c.overrideFieldsFor(model); ok {
		return true
	}
	_, ok := c.overrideFieldsFor(ResolveModelName(model))
	return ok
}

// LongContextSplitThreshold is long_context_split_threshold
// (pricing.rs:2753-2766): the per-request boundary above which a model bills at
// its long-context tier, read from the models.dev snapshot itself rather than
// from the merged table.
//
// The merged table is the wrong source because mergeInto keeps every primary
// row it already has and applyLongContextRates only grafts tiers onto rows
// without above bands: a model whose LiteLLM entry publishes
// `*_above_200k_tokens` while models.dev carries a different `cost.tiers`
// boundary keeps no threshold in Models, yet ccusage's split uses the
// models.dev number. DevThresholds is the separate table that answers it.
func (c Corpus) LongContextSplitThreshold(model string) int64 {
	base := modelWithoutDateSuffix(model)
	resolved := base
	if alias, ok := pricingAlias(base); ok {
		resolved = alias
	}
	if threshold, ok := c.DevThresholds[resolved]; ok {
		return threshold
	}
	if threshold, ok := c.DevThresholds[base]; ok {
		return threshold
	}
	return defaultLongContextThresholdTokens
}
