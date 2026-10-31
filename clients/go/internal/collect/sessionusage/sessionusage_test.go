package sessionusage

import (
	"encoding/json"
	"math"
	"strings"
	"testing"
	"time"

	"github.com/MisonL/TokenBoard/clients/go/internal/contract"
)

// TS truncates with String#slice, which counts UTF-16 code units. Counting
// runes instead lets an astral-plane model id through at 160 runes (up to 320
// UTF-16 units), and the upload-time contract check — which counts UTF-16 —
// then rejects the whole snapshot. The bounded model must satisfy the same
// bound it is bounded for.
func TestBoundedModelTruncatesByUTF16Units(t *testing.T) {
	model := BoundedModel(strings.Repeat("😀", 200))
	if length := len([]rune(model)); length > 160 {
		t.Fatalf("rune length = %d, want <= 160", length)
	}
	snapshot := contract.Snapshot{
		Source:      contract.Source("opencode"),
		UsageDate:   "2026-01-01",
		Timezone:    "UTC",
		Model:       model,
		CollectedAt: "2026-01-01T00:00:00Z",
	}
	if err := snapshot.Validate(); err != nil {
		t.Fatalf("bounded model fails the contract it exists to satisfy: %v", err)
	}
}

// A cut that lands between the halves of a surrogate pair drops the half
// rather than storing a lone surrogate, which a Go string cannot hold. JS's
// slice keeps the half; the two can differ only for an id over 160 units with
// a pair straddling the cut, and keeping the whole pair instead would break
// the bound.
func TestBoundedModelKeepsABoundaryCharacterWhole(t *testing.T) {
	// 159 ASCII units leave room for one code unit of a surrogate pair.
	model := BoundedModel(strings.Repeat("a", 159) + "😀" + "tail")
	if length := len([]rune(model)); length != 159 {
		t.Errorf("rune length = %d, want 159 (the pair is cut, not half-kept)", length)
	}
	if !strings.HasPrefix(model, strings.Repeat("a", 159)) {
		t.Errorf("model = %q, want the 159 ASCII prefix", model)
	}
}

// An offset zone must attribute dates the way Intl does: the local calendar
// day in that offset, not UTC. TS accepts "+08:00" everywhere it formats a
// date, so a session that crosses midnight UTC has to land on the next day
// here too.
func TestAggregateAttributesDatesUnderAnOffsetTimezone(t *testing.T) {
	aggregate, err := NewAggregate(contract.Source("pi"), "+08:00", "2026-10-21T00:00:00Z", true)
	if err != nil {
		t.Fatalf("NewAggregate: %v", err)
	}
	if got := FormatDate(time.Date(2026, 10, 20, 17, 0, 0, 0, time.UTC), "+08:00"); got != "2026-10-21" {
		t.Errorf("FormatDate = %q, want 2026-10-21 (01:00 in +08:00)", got)
	}
	if got := FormatDate(time.Date(2026, 10, 20, 15, 59, 0, 0, time.UTC), "+08:00"); got != "2026-10-20" {
		t.Errorf("FormatDate = %q, want 2026-10-20 (23:59 in +08:00)", got)
	}
	if aggregate == nil {
		t.Fatal("aggregate is nil")
	}
}

// TS folds every row through `usageSnapshotSchema.parse` before it leaves the
// collector, so a corrupted session row fails that one source. Go's aggregate is the
// only gate those four sources have: without it a huge count survives folding, the
// server rejects the whole upload batch, the failure classifies as non-transient, and
// after enough attempts *every* source on the machine stops uploading. The folded
// rows must satisfy the same contract the server enforces.
func TestSnapshotsRejectRowsBeyondTheContract(t *testing.T) {
	cases := map[string]Event{
		"input beyond the token bound": {
			OccurredAt: time.Date(2026, 10, 24, 5, 0, 0, 0, time.UTC),
			Model:      "corrupt", InputTokens: 1_000_000_000_001, OutputTokens: 1, CostUSD: 0.01, SessionID: "s",
		},
		"a sum that overflows int64": {
			OccurredAt: time.Date(2026, 10, 24, 5, 0, 0, 0, time.UTC),
			Model:      "corrupt", InputTokens: 9_000_000_000_000_000_000, OutputTokens: 9_000_000_000_000_000_000,
			CostUSD: 0.01, SessionID: "s",
		},
		"negative cost on a costed source": {
			OccurredAt: time.Date(2026, 10, 24, 5, 0, 0, 0, time.UTC),
			Model:      "corrupt", InputTokens: 10, CostUSD: -1, SessionID: "s",
		},
	}
	for name, event := range cases {
		aggregate, err := NewAggregate(contract.Source("pi"), "UTC", "2026-10-24T00:00:00Z", true)
		if err != nil {
			t.Fatalf("NewAggregate: %v", err)
		}
		aggregate.Add(event)
		snapshots, err := aggregate.Snapshots()
		if err == nil {
			t.Fatalf("%s: Snapshots accepted a row the server would reject: %+v", name, snapshots)
		}
		if len(snapshots) != 0 {
			t.Fatalf("%s: Snapshots returned %d rows alongside the error", name, len(snapshots))
		}
	}
}

// A row that stays inside the contract still produces the same output as before.
func TestSnapshotsStillPassValidRows(t *testing.T) {
	aggregate, err := NewAggregate(contract.Source("pi"), "UTC", "2026-10-24T00:00:00Z", true)
	if err != nil {
		t.Fatalf("NewAggregate: %v", err)
	}
	aggregate.Add(Event{
		OccurredAt: time.Date(2026, 10, 24, 5, 0, 0, 0, time.UTC),
		Model:      "normal", InputTokens: 100, OutputTokens: 20, CostUSD: 0.5, SessionID: "s",
	})
	snapshots, err := aggregate.Snapshots()
	if err != nil {
		t.Fatalf("Snapshots: %v", err)
	}
	if len(snapshots) != 1 || snapshots[0].TotalTokens != 120 {
		t.Fatalf("got %+v", snapshots)
	}
}

// TS keeps a huge count (`Math.trunc`) and lets the schema reject the row; Go's
// `int64(float)` for a value past int64 is not a rejection, it is a wrapped number
// — commonly negative — that then folds, uploads, and poisons the batch. The reader
// is where the two sides have to agree: a count beyond what the contract can carry
// must arrive at the aggregate as something the contract will refuse, never as a
// quiet wraparound.
func TestReadTokenCountRejectsCountsBeyondTheContract(t *testing.T) {
	for _, value := range []any{
		9.3e18,                           // past int64 range: int64() would wrap
		1e30,                             // absurd but finite: the JSON can say anything
		"1000000000001",                  // string-encoded, one past the token bound
		contract.MaxSnapshotTokens + 1.0, // the bound itself, exclusive
	} {
		if got := ReadTokenCount(value); got <= contract.MaxSnapshotTokens {
			t.Fatalf("ReadTokenCount(%v) = %d, want a value the contract refuses", value, got)
		}
	}

	// The ordinary cases are unchanged.
	if got := ReadTokenCount("12345"); got != 12345 {
		t.Fatalf("ReadTokenCount(string) = %d, want 12345", got)
	}
	if got := ReadTokenCount(-5); got != 0 {
		t.Fatalf("ReadTokenCount(-5) = %d, want 0", got)
	}
	if got := ReadTokenCount(1.9); got != 1 {
		t.Fatalf("ReadTokenCount(1.9) = %d, want 1 (truncation)", got)
	}
}

// The name promises a finite number, and TS's `readNumber` guarantees it
// (`Number.isFinite`). A NaN that slips through is worse than a wrong value:
// `NaN > bound` is false and `int64(NaN)` is undefined, so a NaN cost reaches the
// snapshot and fails validation only if something else notices.
func TestReadFiniteNumberRejectsNonFiniteValues(t *testing.T) {
	nan := math.NaN()
	inf := math.Inf(1)
	for _, value := range []any{nan, inf, math.Inf(-1), json.Number("NaN"), json.Number("+Inf")} {
		if parsed, ok := ReadFiniteNumber(value); ok {
			t.Fatalf("ReadFiniteNumber(%v) = (%v, true), want ok=false", value, parsed)
		}
	}
	if parsed, ok := ReadFiniteNumber(1.5); !ok || parsed != 1.5 {
		t.Fatalf("ReadFiniteNumber(1.5) = (%v, %v)", parsed, ok)
	}
}

// A NaN reaches the readers as a JSON number from a corrupted store. The readers'
// rejections above keep it out of the counts, but the cost reader on a costed
// source (`ReadFiniteNumber` directly) is the last path a NaN could ride to a
// snapshot; the schema rejects NaN, and the aggregate gate must catch it there too.
func TestSnapshotsRejectANaNCost(t *testing.T) {
	aggregate, err := NewAggregate(contract.Source("pi"), "UTC", "2026-10-24T00:00:00Z", true)
	if err != nil {
		t.Fatalf("NewAggregate: %v", err)
	}
	aggregate.Add(Event{
		OccurredAt: time.Date(2026, 10, 24, 5, 0, 0, 0, time.UTC),
		Model:      "corrupt", InputTokens: 10, CostUSD: math.NaN(), SessionID: "s",
	})
	if _, err := aggregate.Snapshots(); err == nil {
		t.Fatal("Snapshots accepted a NaN cost")
	}
}

// JS `line.trim()` strips U+FEFF as well as whitespace, so a Pi/Grok/DSH session file written by
// an editor or a PowerShell `>` redirect parses there. Go's TrimSpace does not, and the JSON
// decoder rejects `\uFEFF{...}` — the first line of such a file would be dropped, taking the
// session timestamp that entries without their own timestamp fall back on.
func TestParseJSONLineDropsALeadingBOM(t *testing.T) {
	record := ParseJSONLine("\ufeff{\"type\":\"session\",\"id\":\"s1\"}")
	if record == nil {
		t.Fatal("ParseJSONLine rejected a BOM-prefixed object")
	}
	if record["type"] != "session" || record["id"] != "s1" {
		t.Fatalf("record = %#v", record)
	}
	// A BOM is only meaningful at the start: one between tokens is malformed, as in JS.
	if ParseJSONLine("{\"a\":1}\ufeff") != nil {
		t.Fatal("a trailing BOM must not be accepted")
	}
}
