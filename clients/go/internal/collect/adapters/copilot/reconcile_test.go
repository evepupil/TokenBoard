package copilot

import (
	"math"
	"strings"
	"testing"

	"github.com/MisonL/TokenBoard/clients/go/internal/collect/adapters/tools"
)

// The tests below follow the loader.rs credit-gap suite (loader.rs:1519-1752)
// case by case, with the fixtures' timestamps moved to epoch milliseconds. Each
// fixture is one session's shutdown/checkpoint stream; credits are whole AIU.

const nanoPerCredit = 1_000_000_000

// msAt parses a UTC timestamp string into epoch milliseconds.
func msAt(t *testing.T, text string) int64 {
	t.Helper()
	millis, ok := parseFixtureTime(text)
	if !ok {
		t.Fatalf("bad fixture timestamp %q", text)
	}
	return millis
}

func shutdownEntry(t *testing.T, session, id, timestamp string, input, output, cacheRead, cacheWrite, reasoning, requests, nano uint64) Entry {
	return Entry{
		Timestamp:     msAt(t, timestamp),
		TimestampText: timestamp,
		SessionID:     session,
		Model:         "test-model",
		Input:         input,
		Output:        output,
		CacheRead:     cacheRead,
		CacheCreation: cacheWrite,
		Reasoning:     reasoning,
		RequestCount:  requests,
		NanoAiu:       nano,
		DedupKey:      "shutdown:" + session + ":" + id + ":test-model",
	}
}

func shutdownSnapshot(t *testing.T, session, id, timestamp string, total *uint64) CreditSnapshot {
	return CreditSnapshot{
		Timestamp:    msAt(t, timestamp),
		SessionID:    session,
		IsShutdown:   true,
		TotalNanoAiu: total,
		DedupKey:     "credits:" + session + ":" + id,
	}
}

func checkpointSnapshot(t *testing.T, session, id, timestamp string, credits uint64) CreditSnapshot {
	total := credits * nanoPerCredit
	return CreditSnapshot{
		Timestamp:    msAt(t, timestamp),
		SessionID:    session,
		IsShutdown:   false,
		TotalNanoAiu: &total,
		DedupKey:     "credits:" + session + ":" + id,
	}
}

func credits(whole uint64) *uint64 {
	value := whole * nanoPerCredit
	return &value
}

// TestCopilotIntervalsDifferencing mirrors
// splits_resumed_shutdowns_across_dates_without_double_counting and
// keeps_one_entry_for_a_single_shutdown_snapshot (loader.rs:1336-1445): each
// snapshot is cumulative, so every later one becomes its own difference against
// the previous, saturating; a lone snapshot is kept as-is.
func TestCopilotIntervalsDifferencing(t *testing.T) {
	old := shutdownEntry(t, "s", "shutdown-old", "2026-01-02T01:20:00.000Z", 70, 50, 10, 20, 0, 1, 0)
	latest := shutdownEntry(t, "s", "shutdown-latest", "2026-01-03T01:20:00.000Z", 150, 30, 10, 10, 0, 2, 0)
	result := Reconcile(ReconcileInput{Entries: []Entry{old, latest}})
	if len(result.Intervals) != 2 {
		t.Fatalf("intervals = %+v, want 2", result.Intervals)
	}
	if got := result.Intervals[0]; got.Input != 70 || got.Output != 50 || got.RequestCount != 1 {
		t.Fatalf("first interval = %+v, want the snapshot as-is", got)
	}
	if got := result.Intervals[1]; got.Input != 80 || got.Output != toolsSub(30, 50) || got.RequestCount != 1 {
		t.Fatalf("second interval = %+v, want the difference", got)
	}
	if result.AttributedNano[attributedKey("s", msAt(t, "2026-01-03T01:20:00.000Z"))] != 0 {
		t.Fatalf("attributed = %v", result.AttributedNano)
	}

	// A counter that goes backwards saturates at zero instead of wrapping.
	backwards := Reconcile(ReconcileInput{Entries: []Entry{
		shutdownEntry(t, "s", "a", "2026-01-02T00:00:00.000Z", 100, 0, 0, 0, 0, 3, 0),
		shutdownEntry(t, "s", "b", "2026-01-03T00:00:00.000Z", 10, 5, 0, 0, 0, 1, 0),
	}})
	if got := backwards.Intervals[1]; got.Input != 0 || got.Output != 5 || got.RequestCount != 0 {
		t.Fatalf("backwards interval = %+v, want input 0 output 5 requests 0", got)
	}

	single := Reconcile(ReconcileInput{Entries: []Entry{
		shutdownEntry(t, "s", "only", "2026-01-02T01:20:00.000Z", 100, 50, 0, 0, 0, 1, 0),
	}})
	if len(single.Intervals) != 1 || single.Intervals[0].Input != 100 || single.Intervals[0].Output != 50 {
		t.Fatalf("single snapshot = %+v, want it kept as-is", single.Intervals)
	}
}

// TestCopilotOTelKeyKeepsDistinctPairsDistinct pins the shape of the OTel map's
// key against Rust's (String, String) tuple (loader.rs:140-154). A joined key
// lets a session id that carries the separator name another pair's slot, so two
// sessions' OTel rows would suppress or replace each other's intervals. Both
// halves are read from Copilot's JSON as arbitrary strings.
func TestCopilotOTelKeyKeepsDistinctPairsDistinct(t *testing.T) {
	if otelKey("a", "b\x00c") == otelKey("a\x00b", "c") {
		t.Fatal("otelKey must not let a separator inside a value name another pair")
	}
	if got := otelKey("left\x00", "right"); got == otelKey("left", "\x00right") {
		t.Fatalf("otelKey(%q) collides", got)
	}
}

// TestCopilotAttributedKeyKeepsDistinctPairsDistinct pins AttributedNano's key
// against Rust's HashMap<(String, i64), u64> (loader.rs:236-252). A joined key
// would let a session id whose tail spells a number, e.g. "-5", name another
// session's shutdown and move its credits into the wrong gap.
func TestCopilotAttributedKeyKeepsDistinctPairsDistinct(t *testing.T) {
	if attributedKey("s-5", 0) == attributedKey("s", -5) {
		t.Fatal("attributedKey must not let a session id name another pair")
	}
	if attributedKey("a", 1) == attributedKey("a", 2) {
		t.Fatal("attributedKey must keep distinct timestamps apart")
	}
}

// TestCopilotDiffDropsBeyondLatestVisible mirrors latest_visible and the drop
// conditions (loader.rs:224-258): a snapshot at or after --until is not
// visible, so every interval from it on is dropped; the last visible snapshot
// becomes otel_after for the key; a zero-usage interval is dropped and rows
// before --since are dropped.
func TestCopilotDiffDropsBeyondLatestVisible(t *testing.T) {
	entries := []Entry{
		shutdownEntry(t, "s", "a", "2026-01-01T00:00:00.000Z", 10, 0, 0, 0, 0, 0, 0),
		shutdownEntry(t, "s", "b", "2026-01-02T00:00:00.000Z", 10, 0, 0, 0, 0, 0, 0), // zero difference
		shutdownEntry(t, "s", "c", "2026-01-03T00:00:00.000Z", 30, 0, 0, 0, 0, 0, 0),
		shutdownEntry(t, "s", "d", "2026-01-05T00:00:00.000Z", 50, 0, 0, 0, 0, 0, 0),
	}
	until := msAt(t, "2026-01-04T00:00:00.000Z")
	since := msAt(t, "2026-01-02T00:00:00.000Z")
	result := Reconcile(ReconcileInput{Entries: entries, SinceMs: &since, UntilMs: &until})
	if len(result.Intervals) != 1 || result.Intervals[0].Input != 20 {
		t.Fatalf("intervals = %+v, want only the 20-token interval on 01-03", result.Intervals)
	}
	if after, ok := result.OTelAfter[otelKey("s", "test-model")]; !ok || after != msAt(t, "2026-01-03T00:00:00.000Z") {
		t.Fatalf("otelAfter = %v, want the last visible shutdown", result.OTelAfter)
	}
}

// toolsSub is saturating subtraction for test expectations.
func toolsSub(left, right uint64) uint64 {
	if right > left {
		return 0
	}
	return left - right
}

// parseFixtureTime parses "YYYY-MM-DDTHH:MM:SS.mmmZ" through the strict gate
// the adapters use, so a moved fixture date fails loudly.
func parseFixtureTime(text string) (int64, bool) {
	return tools.ParseTSTimestamp(text)
}

// creditRows renders reconcile output the way credit_rows does
// (loader.rs:1504-1517): date, model, total tokens, whole credits. Interval
// cost is not priced here (the loader does that), so only the credit gaps
// carry a cost.
func creditRows(result Reconciliation, timezone string) []string {
	rows := []string{}
	for _, entry := range result.Intervals {
		rows = append(rows, tools.FormatDateTZ(entry.Timestamp, timezone)+" "+entry.Model+" "+
			utoa(entry.Input+entry.Output+entry.CacheCreation+entry.CacheRead+entry.Extra)+" 0")
	}
	for _, gap := range result.Gaps {
		rows = append(rows, tools.FormatDateTZ(gap.Timestamp, timezone)+" "+gap.Model+" 0 "+
			utoa(uint64(math.Round(*gap.CostUSD*100))))
	}
	return rows
}

func requireRows(t *testing.T, got, want []string) {
	t.Helper()
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("rows = %v, want %v", got, want)
	}
}

// usageShutdown is one shutdown whose test-model breakdown reports one request
// of 100 input and 50 output tokens; nano is the model's own totalNanoAiu.
func usageShutdown(t *testing.T, session, id, timestamp string, nano uint64) Entry {
	return shutdownEntry(t, session, id, timestamp, 100, 50, 0, 0, 0, 1, nano)
}

// TestCopilotCreditGapSkipWhenOtelsPresent mirrors
// leaves_credit_gaps_to_otel_when_a_session_has_otel_rows (loader.rs:1705-1733).
func TestCopilotCreditGapSkipWhenOtelsPresent(t *testing.T) {
	result := Reconcile(ReconcileInput{
		Snapshots:      []CreditSnapshot{checkpointSnapshot(t, "s", "checkpoint-1", "2026-01-02T10:00:00.000Z", 20)},
		SkippedSession: func(session string) bool { return session == "s" },
	})
	if len(result.Gaps) != 0 {
		t.Fatalf("gaps = %+v, want none for a session with OTel rows", result.Gaps)
	}
}

// TestCopilotCreditGapSkipWhenAllShutdown mirrors leaves_sessions_without_checkpoints_unchanged
// (loader.rs:1667-1684).
func TestCopilotCreditGapSkipWhenAllShutdown(t *testing.T) {
	result := Reconcile(ReconcileInput{
		Entries: []Entry{
			usageShutdown(t, "s", "shutdown-1", "2026-01-02T10:00:00.000Z", 0),
			usageShutdown(t, "s", "shutdown-2", "2026-01-03T10:00:00.000Z", 0),
		},
		Snapshots: []CreditSnapshot{
			shutdownSnapshot(t, "s", "shutdown-1", "2026-01-02T10:00:00.000Z", credits(60)),
			shutdownSnapshot(t, "s", "shutdown-2", "2026-01-03T10:00:00.000Z", credits(25)),
		},
	})
	requireRows(t, creditRows(result, "UTC"), []string{"2026-01-02 test-model 150 0"})
}

// TestCopilotCreditGapSkipWhenShutdownTotalUnknown mirrors
// leaves_sessions_with_incomplete_credit_totals_unchanged (loader.rs:1686-1703).
func TestCopilotCreditGapSkipWhenShutdownTotalUnknown(t *testing.T) {
	result := Reconcile(ReconcileInput{
		Entries: []Entry{usageShutdown(t, "s", "shutdown-1", "2026-01-02T10:00:00.000Z", 0)},
		Snapshots: []CreditSnapshot{
			checkpointSnapshot(t, "s", "checkpoint-1", "2026-01-02T09:00:00.000Z", 20),
			shutdownSnapshot(t, "s", "shutdown-1", "2026-01-02T10:00:00.000Z", nil),
			checkpointSnapshot(t, "s", "checkpoint-2", "2026-01-02T11:00:00.000Z", 120),
		},
	})
	requireRows(t, creditRows(result, "UTC"), []string{"2026-01-02 test-model 150 0"})
}

// TestCopilotCreditGapReportsMissingCredits mirrors
// reports_session_credits_missing_from_model_metrics (loader.rs:1519-1541): the
// unexplained credits are dated at the first snapshot they stay unexplained
// from - here the first checkpoint, dropping the last shutdown's checkpoint.
func TestCopilotCreditGapReportsMissingCredits(t *testing.T) {
	result := Reconcile(ReconcileInput{
		Entries: []Entry{usageShutdown(t, "s", "shutdown-1", "2026-01-02T10:20:00.000Z", 42*nanoPerCredit)},
		Snapshots: []CreditSnapshot{
			checkpointSnapshot(t, "s", "checkpoint-1", "2026-01-02T10:00:00.000Z", 51),
			checkpointSnapshot(t, "s", "checkpoint-2", "2026-01-02T10:10:00.000Z", 73),
			shutdownSnapshot(t, "s", "shutdown-1", "2026-01-02T10:20:00.000Z", credits(93)),
		},
	})
	requireRows(t, creditRows(result, "UTC"), []string{
		"2026-01-02 test-model 150 0",
		"2026-01-02 unknown 0 51",
	})
	gap := result.Gaps[0]
	if gap.RequestCount != 0 || gap.CostUSD == nil || !floatNear(*gap.CostUSD, 0.51) {
		t.Fatalf("gap = %+v, want credits-only with cost 0.51", gap)
	}
}

// TestCopilotCreditGapCheckpointsWithoutShutdown mirrors
// reports_checkpoint_credits_of_sessions_without_a_shutdown (loader.rs:1543-1567).
func TestCopilotCreditGapCheckpointsWithoutShutdown(t *testing.T) {
	result := Reconcile(ReconcileInput{
		Entries: []Entry{usageShutdown(t, "s1", "shutdown-1", "2026-01-02T10:00:00.000Z", 0)},
		Snapshots: []CreditSnapshot{
			shutdownSnapshot(t, "s1", "shutdown-1", "2026-01-02T10:00:00.000Z", credits(10)),
			// The model's own credit total lands the shutdown exactly on its
			// token usage. The checkpoints that follow then report credits no
			// model breakdown accounts for: 10 + 15 outside the breakdown at
			// 11:00, and 15 more by the next day.
			checkpointSnapshot(t, "s1", "checkpoint-1", "2026-01-02T11:00:00.000Z", 25),
			checkpointSnapshot(t, "s1", "checkpoint-2", "2026-01-03T11:00:00.000Z", 40),
			checkpointSnapshot(t, "s2", "checkpoint-3", "2026-01-03T12:00:00.000Z", 7),
		},
	})
	requireRows(t, creditRows(result, "UTC"), []string{
		"2026-01-02 test-model 150 0",
		"2026-01-02 unknown 0 10",
		"2026-01-02 unknown 0 15",
		"2026-01-03 unknown 0 15",
		"2026-01-03 unknown 0 7",
	})
}

// TestCopilotCreditGapResumedSessionWithoutModelMetrics mirrors
// reports_resumed_session_credits_when_the_last_shutdown_has_no_model_metrics
// (loader.rs:1569-1597): the checkpoint sits before the (empty) shutdown, and
// the whole session total stays unexplained.
func TestCopilotCreditGapResumedSessionWithoutModelMetrics(t *testing.T) {
	result := Reconcile(ReconcileInput{Snapshots: []CreditSnapshot{
		checkpointSnapshot(t, "s", "checkpoint-1", "2026-01-02T10:00:00.000Z", 1_072),
		shutdownSnapshot(t, "s", "shutdown-1", "2026-01-03T10:00:00.000Z", credits(1_072)),
	}})
	requireRows(t, creditRows(result, "UTC"), []string{"2026-01-03 unknown 0 1072"})
}

// TestCopilotCreditGapSubtractsBeforeSince mirrors subtracts_credit_snapshots_before_since
// (loader.rs:1599-1619): a gap dated before --since is dropped.
func TestCopilotCreditGapSubtractsBeforeSince(t *testing.T) {
	since := msAt(t, "2026-01-03T00:00:00.000Z")
	result := Reconcile(ReconcileInput{
		Entries: []Entry{usageShutdown(t, "s", "shutdown-1", "2026-01-02T10:00:00.000Z", 10*nanoPerCredit)},
		Snapshots: []CreditSnapshot{
			shutdownSnapshot(t, "s", "shutdown-1", "2026-01-02T10:00:00.000Z", credits(30)),
			checkpointSnapshot(t, "s", "checkpoint-1", "2026-01-03T10:00:00.000Z", 50),
		},
		SinceMs: &since,
	})
	requireRows(t, creditRows(result, "UTC"), []string{"2026-01-03 unknown 0 20"})
}

// TestCopilotCreditGapLaterShutdownAttribution mirrors
// does_not_count_credits_that_a_later_shutdown_attributes (loader.rs:1621-1640)
// and TestCopilotCreditGapSuffixMinimumDecays: an earlier unexplained amount
// that a later shutdown's model breakdown catches up on is never reported.
func TestCopilotCreditGapSuffixMinimumDecays(t *testing.T) {
	// A later shutdown that catches up on an earlier breakdown explains the
	// earlier amount away: the 12:00 shutdown attributes 20 more than its own
	// interval, so the 20 left unexplained at 10:00 is never reported.
	result := Reconcile(ReconcileInput{
		Entries: []Entry{
			usageShutdown(t, "s", "shutdown-1", "2026-01-02T10:00:00.000Z", 30*nanoPerCredit),
			usageShutdown(t, "s", "shutdown-2", "2026-01-02T12:00:00.000Z", 50*nanoPerCredit),
		},
		Snapshots: []CreditSnapshot{
			checkpointSnapshot(t, "s", "checkpoint-1", "2026-01-02T09:00:00.000Z", 1),
			shutdownSnapshot(t, "s", "shutdown-1", "2026-01-02T10:00:00.000Z", credits(50)),
			shutdownSnapshot(t, "s", "shutdown-2", "2026-01-02T12:00:00.000Z", credits(50)),
		},
	})
	requireRows(t, creditRows(result, "UTC"), []string{"2026-01-02 test-model 150 0"})
	if len(result.Gaps) != 0 {
		t.Fatalf("gaps = %+v, want none once the later shutdown catches up", result.Gaps)
	}

	// The decay alone: A, B, C at 50 unanswered by nothing; B at 30 unaccounted
	// for by A's 50 (already more than all of B's), so nothing is left
	// unexplained from B on and A's 50 never becomes a lasting gap.
	answered := Reconcile(ReconcileInput{
		Entries: []Entry{
			usageShutdown(t, "s", "shutdown-1", "2026-01-02T10:00:00.000Z", 50*nanoPerCredit),
		},
		Snapshots: []CreditSnapshot{
			shutdownSnapshot(t, "s", "shutdown-1", "2026-01-02T10:00:00.000Z", credits(60)),
			checkpointSnapshot(t, "s", "checkpoint-1", "2026-01-02T11:00:00.000Z", 80),
			checkpointSnapshot(t, "s", "checkpoint-2", "2026-01-02T12:00:00.000Z", 90),
		},
	})
	// 10 at the shutdown (60 - 50), 10 more at 11:00 (80 - 50 - 10), and the
	// 12:00 point raises nothing.
	requireRows(t, creditRows(answered, "UTC"), []string{
		"2026-01-02 test-model 150 0",
		"2026-01-02 unknown 0 10",
		"2026-01-02 unknown 0 20",
		"2026-01-02 unknown 0 10",
	})
}

// TestCopilotCreditGapAttributedIncludesOutOfWindowShutdowns mirrors
// credit_gaps_do_not_depend_on_until (loader.rs:1642-1665): the gap decision
// reads every shutdown, including ones past --until. Hand-checked: session
// totals 30 -> 90 -> 50 against model breakdowns that report 30 and 5. The
// 12:00 shutdown reports a lower total, which does not lower the running
// maximum, and leaves 55 unexplained; the shutdown past --until books 60
// credits, so 55 are explained away and nothing is reported.
func TestCopilotCreditGapAttributedIncludesOutOfWindowShutdowns(t *testing.T) {
	until := msAt(t, "2026-01-03T00:00:00.000Z")
	fixture := func() ReconcileInput {
		return ReconcileInput{
			Entries: []Entry{
				usageShutdown(t, "s", "shutdown-1", "2026-01-02T10:00:00.000Z", 30*nanoPerCredit),
				usageShutdown(t, "s", "shutdown-2", "2026-01-02T12:00:00.000Z", 5*nanoPerCredit),
				usageShutdown(t, "s", "shutdown-3", "2026-01-03T10:00:00.000Z", 60*nanoPerCredit),
			},
			Snapshots: []CreditSnapshot{
				checkpointSnapshot(t, "s", "checkpoint-1", "2026-01-02T09:00:00.000Z", 30),
				shutdownSnapshot(t, "s", "shutdown-1", "2026-01-02T10:00:00.000Z", credits(30)),
				checkpointSnapshot(t, "s", "checkpoint-2", "2026-01-02T11:00:00.000Z", 90),
				shutdownSnapshot(t, "s", "shutdown-2", "2026-01-02T12:00:00.000Z", credits(50)),
				// Past --until: its 60 credits alone explain the 55 away.
				shutdownSnapshot(t, "s", "shutdown-3", "2026-01-03T10:00:00.000Z", credits(50)),
			},
		}
	}
	windowedInput := fixture()
	windowedInput.UntilMs = &until
	windowed := Reconcile(windowedInput)
	// Shutdown-2's interval is zero (its breakdown is a subset of the restored
	// one), so the window holds only shutdown-1's row.
	requireRows(t, creditRows(windowed, "UTC"), []string{"2026-01-02 test-model 150 0"})
	unbounded := Reconcile(fixture())
	requireRows(t, creditRows(unbounded, "UTC"), []string{"2026-01-02 test-model 150 0"})
	// Attribution is the interval difference: the 60 credits over an interval
	// of 5, i.e. the 55 the out-of-window shutdown explained away.
	if got := windowed.AttributedNano[attributedKey("s", msAt(t, "2026-01-03T10:00:00.000Z"))]; got != 55*nanoPerCredit {
		t.Fatalf("attributed for the out-of-window shutdown = %d, want 55", got)
	}

	// Control: drop only the out-of-window shutdown (its session keeps a
	// checkpoint, so gaps still apply) and the 12:00 shutdown's unexplained
	// 20 (60 - 35 - 5) is reported.
	withoutLate := fixture()
	withoutLate.Entries = withoutLate.Entries[:2]
	withoutLate.Snapshots = withoutLate.Snapshots[:4]
	requireRows(t, creditRows(Reconcile(withoutLate), "UTC"), []string{
		"2026-01-02 test-model 150 0",
		"2026-01-02 unknown 0 20",
	})
}

// TestCopilotOtelReplacementStartsAtFirstExcess mirrors
// reports_otel_calls_of_a_process_that_ended_without_a_shutdown (loader.rs:1810-1852):
// the crashed process's three calls sit in no shutdown, so OTel holds more
// calls than the intervals report, and the replacement starts at the very first
// interval - which leaves no "interval before" to date the suppression from, so
// every OTel row counts and every shutdown interval drops.
func TestCopilotOtelReplacementStartsAtFirstExcess(t *testing.T) {
	entries := []Entry{
		// Per-interval request counts: 2, then 3 more (the crashed process's
		// calls are in no shutdown).
		shutdownEntry(t, "s", "shutdown-1", "2026-01-02T10:00:00.000Z", 200, 20, 0, 0, 0, 2, 0),
		shutdownEntry(t, "s", "shutdown-2", "2026-01-03T10:00:00.000Z", 500, 50, 0, 0, 0, 4, 0),
	}
	otel := []Entry{
		otelCall("s", "2026-01-02T09:00:00.000Z"),
		otelCall("s", "2026-01-02T09:30:00.000Z"),
		otelCall("s", "2026-01-02T20:00:00.000Z"),
		otelCall("s", "2026-01-02T21:00:00.000Z"),
		otelCall("s", "2026-01-03T08:00:00.000Z"),
		otelCall("s", "2026-01-03T09:00:00.000Z"),
		otelCall("s", "2026-01-03T11:00:00.000Z"),
	}
	result := Reconcile(ReconcileInput{Entries: entries, OTelEntries: otel})
	// Seven OTel calls against four reported requests: every shutdown interval
	// drops and nothing is suppressed.
	if _, present := result.OTelAfter[otelKey("s", "test-model")]; present {
		t.Fatalf("otelAfter = %v, want no entry when the replacement starts at the first interval", result.OTelAfter)
	}
	if len(result.Intervals) != 0 {
		t.Fatalf("intervals = %+v, want none", result.Intervals)
	}

	// keeps_shutdown_usage_from_before_the_otel_export_started
	// (loader.rs:1877-1904): OTel rows start after shutdown-1, so the first
	// interval with OTel rows is shutdown-2's; OTel holds 3 calls to its 2 and
	// replaces it, leaving otelAfter at shutdown-1.
	late := Reconcile(ReconcileInput{
		Entries: entries,
		OTelEntries: []Entry{
			otelCall("s", "2026-01-02T20:00:00.000Z"),
			otelCall("s", "2026-01-02T21:00:00.000Z"),
			otelCall("s", "2026-01-03T09:00:00.000Z"),
		},
	})
	if after := late.OTelAfter[otelKey("s", "test-model")]; after != msAt(t, "2026-01-02T10:00:00.000Z") {
		t.Fatalf("otelAfter = %d, want shutdown-1", after)
	}
	if len(late.Intervals) != 1 || late.Intervals[0].Input != 200 {
		t.Fatalf("intervals = %+v, want only shutdown-1", late.Intervals)
	}

	// keeps_shutdown_intervals_when_otel_has_no_calls_they_miss
	// (loader.rs:1906-1933): OTel holds exactly the calls the intervals
	// report, so nothing is replaced and otelAfter is the last shutdown.
	exact := Reconcile(ReconcileInput{
		Entries: entries,
		OTelEntries: []Entry{
			otelCall("s", "2026-01-02T09:00:00.000Z"),
			otelCall("s", "2026-01-02T09:30:00.000Z"),
			otelCall("s", "2026-01-03T09:00:00.000Z"),
			otelCall("s", "2026-01-03T11:00:00.000Z"),
		},
	})
	if after := exact.OTelAfter[otelKey("s", "test-model")]; after != msAt(t, "2026-01-03T10:00:00.000Z") {
		t.Fatalf("otelAfter = %d, want the last shutdown", after)
	}
	if len(exact.Intervals) != 2 || exact.Intervals[1].Input != 300 || exact.Intervals[1].RequestCount != 2 {
		t.Fatalf("intervals = %+v, want both shutdown intervals", exact.Intervals)
	}

	// Concurrency (loader.rs:1935-1964): process B shuts down first with the
	// breakdown of shutdown-1, then A's shutdown reports A's two calls. OTel
	// holds 3 calls against intervals 1 + 2, so nothing is replaced and the
	// zero-valued B interval does not survive while shutdown-1's does.
	concurrent := Reconcile(ReconcileInput{
		Entries: []Entry{
			shutdownEntry(t, "s", "shutdown-1", "2026-01-02T10:00:00.000Z", 100, 10, 0, 0, 0, 1, 0),
			shutdownEntry(t, "s", "shutdown-b", "2026-01-02T10:55:00.000Z", 100, 10, 0, 0, 0, 1, 0),
			shutdownEntry(t, "s", "shutdown-a", "2026-01-02T11:00:00.000Z", 300, 30, 0, 0, 0, 3, 0),
		},
		OTelEntries: []Entry{
			otelCall("s", "2026-01-02T09:00:00.000Z"),
			otelCall("s", "2026-01-02T10:40:00.000Z"),
			otelCall("s", "2026-01-02T10:50:00.000Z"),
		},
	})
	if after := concurrent.OTelAfter[otelKey("s", "test-model")]; after != msAt(t, "2026-01-02T11:00:00.000Z") {
		t.Fatalf("otelAfter = %d, want the last shutdown", after)
	}
	if len(concurrent.Intervals) != 2 || concurrent.Intervals[1].Input != 200 || concurrent.Intervals[1].RequestCount != 2 {
		t.Fatalf("intervals = %+v, want shutdown-1 and shutdown-a's 200-token interval", concurrent.Intervals)
	}

	// leaves_shutdowns_without_request_counts_to_the_shutdown_breakdown
	// (loader.rs:1966-1989): a zero request count makes the comparison
	// impossible, so nothing is replaced.
	noCounts := Reconcile(ReconcileInput{
		Entries:     []Entry{shutdownEntry(t, "s", "shutdown-1", "2026-01-02T10:00:00.000Z", 100, 0, 0, 0, 0, 0, 0)},
		OTelEntries: []Entry{otelCall("s", "2026-01-02T09:00:00.000Z"), otelCall("s", "2026-01-02T09:30:00.000Z")},
	})
	if len(noCounts.Intervals) != 1 || noCounts.OTelAfter[otelKey("s", "test-model")] != msAt(t, "2026-01-02T10:00:00.000Z") {
		t.Fatalf("intervals = %+v / otelAfter = %v, want the shutdown kept", noCounts.Intervals, noCounts.OTelAfter)
	}
}

// TestCopilotOtelReplacementIgnoresWindow mirrors
// otel_reconciliation_does_not_depend_on_the_date_range (loader.rs:1854-1875):
// the replacement decision counts every shutdown and every OTel call. A window
// changes only which snapshots are visible afterwards, so the same crash
// replacement must appear under every window.
func TestCopilotOtelReplacementIgnoresWindow(t *testing.T) {
	entries := []Entry{
		shutdownEntry(t, "s", "shutdown-1", "2026-01-02T10:00:00.000Z", 200, 20, 0, 0, 0, 2, 0),
		shutdownEntry(t, "s", "shutdown-2", "2026-01-03T10:00:00.000Z", 500, 50, 0, 0, 0, 4, 0),
	}
	// Two calls in the first interval and three in the second: OTel is short by
	// one, and the same verdict must hold with and without a --since.
	otel := []Entry{
		otelCall("s", "2026-01-02T09:00:00.000Z"),
		otelCall("s", "2026-01-02T09:30:00.000Z"),
		otelCall("s", "2026-01-03T08:00:00.000Z"),
		otelCall("s", "2026-01-03T09:00:00.000Z"),
		otelCall("s", "2026-01-03T11:00:00.000Z"),
	}
	since := msAt(t, "2026-01-03T00:00:00.000Z")
	for index, input := range []ReconcileInput{
		{Entries: entries, OTelEntries: otel},
		{Entries: entries, OTelEntries: otel, SinceMs: &since},
	} {
		result := Reconcile(input)
		if after := result.OTelAfter[otelKey("s", "test-model")]; after != msAt(t, "2026-01-03T10:00:00.000Z") {
			t.Fatalf("window %d: otelAfter = %d, want the last shutdown", index, after)
		}
	}
}

// otelCall is one `test-model` OTel call of session s with one input token.
func otelCall(session, timestamp string) Entry {
	return Entry{
		Timestamp:     mustFixtureTime(timestamp),
		TimestampText: timestamp,
		SessionID:     session,
		Model:         "test-model",
		Input:         1,
		Output:        1,
		RequestCount:  1,
	}
}

func mustFixtureTime(text string) int64 {
	millis, ok := parseFixtureTime(text)
	if !ok {
		panic("bad fixture timestamp " + text)
	}
	return millis
}

// TestCopilotCreditGapCalculateModeHasNoCost pins
// calculate_mode_does_not_price_credit_only_entries (loader.rs:1735-1752): a
// credit gap keeps its own cost whatever the mode - it is a reported cost, not
// a computed one.
func TestCopilotCreditGapCalculateModeHasNoCost(t *testing.T) {
	result := Reconcile(ReconcileInput{Snapshots: []CreditSnapshot{
		checkpointSnapshot(t, "s", "checkpoint-1", "2026-01-02T10:00:00.000Z", 20),
	}})
	if len(result.Gaps) != 1 {
		t.Fatalf("gaps = %+v, want one", result.Gaps)
	}
	gap := result.Gaps[0]
	if gap.Model != "unknown" || gap.Input != 0 || gap.Output != 0 || gap.CacheRead != 0 ||
		gap.CacheCreation != 0 || gap.Reasoning != 0 || gap.Extra != 0 || gap.RequestCount != 0 {
		t.Fatalf("gap = %+v, want model unknown and zero tokens", gap)
	}
	if gap.CostUSD == nil || !floatNear(*gap.CostUSD, 0.2) || gap.NanoAiu != 20*nanoPerCredit {
		t.Fatalf("gap cost = %v nano = %d, want 0.2 / 20 credits", gap.CostUSD, gap.NanoAiu)
	}
	if gap.DedupKey != "credits:s:checkpoint-1" {
		t.Fatalf("gap dedup key = %q", gap.DedupKey)
	}
}

// TestCopilotRawWindowConvertsInTheReportTimezone pins loader.rs:81-85: the
// reconciliation turns its string bounds into milliseconds in the REPORT
// timezone, not the host's. 2026-01-03T10:00Z and 12:00Z are 2026-01-04 02:00
// and 04:00 in Pacific/Auckland (UTC+13 in January). --since 20260104 therefore
// keeps the checkpoint and reports its 01-04 gap, while --until 20260103 ends
// at 2026-01-04T00:00 Auckland = 2026-01-03T11:00Z and drops it for a host that
// resolves the same spelling to 01-04T00:00Z (the UTCMs case below, the host
// zone in CI), which would keep it.
func TestCopilotRawWindowConvertsInTheReportTimezone(t *testing.T) {
	snapshots := []CreditSnapshot{
		shutdownSnapshot(t, "s", "shutdown-1", "2026-01-03T10:00:00.000Z", credits(30)),
		checkpointSnapshot(t, "s", "checkpoint-1", "2026-01-03T12:00:00.000Z", 50),
	}
	entries := []Entry{usageShutdown(t, "s", "shutdown-1", "2026-01-03T10:00:00.000Z", 10*nanoPerCredit)}
	auckland := Reconcile(ReconcileInput{
		Entries: entries, Snapshots: snapshots, Since: "20260104", Timezone: "Pacific/Auckland",
	})
	requireRows(t, creditRows(auckland, "Pacific/Auckland"), []string{"2026-01-04 unknown 0 20"})

	utcEnd := msAt(t, "2026-01-04T00:00:00.000Z")
	if bound := Reconcile(ReconcileInput{
		Entries: entries, Snapshots: snapshots, UntilMs: &utcEnd,
	}); len(bound.Gaps) != 2 || bound.Gaps[1].DedupKey != "credits:s:checkpoint-1" {
		t.Fatalf("gaps against the UTC end bound = %+v, want the 01-04 checkpoint", bound.Gaps)
	}
	earlier := Reconcile(ReconcileInput{
		Entries: entries, Snapshots: snapshots, Until: "20260103", Timezone: "Pacific/Auckland",
	})
	if len(earlier.Gaps) != 1 || earlier.Gaps[0].DedupKey != "credits:s:shutdown-1" {
		t.Fatalf("gaps = %+v, want only the pre-window 01-03 shutdown gap", earlier.Gaps)
	}
	partial := Reconcile(ReconcileInput{
		Entries: []Entry{
			shutdownEntry(t, "s", "a", "2026-01-01T00:00:00.000Z", 10, 0, 0, 0, 0, 0, 0),
			shutdownEntry(t, "s", "b", "2026-01-11T00:00:00.000Z", 20, 0, 0, 0, 0, 0, 0),
		},
		Since: "202601", Timezone: "Pacific/Auckland",
	})
	if len(partial.Intervals) != 2 {
		t.Fatalf("partial since: intervals = %+v, want both (no millisecond bound)", partial.Intervals)
	}
}

// floatNear compares two costs at the 1e-9 absolute precision the fixtures'
// decimal amounts need.
func floatNear(got float64, want float64) bool {
	return math.Abs(got-want) < 1e-9
}

// TestCopilotCreditGapCostIsADivision pins credit_gap_entry's arithmetic
// (loader.rs:374, `nano_aiu as f64 / 1e11`): the dollars are a division, not a
// multiply by the reciprocal. The two differ in the last bit for 38% of small
// nano values, and that bit reaches snapshotHash.
func TestCopilotCreditGapCostIsADivision(t *testing.T) {
	for _, nano := range []uint64{5_000_000_000, 11_000_000_000, 107_200_000_000, 9_999_999_999} {
		got := *creditGapEntry(CreditSnapshot{}, nano).CostUSD
		want := float64(nano) / 1e11
		if math.Float64bits(got) != math.Float64bits(want) {
			t.Fatalf("cost(%d) = %v (0x%x), want the division's %v (0x%x)",
				nano, got, math.Float64bits(got), want, math.Float64bits(want))
		}
	}
}
