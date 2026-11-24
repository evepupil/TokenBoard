package codex

// ccusage's Codex speed detection, pinned against v20.0.33 (commit 1308c416):
// rust/adapters/codex/src/speed.rs. TOML is a real grammar here, so the tests
// cover what a substring scan would get wrong.

import (
	"os"
	"path/filepath"
	"testing"
)

func writeConfig(t *testing.T, home, content string) string {
	t.Helper()
	if err := os.MkdirAll(home, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, "config.toml"), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	return home
}

// TestSpeedDetectsProfileThenTopLevelAndFastWinsAcrossHomes pins
// detect_codex_service_tier and codex_config_service_tier (speed.rs:38-74): the
// selected profile's tier beats the top-level one, an unparsable config says
// nothing, and Fast beats Flex beats Standard across homes.
func TestSpeedDetectsProfileThenTopLevelAndFastWinsAcrossHomes(t *testing.T) {
	profileHome := writeConfig(t, t.TempDir(), "profile = \"work\"\nservice_tier = \"standard\"\n[profiles.work]\nservice_tier = \"fast\"\n")
	topLevelHome := writeConfig(t, t.TempDir(), "service_tier = 'flex' # comment\n")
	brokenHome := writeConfig(t, t.TempDir(), "this is not = = toml\n")
	missingHome := filepath.Join(t.TempDir(), "absent")

	if got := detectServiceTier([]string{profileHome}); got != TierFast {
		t.Fatalf("profile home tier = %v, want the profile's fast", got)
	}
	if got := detectServiceTier([]string{topLevelHome}); got != TierFlex {
		t.Fatalf("top-level home tier = %v, want flex", got)
	}
	if got := detectServiceTier([]string{brokenHome, missingHome}); got != TierStandard {
		t.Fatalf("broken or missing configs = %v, want the standard default", got)
	}
	if got := detectServiceTier([]string{topLevelHome, profileHome}); got != TierFast {
		t.Fatalf("two homes = %v, want fast to win", got)
	}
}

// TestSpeedIgnoresMultilineStringAssignments pins that the value has to be the
// real key: a `service_tier = "fast"` inside a multiline string is text, not a
// setting.
func TestSpeedIgnoresMultilineStringAssignments(t *testing.T) {
	home := writeConfig(t, t.TempDir(), "notes = \"\"\"\nservice_tier = \"fast\"\n\"\"\"\n")
	if got := detectServiceTier([]string{home}); got != TierStandard {
		t.Fatalf("multiline string tier = %v, want standard", got)
	}
}

// TestResolveSpeedPolicyForcedValuesIgnoreTheConfig pins resolve_codex_speed
// (speed.rs:17-36): an explicit --speed never reads config.toml.
func TestResolveSpeedPolicyForcedValuesIgnoreTheConfig(t *testing.T) {
	home := writeConfig(t, t.TempDir(), "service_tier = \"fast\"\n")
	for requested, want := range map[RequestedSpeed]Tier{
		SpeedStandard: TierStandard,
		SpeedFast:     TierFast,
		SpeedFlex:     TierFlex,
	} {
		policy := ResolveSpeedPolicy(requested, []string{home})
		if !policy.Forced || policy.Tier != want {
			t.Fatalf("requested %v = %+v, want forced %v", requested, policy, want)
		}
	}
	policy := ResolveSpeedPolicy(SpeedAuto, []string{home})
	if policy.Forced || policy.Tier != TierFast {
		t.Fatalf("auto = %+v, want the detected fast tier", policy)
	}
}
