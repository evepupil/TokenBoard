package codex

// ccusage's Codex speed detection, ported from v20.0.33 (commit 1308c416):
// rust/adapters/codex/src/speed.rs. The requested `--speed` is a CLI value;
// Auto means "read the user's Codex config and use the tier it names", which is
// the only reason this adapter touches config.toml at all.

import (
	"os"
	"path/filepath"

	toml "github.com/pelletier/go-toml/v2"
)

// RequestedSpeed is ccusage's CodexSpeed CLI value (cli).
type RequestedSpeed int

const (
	// SpeedAuto detects the tier from the Codex config.
	SpeedAuto RequestedSpeed = iota
	// SpeedStandard forces the standard tier.
	SpeedStandard
	// SpeedFast forces the fast tier.
	SpeedFast
	// SpeedFlex forces the flex tier.
	SpeedFlex
)

// ResolveSpeedPolicy is resolve_codex_speed (speed.rs:29-36).
func ResolveSpeedPolicy(requested RequestedSpeed, homes []string) SpeedPolicy {
	switch requested {
	case SpeedStandard:
		return SpeedPolicy{Forced: true, Tier: TierStandard}
	case SpeedFast:
		return SpeedPolicy{Forced: true, Tier: TierFast}
	case SpeedFlex:
		return SpeedPolicy{Forced: true, Tier: TierFlex}
	}
	return SpeedPolicy{Tier: detectServiceTier(homes)}
}

// detectServiceTier is detect_codex_service_tier (speed.rs:38-57): read every
// home's config.toml, keep the readable ones, and let Fast beat Flex beat
// Standard.
func detectServiceTier(homes []string) Tier {
	configured := []Tier{}
	for _, home := range homes {
		content, err := os.ReadFile(filepath.Join(home, "config.toml"))
		if err != nil {
			continue
		}
		if tier, ok := configServiceTier(string(content)); ok {
			configured = append(configured, tier)
		}
	}
	for _, tier := range []Tier{TierFast, TierFlex} {
		for _, candidate := range configured {
			if candidate == tier {
				return tier
			}
		}
	}
	return TierStandard
}

// configServiceTier is codex_config_service_tier (speed.rs:59-74): the tier of
// the profile named by the top-level `profile` key, otherwise the top-level
// `service_tier`. A config that is not valid TOML says nothing.
func configServiceTier(content string) (Tier, bool) {
	var config map[string]any
	if err := toml.Unmarshal([]byte(content), &config); err != nil || config == nil {
		return 0, false
	}
	var recorded any
	if profile, ok := config["profile"].(string); ok {
		if profiles, ok := config["profiles"].(map[string]any); ok {
			if selected, ok := profiles[profile].(map[string]any); ok {
				recorded = selected["service_tier"]
			}
		}
	}
	if recorded == nil {
		recorded = config["service_tier"]
	}
	text, ok := recorded.(string)
	if !ok {
		return 0, false
	}
	switch text {
	case "default", "standard":
		return TierStandard, true
	case "fast", "priority":
		return TierFast, true
	case "flex":
		return TierFlex, true
	}
	return 0, false
}
