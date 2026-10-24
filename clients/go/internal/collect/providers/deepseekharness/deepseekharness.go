// Package deepseekharness ports providers/deepseek-harness.ts: collecting
// DeepSeek Harness (DSH) usage from its session event logs.
//
// DSH reports token counts but no cost, so costUsd stays 0 and every
// reporting surface labels the cost as unavailable rather than showing a
// derived figure as real.
package deepseekharness

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/MisonL/TokenBoard/clients/go/internal/collect/sessionscan"
	"github.com/MisonL/TokenBoard/clients/go/internal/collect/sessionusage"
	"github.com/MisonL/TokenBoard/clients/go/internal/collect/zstdframes"
	"github.com/MisonL/TokenBoard/clients/go/internal/contract"
)

const (
	source                = contract.SourceDeepSeekHarness
	label                 = "DeepSeek Harness"
	assistantMessageEvent = "assistant/message"
	plainLogName          = "session.jsonl"
	compressedLogName     = "session.jsonl.zstd"
)

// Options configures one collection. Zero values fall back to the
// environment and the clock.
type Options struct {
	Timezone    string
	CollectedAt string
	Since       string
	DSHHome     string
	SessionRoot string
	Stderr      func(line string)
	// Env resolves TOKENBOARD_DSH_HOME/DSH_HOME/DSH_SESSION_ROOT; nil means
	// the process environment.
	Env func(string) string
}

// Collect gathers DSH usage. It mirrors collectDeepSeekHarnessUsage: an event
// is identified by its durable per-session sequence and counted once across
// both physical encodings of a session directory.
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

	root := sessionRoot(options)
	// Events are folded one session directory at a time, because a session
	// directory can hold both physical encodings at once while a DSH
	// compression change is unresolved. Files are grouped by directory rather
	// than folded in scan order: the scanner recurses into a subdirectory
	// mid-list when its name sorts between two sibling files, which would
	// split one directory's files across two folds and reset the dedup set
	// between them (double-counting a sequence). The map holds path strings
	// only — never event records or content.
	filesBySessionDir := map[string][]string{}
	scannedFiles := 0
	err = sessionscan.Scan(root, sessionscan.Options{
		Matches: func(name string) bool { return name == plainLogName || name == compressedLogName },
		OnSkipped: func(path, reason string) {
			if options.Stderr != nil {
				options.Stderr("Skipping " + label + " session path (" + reason + "): " + path)
			}
		},
	}, func(file sessionscan.ScannedSessionFile) error {
		sessionDir := filepath.Dir(file.Path)
		filesBySessionDir[sessionDir] = append(filesBySessionDir[sessionDir], file.Path)
		scannedFiles++
		return nil
	})
	if err != nil {
		return nil, err
	}

	for _, sessionFiles := range filesBySessionDir {
		// The two encodings are two views of the same logical event log, so
		// an event is identified by its durable per-session sequence and
		// counted once. The union is kept rather than one file being
		// preferred: a sequence present in only one file still counts, so
		// neither a stale view nor a newer one silently loses events. A
		// usage event without a usable sequence cannot be compared, so it is
		// counted rather than dropped — the readable-data rule outweighs the
		// possibility of counting it twice.
		seenSeqs := map[int64]bool{}
		for _, filePath := range sessionFiles {
			// A real read failure (corrupt frame, oversize log) fails the
			// source; only a torn trailing frame from a session still being
			// written is tolerated inside the frame reader.
			err := readUsageEvents(filePath, func(seq int64, hasSeq bool, event sessionusage.Event) {
				if hasSeq {
					if seenSeqs[seq] {
						return
					}
					seenSeqs[seq] = true
				}
				if sinceDate != "" && sessionusage.FormatDate(event.OccurredAt, timezone) < sinceDate {
					return
				}
				aggregate.Add(event)
			})
			if err != nil {
				return nil, err
			}
		}
	}

	// Signals "nothing to collect here" so an all-source run skips this
	// source instead of reporting it as collected with zero usage.
	if scannedFiles == 0 {
		return nil, errors.New("No " + label + " sessions found: " + root)
	}
	return aggregate.Snapshots()
}

// readUsageEvents yields one usage event per assistant message that reported
// token accounting.
//
// A DSH event log line is {type, seq, time, data} with time in epoch
// milliseconds and seq the durable per-session event sequence. Usage travels
// on assistant/message events, whose data also holds the assistant's reply
// and the provider's replay state; only the token counts, the model identity
// and the sequence number are read. hasSeq is false when the envelope does
// not carry a usable sequence, which the caller treats as "cannot be
// deduplicated".
func readUsageEvents(filePath string, yield func(seq int64, hasSeq bool, event sessionusage.Event)) error {
	sessionID := filepath.Base(filepath.Dir(filePath))
	return readLogLines(filePath, func(line string) error {
		record := sessionusage.ParseJSONLine(line)
		if record == nil || record["type"] != assistantMessageEvent {
			return nil
		}

		data := sessionusage.ReadRecordAt(record["data"])
		usage := sessionusage.ReadRecordAt(data["usage"])
		if usage == nil {
			return nil
		}
		occurredAt, ok := sessionusage.ReadEventTimestamp(record["time"])
		if !ok {
			return nil
		}

		seq, hasSeq := readEventSeq(record["seq"])
		yield(seq, hasSeq, sessionusage.Event{
			OccurredAt:  occurredAt,
			Model:       readModel(data),
			InputTokens: sessionusage.ReadTokenCount(usage["inputTokens"]),
			// reasoningTokens is informational and already inside
			// outputTokens, so it is not added again.
			OutputTokens:        sessionusage.ReadTokenCount(usage["outputTokens"]),
			CacheCreationTokens: sessionusage.ReadTokenCount(usage["cacheWriteTokens"]),
			CacheReadTokens:     sessionusage.ReadTokenCount(usage["cacheReadTokens"]),
			CostUSD:             0,
			SessionID:           sessionID,
		})
		return nil
	})
}

// readEventSeq reads the durable event sequence, or reports it absent when
// the envelope lacks a usable one. Only non-negative safe integers are
// accepted: a sequence that cannot be compared exactly cannot deduplicate
// anything, and treating it as a key would merge distinct events instead of
// skipping duplicates.
func readEventSeq(value any) (int64, bool) {
	number, ok := sessionusage.ReadFiniteNumber(value)
	if !ok || number != float64(int64(number)) {
		return 0, false
	}
	seq := int64(number)
	if seq < 0 || number > float64(1<<53-1) {
		return 0, false
	}
	return seq, true
}

// readLogLines yields a log's lines. A DSH log is Zstandard-compressed by
// default and its frames are appended in batches, so the whole file has to be
// decoded before the lines are readable. Plain logs stay streamed line by
// line.
func readLogLines(filePath string, yield func(line string) error) error {
	if !strings.HasSuffix(filePath, ".zstd") {
		return sessionscan.ReadLines(filePath, yield)
	}
	info, err := os.Stat(filePath)
	if err != nil {
		return err
	}
	if info.Size() > sessionscan.MaxSessionFileBytes {
		return errors.New("DeepSeek Harness compressed session log exceeds " +
			strconv.FormatInt(sessionscan.MaxSessionFileBytes, 10) + " bytes")
	}
	compressed, err := os.ReadFile(filePath)
	if err != nil {
		return err
	}
	if len(compressed) == 0 {
		return nil
	}
	if int64(len(compressed)) > sessionscan.MaxSessionFileBytes {
		return errors.New("DeepSeek Harness compressed session log exceeds " +
			strconv.FormatInt(sessionscan.MaxSessionFileBytes, 10) + " bytes")
	}
	if !zstdframes.IsZstdBuffer(compressed) {
		return errors.New("not a Zstandard session log")
	}
	frames, err := zstdframes.ScanFrames(compressed)
	if err != nil {
		return err
	}

	var decodedBytes int
	pending := make([]byte, 0, 64*1024)
	emitLines := func(final bool) error {
		for {
			index := bytes.IndexByte(pending, '\n')
			if index < 0 {
				break
			}
			if err := yield(string(pending[:index])); err != nil {
				return err
			}
			pending = pending[index+1:]
		}
		if final && len(pending) > 0 {
			if err := yield(string(pending)); err != nil {
				return err
			}
			pending = pending[:0]
		}
		return nil
	}

	for _, frame := range frames {
		// Each frame is bounded by what is left of the budget, not the whole
		// of it: passing the full limit to every frame would let the peak
		// reach twice the cap before the running total is ever checked.
		decoded, err := zstdframes.DecompressFrame(compressed, frame, frameBudget(decodedBytes))
		if err != nil {
			if errors.Is(err, zstdframes.ErrOutputTooLarge) {
				return errors.New("DeepSeek Harness decompressed session log exceeds " +
					strconv.FormatInt(sessionscan.MaxSessionFileBytes, 10) + " bytes")
			}
			return err
		}
		decodedBytes += len(decoded)
		if decodedBytes > sessionscan.MaxSessionFileBytes {
			return errors.New("DeepSeek Harness decompressed session log exceeds " +
				strconv.FormatInt(sessionscan.MaxSessionFileBytes, 10) + " bytes")
		}
		// Frames are independent byte ranges of one logical stream, so a
		// multibyte UTF-8 sequence can straddle a frame boundary. No carry
		// buffer is needed for that: lines split on '\n' (0x0A), which never
		// occurs inside a multibyte sequence, so a rune split across frames
		// stays contiguous in pending and is rejoined before it is yielded.
		pending = append(pending, decoded...)
		if err := emitLines(false); err != nil {
			return err
		}
	}
	return emitLines(true)
}

// frameBudget is what one frame may decompress to: what is left of the session
// cap. The floor of 1 keeps the case where the decoded total lands exactly on
// the cap decodable — an empty trailing frame passes, and any frame with real
// content is rejected as over budget. Passing the full cap to every frame
// instead would bound the result but not the peak.
func frameBudget(decodedBytes int) int {
	budget := sessionscan.MaxSessionFileBytes - decodedBytes
	if budget < 1 {
		budget = 1
	}
	return budget
}

// readModel reads the model that produced the message, which lives on the
// assistant message's source (the provider route and provider model id).
func readModel(data map[string]any) string {
	message := sessionusage.ReadRecordAt(data["message"])
	provenance := sessionusage.ReadRecordAt(message["source"])
	for _, candidate := range []any{provenance["model"], message["model"], data["model"]} {
		if text, ok := candidate.(string); ok && strings.TrimSpace(text) != "" {
			return text
		}
	}
	return sessionusage.UnknownModel
}

func sessionRoot(options Options) string {
	if options.SessionRoot != "" {
		return options.SessionRoot
	}
	// The explicit root is picked with `??` but tested for truthiness before
	// use, so an empty one falls through to the home chain below.
	explicitRoot, hasRoot := "", false
	for _, key := range []string{"DSH_SESSION_ROOT", "TOKENBOARD_DSH_SESSION_ROOT"} {
		if value, ok := lookupSet(options.Env, key); ok {
			explicitRoot, hasRoot = value, true
		}
	}
	if options.DSHHome == "" && hasRoot && explicitRoot != "" {
		return explicitRoot
	}
	// The home chain, by contrast, adopts a set-but-empty variable: `??` has
	// no truthiness test, and an empty home resolves to a relative path.
	home := defaultHome()
	for _, key := range []string{"DSH_HOME", "TOKENBOARD_DSH_HOME"} {
		if value, ok := lookupSet(options.Env, key); ok {
			home = value
		}
	}
	if options.DSHHome != "" {
		home = options.DSHHome
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

// defaultHome is the TS fallback `join(homedir(), '.dsh')`: the user's home
// is the parent of the tool's directory, not the directory itself.
func defaultHome() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".dsh")
}
