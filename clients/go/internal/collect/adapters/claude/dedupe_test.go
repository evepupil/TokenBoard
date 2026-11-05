package claude

// The dedupe index decides which entries are one response's usage. Every case
// here ports an upstream regression test - rust/adapters/claude/src/lib.rs
// 1257-1580 (entry chain) and rust/adapters/claude/src/daily.rs 681-1140
// (daily chain) - with the Rust fixtures rewritten as Entry literals so each
// case states exactly the fields the index reads.

import (
	"fmt"
	"sort"
	"strings"
	"testing"
	"time"
)

// dedupeBaseMs is the fixture instant of lib.rs:1579 (1_775_000_000_000 ms).
const dedupeBaseMs int64 = 1_775_000_000_000

// dedupeFixture carries the Entry fields the dedupe index reads, with the same
// defaults as UsageEntryFixture (lib.rs:1547-1575) and DailyEntryFixture
// (daily.rs:1141-1170).
type dedupeFixture struct {
	messageID     string
	requestID     string
	sessionID     string // serialized sessionId; "" means the line omitted it
	pathSessionID string
	sidechain     bool
	input         int64
	output        int64
	cacheRead     int64
	cost          float64
	speed         string
	atMs          int64 // 0 keeps the upstream fixture instant
}

func dedupeEntry(f dedupeFixture) Entry {
	atMs := f.atMs
	if atMs == 0 {
		atMs = dedupeBaseMs
	}
	return Entry{
		MessageID:     f.messageID,
		RequestID:     f.requestID,
		SessionID:     f.sessionID,
		PathSessionID: f.pathSessionID,
		Sidechain:     f.sidechain,
		Timestamp:     time.UnixMilli(atMs),
		Model:         "claude-sonnet-4-20250514",
		Cost:          f.cost,
		Usage: Usage{
			Input:     f.input,
			Output:    f.output,
			CacheRead: f.cacheRead,
			Speed:     f.speed,
		},
	}
}

// dedupeRun adds entries in the given order and returns the survivors.
func dedupeRun(mode DedupeMode, entries ...Entry) []Entry {
	dedupe := NewDedupe(mode)
	for _, entry := range entries {
		dedupe.Add(entry)
	}
	return dedupe.Entries()
}

func requireSurvivorCount(t *testing.T, entries []Entry, want int) {
	t.Helper()
	if len(entries) != want {
		t.Fatalf("survivors = %d, want %d (%+v)", len(entries), want, dedupeSignatures(entries))
	}
}

func dedupeSignatures(entries []Entry) []string {
	signatures := make([]string, 0, len(entries))
	for _, entry := range entries {
		signatures = append(signatures, survivorSignature(entry))
	}
	return signatures
}

// survivorSignature names the payload a survivor carries, which is what the
// replacement ladder can change. Session identity is excluded on purpose: a
// cross-session replacement legitimately swaps which session's copy survives.
func survivorSignature(entry Entry) string {
	return fmt.Sprintf("%s|%s|%t|%d|%d|%d|%s",
		entry.MessageID, entry.RequestID, entry.Sidechain,
		entry.Usage.Input, entry.Usage.Output, entry.Usage.CacheRead, entry.Usage.Speed)
}

func permutations(entries []Entry) [][]Entry {
	if len(entries) <= 1 {
		return [][]Entry{append([]Entry(nil), entries...)}
	}
	result := [][]Entry{}
	for index := range entries {
		rest := make([]Entry, 0, len(entries)-1)
		rest = append(rest, entries[:index]...)
		rest = append(rest, entries[index+1:]...)
		for _, tail := range permutations(rest) {
			result = append(result, append([]Entry{entries[index]}, tail...))
		}
	}
	return result
}

func TestDedupeKeyUsesRequestIDWhenPresent(t *testing.T) {
	// lib.rs:1332 dedupes_copied_transcripts_with_the_same_request_id_across_sessions:
	// a matching message id plus request id identifies one response across
	// sessions and timestamps.
	survivors := dedupeRun(DedupeEntry,
		dedupeEntry(dedupeFixture{messageID: "msg-shared", requestID: "req-shared", sessionID: "session-a", output: 1}),
		dedupeEntry(dedupeFixture{messageID: "msg-shared", requestID: "req-shared", sessionID: "session-b", atMs: dedupeBaseMs + 1000, output: 2}),
	)
	requireSurvivorCount(t, survivors, 1)
	if survivors[0].Usage.Output != 2 {
		t.Errorf("survivor output = %d, want 2 (the larger copy)", survivors[0].Usage.Output)
	}

	// A distinct request id under the same message id is a distinct response.
	survivors = dedupeRun(DedupeEntry,
		dedupeEntry(dedupeFixture{messageID: "msg-shared", requestID: "req-one", sessionID: "session-a", output: 1}),
		dedupeEntry(dedupeFixture{messageID: "msg-shared", requestID: "req-two", sessionID: "session-a", output: 2}),
	)
	requireSurvivorCount(t, survivors, 2)
}

func TestDedupeKeyFallsBackToSessionAndTimestampOnlyForNonMsgIDs(t *testing.T) {
	cases := []struct {
		name      string
		mode      DedupeMode
		entries   []Entry
		want      int
		wantExtra func(*testing.T, []Entry)
	}{
		{
			// usage_dedupe_hash (lib.rs:350-373): a requestless non-msg_ id
			// keeps the timestamp, so gateway ids reused per response survive.
			name: "requestless non-msg id keeps the timestamp in the key",
			mode: DedupeEntry,
			entries: []Entry{
				dedupeEntry(dedupeFixture{messageID: "ocgo", sessionID: "session-a", output: 10}),
				dedupeEntry(dedupeFixture{messageID: "ocgo", sessionID: "session-a", atMs: dedupeBaseMs + 1000, output: 20}),
			},
			want: 2,
		},
		{
			// daily.rs:857 keeps_timestamp_different_requestless_daily_entries_without_sidechain.
			name: "daily requestless non-msg id keeps the timestamp in the key",
			mode: DedupeDaily,
			entries: []Entry{
				dedupeEntry(dedupeFixture{messageID: "ocgo", sessionID: "session-a", output: 10}),
				dedupeEntry(dedupeFixture{messageID: "ocgo", sessionID: "session-a", atMs: dedupeBaseMs + 1000, output: 20}),
			},
			want: 2,
		},
		{
			// lib.rs:1257 dedupes_anthropic_message_id_from_same_session_at_distinct_timestamps:
			// a msg_ id is unique per response, so Claude Code's one-line-per-content-block
			// writes collapse by session across timestamps.
			name: "requestless msg_ id collapses across timestamps",
			mode: DedupeEntry,
			entries: []Entry{
				dedupeEntry(dedupeFixture{messageID: "msg_01AbC2DeF3", sessionID: "session-a", output: 25}),
				dedupeEntry(dedupeFixture{messageID: "msg_01AbC2DeF3", sessionID: "session-a", atMs: dedupeBaseMs + 500, output: 25}),
			},
			want: 1,
		},
		{
			// daily.rs:900 dedupes_anthropic_message_id_from_same_session_at_distinct_timestamps.
			name: "daily requestless msg_ id collapses across timestamps",
			mode: DedupeDaily,
			entries: []Entry{
				dedupeEntry(dedupeFixture{messageID: "msg_01AbC2DeF3", sessionID: "session-a", output: 25}),
				dedupeEntry(dedupeFixture{messageID: "msg_01AbC2DeF3", sessionID: "session-a", atMs: dedupeBaseMs + 500, output: 25}),
			},
			want: 1,
		},
		{
			// The session is always in the key when there is no request id,
			// so a reused id in another session is another response.
			name: "requestless non-msg id keeps the session in the key",
			mode: DedupeEntry,
			entries: []Entry{
				dedupeEntry(dedupeFixture{messageID: "ocgo", sessionID: "session-a", input: 100, output: 1}),
				dedupeEntry(dedupeFixture{messageID: "ocgo", sessionID: "session-b", input: 300, output: 1}),
			},
			want: 2,
		},
		{
			// daily.rs:828 keeps_gateway_daily_usage_from_distinct_sessions_with_reused_message_id.
			name: "daily requestless non-msg id keeps the session in the key",
			mode: DedupeDaily,
			entries: []Entry{
				dedupeEntry(dedupeFixture{messageID: "ocgo", sessionID: "session-a", input: 100, output: 1}),
				dedupeEntry(dedupeFixture{messageID: "ocgo", sessionID: "session-b", input: 300, output: 1}),
			},
			want: 2,
			wantExtra: func(t *testing.T, entries []Entry) {
				t.Helper()
				var total int64
				for _, entry := range entries {
					total += entry.Usage.Input
				}
				if total != 400 {
					t.Errorf("input total = %d, want 400", total)
				}
			},
		},
		{
			name: "requestless msg_ id keeps the session in the key",
			mode: DedupeEntry,
			entries: []Entry{
				dedupeEntry(dedupeFixture{messageID: "msg_shared", sessionID: "session-a", output: 1}),
				dedupeEntry(dedupeFixture{messageID: "msg_shared", sessionID: "session-b", output: 2}),
			},
			want: 2,
		},
		{
			// lib.rs:1283 dedupes_repeated_requestless_writes_at_the_same_timestamp:
			// same id, session and timestamp is one entry; the bigger total wins.
			name: "requestless non-msg id at the same timestamp merges",
			mode: DedupeEntry,
			entries: []Entry{
				dedupeEntry(dedupeFixture{messageID: "ocgo", sessionID: "session-a", output: 10}),
				dedupeEntry(dedupeFixture{messageID: "ocgo", sessionID: "session-a", output: 20}),
			},
			want: 1,
			wantExtra: func(t *testing.T, entries []Entry) {
				t.Helper()
				if entries[0].Usage.Output != 20 {
					t.Errorf("survivor output = %d, want 20", entries[0].Usage.Output)
				}
			},
		},
		{
			// loaded_entry_session_id (lib.rs:405-411): without a serialized
			// sessionId the key uses the path-derived session id.
			name: "requestless entry without a serialized session falls back to the path session",
			mode: DedupeEntry,
			entries: []Entry{
				dedupeEntry(dedupeFixture{messageID: "msg_shared", pathSessionID: "session-a", output: 25}),
				dedupeEntry(dedupeFixture{messageID: "msg_shared", pathSessionID: "session-a", atMs: dedupeBaseMs + 500, output: 25}),
			},
			want: 1,
		},
		{
			name: "requestless entries in different path sessions stay apart",
			mode: DedupeEntry,
			entries: []Entry{
				dedupeEntry(dedupeFixture{messageID: "msg_shared", pathSessionID: "session-a", output: 25}),
				dedupeEntry(dedupeFixture{messageID: "msg_shared", pathSessionID: "session-b", output: 25}),
			},
			want: 2,
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			survivors := dedupeRun(testCase.mode, testCase.entries...)
			requireSurvivorCount(t, survivors, testCase.want)
			if testCase.wantExtra != nil {
				testCase.wantExtra(t, survivors)
			}
		})
	}
}

func TestDedupeMergesDuplicateAcrossFiles(t *testing.T) {
	// lib.rs:1309 dedupes_copied_transcripts_with_the_same_serialized_session_id
	// (daily.rs:983 is the same case on the daily chain) pins the priority of
	// loaded_entry_session_id (lib.rs:405-411): both lines are requestless with
	// the gateway-style id "ocgo" and both serialize the SAME sessionId, while
	// the path-derived ids differ because the copies sit in two project
	// directories. Only the serialized id makes the keys equal - under a
	// path-first rule the sessions would differ and the non-msg_ timestamp
	// rule would keep them apart. The survivor is the bigger copy.
	first := dedupeEntry(dedupeFixture{
		messageID: "ocgo", sessionID: "session-a", pathSessionID: "session-a", input: 100, output: 1,
	})
	second := dedupeEntry(dedupeFixture{
		messageID: "ocgo", sessionID: "session-a", pathSessionID: "session-b", input: 200, output: 1,
	})

	for _, mode := range []DedupeMode{DedupeEntry, DedupeDaily} {
		survivors := dedupeRun(mode, first, second)
		requireSurvivorCount(t, survivors, 1)
		if survivors[0].Usage.Input != 200 {
			t.Errorf("mode %d: survivor input = %d, want 200", mode, survivors[0].Usage.Input)
		}
	}
}

func TestSidechainReplayMergesOnNewRequestID(t *testing.T) {
	// lib.rs:1450 keeps_parent_usage_when_sidechain_replays_message_with_new_request_id.
	survivors := dedupeRun(DedupeEntry,
		dedupeEntry(dedupeFixture{messageID: "msg-parent", requestID: "req-parent", sessionID: "session-a", output: 10, cacheRead: 20}),
		dedupeEntry(dedupeFixture{messageID: "msg-parent", requestID: "req-sidechain-replay", sessionID: "session-a", sidechain: true, output: 10, cacheRead: 50_000}),
		dedupeEntry(dedupeFixture{messageID: "msg-sidechain-answer", requestID: "req-sidechain-answer", sessionID: "session-a", sidechain: true, output: 30, cacheRead: 700}),
	)
	requireSurvivorCount(t, survivors, 2)
	if survivors[0].RequestID != "req-parent" || survivors[0].Usage.CacheRead != 20 {
		t.Errorf("first survivor = %s, want the parent (req-parent, cache read 20)", survivorSignature(survivors[0]))
	}
	if survivors[1].MessageID != "msg-sidechain-answer" || survivors[1].Usage.CacheRead != 700 {
		t.Errorf("second survivor = %s, want msg-sidechain-answer with cache read 700", survivorSignature(survivors[1]))
	}
}

func TestDailyDedupCostTieBreakBeatsSpeedRung(t *testing.T) {
	// daily.rs:592-596 inserts the cost rung between the token total and the
	// speed rung: equal totals, different costs, the larger cost wins even when
	// the other candidate is the one carrying a speed.
	cheapFast := dedupeEntry(dedupeFixture{messageID: "msg-x", requestID: "req-x", sessionID: "session-a", output: 10, cost: 0.10, speed: "standard"})
	expensivePlain := dedupeEntry(dedupeFixture{messageID: "msg-x", requestID: "req-x", sessionID: "session-a", output: 10, cost: 0.20})

	for _, order := range [][]Entry{{cheapFast, expensivePlain}, {expensivePlain, cheapFast}} {
		survivors := dedupeRun(DedupeDaily, order...)
		requireSurvivorCount(t, survivors, 1)
		if survivors[0].Cost != 0.20 {
			t.Errorf("survivor cost = %v, want 0.20 regardless of add order", survivors[0].Cost)
		}
	}
}

func TestEntryDedupDoesNotUseCostRung(t *testing.T) {
	// lib.rs:198-212 has no cost rung: with equal totals and equal (absent)
	// speed, the first-seen entry wins no matter the cost.
	cheap := dedupeEntry(dedupeFixture{messageID: "msg-x", requestID: "req-x", sessionID: "session-a", output: 10, cost: 0.10})
	expensive := dedupeEntry(dedupeFixture{messageID: "msg-x", requestID: "req-x", sessionID: "session-a", output: 10, cost: 0.90})

	survivors := dedupeRun(DedupeEntry, cheap, expensive)
	requireSurvivorCount(t, survivors, 1)
	if survivors[0].Cost != 0.10 {
		t.Errorf("survivor cost = %v, want 0.10 (first-seen)", survivors[0].Cost)
	}

	survivors = dedupeRun(DedupeEntry, expensive, cheap)
	requireSurvivorCount(t, survivors, 1)
	if survivors[0].Cost != 0.90 {
		t.Errorf("survivor cost = %v, want 0.90 (first-seen)", survivors[0].Cost)
	}
}

func TestDailySidechainMatchIgnoresTimestampEntryMatchRequiresIt(t *testing.T) {
	// daily.rs:486-498 drops the timestamp condition; lib.rs:427-440 keeps it
	// for replays that carry a new request id.
	parent := dedupeEntry(dedupeFixture{messageID: "msg-parent", requestID: "req-parent", sessionID: "session-a", output: 10, cacheRead: 20})
	replay := dedupeEntry(dedupeFixture{messageID: "msg-parent", requestID: "req-sidechain-replay", sessionID: "session-a", sidechain: true, output: 10, cacheRead: 50_000, atMs: dedupeBaseMs + 1000})

	// daily.rs:731 dedupes_timestamp_different_daily_sidechain_replay_with_parent.
	dailySurvivors := dedupeRun(DedupeDaily, parent, replay)
	requireSurvivorCount(t, dailySurvivors, 1)
	if dailySurvivors[0].RequestID != "req-parent" || dailySurvivors[0].Usage.CacheRead != 20 {
		t.Errorf("daily survivor = %s, want the parent", survivorSignature(dailySurvivors[0]))
	}

	entrySurvivors := dedupeRun(DedupeEntry, parent, replay)
	requireSurvivorCount(t, entrySurvivors, 2)
}

func TestDailyKeepsParentUsageWhenSidechainReplaysWithNewRequestID(t *testing.T) {
	// daily.rs:681 keeps_parent_daily_usage_when_sidechain_replays_message_with_new_request_id:
	// the same sequence as the entry-chain case above, on the daily chain.
	survivors := dedupeRun(DedupeDaily,
		dedupeEntry(dedupeFixture{messageID: "msg-parent", requestID: "req-parent", sessionID: "session-a", output: 10, cacheRead: 20}),
		dedupeEntry(dedupeFixture{messageID: "msg-parent", requestID: "req-sidechain-replay", sessionID: "session-a", sidechain: true, output: 10, cacheRead: 50_000}),
		dedupeEntry(dedupeFixture{messageID: "msg-sidechain-answer", requestID: "req-sidechain-answer", sessionID: "session-a", sidechain: true, output: 30, cacheRead: 700}),
	)
	requireSurvivorCount(t, survivors, 2)
	if survivors[0].RequestID != "req-parent" || survivors[0].Usage.CacheRead != 20 {
		t.Errorf("first survivor = %s, want the parent (req-parent, cache read 20)", survivorSignature(survivors[0]))
	}
	if survivors[1].MessageID != "msg-sidechain-answer" || survivors[1].Usage.CacheRead != 700 {
		t.Errorf("second survivor = %s, want msg-sidechain-answer with cache read 700", survivorSignature(survivors[1]))
	}
}

func TestEntrySidechainMatchRequestlessNeedsBothSides(t *testing.T) {
	// lib.rs:427-440: `requestless` is true only when NEITHER side carries a
	// request id; that is what lets a replay cross timestamps. A stale
	// implementation that tested the candidate alone would over-merge the
	// second case.
	t.Run("both sides requestless cross timestamps", func(t *testing.T) {
		survivors := dedupeRun(DedupeEntry,
			dedupeEntry(dedupeFixture{messageID: "ocgo", sessionID: "session-a", output: 10, cacheRead: 20}),
			dedupeEntry(dedupeFixture{messageID: "ocgo", sessionID: "session-a", sidechain: true, output: 10, cacheRead: 50_000, atMs: dedupeBaseMs + 1000}),
		)
		requireSurvivorCount(t, survivors, 1)
		if survivors[0].Sidechain || survivors[0].Usage.CacheRead != 20 {
			t.Errorf("survivor = %s, want the parent", survivorSignature(survivors[0]))
		}
	})

	t.Run("requestless candidate against a parent with a request id needs the timestamp", func(t *testing.T) {
		survivors := dedupeRun(DedupeEntry,
			dedupeEntry(dedupeFixture{messageID: "msg-parent", requestID: "req-parent", sessionID: "session-a", output: 10, cacheRead: 20}),
			dedupeEntry(dedupeFixture{messageID: "msg-parent", sessionID: "session-a", sidechain: true, output: 10, cacheRead: 50_000, atMs: dedupeBaseMs + 1000}),
		)
		requireSurvivorCount(t, survivors, 2)
	})

	t.Run("candidate with a request id against a requestless parent needs the timestamp", func(t *testing.T) {
		survivors := dedupeRun(DedupeEntry,
			dedupeEntry(dedupeFixture{messageID: "ocgo", sessionID: "session-a", output: 10, cacheRead: 20}),
			dedupeEntry(dedupeFixture{messageID: "ocgo", requestID: "req-replay", sessionID: "session-a", sidechain: true, output: 10, cacheRead: 50_000, atMs: dedupeBaseMs + 1000}),
		)
		requireSurvivorCount(t, survivors, 2)
	})
}

func TestDedupeAliasDistinguishesAnEmptySessionFromNoAlias(t *testing.T) {
	// Upstream stores session_alias: Option<Arc<str>> (lib.rs:40-43), so an
	// alias for the empty session id is still an alias. A "" sentinel would
	// read it as "no alias", fall back to the survivor's own session id and
	// miss the replay, counting the response twice. A caller that forgets to
	// fill PathSessionID lands exactly here (dedupeSessionID == "").
	survivors := dedupeRun(DedupeEntry,
		// Survivor candidate in the empty session, replaced by the bigger copy.
		dedupeEntry(dedupeFixture{messageID: "msg-parent", requestID: "req-parent", output: 10, cacheRead: 20}),
		dedupeEntry(dedupeFixture{messageID: "msg-parent", requestID: "req-parent", sessionID: "session-a", output: 10, cacheRead: 30}),
		// The replay arrives in the losing (empty) session and can only be
		// routed by the "" alias registered before the replacement.
		dedupeEntry(dedupeFixture{messageID: "msg-parent", requestID: "req-sidechain-replay", sidechain: true, output: 10, cacheRead: 50_000}),
	)
	requireSurvivorCount(t, survivors, 1)
	if survivors[0].SessionID != "session-a" || survivors[0].Usage.CacheRead != 30 {
		t.Errorf("survivor = %s from %q, want the bigger session-a copy", survivorSignature(survivors[0]), survivors[0].SessionID)
	}
}

func TestDedupeSpeedRungReplacesOnlyWhenTokensTie(t *testing.T) {
	// lib.rs:211: a candidate that carries a speed replaces a speedless one
	// only after the sidechain and token rungs tie.
	plain := dedupeEntry(dedupeFixture{messageID: "msg-x", requestID: "req-x", sessionID: "session-a", output: 10})
	fast := dedupeEntry(dedupeFixture{messageID: "msg-x", requestID: "req-x", sessionID: "session-a", output: 10, speed: "standard"})

	survivors := dedupeRun(DedupeEntry, plain, fast)
	requireSurvivorCount(t, survivors, 1)
	if survivors[0].Usage.Speed != "standard" {
		t.Errorf("survivor speed = %q, want the speed-carrying entry", survivors[0].Usage.Speed)
	}

	survivors = dedupeRun(DedupeEntry, fast, plain)
	requireSurvivorCount(t, survivors, 1)
	if survivors[0].Usage.Speed != "standard" {
		t.Errorf("survivor speed = %q, want the speed-carrying entry", survivors[0].Usage.Speed)
	}

	// The token rung runs first: a bigger speedless candidate still wins.
	bigPlain := dedupeEntry(dedupeFixture{messageID: "msg-x", requestID: "req-x", sessionID: "session-a", output: 20})
	survivors = dedupeRun(DedupeEntry, fast, bigPlain)
	requireSurvivorCount(t, survivors, 1)
	if survivors[0].Usage.Output != 20 {
		t.Errorf("survivor output = %d, want 20 (the bigger total)", survivors[0].Usage.Output)
	}
}

func TestDedupeIsOrderIndependentForTheSurvivorSet(t *testing.T) {
	// Ties are resolved first-seen, so a different add order may keep a
	// different - but equal-payload - survivor. This set is chosen so that
	// every permutation keeps the same payload multiset: an identical copy of
	// the parent in another session, a strictly bigger duplicate, and a speed
	// tie where one side always wins by the speed rung; no sidechain replay is
	// involved, because a replay seen before its parent legitimately changes
	// the outcome (upstream reads files in path order, lib.rs:170-182).
	entries := []Entry{
		dedupeEntry(dedupeFixture{messageID: "msg-p", requestID: "req-p", sessionID: "session-a", output: 10, cacheRead: 20}),
		dedupeEntry(dedupeFixture{messageID: "msg-p", requestID: "req-p", sessionID: "session-b", output: 10, cacheRead: 20}),
		dedupeEntry(dedupeFixture{messageID: "msg-o", requestID: "req-o", sessionID: "session-a", output: 5}),
		dedupeEntry(dedupeFixture{messageID: "msg-d", requestID: "req-d", sessionID: "session-a", output: 10}),
		dedupeEntry(dedupeFixture{messageID: "msg-d", requestID: "req-d", sessionID: "session-a", output: 20}),
		dedupeEntry(dedupeFixture{messageID: "msg-s", requestID: "req-s", sessionID: "session-a", output: 10}),
		dedupeEntry(dedupeFixture{messageID: "msg-s", requestID: "req-s", sessionID: "session-a", output: 10, speed: "standard"}),
	}
	want := dedupeSignatures(dedupeRun(DedupeEntry, entries...))
	sort.Strings(want)
	if len(want) != 4 {
		t.Fatalf("in-order survivors = %d, want 4 (%v)", len(want), want)
	}

	for _, mode := range []DedupeMode{DedupeEntry, DedupeDaily} {
		for _, order := range permutations(entries) {
			got := dedupeSignatures(dedupeRun(mode, order...))
			sort.Strings(got)
			if strings.Join(got, "\n") != strings.Join(want, "\n") {
				t.Fatalf("mode %d, order %v: survivor payloads = %v, want %v",
					mode, order, got, want)
			}
		}
	}
}

func TestCrossSessionCopyKeepsReplayRoute(t *testing.T) {
	t.Run("equal copy from another session", func(t *testing.T) {
		// lib.rs:1355 dedupes_sidechain_replay_after_an_equal_copy_from_another_session:
		// the alias routes registered when the copy matched keep the later
		// replay (in the original session) pointing at the survivor.
		survivors := dedupeRun(DedupeEntry,
			dedupeEntry(dedupeFixture{messageID: "msg-parent", requestID: "req-parent", sessionID: "session-b", output: 10, cacheRead: 20}),
			dedupeEntry(dedupeFixture{messageID: "msg-parent", requestID: "req-parent", sessionID: "session-a", output: 10, cacheRead: 20}),
			dedupeEntry(dedupeFixture{messageID: "msg-parent", requestID: "req-sidechain-replay", sessionID: "session-a", sidechain: true, output: 10, cacheRead: 50_000}),
		)
		requireSurvivorCount(t, survivors, 1)
		if survivors[0].RequestID != "req-parent" || survivors[0].Usage.CacheRead != 20 {
			t.Errorf("survivor = %s, want the parent", survivorSignature(survivors[0]))
		}
	})

	t.Run("cross-session survivor replacement", func(t *testing.T) {
		// lib.rs:1424 dedupes_sidechain_replay_after_cross_session_survivor_replacement:
		// the replay arrives in the losing session, so only the alias route
		// registered before the replacement can still match it.
		survivors := dedupeRun(DedupeEntry,
			dedupeEntry(dedupeFixture{messageID: "msg-parent", requestID: "req-parent", sessionID: "session-b", output: 10, cacheRead: 20}),
			dedupeEntry(dedupeFixture{messageID: "msg-parent", requestID: "req-parent", sessionID: "session-a", output: 10, cacheRead: 30}),
			dedupeEntry(dedupeFixture{messageID: "msg-parent", requestID: "req-sidechain-replay", sessionID: "session-b", sidechain: true, output: 10, cacheRead: 50_000}),
		)
		requireSurvivorCount(t, survivors, 1)
		if survivors[0].SessionID != "session-a" || survivors[0].Usage.CacheRead != 30 {
			t.Errorf("survivor = %s from %q, want the bigger session-a copy", survivorSignature(survivors[0]), survivors[0].SessionID)
		}
	})
}

func TestDailyCrossSessionReplayRoutes(t *testing.T) {
	t.Run("equal copy from another session", func(t *testing.T) {
		// daily.rs:1029 dedupes_daily_sidechain_replay_after_an_equal_copy_from_another_session.
		survivors := dedupeRun(DedupeDaily,
			dedupeEntry(dedupeFixture{messageID: "msg-parent", requestID: "req-parent", sessionID: "session-b", output: 10, cacheRead: 20}),
			dedupeEntry(dedupeFixture{messageID: "msg-parent", requestID: "req-parent", sessionID: "session-a", output: 10, cacheRead: 20}),
			dedupeEntry(dedupeFixture{messageID: "msg-parent", requestID: "req-sidechain-replay", sessionID: "session-a", sidechain: true, output: 10, cacheRead: 50_000}),
		)
		requireSurvivorCount(t, survivors, 1)
		if survivors[0].RequestID != "req-parent" || survivors[0].Usage.CacheRead != 20 {
			t.Errorf("survivor = %s, want the parent", survivorSignature(survivors[0]))
		}
	})

	t.Run("cross-session survivor replacement", func(t *testing.T) {
		// daily.rs:1085 dedupes_daily_sidechain_replay_after_cross_session_survivor_replacement.
		survivors := dedupeRun(DedupeDaily,
			dedupeEntry(dedupeFixture{messageID: "msg-parent", requestID: "req-parent", sessionID: "session-b", output: 10, cacheRead: 20}),
			dedupeEntry(dedupeFixture{messageID: "msg-parent", requestID: "req-parent", sessionID: "session-a", output: 10, cacheRead: 30}),
			dedupeEntry(dedupeFixture{messageID: "msg-parent", requestID: "req-sidechain-replay", sessionID: "session-b", sidechain: true, output: 10, cacheRead: 50_000}),
		)
		requireSurvivorCount(t, survivors, 1)
		if survivors[0].SessionID != "session-a" || survivors[0].Usage.CacheRead != 30 {
			t.Errorf("survivor = %s from %q, want the bigger session-a copy", survivorSignature(survivors[0]), survivors[0].SessionID)
		}
	})

	t.Run("replay from a distinct session without an alias stays separate", func(t *testing.T) {
		// daily.rs:937 keeps_daily_sidechain_replay_from_distinct_session.
		survivors := dedupeRun(DedupeDaily,
			dedupeEntry(dedupeFixture{messageID: "msg-parent", requestID: "req-parent", sessionID: "session-a", output: 10, cacheRead: 20}),
			dedupeEntry(dedupeFixture{messageID: "msg-parent", requestID: "req-sidechain-replay", sessionID: "session-b", sidechain: true, output: 10, cacheRead: 50_000, atMs: dedupeBaseMs + 1000}),
		)
		requireSurvivorCount(t, survivors, 2)
		var cacheRead int64
		for _, entry := range survivors {
			cacheRead += entry.Usage.CacheRead
		}
		if cacheRead != 50_020 {
			t.Errorf("cache read total = %d, want 50020", cacheRead)
		}
	})
}

func TestDedupeRefreshesIndexesWhenParentReplacesSidechainReplay(t *testing.T) {
	// lib.rs:1503 refreshes_dedupe_indexes_when_parent_replaces_sidechain_replay
	// and daily.rs:772: once the parent replaces the replay, the parent's exact
	// key must be indexed or the next identical write is counted twice.
	for _, mode := range []DedupeMode{DedupeEntry, DedupeDaily} {
		survivors := dedupeRun(mode,
			dedupeEntry(dedupeFixture{messageID: "msg-parent", requestID: "req-sidechain-replay", sessionID: "session-a", sidechain: true, output: 10, cacheRead: 50_000}),
			dedupeEntry(dedupeFixture{messageID: "msg-parent", requestID: "req-parent", sessionID: "session-a", output: 10, cacheRead: 20}),
			dedupeEntry(dedupeFixture{messageID: "msg-parent", requestID: "req-parent", sessionID: "session-a", output: 5, cacheRead: 5}),
		)
		if len(survivors) != 1 {
			t.Fatalf("mode %d: survivors = %d, want 1 (%v)", mode, len(survivors), dedupeSignatures(survivors))
		}
		if survivors[0].RequestID != "req-parent" || survivors[0].Usage.CacheRead != 20 {
			t.Errorf("mode %d: survivor = %s, want the parent", mode, survivorSignature(survivors[0]))
		}
	}
}

func TestDedupeEntriesWithoutMessageIDAreKept(t *testing.T) {
	// lib.rs:219: the whole lookup is skipped when message.id is absent, so
	// such entries are appended without ever being indexed or matched.
	entries := []Entry{
		dedupeEntry(dedupeFixture{sessionID: "session-a", output: 10}),
		dedupeEntry(dedupeFixture{sessionID: "session-a", output: 10}),
	}
	survivors := dedupeRun(DedupeEntry, entries...)
	requireSurvivorCount(t, survivors, 2)
}

func TestEntryAndDailyModesDoNotShareState(t *testing.T) {
	entryMode := NewDedupe(DedupeEntry)
	dailyMode := NewDedupe(DedupeDaily)

	first := dedupeEntry(dedupeFixture{messageID: "msg-x", requestID: "req-x", sessionID: "session-a", output: 10, cost: 0.10})
	second := dedupeEntry(dedupeFixture{messageID: "msg-x", requestID: "req-x", sessionID: "session-a", output: 10, cost: 0.90})

	entryMode.Add(first)
	dailyMode.Add(first)
	entryMode.Add(second)
	dailyMode.Add(second)

	if got := entryMode.Entries(); len(got) != 1 || got[0].Cost != 0.10 {
		t.Errorf("entry mode survivors = %+v, want the first-seen entry", got)
	}
	if got := dailyMode.Entries(); len(got) != 1 || got[0].Cost != 0.90 {
		t.Errorf("daily mode survivors = %+v, want the cost rung winner", got)
	}
}

func TestDedupeReturnsSurvivorsInFirstSeenOrder(t *testing.T) {
	survivors := dedupeRun(DedupeEntry,
		dedupeEntry(dedupeFixture{messageID: "msg-b", requestID: "req-b", sessionID: "session-a", output: 1}),
		dedupeEntry(dedupeFixture{messageID: "msg-a", requestID: "req-a", sessionID: "session-a", output: 1}),
		dedupeEntry(dedupeFixture{messageID: "msg-b", requestID: "req-b", sessionID: "session-a", output: 2}),
	)
	requireSurvivorCount(t, survivors, 2)
	if survivors[0].MessageID != "msg-b" || survivors[0].Usage.Output != 2 {
		t.Errorf("first survivor = %s, want the upgraded msg-b", survivorSignature(survivors[0]))
	}
	if survivors[1].MessageID != "msg-a" {
		t.Errorf("second survivor = %s, want msg-a", survivorSignature(survivors[1]))
	}
}

func TestNewDedupeRejectsUnknownModes(t *testing.T) {
	defer func() {
		if recover() == nil {
			t.Fatal("NewDedupe accepted an unknown mode")
		}
	}()
	NewDedupe(DedupeMode(7))
}
