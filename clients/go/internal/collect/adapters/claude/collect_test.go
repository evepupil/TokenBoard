package claude

// The collect entry point ties the five adapter layers together: discovery
// (paths.go), the two line parsers (entry.go), the pricing pass (cost.go), the
// dedupe index (dedupe.go) and the two report builders (daily.go, session.go).
// These tests drive it through real transcript files on disk, so every case
// also pins the wiring the upstream commands do between their layers
// (ccusage claude daily --json --breakdown, ccusage claude session --json;
// commands/mod.rs:33-59, 146-206).

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"
)

// collectNow is the wall clock every prune test runs against: well after the
// fixture dates below, so no window opens in the future.
var collectNow = time.Date(2026, 11, 5, 12, 0, 0, 0, time.UTC)

// collectLine is one direct-shape transcript line with explicit ids, model,
// timestamp, tokens and (when reported is non-nil) a costUSD.
func collectLine(sessionID, messageID, requestID, model, timestamp string, input, output int64, reported *float64) string {
	usage := `{"input_tokens":` + itoa(input) + `,"output_tokens":` + itoa(output) + `}`
	line := `{"sessionId":"` + sessionID + `","version":"2.0.30","timestamp":"` + timestamp + `"`
	if requestID != "" {
		line += `,"requestId":"` + requestID + `"`
	}
	if reported != nil {
		line += `,"costUSD":` + strconv.FormatFloat(*reported, 'f', -1, 64)
	}
	line += `,"message":{"id":"` + messageID + `","model":"` + model + `","usage":` + usage + `}}`
	return line
}

// writeTranscript writes projects/<project>/<session>.jsonl under root, one
// element per line, and pins its mtime to modified. A line is written with a
// trailing newline unless it is named as the unterminated tail.
func writeTranscript(t *testing.T, root, project, session string, modified time.Time, lines ...string) string {
	t.Helper()
	dir := filepath.Join(root, "projects", project)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	path := filepath.Join(dir, session+".jsonl")
	if err := os.WriteFile(path, []byte(strings.Join(lines, "\n")+"\n"), 0o644); err != nil {
		t.Fatalf("write transcript: %v", err)
	}
	if err := os.Chtimes(path, modified, modified); err != nil {
		t.Fatalf("chtimes: %v", err)
	}
	return path
}

func collectRoots(dirs ...string) Roots { return Roots{Dirs: dirs} }

func reportRows(t *testing.T, document map[string]any, key string) []map[string]any {
	t.Helper()
	return reportObjects(t, document, key)
}

func reportTotals(t *testing.T, document map[string]any) map[string]any {
	t.Helper()
	raw, ok := document["totals"]
	if !ok {
		t.Fatalf("report has no totals: %v", document)
	}
	totals, ok := raw.(map[string]any)
	if !ok {
		t.Fatalf("totals is %T, want an object", raw)
	}
	return totals
}

func numberField(t *testing.T, object map[string]any, key string) float64 {
	t.Helper()
	value, ok := object[key].(float64)
	if !ok {
		t.Fatalf("%q is %T, want a number (object: %v)", key, object[key], object)
	}
	return value
}

// collectReport parses one report document, failing when it is nil.
func collectReport(t *testing.T, data []byte) map[string]any {
	t.Helper()
	if data == nil {
		t.Fatalf("report is nil, want a JSON document")
	}
	return decodeReport(t, data)
}

func TestCollectEmptyWindowReturnsEmptyReports(t *testing.T) {
	t.Run("no roots", func(t *testing.T) {
		dailyJSON, sessionsJSON, err := Collect(context.Background(), Options{
			Timezone: "UTC", Roots: Roots{}, Now: collectNow,
		})
		if err != nil {
			t.Fatalf("Collect: %v", err)
		}
		assertEmptyReports(t, dailyJSON, sessionsJSON)
	})

	t.Run("root without projects", func(t *testing.T) {
		root := t.TempDir()
		dailyJSON, sessionsJSON, err := Collect(context.Background(), Options{
			Timezone: "UTC", Roots: collectRoots(root), Now: collectNow,
		})
		if err != nil {
			t.Fatalf("Collect: %v", err)
		}
		assertEmptyReports(t, dailyJSON, sessionsJSON)
	})

	t.Run("empty projects tree", func(t *testing.T) {
		root := t.TempDir()
		if err := os.MkdirAll(filepath.Join(root, "projects", "proj-a"), 0o755); err != nil {
			t.Fatal(err)
		}
		dailyJSON, sessionsJSON, err := Collect(context.Background(), Options{
			Timezone: "UTC", Roots: collectRoots(root), Now: collectNow,
		})
		if err != nil {
			t.Fatalf("Collect: %v", err)
		}
		assertEmptyReports(t, dailyJSON, sessionsJSON)
	})

	t.Run("all lines dropped by the parser", func(t *testing.T) {
		root := t.TempDir()
		writeTranscript(t, root, "proj-a", "sess-a", collectNow, `{"type":"user","message":"hi"}`, "", `not json`)
		dailyJSON, sessionsJSON, err := Collect(context.Background(), Options{
			Timezone: "UTC", Roots: collectRoots(root), Now: collectNow,
		})
		if err != nil {
			t.Fatalf("Collect: %v", err)
		}
		assertEmptyReports(t, dailyJSON, sessionsJSON)
	})
}

// assertEmptyReports checks the document SHAPE, not its bytes: both reports
// must carry an empty array under their row key and a totals object.
func assertEmptyReports(t *testing.T, dailyJSON, sessionsJSON []byte) {
	t.Helper()
	daily := collectReport(t, dailyJSON)
	if rows := reportRows(t, daily, "daily"); len(rows) != 0 {
		t.Fatalf("daily rows = %d, want 0", len(rows))
	}
	reportTotals(t, daily)
	sessions := collectReport(t, sessionsJSON)
	if rows := reportRows(t, sessions, "sessions"); len(rows) != 0 {
		t.Fatalf("session rows = %d, want 0", len(rows))
	}
	reportTotals(t, sessions)
}

func TestCollectReadsBothChainsIndependently(t *testing.T) {
	root := t.TempDir()
	at := "2026-10-30T12:00:00.000Z"
	// Daily.rs:182-227 accepts the AgentProgress shape
	// {"sessionId", "data": {"message": <a full entry line>}}; lib.rs has no
	// such shape, so the entry chain drops the line entirely.
	inner := `{"timestamp":"` + at +
		`","requestId":"req-w","message":{"id":"msg_w","model":"claude-sonnet-4-5","usage":{"input_tokens":40,"output_tokens":2}}}`
	wrapper := dailyWrapperLine(inner)
	direct := collectLine("sess-a", "msg_a", "req-a", "claude-sonnet-4-5", at, 10, 5, nil)
	writeTranscript(t, root, "proj-a", "sess-a", collectNow, wrapper, direct)

	dailyJSON, sessionsJSON, err := Collect(context.Background(), Options{
		Timezone: "UTC", Roots: collectRoots(root), Now: collectNow,
	})
	if err != nil {
		t.Fatalf("Collect: %v", err)
	}

	daily := reportRows(t, collectReport(t, dailyJSON), "daily")
	if len(daily) != 1 {
		t.Fatalf("daily rows = %d, want 1", len(daily))
	}
	// 40 + 2 (wrapper) + 10 + 5 (direct).
	if got := numberField(t, daily[0], "inputTokens"); got != 50 {
		t.Fatalf("daily inputTokens = %v, want 50 (the wrapper line counts)", got)
	}
	if got := numberField(t, daily[0], "outputTokens"); got != 7 {
		t.Fatalf("daily outputTokens = %v, want 7", got)
	}

	sessions := reportRows(t, collectReport(t, sessionsJSON), "sessions")
	if len(sessions) != 1 {
		t.Fatalf("session rows = %d, want 1", len(sessions))
	}
	if got := numberField(t, sessions[0], "inputTokens"); got != 10 {
		t.Fatalf("session inputTokens = %v, want 10 (the wrapper is not an entry)", got)
	}
	if got := numberField(t, sessions[0], "outputTokens"); got != 5 {
		t.Fatalf("session outputTokens = %v, want 5", got)
	}
}

func TestCollectAppliesOverridesToCost(t *testing.T) {
	root := t.TempDir()
	writeTranscript(t, root, "proj-a", "sess-a", collectNow,
		collectLine("sess-a", "msg_a", "req-a", "claude-sonnet-4-5", "2026-10-30T12:00:00.000Z", 1_000_000, 0, nil))

	run := func(overrides map[string]any) (dailyCost, sessionCost float64) {
		t.Helper()
		dailyJSON, sessionsJSON, err := Collect(context.Background(), Options{
			Timezone: "UTC", Roots: collectRoots(root), Overrides: overrides, Now: collectNow,
		})
		if err != nil {
			t.Fatalf("Collect: %v", err)
		}
		daily := reportRows(t, collectReport(t, dailyJSON), "daily")
		sessions := reportRows(t, collectReport(t, sessionsJSON), "sessions")
		if len(daily) != 1 || len(sessions) != 1 {
			t.Fatalf("rows = %d daily / %d session, want 1/1", len(daily), len(sessions))
		}
		return numberField(t, daily[0], "totalCost"), numberField(t, sessions[0], "totalCost")
	}

	baseDaily, baseSession := run(nil)
	if baseDaily <= 0 || baseSession <= 0 {
		t.Fatalf("unoverridden cost = %v / %v, want positive (the embedded corpus must price sonnet)", baseDaily, baseSession)
	}

	// A per-token rate far above any real price, in ccusage's camelCase form
	// (overrides.go parseOverrideFields).
	overrides := map[string]any{
		"claude-sonnet-4-5": map[string]any{"inputCostPerToken": 1e-3},
	}
	overriddenDaily, overriddenSession := run(overrides)
	if overriddenDaily <= baseDaily {
		t.Fatalf("overridden daily cost = %v, want above the default %v", overriddenDaily, baseDaily)
	}
	if overriddenSession <= baseSession {
		t.Fatalf("overridden session cost = %v, want above the default %v", overriddenSession, baseSession)
	}
	// Both chains price from the same override, independently.
	if overriddenDaily != overriddenSession {
		t.Fatalf("daily cost = %v, session cost = %v, want equal (same entries, same override)", overriddenDaily, overriddenSession)
	}

	// A malformed override is a hard error, not a silent no-op.
	if _, _, err := Collect(context.Background(), Options{
		Timezone: "UTC", Roots: collectRoots(root), Overrides: map[string]any{"claude-sonnet-4-5": "nope"}, Now: collectNow,
	}); err == nil {
		t.Fatalf("Collect accepted a malformed override")
	}
}

func TestCollectRespectsSincePruningAndUntilFiltering(t *testing.T) {
	root := t.TempDir()
	// Three transcripts:
	//   sess-old   old mtime, line dated INSIDE the since window below - only
	//              the mtime prune can keep it out;
	//   sess-mid   recent mtime, line dated BEFORE the since window - the since
	//              prune keeps the file and the date filter drops the line;
	//   sess-new   recent mtime, one line inside the window.
	writeTranscript(t, root, "proj-a", "sess-old", time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC),
		collectLine("sess-old", "msg_old", "req-old", "claude-sonnet-4-5", "2026-09-27T10:00:00.000Z", 7, 0, nil))
	writeTranscript(t, root, "proj-a", "sess-mid", time.Date(2026, 11, 2, 0, 0, 0, 0, time.UTC),
		collectLine("sess-mid", "msg_before", "req-before", "claude-sonnet-4-5", "2026-09-01T10:00:00.000Z", 30, 0, nil))
	writeTranscript(t, root, "proj-a", "sess-new", time.Date(2026, 11, 2, 0, 0, 0, 0, time.UTC),
		collectLine("sess-new", "msg_in", "req-in", "claude-sonnet-4-5", "2026-10-30T10:00:00.000Z", 20, 0, nil))

	const since = "2026-09-25"
	collectTotals := func(t *testing.T, since, until string, pruned *[]string) map[string]float64 {
		t.Helper()
		var lines []string
		stderr := func(line string) { lines = append(lines, line) }
		dailyJSON, sessionsJSON, err := Collect(context.Background(), Options{
			Timezone: "UTC", Since: since, Until: until, Roots: collectRoots(root), Now: collectNow, Stderr: stderr,
		})
		if err != nil {
			t.Fatalf("Collect(%q, %q): %v", since, until, err)
		}
		if pruned != nil {
			*pruned = lines
		}
		return map[string]float64{
			"daily":    numberField(t, reportTotals(t, collectReport(t, dailyJSON)), "inputTokens"),
			"sessions": numberField(t, reportTotals(t, collectReport(t, sessionsJSON)), "inputTokens"),
		}
	}
	assertTotals := func(t *testing.T, totals map[string]float64, want float64, context string) {
		t.Helper()
		for _, chain := range []string{"daily", "sessions"} {
			if totals[chain] != want {
				t.Fatalf("%s %s inputTokens = %v, want %v", context, chain, totals[chain], want)
			}
		}
	}

	// Since with no until: the mtime prune drops sess-old (its in-window line
	// never counts), the date window drops sess-mid's line.
	var pruned []string
	assertTotals(t, collectTotals(t, since, "", &pruned), 20, "since only")

	joined := strings.Join(pruned, "\n")
	if !strings.Contains(joined, "sess-old.jsonl") {
		t.Fatalf("stderr = %q, want the mtime-pruned transcript named", joined)
	}
	if strings.Contains(joined, "sess-mid.jsonl") || strings.Contains(joined, "sess-new.jsonl") {
		t.Fatalf("stderr = %q, want only the stale transcript pruned (--since never prunes by entry date)", joined)
	}

	// Until 2026-10-29 filters sess-new's in-window line out by date, while
	// sess-mid's file is still scanned (its line was already outside the
	// since window): the result empties, which a file prune would not explain.
	assertTotals(t, collectTotals(t, since, "2026-10-29", nil), 0, "until before the line")

	// Until is inclusive: the same line counts on its own date.
	assertTotals(t, collectTotals(t, since, "2026-10-30", nil), 20, "until on the line date")

	// With no window at all nothing is pruned and nothing is filtered.
	assertTotals(t, collectTotals(t, "", "", nil), 57, "no window")
}

func TestCollectFillsPathSessionIDAndProjectPath(t *testing.T) {
	root := t.TempDir()
	// The serialized sessionId differs from the file name: the session report
	// groups by the PATH-derived id (commands/mod.rs:186-199).
	writeTranscript(t, root, "-Users-me-proj-a", "path-sess", collectNow,
		collectLine("serialized-sess", "msg_a", "req_a", "claude-sonnet-4-5", "2026-10-30T12:00:00.000Z", 3, 4, nil))

	_, sessionsJSON, err := Collect(context.Background(), Options{
		Timezone: "UTC", Roots: collectRoots(root), Now: collectNow,
	})
	if err != nil {
		t.Fatalf("Collect: %v", err)
	}
	sessions := reportRows(t, collectReport(t, sessionsJSON), "sessions")
	if len(sessions) != 1 {
		t.Fatalf("session rows = %d, want 1", len(sessions))
	}
	if got := sessions[0]["sessionId"]; got != "path-sess" {
		t.Fatalf("sessionId = %v, want path-sess", got)
	}
	if got := sessions[0]["projectPath"]; got != "-Users-me-proj-a" {
		t.Fatalf("projectPath = %v, want -Users-me-proj-a", got)
	}
}

func TestCollectRejectsUnreadableFile(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("chmod 000 does not deny reads on Windows")
	}
	if os.Geteuid() == 0 {
		t.Skip("root can read a 000-mode file")
	}
	root := t.TempDir()
	path := writeTranscript(t, root, "proj-a", "sess-a", collectNow,
		collectLine("sess-a", "msg_a", "req_a", "claude-sonnet-4-5", "2026-10-30T12:00:00.000Z", 3, 4, nil))
	if err := os.Chmod(path, 0); err != nil {
		t.Fatalf("chmod: %v", err)
	}
	t.Cleanup(func() { _ = os.Chmod(path, 0o644) })

	// Deliberate divergence from ccusage: `let Ok(content) = fs::read(path)
	// else { return empty }` (lib.rs:505, daily.rs:298) drops the file; here a
	// real read failure is an error (fail-closed).
	if _, _, err := Collect(context.Background(), Options{
		Timezone: "UTC", Roots: collectRoots(root), Now: collectNow,
	}); err == nil {
		t.Fatalf("Collect swallowed an unreadable transcript")
	}
}

func TestCollectRespectsContextCancellation(t *testing.T) {
	root := t.TempDir()
	var lines []string
	for index := 0; index < 50; index++ {
		lines = append(lines, collectLine("sess-a", "msg_"+itoa(int64(index)), "req_"+itoa(int64(index)), "claude-sonnet-4-5", "2026-10-30T12:00:00.000Z", 1, 1, nil))
	}
	writeTranscript(t, root, "proj-a", "sess-a", collectNow, lines...)

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	dailyJSON, sessionsJSON, err := Collect(ctx, Options{
		Timezone: "UTC", Roots: collectRoots(root), Now: collectNow,
	})
	if err != context.Canceled {
		t.Fatalf("err = %v, want context.Canceled", err)
	}
	if dailyJSON != nil || sessionsJSON != nil {
		t.Fatalf("a cancelled collection returned reports")
	}

	// A live context over the same fixture still succeeds.
	if _, _, err := Collect(context.Background(), Options{
		Timezone: "UTC", Roots: collectRoots(root), Now: collectNow,
	}); err != nil {
		t.Fatalf("Collect: %v", err)
	}
}

// TestCollectLineSplittingMatchesUpstream pins fast.rs:82-99: split on \n, a
// final line without a newline is still a line, an empty file has none, and a
// trailing \r is tolerated exactly as serde tolerates it.
func TestCollectLineSplittingMatchesUpstream(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "projects", "proj-a")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	lineA := collectLine("sess-a", "msg_a", "req_a", "claude-sonnet-4-5", "2026-10-30T12:00:00.000Z", 5, 0, nil)
	lineB := collectLine("sess-a", "msg_b", "req_b", "claude-sonnet-4-5", "2026-10-30T12:00:00.000Z", 6, 0, nil)
	// CRLF line, unterminated tail, and an empty file next to it.
	if err := os.WriteFile(filepath.Join(dir, "a-crlf.jsonl"), []byte(lineA+"\r\n"+lineB), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "b-empty.jsonl"), nil, 0o644); err != nil {
		t.Fatal(err)
	}

	_, sessionsJSON, err := Collect(context.Background(), Options{
		Timezone: "UTC", Roots: collectRoots(root), Now: collectNow,
	})
	if err != nil {
		t.Fatalf("Collect: %v", err)
	}
	if got := numberField(t, reportTotals(t, collectReport(t, sessionsJSON)), "inputTokens"); got != 11 {
		t.Fatalf("totals inputTokens = %v, want 11 (CRLF line + unterminated tail)", got)
	}
}

// TestCollectStreamsLargeTranscript reads a transcript well past the 64 KiB
// bufio.Scanner limit to prove the reader is not Scanner-based, and past a
// single line of many MB.
func TestCollectStreamsLargeTranscript(t *testing.T) {
	root := t.TempDir()
	bigLine := collectLine("sess-a", "msg_big", "req_big", "claude-sonnet-4-5", "2026-10-30T12:00:00.000Z", 9, 0, nil)
	bigLine = strings.Replace(bigLine, `"usage":`, `"padding":"`+strings.Repeat("x", 200*1024)+`","usage":`, 1)
	path := writeTranscript(t, root, "proj-a", "sess-a", collectNow, bigLine)

	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Size() <= 64*1024 {
		t.Fatalf("fixture is %d bytes, want more than a Scanner token", info.Size())
	}
	_, sessionsJSON, err := Collect(context.Background(), Options{
		Timezone: "UTC", Roots: collectRoots(root), Now: collectNow,
	})
	if err != nil {
		t.Fatalf("Collect: %v", err)
	}
	if got := reportTotals(t, collectReport(t, sessionsJSON))["inputTokens"]; got != float64(9) {
		t.Fatalf("totals inputTokens = %v, want 9", got)
	}
}

// TestCollectRejectsUnknownTimezone pins the zone check at the entry point.
// Without it an unloadable zone is only caught when --since sends the bound
// through the prune (PruneByMTime's pruneLocation); with no --since the reports
// silently fall back to UTC (sessionusage.FormatDate), so a typo would shift
// which day a midnight-adjacent row lands on without any error.
func TestCollectRejectsUnknownTimezone(t *testing.T) {
	root := t.TempDir()
	writeTranscript(t, root, "proj-a", "sess-a", collectNow,
		collectLine("sess-a", "msg_a", "req_a", "claude-sonnet-4-5", "2026-10-30T12:00:00.000Z", 3, 4, nil))
	for name, since := range map[string]string{"without since": "", "with since": "2026-10-01"} {
		t.Run(name, func(t *testing.T) {
			if _, _, err := Collect(context.Background(), Options{
				Timezone: "Not/AZone", Since: since, Roots: collectRoots(root), Now: collectNow,
			}); err == nil {
				t.Fatalf("Collect accepted the unknown timezone Not/AZone")
			}
		})
	}
}

// TestCollectRejectsEmptyTimezone pins Options.Timezone's documented contract:
// the zero value is required, never treated as a fallback zone. Before this
// check the prune fell back to the system zone while the reports fell back to
// UTC, so the same collection could attribute a boundary row two ways.
func TestCollectRejectsEmptyTimezone(t *testing.T) {
	root := t.TempDir()
	writeTranscript(t, root, "proj-a", "sess-a", collectNow,
		collectLine("sess-a", "msg_a", "req_a", "claude-sonnet-4-5", "2026-10-30T12:00:00.000Z", 3, 0, nil))
	for _, timezone := range []string{"", "   "} {
		if _, _, err := Collect(context.Background(), Options{
			Timezone: timezone, Roots: collectRoots(root), Now: collectNow,
		}); err == nil {
			t.Fatalf("Collect accepted the empty timezone %q", timezone)
		}
	}
}

// TestCollectRejectsInvalidDateBounds pins that --since/--until are validated
// before they reach the prune and the date filter. An invalid spelling used to
// pass through compactDateBound and drop every row, returning an empty report
// with no error; "all" was worse - it reached the lexical date compare and
// emptied the reports the same way.
func TestCollectRejectsInvalidDateBounds(t *testing.T) {
	root := t.TempDir()
	writeTranscript(t, root, "proj-a", "sess-a", collectNow,
		collectLine("sess-a", "msg_a", "req_a", "claude-sonnet-4-5", "2026-10-30T12:00:00.000Z", 7, 0, nil))

	run := func(t *testing.T, since, until string) (dailyInput, sessionInput float64, err error) {
		t.Helper()
		dailyJSON, sessionsJSON, err := Collect(context.Background(), Options{
			Timezone: "UTC", Since: since, Until: until, Roots: collectRoots(root), Now: collectNow,
		})
		if err != nil {
			return 0, 0, err
		}
		return numberField(t, reportTotals(t, collectReport(t, dailyJSON)), "inputTokens"),
			numberField(t, reportTotals(t, collectReport(t, sessionsJSON)), "inputTokens"), nil
	}

	t.Run("invalid since spelling", func(t *testing.T) {
		if _, _, err := run(t, "2026-09-25T00:00:00Z", ""); err == nil {
			t.Fatalf("Collect accepted the invalid --since bound 2026-09-25T00:00:00Z")
		}
	})

	t.Run("invalid until calendar date", func(t *testing.T) {
		if _, _, err := run(t, "", "20261032"); err == nil {
			t.Fatalf("Collect accepted the invalid --until bound 20261032")
		}
	})

	t.Run("reversed window", func(t *testing.T) {
		if _, _, err := run(t, "2026-10-30", "2026-10-01"); err == nil {
			t.Fatalf("Collect accepted a reversed --since/--until window")
		}
	})

	t.Run("all disables the since bound", func(t *testing.T) {
		dailyInput, sessionInput, err := run(t, "all", "")
		if err != nil {
			t.Fatalf("Collect: %v", err)
		}
		if dailyInput != 7 || sessionInput != 7 {
			t.Fatalf(`totals = %v daily / %v session inputTokens, want 7/7 ("all" means no bound)`,
				dailyInput, sessionInput)
		}
	})

	t.Run("all is not accepted as an until bound", func(t *testing.T) {
		// Only --since has an "all" form: the shared validator refuses an
		// "all" upper bound (sessionusage.go:437-444), matching the
		// collector's TypeScript side.
		if _, _, err := run(t, "", "all"); err == nil {
			t.Fatalf(`Collect accepted Until: "all"`)
		}
	})
}

// TestCollectFullTieResolvesByFileOrder pins the one case the replacement
// ladder cannot decide. Two entries that tie on every rung - the sidechain flag,
// the token total and, for the daily chain, the cost - leave the first-seen
// survivor in place (lib.rs:198-212, daily.rs:582-601). ScanFiles sorts by full
// path, so "sess-tie-a" is added first and its split is the one reported;
// putting the other split in that name flips the survivor.
func TestCollectFullTieResolvesByFileOrder(t *testing.T) {
	const at = "2026-10-30T12:00:00.000Z"
	// Same serialized session id, message id, request id, timestamp, model and
	// reported cost; the token total is 12 either way, only the input/output
	// split differs. Pinning costUSD equal ties the daily chain's cost rung
	// (daily.rs:592-599) too, so the whole ladder falls through.
	reported := 1.5
	low := collectLine("tie-session", "msg_tie", "req_tie", "claude-sonnet-4-5", at, 12, 0, &reported)
	high := collectLine("tie-session", "msg_tie", "req_tie", "claude-sonnet-4-5", at, 0, 12, &reported)

	// collectTie writes firstContent to sess-tie-a.jsonl and secondContent to
	// sess-tie-b.jsonl, then returns the surviving daily and session splits.
	collectTie := func(t *testing.T, firstContent, secondContent string) (dailyInput, dailyOutput, sessionInput, sessionOutput float64) {
		t.Helper()
		root := t.TempDir()
		writeTranscript(t, root, "proj-a", "sess-tie-a", collectNow, firstContent)
		writeTranscript(t, root, "proj-a", "sess-tie-b", collectNow, secondContent)
		dailyJSON, sessionsJSON, err := Collect(context.Background(), Options{
			Timezone: "UTC", Roots: collectRoots(root), Now: collectNow,
		})
		if err != nil {
			t.Fatalf("Collect: %v", err)
		}
		daily := reportRows(t, collectReport(t, dailyJSON), "daily")
		sessions := reportRows(t, collectReport(t, sessionsJSON), "sessions")
		if len(daily) != 1 || len(sessions) != 1 {
			t.Fatalf("rows = %d daily / %d session, want 1/1 (a full tie collapses to one entry)", len(daily), len(sessions))
		}
		return numberField(t, daily[0], "inputTokens"), numberField(t, daily[0], "outputTokens"),
			numberField(t, sessions[0], "inputTokens"), numberField(t, sessions[0], "outputTokens")
	}

	// sess-tie-a sorts first, so its low-split line is the survivor.
	dailyIn, dailyOut, sessionIn, sessionOut := collectTie(t, low, high)
	if dailyIn != 12 || dailyOut != 0 || sessionIn != 12 || sessionOut != 0 {
		t.Fatalf("forward order: daily %v/%v session %v/%v, want 12/0 and 12/0 (sess-tie-a survives)",
			dailyIn, dailyOut, sessionIn, sessionOut)
	}

	// Swapping which split sits in each name flips the survivor: the line in
	// sess-tie-a is now the high split, and file order alone decides it.
	dailyIn, dailyOut, sessionIn, sessionOut = collectTie(t, high, low)
	if dailyIn != 0 || dailyOut != 12 || sessionIn != 0 || sessionOut != 12 {
		t.Fatalf("swapped names: daily %v/%v session %v/%v, want 0/12 and 0/12 (the first-sorting file holds the high split)",
			dailyIn, dailyOut, sessionIn, sessionOut)
	}
}
