package pricing

import (
	"strings"
	"testing"
)

// preparedWithConfig builds the part of PreparedConfig usable in-package: the
// config ccusage would be pointed at.
func preparedWithConfig(config map[string]any) PreparedConfig {
	return PreparedConfig{ccusageConfig: config}
}

func TestResolveScopeFollowsTheOptionMapOrder(t *testing.T) {
	override := func(rate float64) map[string]any {
		return map[string]any{"inputCostPerToken": rate}
	}
	config := map[string]any{
		"defaults": map[string]any{
			"mode":              "auto",
			"pricingOverrides":  map[string]any{"model-x": override(1), "model-root": override(2)},
			"someOtherDefaults": true,
		},
		"commands": map[string]any{
			"claude daily": map[string]any{"pricingOverrides": map[string]any{"model-x": override(3)}},
			"daily":        map[string]any{"pricingOverrides": map[string]any{"model-x": override(4)}},
			"claude:daily": map[string]any{"mode": "calculate"},
		},
		"claude": map[string]any{
			"defaults": map[string]any{
				"mode":             "display",
				"pricingOverrides": map[string]any{"model-x": override(5)},
			},
			"commands": map[string]any{
				"daily": map[string]any{"pricingOverrides": map[string]any{
					// Only the output rate: the input rate from earlier layers
					// must survive, because scoped layers merge field by field.
					"model-x": map[string]any{"outputCostPerToken": 6},
				}},
			},
		},
	}

	resolved := preparedWithConfig(config).ResolveScope(Scope{Agent: "claude", Report: "daily"})

	if resolved.Mode != "display" {
		t.Fatalf("mode = %q, want display (claude.defaults is the last layer that sets it)", resolved.Mode)
	}
	x, ok := resolved.Overrides["model-x"].(map[string]any)
	if !ok {
		t.Fatalf("model-x missing from %+v", resolved.Overrides)
	}
	if x["inputCostPerToken"] != 5.0 {
		t.Errorf("model-x inputCostPerToken = %v, want 5 (claude.defaults wins)", x["inputCostPerToken"])
	}
	if x["outputCostPerToken"] != 6 {
		t.Errorf("model-x outputCostPerToken = %v, want 6 (claude.commands.daily wins)", x["outputCostPerToken"])
	}
	if root, ok := resolved.Overrides["model-root"].(map[string]any); !ok || root["inputCostPerToken"] != 2.0 {
		t.Errorf("model-root = %+v, want the root defaults entry", resolved.Overrides["model-root"])
	}
}

func TestResolveScopeIgnoresDisabledAndMalformedLayersLikeCcusage(t *testing.T) {
	cases := []struct {
		name   string
		config map[string]any
		mode   string
	}{
		{
			name: "an unknown mode is ignored",
			config: map[string]any{"defaults": map[string]any{
				"mode":             "nonsense",
				"pricingOverrides": map[string]any{"m": map[string]any{"inputCostPerToken": 1.0}},
			}},
			mode: "auto",
		},
		{
			name: "a non-object pricingOverrides is ignored",
			config: map[string]any{"defaults": map[string]any{
				"pricingOverrides": "not an object",
				"mode":             "calculate",
			}},
			mode: "calculate",
		},
		{
			name: "a non-object commands section is ignored",
			config: map[string]any{
				"commands": "junk",
				"defaults": map[string]any{"mode": "display"},
			},
			mode: "display",
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			resolved := preparedWithConfig(testCase.config).ResolveScope(Scope{Agent: "claude", Report: "daily"})
			if resolved.Mode != testCase.mode {
				t.Fatalf("mode = %q, want %q", resolved.Mode, testCase.mode)
			}
		})
	}

	// An invalid entry discards the whole layer (serde's all-or-nothing parse),
	// so the earlier layer's rate stays in force.
	config := map[string]any{
		"defaults": map[string]any{"pricingOverrides": map[string]any{
			"m": map[string]any{"inputCostPerToken": 1.0},
		}},
		"claude": map[string]any{"defaults": map[string]any{"pricingOverrides": map[string]any{
			"m": map[string]any{"inputCostPerToken": "free"},
		}}},
	}
	resolved := preparedWithConfig(config).ResolveScope(Scope{Agent: "claude", Report: "daily"})
	entry, _ := resolved.Overrides["m"].(map[string]any)
	if entry["inputCostPerToken"] != 1.0 {
		t.Fatalf("rate = %v, want the root layer's 1.0 (the malformed layer must be dropped whole)",
			entry["inputCostPerToken"])
	}
}

func TestResolveScopeDropsUnknownOverrideMembers(t *testing.T) {
	config := map[string]any{"defaults": map[string]any{
		"pricingOverrides": map[string]any{
			"m": map[string]any{
				"inputCostPerToken":           1.0,
				"input_cost_per_token":        99.0,
				"somethingElseTheSchemaLacks": 7.0,
			},
		},
	}}
	resolved := preparedWithConfig(config).ResolveScope(Scope{Agent: "claude", Report: "daily"})
	entry, _ := resolved.Overrides["m"].(map[string]any)
	if len(entry) != 1 || entry["inputCostPerToken"] != 1.0 {
		t.Fatalf("entry = %+v, want only the camelCase known member", entry)
	}
}

func TestResolveScopeWithNoConfigIsTheDefaults(t *testing.T) {
	resolved := preparedWithConfig(nil).ResolveScope(Scope{Agent: "claude", Report: "daily"})
	if resolved.Mode != "auto" || len(resolved.Overrides) != 0 {
		t.Fatalf("resolved = %+v, want auto with no overrides", resolved)
	}
	if resolved.Speed != "auto" {
		t.Fatalf("speed = %q, want auto with no config", resolved.Speed)
	}
}

// TestResolveScopeResolvesTheCodexSpeed pins the `speed` option to
// apply_config_to_agent_args (config.rs:507-516): every option map is read,
// later layers win, and an unparseable value is ignored rather than failing the
// run (CodexOptions::from_map uses serde's .ok()). The native Codex pricer must
// bill at the configured tier or a user's `speed` setting forks costUSD
// against ccusage.
func TestResolveScopeResolvesTheCodexSpeed(t *testing.T) {
	config := map[string]any{
		"defaults": map[string]any{"speed": "fast"},
		"commands": map[string]any{
			"codex daily": map[string]any{"speed": "flex"},
		},
		"codex": map[string]any{
			"defaults": map[string]any{"speed": "standard"},
			"commands": map[string]any{
				"daily": map[string]any{"speed": "auto"},
			},
		},
	}
	resolved := preparedWithConfig(config).ResolveScope(Scope{Agent: "codex", Report: "daily"})
	if resolved.Speed != "auto" {
		t.Fatalf("speed = %q, want auto (codex.commands.daily is the last layer)", resolved.Speed)
	}

	cases := []struct {
		name   string
		config map[string]any
		speed  string
	}{
		{
			name: "an unknown speed is ignored",
			config: map[string]any{
				"defaults": map[string]any{"speed": "fast"},
				"codex":    map[string]any{"defaults": map[string]any{"speed": "turbo"}},
			},
			speed: "fast",
		},
		{
			name: "a non-string speed is ignored",
			config: map[string]any{
				"defaults": map[string]any{"speed": "flex"},
				"codex":    map[string]any{"defaults": map[string]any{"speed": 1.5}},
			},
			speed: "flex",
		},
		{
			name:   "the agent defaults layer applies",
			config: map[string]any{"codex": map[string]any{"defaults": map[string]any{"speed": "fast"}}},
			speed:  "fast",
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			resolved := preparedWithConfig(testCase.config).ResolveScope(Scope{Agent: "codex", Report: "daily"})
			if resolved.Speed != testCase.speed {
				t.Fatalf("speed = %q, want %q", resolved.Speed, testCase.speed)
			}
		})
	}
}

func TestMergeCcusageConfigRejectsMalformedSections(t *testing.T) {
	bundled := map[string]any{"defaults": map[string]any{"pricingOverrides": map[string]any{}}}
	cases := []struct {
		name     string
		explicit map[string]any
		want     string
	}{
		{name: "non-object defaults", explicit: map[string]any{"defaults": "junk"}, want: "explicit defaults must be an object"},
		{name: "non-object codex", explicit: map[string]any{"codex": []any{1.0}}, want: "explicit codex must be an object"},
		{name: "non-object codex defaults", explicit: map[string]any{"codex": map[string]any{"defaults": 5.0}}, want: "explicit codex defaults must be an object"},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			_, err := mergeCcusageConfig(bundled, map[string]any{}, testCase.explicit, nil)
			if err == nil || !strings.Contains(err.Error(), testCase.want) {
				t.Fatalf("err = %v, want one containing %q", err, testCase.want)
			}
		})
	}

	// A null section means "absent", exactly as serde's Option sees it and as
	// the TypeScript `?? {}` fallback treats it.
	if _, err := mergeCcusageConfig(bundled, map[string]any{}, map[string]any{"defaults": nil, "codex": nil}, nil); err != nil {
		t.Fatalf("null sections = %v, want no error", err)
	}
}
