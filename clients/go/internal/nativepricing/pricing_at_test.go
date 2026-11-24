package nativepricing

// Task 7: the event-time pricing engine and per-model long-context boundary,
// pinned against ccusage v20.0.33 (commit 1308c416):
// rust/crates/ccusage-core/src/pricing.rs. These are the primitives the Codex
// aggregator prices its buckets with; a drift here changes a user's cost
// silently, so every expected rate comes from the embedded rate table.

import (
	"math"
	"testing"
	"time"
)

const deepSeekCutoff = int64(1_786_896_000_000)

func mustFindAt(t *testing.T, corpus Corpus, model string, millis int64) CorpusModel {
	t.Helper()
	pricing, ok := corpus.FindAt(model, millis)
	if !ok {
		t.Fatalf("FindAt(%q, %d) missed, want the static entry with a schedule", model, millis)
	}
	return pricing
}

func approxRate(t *testing.T, label string, got, want float64) {
	t.Helper()
	if math.Abs(got-want) > 1e-18 {
		t.Fatalf("%s = %.18g, want %.18g", label, got, want)
	}
}

// TestFindAtAppliesDeepSeekScheduleAtCutoff pins the two schedule branches
// (pricing.rs:286-333): before the cutoff the old rates apply, and at or after
// it the off-peak / peak rates replace all four rates and all four above bands.
func TestFindAtAppliesDeepSeekScheduleAtCutoff(t *testing.T) {
	corpus, err := LoadEmbeddedCorpus()
	if err != nil {
		t.Fatal(err)
	}
	// The cutoff is 2026-08-16T16:00:00Z; 2026-08-17T02:00:00Z is a Monday
	// peak hour and 2026-08-17T05:00:00Z is off-peak.
	peak := millisOf(t, "2026-08-17T02:00:00Z")
	offPeak := millisOf(t, "2026-08-17T05:00:00Z")
	for _, tc := range []struct {
		name   string
		millis int64
		input  float64
		output float64
		create float64
		read   float64
	}{
		{"before cutoff", deepSeekCutoff - 1, 0.14e-6, 0.28e-6, 0.14e-6, 0.0028e-6},
		{"off peak", offPeak, 0.22e-6, 0.66e-6, 0.22e-6, 0.007e-6},
		{"peak", peak, 0.44e-6, 1.32e-6, 0.44e-6, 0.014e-6},
	} {
		pricing := mustFindAt(t, corpus, "deepseek-v4-flash", tc.millis)
		approxRate(t, tc.name+" input", pricing.Input, tc.input)
		approxRate(t, tc.name+" output", pricing.Output, tc.output)
		approxRate(t, tc.name+" create", pricing.CacheCreate, tc.create)
		approxRate(t, tc.name+" read", pricing.CacheRead, tc.read)
		for _, band := range []struct {
			name  string
			value *float64
			want  float64
		}{
			{"input above", pricing.InputAbove, tc.input},
			{"output above", pricing.OutputAbove, tc.output},
			{"create above", pricing.CacheCreateAbove, tc.create},
			{"read above", pricing.CacheReadAbove, tc.read},
		} {
			if band.value == nil {
				t.Fatalf("%s: %s is nil, want the scheduled rate", tc.name, band.name)
			}
			approxRate(t, tc.name+" "+band.name, *band.value, band.want)
		}
		if !pricing.CacheReadExplicit || !pricing.CacheCreateExplicit {
			t.Fatalf("%s: schedule must mark both cache rates explicit", tc.name)
		}
	}

	pro := mustFindAt(t, corpus, "deepseek-v4-pro", peak)
	approxRate(t, "pro peak input", pro.Input, 1.32e-6)
	approxRate(t, "pro peak output", pro.Output, 3.96e-6)
	approxRate(t, "pro peak create", pro.CacheCreate, 1.32e-6)
	approxRate(t, "pro peak read", pro.CacheRead, 0.044e-6)
}

func millisOf(t *testing.T, value string) int64 {
	t.Helper()
	instant, err := time.Parse(time.RFC3339, value)
	if err != nil {
		t.Fatal(err)
	}
	return instant.UnixMilli()
}

// TestFindAtPeakWindowsAreHalfOpenWeekdaysOnly pins deepseek_v4_peak
// (pricing.rs:334-347): UTC hours 1-3 and 6-9 on weekdays are peak; the
// ending hours 4 and 10 are not; weekends are always off-peak.
func TestFindAtPeakWindowsAreHalfOpenWeekdaysOnly(t *testing.T) {
	corpus, err := LoadEmbeddedCorpus()
	if err != nil {
		t.Fatal(err)
	}
	// 2026-08-17 is a Monday, 2026-08-22 a Saturday, 2026-08-23 a Sunday.
	weekdays := []struct {
		day  string
		hour string
		peak bool
	}{
		{"2026-08-17", "00:00", false},
		{"2026-08-17", "01:00", true},
		{"2026-08-17", "03:59", true},
		{"2026-08-17", "04:00", false},
		{"2026-08-17", "06:00", true},
		{"2026-08-17", "09:59", true},
		{"2026-08-17", "10:00", false},
		{"2026-08-22", "02:00", false},
		{"2026-08-23", "07:00", false},
	}
	for _, tc := range weekdays {
		millis := millisOf(t, tc.day+"T"+tc.hour+":00Z")
		pricing := mustFindAt(t, corpus, "deepseek-v4-flash", millis)
		want := 0.22e-6
		if tc.peak {
			want = 0.44e-6
		}
		approxRate(t, tc.day+" "+tc.hour, pricing.Input, want)
	}
}

// TestFindAtKeepsStaticPricingForOtherModels pins the miss arm of find_at
// (pricing.rs:1461-1468): a model outside the two DeepSeek families is priced
// exactly as Find would price it, including aliases that do not resolve to a
// scheduled id.
func TestFindAtKeepsStaticPricingForOtherModels(t *testing.T) {
	corpus, err := LoadEmbeddedCorpus()
	if err != nil {
		t.Fatal(err)
	}
	for _, model := range []string{"gpt-5.4", "deepseek-v3.2", "claude-opus-4-6"} {
		static, ok := corpus.Find(model)
		if !ok {
			t.Fatalf("Find(%q) missed", model)
		}
		timed, ok := corpus.FindAt(model, deepSeekCutoff+3_600_000)
		if !ok {
			t.Fatalf("FindAt(%q) missed", model)
		}
		if timed.Input != static.Input || timed.Output != static.Output ||
			timed.CacheCreate != static.CacheCreate || timed.CacheRead != static.CacheRead {
			t.Fatalf("FindAt(%q) = %+v, want Find's %+v", model, timed, static)
		}
	}
}

// TestFindAtReappliesExplicitOverridesAfterTheSchedule pins the override replay
// (pricing.rs:1469-1482): the schedule would otherwise erase a user's rate,
// and the lookup tries the model, its alias, then the scheduled id.
func TestFindAtReappliesExplicitOverridesAfterTheSchedule(t *testing.T) {
	corpus, err := LoadEmbeddedCorpus()
	if err != nil {
		t.Fatal(err)
	}
	withOverrides, err := corpus.WithOverrides(map[string]any{
		"my-deepseek": map[string]any{"inputCostPerToken": 11e-6, "cacheReadInputTokenCost": 3e-6},
	})
	if err != nil {
		t.Fatal(err)
	}
	// An alias from the name to a scheduled id makes the second spelling win.
	t.Setenv("CCUSAGE_MODEL_ALIASES", "my-alias=deepseek-v4-flash")
	pricing, ok := withOverrides.FindAt("my-alias", millisOf(t, "2026-08-17T02:00:00Z"))
	if !ok {
		t.Fatal("FindAt(my-alias) missed")
	}
	approxRate(t, "scheduled input", pricing.Input, 0.44e-6)

	// A direct override of the scheduled id is re-applied after the schedule,
	// and the explicit cache-read flag is restored.
	direct, err := corpus.WithOverrides(map[string]any{
		"deepseek-v4-flash": map[string]any{"inputCostPerToken": 7e-6, "cacheReadInputTokenCost": 2e-6},
	})
	if err != nil {
		t.Fatal(err)
	}
	pricing = mustFindAt(t, direct, "deepseek-v4-flash", millisOf(t, "2026-08-17T02:00:00Z"))
	approxRate(t, "override input", pricing.Input, 7e-6)
	approxRate(t, "override cache read", pricing.CacheRead, 2e-6)
	approxRate(t, "scheduled output survives", pricing.Output, 1.32e-6)
	if !pricing.CacheReadExplicit {
		t.Fatal("an explicit override must mark the cache-read rate explicit")
	}
}

// TestLongContextThresholdComesFromModelsDevOnlyAndDefaultsTo200k pins
// long_context_split_threshold (pricing.rs:2753-2775): the boundary comes from
// the models.dev snapshot's own tiers, not the merged corpus, and defaults to
// 200K when the id has no published threshold.
func TestLongContextThresholdComesFromModelsDevOnlyAndDefaultsTo200k(t *testing.T) {
	corpus, err := LoadEmbeddedCorpus()
	if err != nil {
		t.Fatal(err)
	}
	if got := corpus.LongContextSplitThreshold("a-model-with-no-tiers"); got != 200_000 {
		t.Fatalf("default threshold = %d, want 200000", got)
	}
	// grok-4.3 publishes a 200K tier in the models.dev snapshot and takes over
	// an existing primary row in the merged table; both paths agree here, so
	// the stronger check is the primary-only case below.
	if got := corpus.LongContextSplitThreshold("grok-4.3"); got != 200_000 {
		t.Fatalf("grok-4.3 threshold = %d, want 200000", got)
	}
	for name, threshold := range corpus.DevThresholds {
		base := modelWithoutDateSuffix(name)
		if alias, ok := pricingAlias(base); ok {
			base = alias
		}
		want, published := corpus.DevThresholds[base]
		if !published {
			want, published = corpus.DevThresholds[modelWithoutDateSuffix(name)]
		}
		if !published {
			want = 200_000
		}
		if got := corpus.LongContextSplitThreshold(name); got != want {
			t.Fatalf("LongContextSplitThreshold(%q) = %d, want %d", name, got, want)
		}
		_ = threshold
	}
	// A key whose boundary differs from the 200K default proves the answer
	// comes from the models.dev table rather than a constant.
	for _, name := range []string{"openai/gpt-5.5", "qwen3.6-plus"} {
		if got := corpus.LongContextSplitThreshold(name); got != corpus.DevThresholds[name] {
			t.Fatalf("LongContextSplitThreshold(%q) = %d, want its dev threshold %d", name, got, corpus.DevThresholds[name])
		}
	}
	if len(corpus.DevThresholds) == 0 {
		t.Fatal("DevThresholds is empty: the models.dev snapshot was not retained")
	}
}

// TestThresholdStripsDateSuffixAndResolvesAlias pins the two lookup steps
// (pricing.rs:2753-2766, 2793-2801): a date-pinned id falls back to its base
// and a pricing alias resolves before the base is tried.
func TestThresholdStripsDateSuffixAndResolvesAlias(t *testing.T) {
	corpus, err := LoadEmbeddedCorpus()
	if err != nil {
		t.Fatal(err)
	}
	for name, threshold := range corpus.DevThresholds {
		if modelWithoutDateSuffix(name) != name {
			// The id already carries a release date; appending another would
			// strip down to a different (possibly unpublished) base.
			continue
		}
		pinned := name + "-2026-04-23"
		if got := corpus.LongContextSplitThreshold(pinned); got != threshold {
			t.Fatalf("date-pinned %q = %d, want %d", pinned, got, threshold)
		}
		compact := name + "-20260423"
		if got := corpus.LongContextSplitThreshold(compact); got != threshold {
			t.Fatalf("compact-pinned %q = %d, want %d", compact, got, threshold)
		}
	}
	if alias, ok := pricingAlias("gpt-5.6"); ok {
		if got, want := corpus.LongContextSplitThreshold("gpt-5.6"), corpus.LongContextSplitThreshold(alias); got != want {
			t.Fatalf("alias gpt-5.6 = %d, want %s's %d", got, alias, want)
		}
	}
}

// TestCostUsesFindAtWhenTimeIsProvided pins cost.go:141-160: the `at` argument
// is no longer reserved, and a scheduled model priced at two different hours
// produces two different costs while an unscheduled model does not change.
func TestCostUsesFindAtWhenTimeIsProvided(t *testing.T) {
	corpus, err := LoadEmbeddedCorpus()
	if err != nil {
		t.Fatal(err)
	}
	usage := Usage{Input: 1_000_000, Output: 1_000_000}
	peakTime := time.UnixMilli(millisOf(t, "2026-08-17T02:00:00Z"))
	offTime := time.UnixMilli(millisOf(t, "2026-08-17T05:00:00Z"))
	peak, missing := Cost(corpus, "deepseek-v4-flash", usage, peakTime, ModeCalculate, false, false)
	if missing {
		t.Fatal("Cost(deepseek-v4-flash) reported missing pricing")
	}
	off, _ := Cost(corpus, "deepseek-v4-flash", usage, offTime, ModeCalculate, false, false)
	if peak <= off {
		t.Fatalf("peak cost %v <= off-peak cost %v, want the peak schedule", peak, off)
	}
	// A zero time keeps the static Find path, so existing callers are unchanged.
	zero, _ := Cost(corpus, "gpt-5.4", usage, time.Time{}, ModeCalculate, false, false)
	static, _ := Cost(corpus, "gpt-5.4", usage, peakTime, ModeCalculate, false, false)
	if zero != static {
		t.Fatalf("a nonzero time changed static pricing: %v vs %v", zero, static)
	}
}
