// Scenario windows for bench-collect: which dates each scenario measures, and
// where the hook scenario's cursor watermark comes from.
package main

import (
	"fmt"
	"path/filepath"
	"strings"
	"time"

	"github.com/MisonL/TokenBoard/clients/go/internal/collect/sessioncursor"
	"github.com/MisonL/TokenBoard/clients/go/internal/contract"
)

// scenario is one of the four measurement windows.
type scenario string

const (
	// scenarioSingle is one settled day: the "empty run" cost, where process
	// start-up and the JSON round trip dominate.
	scenarioSingle scenario = "single"
	// scenario30d is the typical scheduled-sync window.
	scenario30d scenario = "30d"
	// scenarioFull is the whole history: throughput and peak memory.
	scenarioFull scenario = "full"
	// scenarioHook is the incremental window a warm hook cursor narrows to.
	scenarioHook scenario = "hook"
)

func parseScenario(value string) (scenario, error) {
	switch parsed := scenario(strings.TrimSpace(value)); parsed {
	case scenarioSingle, scenario30d, scenarioFull, scenarioHook:
		return parsed, nil
	}
	return "", fmt.Errorf("%w: unknown scenario %q (want single, 30d, full or hook)", errUsage, value)
}

// collectWindow is the date filter one round applies, in the compact YYYYMMDD
// form the providers hand to ccusage. Both fields empty means every date.
type collectWindow struct {
	Since string `json:"since,omitempty"`
	Until string `json:"until,omitempty"`
}

// rangeArgs renders the window as ccusage flags. An empty window yields nil, not
// an empty slice: the full scenario must add nothing at all.
func (w collectWindow) rangeArgs() []string {
	if w.Since == "" && w.Until == "" {
		return nil
	}
	args := []string{}
	if w.Since != "" {
		args = append(args, "--since", w.Since)
	}
	if w.Until != "" {
		args = append(args, "--until", w.Until)
	}
	return args
}

func (w collectWindow) String() string {
	switch {
	case w.Since == "" && w.Until == "":
		return "all"
	case w.Since == w.Until:
		return w.Since
	}
	return w.Since + ".." + w.Until
}

// scenarioWindow resolves a scenario's date filter.
//
// settledDay, not today: a window that includes today races the source being
// appended to while the rounds run (the live-write problem tokenboard shadow
// documents), and the window only filters ccusage's output, so the settled date
// measures the same scan without the noise.
func scenarioWindow(
	scn scenario,
	now time.Time,
	location *time.Location,
	hook func() (string, error),
) (collectWindow, error) {
	switch scn {
	case scenarioSingle:
		day := settledDay(now, location)
		return collectWindow{Since: compactDate(day), Until: compactDate(day)}, nil
	case scenario30d:
		until := settledDay(now, location)
		since := until.AddDate(0, 0, -29)
		return collectWindow{Since: compactDate(since), Until: compactDate(until)}, nil
	case scenarioFull:
		return collectWindow{}, nil
	case scenarioHook:
		if hook == nil {
			return collectWindow{}, fmt.Errorf("%w: the hook scenario needs a cursor watermark", errUsage)
		}
		watermark, err := hook()
		if err != nil {
			return collectWindow{}, err
		}
		watermark = strings.TrimSpace(watermark)
		if watermark == "" {
			// A cold cursor reconciles every date, which is the unfiltered window.
			return collectWindow{}, nil
		}
		// Normalize before validating: the cursor stores YYYY-MM-DD and ccusage
		// takes YYYYMMDD. The length check has to come first — slicing a short
		// value would panic instead of reporting a corrupt cursor.
		compact := strings.ReplaceAll(watermark, "-", "")
		if len(compact) != 8 || !contract.IsValidIsoDate(
			compact[:4]+"-"+compact[4:6]+"-"+compact[6:8]) {
			return collectWindow{}, fmt.Errorf("%w: hook cursor watermark %q is not a date", errUsage, watermark)
		}
		today := compactDate(now.In(location))
		// A watermark ahead of the clock (skew, or a date recorded in another
		// zone) must not render a reversed range: ccusage rejects since > until.
		if compact > today {
			compact = today
		}
		return collectWindow{Since: compact, Until: today}, nil
	}
	return collectWindow{}, fmt.Errorf("%w: unknown scenario %q", errUsage, scn)
}

// readHookWatermark returns the newest usage date already recorded in the
// source's hook cursor, or "" when there is no cursor on this machine.
//
// It only reads: the cursor belongs to the running collector, and a benchmark
// that committed to it would change what the next hook reconciles. Scoped
// cursors (a codex profile, a per-server file) are all considered — the newest
// date across them is the boundary the next hook starts from.
func readHookWatermark(source contract.Source, stateDir string) (string, error) {
	pattern, ok := hookCursorPattern(source)
	if !ok {
		return "", fmt.Errorf("%w: %s installs no hook cursor", errUsage, source)
	}
	paths, err := filepath.Glob(filepath.Join(stateDir, pattern))
	if err != nil {
		return "", err
	}
	newest := ""
	for _, path := range paths {
		cursor, err := sessioncursor.Read(path, string(source))
		if err != nil {
			return "", fmt.Errorf("read hook cursor %s: %w", path, err)
		}
		for _, entry := range cursor.Files {
			for _, snapshot := range entry.Snapshots {
				if snapshot.UsageDate > newest {
					newest = snapshot.UsageDate
				}
			}
		}
	}
	return newest, nil
}

// hookCursorPattern matches the cursor files a source's hook writes: the
// unscoped name and any scoped variant (codex profiles, per-server files).
func hookCursorPattern(source contract.Source) (string, bool) {
	if !hasHookCursor(source) {
		return "", false
	}
	base := strings.TrimSuffix(sessioncursor.FileName(source, ""), ".json")
	return base + "*.json", true
}

// hasHookCursor reports whether the source runs through the hook path at all.
// The twelve tool sources and the locally-read sources install no hook.
func hasHookCursor(source contract.Source) bool {
	switch source {
	case contract.SourceClaudeCode, contract.SourceCodex:
		return true
	}
	return false
}

// settledDay is yesterday in the configured zone: the most recent day whose
// session files have stopped growing.
func settledDay(now time.Time, location *time.Location) time.Time {
	return now.In(location).AddDate(0, 0, -1)
}

func compactDate(day time.Time) string {
	return day.Format("20060102")
}

// isoDate renders a compact window value back into the YYYY-MM-DD form the
// providers' Options take. An empty value stays empty.
func isoDate(compact string) string {
	if len(compact) != 8 {
		return compact
	}
	return compact[:4] + "-" + compact[4:6] + "-" + compact[6:]
}
