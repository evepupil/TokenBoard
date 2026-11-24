package nativepricing

import "testing"

func TestPricingAlias(t *testing.T) {
	cases := map[string]string{
		"gpt-reserve":   "gpt-5.6-luna",
		"gpt-5.6":       "gpt-5.6-sol",
		"gpt-5.3-spark": "gpt-5.3-codex-spark",
	}
	for model, want := range cases {
		got, ok := pricingAlias(model)
		if !ok || got != want {
			t.Errorf("pricingAlias(%q) = %q, %v, want %q, true", model, got, ok, want)
		}
	}
	// Aliases are exact ids, not prefixes or spellings: anything else is not one.
	for _, model := range []string{"gpt-5.6-sol", "gpt-5.6.1", "gpt-5.6-preview", "GPT-5.6", "gpt-reserves"} {
		if got, ok := pricingAlias(model); ok {
			t.Errorf("pricingAlias(%q) = %q, true, want no alias", model, got)
		}
	}
}

func TestModelWithoutDateSuffix(t *testing.T) {
	cases := map[string]string{
		// -YYYY-MM-DD (OpenAI style)
		"gpt-5.5-2026-04-23":     "gpt-5.5",
		"gpt-5.5-pro-2026-04-23": "gpt-5.5-pro",
		// -YYYYMMDD (Anthropic style)
		"claude-3-5-haiku-20241022": "claude-3-5-haiku",
		"claude-opus-4-20250514":    "claude-opus-4",
		// Nothing to strip
		"gpt-5.5":              "gpt-5.5",
		"gpt-5.6-sol":          "gpt-5.6-sol",
		"gpt-4-0613":           "gpt-4-0613", // 4 digits, not a date
		"claude-opus-4-6-v1:0": "claude-opus-4-6-v1:0",
		"20241022":             "20241022", // no separator to anchor on
		"claude-20241022":      "claude",   // 8 digits after a dash are a date
		"-20241022":            "-20241022",
	}
	for model, want := range cases {
		if got := modelWithoutDateSuffix(model); got != want {
			t.Errorf("modelWithoutDateSuffix(%q) = %q, want %q", model, got, want)
		}
	}
}
