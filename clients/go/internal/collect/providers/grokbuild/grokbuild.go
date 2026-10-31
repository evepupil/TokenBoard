// Package grokbuild ports providers/grok-build.ts: collecting Grok Build
// (Grok CLI) usage from its session update logs.
//
// Grok reports no cost of its own, so costUsd stays 0 and every reporting
// surface labels the cost as unavailable rather than showing a derived
// figure as real.
package grokbuild

import (
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/MisonL/TokenBoard/clients/go/internal/collect/sessionscan"
	"github.com/MisonL/TokenBoard/clients/go/internal/collect/sessionusage"
	"github.com/MisonL/TokenBoard/clients/go/internal/contract"
)

const (
	source        = contract.SourceGrokBuild
	label         = "Grok Build"
	usageFileName = "updates.jsonl"
	usageMethod   = "_x.ai/session/update"
	turnCompleted = "turn_completed"
)

// Options configures one collection. Zero values fall back to the
// environment and the clock.
type Options struct {
	Timezone    string
	CollectedAt string
	Since       string
	GrokHome    string
	Stderr      func(line string)
	// Env resolves TOKENBOARD_GROK_HOME/GROK_HOME; nil means the process
	// environment.
	Env func(string) string
}

// Collect gathers Grok Build usage. It mirrors collectGrokBuildUsage: each
// completed turn is recorded at face value, cached reads are subtracted out
// of the reported input, and no cost is ever reported.
func Collect(options Options) ([]contract.Snapshot, error) {
	timezone := options.Timezone
	if timezone == "" {
		timezone = sessionusage.LocalTimezone()
	}
	collectedAt := options.CollectedAt
	if collectedAt == "" {
		collectedAt = time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
	}
	sinceDate, err := sessionusage.ReadSinceDate(options.Since, label)
	if err != nil {
		return nil, err
	}
	aggregate, err := sessionusage.NewAggregate(source, timezone, collectedAt, false)
	if err != nil {
		return nil, errors.New("Invalid timezone for session JSONL formatDate: " + timezone)
	}

	roots := sessionRoots(options.GrokHome, options.Env)
	scannedFiles := 0
	for _, root := range roots {
		err := sessionscan.Scan(root, sessionscan.Options{
			Matches: func(name string) bool { return name == usageFileName },
			OnSkipped: func(path, reason string) {
				if options.Stderr != nil {
					options.Stderr("Skipping " + label + " session path (" + reason + "): " + path)
				}
			},
		}, func(file sessionscan.ScannedSessionFile) error {
			scannedFiles++
			return readUsageEvents(file.Path, options.Stderr, func(event sessionusage.Event) {
				if sinceDate != "" && sessionusage.FormatDate(event.OccurredAt, timezone) < sinceDate {
					return
				}
				aggregate.Add(event)
			})
		})
		if err != nil {
			return nil, err
		}
	}

	// Signals "nothing to collect here" so an all-source run skips this
	// source instead of reporting it as collected with zero usage.
	if scannedFiles == 0 {
		return nil, errors.New("No " + label + " sessions found: " + strings.Join(roots, ", "))
	}
	return aggregate.Snapshots()
}

// readUsageEvents yields one usage event per completed turn.
//
// A turn_completed event carries that turn's own totals, already summed
// across the inference loops inside it, and the next turn starts from zero.
// They are therefore recorded at face value: differencing against the
// previous event would treat per-turn totals as a running counter and lose
// most usage. Only events whose sessionUpdate is exactly turn_completed
// carry usage: every usage-bearing event observed from real Grok logs across
// many sessions was turn_completed, and a mid-turn snapshot alongside the
// turn's final event would double-count it. An update with a different kind,
// a non-string kind, or no kind at all is skipped rather than guessed at.
func readUsageEvents(filePath string, stderr func(string), yield func(sessionusage.Event)) error {
	sessionID := filepath.Base(filepath.Dir(filePath))
	return sessionscan.ReadLines(filePath, func(line string) error {
		record := sessionusage.ParseJSONLine(line)
		if record == nil || record["method"] != usageMethod {
			return nil
		}

		update := sessionusage.ReadRecordAt(sessionusage.ReadRecordAt(record["params"])["update"])
		if update == nil {
			return nil
		}
		kind, kindOK := update["sessionUpdate"].(string)
		if !kindOK || kind != turnCompleted {
			return nil
		}

		usage := sessionusage.ReadRecordAt(update["usage"])
		if usage == nil {
			return nil
		}
		occurredAt, ok := sessionusage.ReadEventTimestamp(record["timestamp"])
		if !ok {
			return nil
		}

		perModel := sessionusage.ReadRecordAt(usage["modelUsage"])
		if len(perModel) > 0 {
			// Sorted so repeated scans aggregate in a deterministic order.
			models := make([]string, 0, len(perModel))
			for model := range perModel {
				models = append(models, model)
			}
			sort.Strings(models)
			yielded := false
			for _, model := range models {
				counters := sessionusage.ReadRecordAt(perModel[model])
				if counters == nil {
					// A corrupt entry is skipped rather than guessed at,
					// but never silently: the turn's top-level totals do
					// not stand in for it (a present breakdown is
					// authoritative), so the tokens it carried would
					// vanish with no trace. Report it instead.
					if stderr != nil {
						stderr("Skipping unreadable " + label + " modelUsage entry (" + model + ") in " + filePath)
					}
					continue
				}
				event := toUsageEvent(counters, occurredAt, sessionID, model)
				// A readable but token-less entry (all counters zero) must
				// not count as the turn's output: marking it yielded would
				// skip the top-level totals below and lose whatever they
				// held, the same way an empty breakdown did before.
				if !hasBillableTokens(event) {
					continue
				}
				yielded = true
				yield(event)
			}
			// A present-but-empty or entirely unreadable breakdown would
			// otherwise drop the turn on the floor; fall through to the
			// top-level totals.
			if yielded {
				return nil
			}
		}
		// Without a usable per-model breakdown the turn's top-level totals
		// still count; the model is unknown and is labeled as such rather
		// than guessed.
		yield(toUsageEvent(usage, occurredAt, sessionID, sessionusage.UnknownModel))
		return nil
	})
}

// hasBillableTokens mirrors the aggregate's own billable test, so an event
// this provider emits is exactly one the aggregate will keep.
func hasBillableTokens(event sessionusage.Event) bool {
	return event.InputTokens+event.OutputTokens+event.CacheCreationTokens+event.CacheReadTokens > 0
}

// toUsageEvent normalizes one turn's counters.
//
// Grok's inputTokens includes cachedReadTokens, unlike TokenBoard's snapshot
// where the two are disjoint and totalTokens is their sum. The cached share
// is therefore subtracted back out of input. reasoningTokens is already part
// of outputTokens and is not added again.
func toUsageEvent(counters map[string]any, occurredAt time.Time, sessionID, model string) sessionusage.Event {
	reportedInput := sessionusage.ReadTokenCount(counters["inputTokens"])
	cacheReadTokens := min(sessionusage.ReadTokenCount(counters["cachedReadTokens"]), reportedInput)
	return sessionusage.Event{
		OccurredAt:          occurredAt,
		Model:               model,
		InputTokens:         reportedInput - cacheReadTokens,
		OutputTokens:        sessionusage.ReadTokenCount(counters["outputTokens"]),
		CacheCreationTokens: 0,
		CacheReadTokens:     cacheReadTokens,
		CostUSD:             0,
		SessionID:           sessionID,
	}
}

func sessionRoots(grokHome string, env func(string) string) []string {
	home := grokHome
	if home == "" {
		// TS chains these with `??`: the first variable that is *set* wins
		// even when it is empty, and an empty home resolves to a relative
		// path. Only a genuinely unset variable falls through to the default.
		home = defaultHome()
		for _, key := range []string{"GROK_HOME", "TOKENBOARD_GROK_HOME"} {
			if value, ok := lookupSet(env, key); ok {
				home = value
			}
		}
	}
	return []string{filepath.Join(home, "sessions"), filepath.Join(home, "archived_sessions")}
}

// lookupSet reports a variable's value and whether it is set at all. The
// injected form cannot tell unset from empty, so it treats a non-empty value
// as set; a nil env reads the process environment, where the distinction
// exists and `??` depends on it.
func lookupSet(env func(string) string, key string) (string, bool) {
	if env == nil {
		return os.LookupEnv(key)
	}
	value := env(key)
	return value, value != ""
}

func lookupEnv(env func(string) string, key string) string {
	if env == nil {
		return os.Getenv(key)
	}
	return env(key)
}

// defaultHome is the TS fallback `join(homedir(), '.grok')`: the user's home
// is the parent of the tool's directory, not the directory itself.
func defaultHome() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".grok")
}
