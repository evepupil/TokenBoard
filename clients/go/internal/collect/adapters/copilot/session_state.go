package copilot

import (
	"encoding/json"
	"math"
	"path/filepath"
	"strconv"

	"github.com/MisonL/TokenBoard/clients/go/internal/collect/adapters/tools"
)

// This file ports the session-state half of rust/adapters/copilot/src/parser.rs
// (:165-373): the cumulative per-model snapshots a Copilot process writes when
// it shuts down, and the session-wide credit checkpoints beside them.

// Entry is CopilotUsageEntry (parser.rs:56-73): one record before pricing. The
// loader turns it into a tools.Entry; credit-gap entries and interval entries
// share the type because the loader treats them alike until the end.
type Entry struct {
	Timestamp     int64 // epoch milliseconds
	TimestampText string
	SessionID     string
	Model         string
	Input         uint64
	Output        uint64
	CacheCreation uint64
	CacheRead     uint64
	Reasoning     uint64
	Extra         uint64
	RequestCount  uint64
	// NanoAiu is cumulative per-model credits from session-state
	// `totalNanoAiu`, used only to find session credits modelMetrics does not
	// account for.
	NanoAiu uint64
	// CostUSD is set only on credit-gap entries (parser.rs:374 comments,
	// loader.rs:374): one AIU is one GitHub credit, billed at $0.01.
	CostUSD  *float64
	DedupKey string
}

// CreditSnapshot is CopilotCreditSnapshot (parser.rs:78-87): the session-wide
// credit total one shutdown or checkpoint reports.
type CreditSnapshot struct {
	Timestamp  int64
	SessionID  string
	IsShutdown bool
	// TotalNanoAiu is nil for a shutdown whose session total or per-model
	// totals are missing, which makes its credits impossible to reconcile.
	TotalNanoAiu *uint64
	DedupKey     string
}

// SourceUsage is CopilotSourceUsage (parser.rs:89-93): what one file yields.
type SourceUsage struct {
	Entries         []Entry
	CreditSnapshots []CreditSnapshot
}

func ptrFloat(value float64) *float64 { return &value }

// parseSessionStateFile is parse_session_state_file (parser.rs:231-343). It
// reads event by event: only session.shutdown and session.usage_checkpoint
// count, a missing type, timestamp or parseable timestamp skips the line, and a
// line that is not JSON is skipped the way jsonl::records skips it.
func parseSessionStateFile(path string) (SourceUsage, error) {
	parsed := SourceUsage{}
	sessionID, ok := sessionIDFromPath(path)
	if !ok {
		return parsed, nil
	}
	return parseSessionStateContent(path, sessionID, &parsed)
}

func parseSessionStateContent(path, sessionID string, parsed *SourceUsage) (SourceUsage, error) {
	prefilter := func(line []byte) bool {
		return containsBytes(line, []byte(shutdownEvent)) || containsBytes(line, []byte(usageCheckpointEvent))
	}
	err := scanJSONL(path, prefilter, decodeSessionStateEvent, func(value any) {
		visitSessionStateEvent(parsed, sessionID, value)
	})
	return *parsed, err
}

// decodeSessionStateEvent is CopilotSessionStateEvent's Deserialize: a field
// declared with a value type but written in another JSON kind fails serde, and
// the line drops.
func decodeSessionStateEvent(line []byte) (any, bool) {
	value, ok := tools.DecodeJSONLine(line)
	if !ok {
		return nil, false
	}
	event, ok := value.(map[string]any)
	if !ok {
		return nil, false
	}
	for _, key := range []string{"type", "id", "timestamp"} {
		if field, present := event[key]; present && field != nil {
			if _, isString := field.(string); !isString {
				return nil, false
			}
		}
	}
	if data, present := event["data"]; present && data != nil {
		object, isObject := data.(map[string]any)
		if !isObject {
			return nil, false
		}
		if !fieldsMatchNames(object, []any{"totalNanoAiu"}, nil) {
			return nil, false
		}
		if metrics, present := object["modelMetrics"]; present && metrics != nil {
			models, isObject := metrics.(map[string]any)
			if !isObject {
				return nil, false
			}
			for _, raw := range models {
				metric, isObject := raw.(map[string]any)
				if !isObject {
					return nil, false
				}
				if usage, present := metric["usage"]; present && usage != nil {
					usageObject, isObject := usage.(map[string]any)
					if !isObject {
						return nil, false
					}
					if !fieldsMatchNames(usageObject, []any{"inputTokens", "outputTokens",
						"cacheReadTokens", "cacheWriteTokens", "reasoningTokens"}, []string{"cost"}) {
						return nil, false
					}
				}
				if requests, present := metric["requests"]; present && requests != nil {
					requestsObject, isObject := requests.(map[string]any)
					if !isObject {
						return nil, false
					}
					if !fieldsMatchNames(requestsObject, []any{"count"}, []string{"cost"}) {
						return nil, false
					}
				}
				if !fieldsMatchNames(metric, []any{"totalNanoAiu"}, []string{"usage", "requests"}) {
					return nil, false
				}
			}
		}
	}
	return value, true
}

// fieldsMatchNames checks the named fields of a typed object: a numeric field
// must be a JSON number when present (lenient_f64, Option<f64> or u64), and
// other must be a JSON object when present (lenient_object with an Option<T>
// target).
func fieldsMatchNames(object map[string]any, numbers []any, objects []string) bool {
	for _, name := range numbers {
		key, _ := name.(string)
		if field, present := object[key]; present && field != nil {
			if _, isNumber := field.(json.Number); !isNumber {
				return false
			}
		}
	}
	for _, key := range objects {
		if field, present := object[key]; present && field != nil {
			if _, isObject := field.(map[string]any); !isObject {
				return false
			}
		}
	}
	return true
}

func visitSessionStateEvent(parsed *SourceUsage, sessionID string, value any) {
	event, ok := tools.LenientObject(value)
	if !ok {
		return
	}
	eventType, _ := tools.NonEmptyString(event["type"])
	isShutdown := false
	switch eventType {
	case shutdownEvent:
		isShutdown = true
	case usageCheckpointEvent:
	default:
		return
	}
	timestampText, ok := tools.NonEmptyString(event["timestamp"])
	if !ok {
		return
	}
	timestamp, ok := tools.ParseTSTimestamp(timestampText)
	if !ok {
		return
	}
	data, _ := tools.LenientObject(event["data"])
	sessionTotal, _ := lenientOptionalF64(data["totalNanoAiu"])
	sessionNano, sessionHasTotal := nanoAiu(sessionTotal)
	eventID, hasID := tools.NonEmptyString(event["id"])
	snapshotKey := func(total *uint64) string {
		if hasID {
			return "credits:" + sessionID + ":" + eventID
		}
		return "credits:" + sessionID + ":" + boolText(isShutdown) + ":" +
			strconv.FormatInt(timestamp, 10) + ":" + debugOptionU64(total)
	}
	if !isShutdown {
		// A checkpoint without a total carries nothing to reconcile.
		if sessionHasTotal {
			total := sessionNano
			parsed.CreditSnapshots = append(parsed.CreditSnapshots, CreditSnapshot{
				Timestamp:    timestamp,
				SessionID:    sessionID,
				IsShutdown:   false,
				TotalNanoAiu: &total,
				DedupKey:     snapshotKey(&total),
			})
		}
		return
	}
	modelsReportCredits := true
	metrics, _ := tools.LenientObject(data["modelMetrics"])
	for model, raw := range metrics {
		metric, ok := tools.LenientObject(raw)
		if !ok {
			metric = map[string]any{}
		}
		name := normalizeCopilotModel(model)
		requestCount := uint64(0)
		if requests, ok := tools.LenientObject(metric["requests"]); ok {
			requestCount = tools.LenientU64(requests["count"])
		}
		usageObject, ok := tools.LenientObject(metric["usage"])
		if !ok {
			continue
		}
		input := tools.LenientU64(usageObject["inputTokens"])
		output := tools.LenientU64(usageObject["outputTokens"])
		cacheRead := tools.LenientU64(usageObject["cacheReadTokens"])
		cacheWrite := tools.LenientU64(usageObject["cacheWriteTokens"])
		reasoning := tools.LenientU64(usageObject["reasoningTokens"])
		if name == "" || (input == 0 && output == 0 && cacheRead == 0 && cacheWrite == 0 &&
			reasoning == 0 && requestCount == 0) {
			continue
		}
		modelTotal, _ := lenientOptionalF64(metric["totalNanoAiu"])
		modelNano, modelHasNano := nanoAiu(modelTotal)
		modelsReportCredits = modelsReportCredits && modelHasNano
		timestampText := tools.FormatRFC3339Millis(timestamp)
		dedupKey := sessionStateDedupKey(sessionID, eventID, hasID, timestampText, name,
			input, output, cacheRead, cacheWrite, reasoning, requestCount)
		parsed.Entries = append(parsed.Entries, Entry{
			Timestamp:     timestamp,
			TimestampText: timestampText,
			SessionID:     sessionID,
			Model:         name,
			Input:         tools.SaturatingSubU64(input, tools.SaturatingAddU64(cacheRead, cacheWrite)),
			Output:        output,
			CacheCreation: cacheWrite,
			CacheRead:     cacheRead,
			Reasoning:     reasoning,
			RequestCount:  requestCount,
			NanoAiu:       modelNano,
			DedupKey:      dedupKey,
		})
	}
	var total *uint64
	if sessionHasTotal && modelsReportCredits {
		value := sessionNano
		total = &value
	}
	parsed.CreditSnapshots = append(parsed.CreditSnapshots, CreditSnapshot{
		Timestamp:    timestamp,
		SessionID:    sessionID,
		IsShutdown:   true,
		TotalNanoAiu: total,
		DedupKey:     snapshotKey(total),
	})
}

const (
	shutdownEvent        = "session.shutdown"
	usageCheckpointEvent = "session.usage_checkpoint"
)

// sessionIDFromPath is parser.rs:232-241: the trimmed parent directory name.
func sessionIDFromPath(path string) (string, bool) {
	parent := filepath.Dir(path)
	name, ok := tools.NonEmptyString(filepath.Base(parent))
	return name, ok
}

// nanoAiu is nano_aiu (parser.rs:345-349): finite and non-negative values round
// half away from zero (Rust's f64::round semantics) to a u64; everything else
// is None.
func nanoAiu(value *float64) (uint64, bool) {
	if value == nil || math.IsNaN(*value) || math.IsInf(*value, 0) || *value < 0 {
		return 0, false
	}
	return uint64(math.Round(*value)), true
}

// lenientOptionalF64 is lenient_f64 as serde's Option<f64>: a present JSON
// number reads back, anything else is absent.
func lenientOptionalF64(value any) (*float64, bool) {
	if parsed, ok := tools.LenientF64(value); ok {
		return &parsed, true
	}
	return nil, false
}

// sessionStateDedupKey is session_state_dedup_key (parser.rs:351-373).
func sessionStateDedupKey(sessionID, eventID string, hasID bool, timestampText, model string,
	input, output, cacheRead, cacheWrite, reasoning, requestCount uint64) string {
	if hasID {
		return "shutdown:" + sessionID + ":" + eventID + ":" + model
	}
	return "shutdown:" + sessionID + ":" + timestampText + ":" + model + ":" +
		strconv.FormatUint(input, 10) + ":" + strconv.FormatUint(output, 10) + ":" +
		strconv.FormatUint(cacheRead, 10) + ":" + strconv.FormatUint(cacheWrite, 10) + ":" +
		strconv.FormatUint(reasoning, 10) + ":" + strconv.FormatUint(requestCount, 10)
}

// normalizeCopilotModel is normalize_copilot_model (parser.rs:633-640): trim,
// then strip one `-1m-internal` or `-1m` suffix, longest first.
func normalizeCopilotModel(model string) string {
	trimmed := trimRustSpace(model)
	return stripSuffix(stripSuffix(trimmed, "-1m-internal"), "-1m")
}

func boolText(value bool) string {
	if value {
		return "true"
	}
	return "false"
}

// debugOptionU64 is Rust's `{:?}` for Option<u64>: `Some(n)` or `None`.
func debugOptionU64(value *uint64) string {
	if value == nil {
		return "None"
	}
	return "Some(" + strconv.FormatUint(*value, 10) + ")"
}
