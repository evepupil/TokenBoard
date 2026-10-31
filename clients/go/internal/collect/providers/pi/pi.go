// Package pi ports providers/pi.ts: collecting Pi coding-agent usage from its
// session JSONL logs.
//
// Pi records normalized token counts and a cost breakdown per model call, so
// both are read straight from the log rather than derived from a pricing
// table.
package pi

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/MisonL/TokenBoard/clients/go/internal/collect/sessionscan"
	"github.com/MisonL/TokenBoard/clients/go/internal/collect/sessionusage"
	"github.com/MisonL/TokenBoard/clients/go/internal/contract"
)

const (
	source = contract.SourcePi
	label  = "Pi"
)

// Options configures one collection. Zero values fall back to the environment
// and the clock.
type Options struct {
	Timezone    string
	CollectedAt string
	Since       string
	AgentDir    string
	Stderr      func(line string)
	// Env resolves PI_CODING_AGENT_DIR, PI_CODING_AGENT_SESSION_DIR and
	// TOKENBOARD_PI_AGENT_DIR; nil means the process environment.
	Env func(string) string
}

// Collect gathers Pi usage.
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
	aggregate, err := sessionusage.NewAggregate(source, timezone, collectedAt, true)
	if err != nil {
		return nil, err
	}

	root := sessionsRoot(options)
	// Forked Pi sessions copy shared history into separate files. Keep one
	// identity set for the whole scan so an entry is counted once even when it
	// appears in more than one fork.
	seenEntryIDs := map[string]bool{}
	scannedFiles := 0
	err = sessionscan.Scan(root, sessionscan.Options{
		Matches: func(name string) bool { return strings.HasSuffix(name, ".jsonl") },
		OnSkipped: func(path, reason string) {
			if options.Stderr != nil {
				options.Stderr("Skipping " + label + " session path (" + reason + "): " + path)
			}
		},
	}, func(file sessionscan.ScannedSessionFile) error {
		scannedFiles++
		return readUsageEvents(file.Path, seenEntryIDs, func(event sessionusage.Event) {
			if sinceDate != "" && sessionusage.FormatDate(event.OccurredAt, timezone) < sinceDate {
				return
			}
			aggregate.Add(event)
		})
	})
	if err != nil {
		return nil, err
	}

	// Signals "nothing to collect here" so an all-source run skips this source
	// instead of reporting it as collected with zero usage.
	if scannedFiles == 0 {
		return nil, errors.New("No " + label + " sessions found: " + root)
	}
	return aggregate.Snapshots()
}

// readUsageEvents yields one usage event per usage-carrying entry.
//
// Usage rides on assistant messages, on tool results that did nested model
// work, and on the compaction and branch-summary entries Pi writes when it
// condenses or forks history. All four are real model calls and all four count.
//
// A session file is a tree keyed by id/parentId, and a fork copies shared
// history into the new file, so an entry id is only counted once per scan.
func readUsageEvents(filePath string, seenEntryIDs map[string]bool, yield func(sessionusage.Event)) error {
	sessionID := strings.TrimSuffix(filepath.Base(filePath), ".jsonl")
	var sessionTimestamp *time.Time

	return sessionscan.ReadLines(filePath, func(line string) error {
		entry := sessionusage.ParseJSONLine(line)
		if entry == nil {
			return nil
		}

		entryType := entry["type"]
		if entryType == "session" {
			// The session's own timestamp is the fallback for entries that
			// carry none. A first session row with an unparsable timestamp
			// leaves the slot open for a later one, matching the TS ??=.
			if sessionTimestamp == nil {
				if parsed, ok := sessionusage.ReadEventTimestamp(entry["timestamp"]); ok {
					sessionTimestamp = &parsed
				}
			}
			return nil
		}

		carrier, ok := readUsageCarrier(entry, entryType)
		if !ok {
			return nil
		}

		// The id is consumed before the timestamp is resolved: an entry that is
		// later dropped for having no usable time still marks its id seen, so a
		// fork repeating it is not counted on the second pass either.
		entryID, _ := entry["id"].(string)
		if entryID != "" {
			if seenEntryIDs[entryID] {
				return nil
			}
			seenEntryIDs[entryID] = true
		}

		occurredAt, ok := readEntryTimestamp(entry, carrier, sessionTimestamp)
		if !ok {
			return nil
		}

		usage := carrier.usage
		yield(sessionusage.Event{
			OccurredAt:      occurredAt,
			Model:           readModel(carrier.message),
			InputTokens:     sessionusage.ReadTokenCount(usage["input"]),
			OutputTokens:    sessionusage.ReadTokenCount(usage["output"]),
			CacheReadTokens: sessionusage.ReadTokenCount(usage["cacheRead"]),
			// Pi splits cache writes by TTL: cacheWrite is the default tier and
			// cacheWrite1h the extended one. Both are cache creation, so
			// dropping the second would silently under-report usage on
			// providers that offer it.
			CacheCreationTokens: sessionusage.ReadTokenCount(usage["cacheWrite"]) +
				sessionusage.ReadTokenCount(usage["cacheWrite1h"]),
			CostUSD:   readCostUSD(usage["cost"]),
			SessionID: sessionID,
		})
		return nil
	})
}

// carrier is one entry's usage plus the message that named the model, if any.
type carrier struct {
	usage   map[string]any
	message map[string]any
}

func readUsageCarrier(entry map[string]any, entryType any) (carrier, bool) {
	if entryType == "message" {
		message := sessionusage.ReadRecordAt(entry["message"])
		if message == nil {
			return carrier{}, false
		}
		role, _ := message["role"].(string)
		if role != "assistant" && role != "toolResult" {
			return carrier{}, false
		}
		usage := sessionusage.ReadRecordAt(message["usage"])
		if usage == nil {
			return carrier{}, false
		}
		return carrier{usage: usage, message: message}, true
	}
	if entryType == "compaction" || entryType == "branch_summary" {
		usage := sessionusage.ReadRecordAt(entry["usage"])
		if usage == nil {
			return carrier{}, false
		}
		return carrier{usage: usage}, true
	}
	return carrier{}, false
}

// readEntryTimestamp prefers the entry's own timestamp, then the one on its
// message, then the session's.
func readEntryTimestamp(entry map[string]any, c carrier, sessionTimestamp *time.Time) (time.Time, bool) {
	if parsed, ok := sessionusage.ReadEventTimestamp(entry["timestamp"]); ok {
		return parsed, true
	}
	if c.message != nil {
		if parsed, ok := sessionusage.ReadEventTimestamp(c.message["timestamp"]); ok {
			return parsed, true
		}
	}
	if sessionTimestamp != nil {
		return *sessionTimestamp, true
	}
	return time.Time{}, false
}

// readCostUSD reads Pi's per-call cost. The reported total is preferred,
// falling back to the sum of the buckets when only those are present.
func readCostUSD(value any) float64 {
	cost := sessionusage.ReadRecordAt(value)
	if cost == nil {
		return 0
	}
	if total, ok := sessionusage.ReadFiniteNumber(cost["total"]); ok && total > 0 {
		return total
	}
	sum := 0.0
	for _, key := range []string{"input", "output", "cacheRead", "cacheWrite", "cacheWrite1h"} {
		if amount, ok := sessionusage.ReadFiniteNumber(cost[key]); ok && amount > 0 {
			sum += amount
		}
	}
	return sum
}

// readModel prefers the model that actually answered over the one that was
// requested: a gateway may serve a different model than the session asked for.
func readModel(message map[string]any) string {
	if message == nil {
		return sessionusage.UnknownModel
	}
	for _, key := range []string{"responseModel", "model", "modelId"} {
		if value, ok := message[key].(string); ok && strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return sessionusage.UnknownModel
}

func sessionsRoot(options Options) string {
	explicitSessionDir := lookupEnv(options.Env, "PI_CODING_AGENT_SESSION_DIR")
	if options.AgentDir == "" && explicitSessionDir != "" {
		return explicitSessionDir
	}
	// TS chains these with `??`: a variable that is set wins even when empty,
	// and an empty home resolves to a relative path. Only an unset variable
	// falls through to the default.
	home := defaultAgentDir()
	for _, key := range []string{"PI_CODING_AGENT_DIR", "TOKENBOARD_PI_AGENT_DIR"} {
		if value, ok := lookupSet(options.Env, key); ok {
			home = value
		}
	}
	if options.AgentDir != "" {
		home = options.AgentDir
	}
	return filepath.Join(home, "sessions")
}

// lookupSet reports whether a variable is set, which is what `??` depends on.
// The injected form cannot tell unset from empty.
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

func defaultAgentDir() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".pi", "agent")
}
