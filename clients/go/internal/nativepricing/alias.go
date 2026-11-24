package nativepricing

// Alias and date-suffix handling shared by the lookup and by everything built on
// top of a resolved model id. Ported from ccusage
// (rust/crates/ccusage-core/src/pricing.rs); see ../../THIRD_PARTY_NOTICES.md.

// pricingAlias mirrors pricing_alias (pricing.rs:2793): a family name bills at
// the variant it points to. The aliased id is resolved exactly like any other
// request - a hardcoded alias does not imply an exact entry for it exists.
func pricingAlias(model string) (string, bool) {
	switch model {
	case "gpt-reserve":
		return "gpt-5.6-luna", true
	case "gpt-5.6":
		return "gpt-5.6-sol", true
	case "gpt-5.3-spark":
		return "gpt-5.3-codex-spark", true
	}
	return "", false
}

// modelWithoutDateSuffix mirrors model_without_date_suffix (pricing.rs:2767):
// strips a trailing release date (-YYYY-MM-DD or -YYYYMMDD) so a date-pinned id
// shares its base model's rates, long-context tier and speed multipliers.
//
// The lookup itself does not need this - pricingKeyMatches already accepts an
// eight-digit date suffix (modelDateSuffixDigits) - but the tier and multiplier
// passes resolve one model id to another and have to agree on what a date looks
// like.
func modelWithoutDateSuffix(model string) string {
	// -YYYY-MM-DD (OpenAI style, e.g. gpt-5.5-2026-04-23)
	if len(model) > 11 {
		suffix := model[len(model)-11:]
		if suffix[0] == '-' && isDigits(suffix[1:5]) && suffix[5] == '-' && isDigits(suffix[6:8]) && suffix[8] == '-' && isDigits(suffix[9:]) {
			return model[:len(model)-11]
		}
	}
	// -YYYYMMDD (Anthropic style, e.g. claude-3-5-haiku-20241022)
	if len(model) > 9 {
		suffix := model[len(model)-9:]
		if suffix[0] == '-' && isDigits(suffix[1:]) {
			return model[:len(model)-9]
		}
	}
	return model
}

// isDigits reports whether value is a non-empty run of ASCII digits, the shape
// the date suffix above is built from.
func isDigits(value string) bool {
	for index := 0; index < len(value); index++ {
		if !isASCIIDigit(value[index]) {
			return false
		}
	}
	return len(value) > 0
}
