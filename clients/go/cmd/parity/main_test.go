package main

import (
	"bytes"
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/MisonL/TokenBoard/clients/go/internal/collect"
	"github.com/MisonL/TokenBoard/clients/go/internal/contract"
)

// snapshotRow builds one row for the comparison tests. CollectedAt is wall
// clock and differs between the sides on purpose: it must never count as a
// difference.
func snapshotRow(date, model string, input, output int64, cost float64) contract.Snapshot {
	return contract.Snapshot{
		Source:       contract.SourceClaudeCode,
		UsageDate:    date,
		Timezone:     "UTC",
		Model:        model,
		InputTokens:  input,
		OutputTokens: output,
		TotalTokens:  input + output,
		CostUSD:      cost,
		SessionCount: 1,
		CollectedAt:  "2026-11-01T00:00:00.000Z",
	}
}

// TestCompareReportsOnlyTheDivergingRows drives the three difference
// classifications with injected rows: only in native, only in ccusage, and the
// same key with a different value. A clean row proves the match count does not
// inflate itself.
func TestCompareReportsOnlyTheDivergingRows(t *testing.T) {
	now := time.Date(2026, 11, 4, 12, 0, 0, 0, time.UTC)
	native := []contract.Snapshot{
		snapshotRow("2026-11-01", "claude-sonnet", 100, 10, 1),
		snapshotRow("2026-11-02", "claude-opus", 200, 20, 2),
		snapshotRow("2026-11-03", "native-only", 300, 30, 3),
	}
	ccusageRows := []contract.Snapshot{
		snapshotRow("2026-11-01", "claude-sonnet", 100, 10, 1),
		snapshotRow("2026-11-02", "claude-opus", 200, 25, 2),
		snapshotRow("2026-11-04", "ccusage-only", 400, 40, 4),
	}
	// A different collectedAt on the matching row is not a semantic difference.
	ccusageRows[0].CollectedAt = "2026-11-01T00:05:00.000Z"

	report := compareParity(native, ccusageRows, now)

	if report.Status != statusDiff {
		t.Fatalf("status = %q, want %q", report.Status, statusDiff)
	}
	if report.Matched != 1 {
		t.Errorf("matched = %d, want 1", report.Matched)
	}
	if len(report.OnlyInNative) != 1 || report.OnlyInNative[0] != (parityKey{"2026-11-03", "native-only"}) {
		t.Errorf("onlyInNative = %+v, want the 2026-11-03 native-only row", report.OnlyInNative)
	}
	if len(report.OnlyInCcusage) != 1 || report.OnlyInCcusage[0] != (parityKey{"2026-11-04", "ccusage-only"}) {
		t.Errorf("onlyInCcusage = %+v, want the 2026-11-04 ccusage-only row", report.OnlyInCcusage)
	}
	if len(report.ValueDiffs) != 1 {
		t.Fatalf("valueDiffs = %+v, want exactly the 2026-11-02 row", report.ValueDiffs)
	}
	diff := report.ValueDiffs[0]
	if diff.Key != (parityKey{"2026-11-02", "claude-opus"}) {
		t.Errorf("valueDiff key = %+v, want the 2026-11-02 claude-opus row", diff.Key)
	}
	fields := map[string]bool{}
	for _, field := range diff.Fields {
		fields[field.Field] = true
	}
	if !fields["outputTokens"] || !fields["totalTokens"] {
		t.Errorf("valueDiff fields = %+v, want outputTokens and totalTokens", diff.Fields)
	}
	if fields["inputTokens"] {
		t.Errorf("valueDiff fields = %+v, inputTokens agrees and must not be listed", diff.Fields)
	}
}

// TestCompareTreatsTodayAsLiveWrite covers the live-write rule: a today row
// whose usage only grew between the two scans is a race, not drift, while the
// same row on a settled date (or with usage going backwards) stays a failure.
func TestCompareTreatsTodayAsLiveWrite(t *testing.T) {
	now := time.Date(2026, 11, 4, 12, 0, 0, 0, time.UTC)

	t.Run("today row that only grew is a live write", func(t *testing.T) {
		native := []contract.Snapshot{snapshotRow("2026-11-04", "claude-sonnet", 100, 10, 1)}
		// ccusage runs second, so it sees the newer bytes: more usage, and the
		// pro-rata cost share moved with them.
		later := snapshotRow("2026-11-04", "claude-sonnet", 150, 10, 1.4)

		report := compareParity(native, []contract.Snapshot{later}, now)

		if report.Status != statusMatch {
			t.Fatalf("status = %q, want %q (a live write is not a failure)", report.Status, statusMatch)
		}
		if len(report.LiveWrite) != 1 || report.LiveWrite[0] != (parityKey{"2026-11-04", "claude-sonnet"}) {
			t.Errorf("liveWrite = %+v, want the today row", report.LiveWrite)
		}
		if len(report.ValueDiffs) != 0 {
			t.Errorf("valueDiffs = %+v, want none", report.ValueDiffs)
		}
	})

	t.Run("a settled date stays a difference", func(t *testing.T) {
		native := []contract.Snapshot{snapshotRow("2026-11-03", "claude-sonnet", 100, 10, 1)}
		later := snapshotRow("2026-11-03", "claude-sonnet", 150, 10, 1.4)

		report := compareParity(native, []contract.Snapshot{later}, now)

		if report.Status != statusDiff {
			t.Fatalf("status = %q, want %q", report.Status, statusDiff)
		}
		if len(report.LiveWrite) != 0 {
			t.Errorf("liveWrite = %+v, want none on a settled date", report.LiveWrite)
		}
		if len(report.ValueDiffs) != 1 {
			t.Errorf("valueDiffs = %+v, want the 2026-11-03 row", report.ValueDiffs)
		}
	})

	t.Run("a today row that shrank is a difference", func(t *testing.T) {
		native := []contract.Snapshot{snapshotRow("2026-11-04", "claude-sonnet", 150, 10, 1.4)}
		later := snapshotRow("2026-11-04", "claude-sonnet", 100, 10, 1)

		report := compareParity(native, []contract.Snapshot{later}, now)

		if report.Status != statusDiff {
			t.Fatalf("status = %q, want %q", report.Status, statusDiff)
		}
		if len(report.LiveWrite) != 0 {
			t.Errorf("liveWrite = %+v, want none when usage went backwards", report.LiveWrite)
		}
	})

	t.Run("a today row with a sessionCount change stays a difference", func(t *testing.T) {
		native := []contract.Snapshot{snapshotRow("2026-11-04", "claude-sonnet", 100, 10, 1)}
		later := snapshotRow("2026-11-04", "claude-sonnet", 150, 10, 1.4)
		later.SessionCount = 2

		report := compareParity(native, []contract.Snapshot{later}, now)

		if report.Status != statusDiff {
			t.Fatalf("status = %q, want %q", report.Status, statusDiff)
		}
		if len(report.LiveWrite) != 0 {
			t.Errorf("liveWrite = %+v, want none; sessionCount is not a partial-read field", report.LiveWrite)
		}
	})
}

// nativeStubProvider counts how often the ccusage-backed registry entry is
// asked for a collection. A non-zero count means parity fell back to Lookup,
// which would compare ccusage against itself.
type nativeStubProvider struct{ calls int }

func (p *nativeStubProvider) Collect(context.Context, collect.Options) ([]contract.Snapshot, error) {
	p.calls++
	return nil, nil
}

// TestCompareReportsNativeProviderMissing pins the contract for a source the
// native seam does not cover: parity reports notImplemented and must not
// silently take the ccusage-backed provider from Lookup. The ccusage side still
// runs, so the operator sees what it produced.
//
// The lookup is injected rather than taken from the global registry: since S2
// the registry does hold the claude-code native provider (TestParityBinarySees
// TheNativeRegistry pins that), and a real one here would collect the
// developer's own history.
func TestCompareReportsNativeProviderMissing(t *testing.T) {
	ccusageStub := &nativeStubProvider{}
	restore := collect.OverrideProvider(contract.SourceClaudeCode, ccusageStub)
	defer restore()

	report, err := runParity(context.Background(), parityInput{
		Source:       contract.SourceClaudeCode,
		Timezone:     "UTC",
		LookupNative: func(contract.Source) (collect.Provider, bool) { return nil, false },
		Prepare:      offlinePrepare,
		Now:          func() time.Time { return time.Date(2026, 11, 4, 12, 0, 0, 0, time.UTC) },
		CollectCcusage: func(context.Context, ccusageRequest) ([]contract.Snapshot, error) {
			return []contract.Snapshot{snapshotRow("2026-11-01", "claude-sonnet", 100, 10, 1)}, nil
		},
	})
	if err != nil {
		t.Fatalf("runParity: %v", err)
	}
	if report.Status != statusNotImplemented {
		t.Fatalf("status = %q, want %q", report.Status, statusNotImplemented)
	}
	if report.CcusageSnapshots != 1 {
		t.Errorf("ccusageSnapshots = %d, want 1 (the ccusage side still runs)", report.CcusageSnapshots)
	}
	if ccusageStub.calls != 0 {
		t.Fatalf("collect.Lookup provider ran %d time(s); parity must not fall back to the ccusage-backed registry", ccusageStub.calls)
	}
}

// TestCompareDistinguishesEmptyFromMatch pins the coverage taxonomy: both
// sides agreeing on zero rows is statusEmpty, not a clean match. A source whose
// data sits outside the window would otherwise read as verified every day
// (shadow-dual-run learned the same lesson).
func TestCompareDistinguishesEmptyFromMatch(t *testing.T) {
	now := time.Date(2026, 11, 4, 12, 0, 0, 0, time.UTC)

	t.Run("zero rows on both sides is empty", func(t *testing.T) {
		report := compareParity(nil, nil, now)
		if report.Status != statusEmpty {
			t.Fatalf("status = %q, want %q", report.Status, statusEmpty)
		}
		if report.Matched != 0 || len(report.OnlyInNative) != 0 || len(report.OnlyInCcusage) != 0 || len(report.ValueDiffs) != 0 {
			t.Errorf("report = %+v, want no rows and no differences", report)
		}
	})

	t.Run("one clean row is a match", func(t *testing.T) {
		row := snapshotRow("2026-11-01", "claude-sonnet", 100, 10, 1)
		report := compareParity([]contract.Snapshot{row}, []contract.Snapshot{row}, now)
		if report.Status != statusMatch || report.Matched != 1 {
			t.Fatalf("report = %+v, want status match with one matched row", report)
		}
	})

	t.Run("rows on one side only stay a diff", func(t *testing.T) {
		row := snapshotRow("2026-11-01", "claude-sonnet", 100, 10, 1)
		if report := compareParity(nil, []contract.Snapshot{row}, now); report.Status != statusDiff {
			t.Fatalf("status = %q, want %q", report.Status, statusDiff)
		}
		if report := compareParity([]contract.Snapshot{row}, nil, now); report.Status != statusDiff {
			t.Fatalf("status = %q, want %q", report.Status, statusDiff)
		}
	})
}

// TestRunParityConsumesTheNativeSeam injects a native provider through the
// seam and proves parity compares its rows (not ccusage's) against the ccusage
// side.
func TestRunParityConsumesTheNativeSeam(t *testing.T) {
	native := &paritySeamStub{snapshots: []contract.Snapshot{
		snapshotRow("2026-11-01", "claude-sonnet", 100, 10, 1),
		snapshotRow("2026-11-02", "claude-opus", 200, 20, 2),
	}}
	ccusageRows := []contract.Snapshot{
		snapshotRow("2026-11-01", "claude-sonnet", 100, 10, 1),
		snapshotRow("2026-11-02", "claude-opus", 200, 25, 2),
	}
	report, err := runParity(context.Background(), parityInput{
		Source:       contract.SourceClaudeCode,
		Timezone:     "UTC",
		LookupNative: func(contract.Source) (collect.Provider, bool) { return native, true },
		Prepare:      offlinePrepare,
		Now:          func() time.Time { return time.Date(2026, 11, 4, 12, 0, 0, 0, time.UTC) },
		CollectCcusage: func(context.Context, ccusageRequest) ([]contract.Snapshot, error) {
			return ccusageRows, nil
		},
	})
	if err != nil {
		t.Fatalf("runParity: %v", err)
	}
	if native.calls != 1 {
		t.Fatalf("native provider ran %d time(s), want 1", native.calls)
	}
	if report.NativeSnapshots != 2 {
		t.Errorf("nativeSnapshots = %d, want 2", report.NativeSnapshots)
	}
	if report.Status != statusDiff || len(report.ValueDiffs) != 1 {
		t.Errorf("report = %+v, want one value difference on the 2026-11-02 row", report)
	}
}

// paritySeamStub is a native provider a test installs through the seam.
type paritySeamStub struct {
	snapshots []contract.Snapshot
	calls     int
}

func (p *paritySeamStub) Collect(context.Context, collect.Options) ([]contract.Snapshot, error) {
	p.calls++
	return p.snapshots, nil
}

// TestRunWithCleanMatchExitsZero pins the exit-code contract: a clean
// comparison prints the summary and exits 0, including a live-write row.
func TestRunWithCleanMatchExitsZero(t *testing.T) {
	rows := []contract.Snapshot{snapshotRow("2026-11-01", "claude-sonnet", 100, 10, 1)}
	var stdout, stderr bytes.Buffer
	code := runWith([]string{"-source", "claude-code", "-since", "2026-11-01", "-until", "2026-11-01"},
		&stdout, &stderr, parityInput{
			LookupNative: func(contract.Source) (collect.Provider, bool) {
				return &paritySeamStub{snapshots: rows}, true
			},
			Prepare: offlinePrepare,
			CollectCcusage: func(context.Context, ccusageRequest) ([]contract.Snapshot, error) {
				return rows, nil
			},
			Now: func() time.Time { return time.Date(2026, 11, 4, 12, 0, 0, 0, time.UTC) },
		})

	if code != exitOK {
		t.Fatalf("exit = %d, want %d (stderr: %s)", code, exitOK, stderr.String())
	}
	if !strings.Contains(stdout.String(), "status: match") {
		t.Errorf("stdout = %q, want status: match", stdout.String())
	}
	if !strings.Contains(stdout.String(), "matched=1") {
		t.Errorf("stdout = %q, want matched=1", stdout.String())
	}
}

// TestRunWithDiffExitsOne pins the other half of the contract: any
// non-liveWrite difference fails the run, and the row is printed.
func TestRunWithDiffExitsOne(t *testing.T) {
	native := []contract.Snapshot{snapshotRow("2026-11-01", "claude-sonnet", 100, 10, 1)}
	ccusageRows := []contract.Snapshot{snapshotRow("2026-11-01", "claude-sonnet", 100, 25, 1)}
	var stdout, stderr bytes.Buffer
	code := runWith([]string{"-source", "claude-code"}, &stdout, &stderr, parityInput{
		LookupNative: func(contract.Source) (collect.Provider, bool) {
			return &paritySeamStub{snapshots: native}, true
		},
		Prepare: offlinePrepare,
		CollectCcusage: func(context.Context, ccusageRequest) ([]contract.Snapshot, error) {
			return ccusageRows, nil
		},
		Now: func() time.Time { return time.Date(2026, 11, 4, 12, 0, 0, 0, time.UTC) },
	})

	if code != exitFailure {
		t.Fatalf("exit = %d, want %d (stderr: %s)", code, exitFailure, stderr.String())
	}
	if !strings.Contains(stdout.String(), "valueDiff 2026-11-01 claude-sonnet") {
		t.Errorf("stdout = %q, want the diverging row", stdout.String())
	}
}

// TestRunWithNotImplementedExitsZero records the S1 boundary: the native seam
// has no provider, so the run reports notImplemented and does not fail.
func TestRunWithNotImplementedExitsZero(t *testing.T) {
	var stdout, stderr bytes.Buffer
	code := runWith([]string{"-source", "claude-code"}, &stdout, &stderr, parityInput{
		LookupNative: func(contract.Source) (collect.Provider, bool) { return nil, false },
		Prepare:      offlinePrepare,
		CollectCcusage: func(context.Context, ccusageRequest) ([]contract.Snapshot, error) {
			return []contract.Snapshot{snapshotRow("2026-11-01", "claude-sonnet", 100, 10, 1)}, nil
		},
		Now: func() time.Time { return time.Date(2026, 11, 4, 12, 0, 0, 0, time.UTC) },
	})

	if code != exitOK {
		t.Fatalf("exit = %d, want %d (stderr: %s)", code, exitOK, stderr.String())
	}
	if !strings.Contains(stdout.String(), "notImplemented") {
		t.Errorf("stdout = %q, want the notImplemented boundary", stdout.String())
	}
	if !strings.Contains(stdout.String(), "ccusage: 1 snapshots") {
		t.Errorf("stdout = %q, want the ccusage side's count", stdout.String())
	}
}

// TestRunWithEmptyComparisonExitsZero covers the empty status at the CLI layer:
// both sides agree on zero rows, the text output says so, and the run is not
// treated as a failure.
func TestRunWithEmptyComparisonExitsZero(t *testing.T) {
	var stdout, stderr bytes.Buffer
	code := runWith([]string{"-source", "claude-code"}, &stdout, &stderr, parityInput{
		LookupNative: func(contract.Source) (collect.Provider, bool) {
			return &paritySeamStub{}, true
		},
		Prepare: offlinePrepare,
		CollectCcusage: func(context.Context, ccusageRequest) ([]contract.Snapshot, error) {
			return nil, nil
		},
		Now: func() time.Time { return time.Date(2026, 11, 4, 12, 0, 0, 0, time.UTC) },
	})

	if code != exitOK {
		t.Fatalf("exit = %d, want %d (stderr: %s)", code, exitOK, stderr.String())
	}
	if !strings.Contains(stdout.String(), "status: empty") {
		t.Errorf("stdout = %q, want status: empty", stdout.String())
	}
	if !strings.Contains(stdout.String(), "empty comparison is not coverage") {
		t.Errorf("stdout = %q, want the empty-comparison note", stdout.String())
	}
}

// TestRunRejectsInvalidInvocations covers the usage exit code: a missing or
// unknown source and a reversed window are invocation errors, not failures.
func TestRunRejectsInvalidInvocations(t *testing.T) {
	for _, args := range [][]string{
		{},
		{"-source", "not-a-source"},
		{"-source", "opencode"}, // no ccusage path to compare against
		{"-source", "claude-code", "-since", "2026-11-05", "-until", "2026-11-01"},
	} {
		var stdout, stderr bytes.Buffer
		if code := run(args, &stdout, &stderr); code != exitUsage {
			t.Errorf("run(%v) exit = %d, want %d (stderr: %s)", args, code, exitUsage, stderr.String())
		}
	}
}

// TestRunJSONOutputIsMachineReadable checks the -json shape the harness will be
// parsed by.
func TestRunJSONOutputIsMachineReadable(t *testing.T) {
	rows := []contract.Snapshot{snapshotRow("2026-11-01", "claude-sonnet", 100, 10, 1)}
	var stdout, stderr bytes.Buffer
	code := runWith([]string{"-source", "claude-code", "-json"}, &stdout, &stderr, parityInput{
		LookupNative: func(contract.Source) (collect.Provider, bool) {
			return &paritySeamStub{snapshots: rows}, true
		},
		Prepare: offlinePrepare,
		CollectCcusage: func(context.Context, ccusageRequest) ([]contract.Snapshot, error) {
			return rows, nil
		},
		Now: func() time.Time { return time.Date(2026, 11, 4, 12, 0, 0, 0, time.UTC) },
	})
	if code != exitOK {
		t.Fatalf("exit = %d, want %d (stderr: %s)", code, exitOK, stderr.String())
	}
	var report parityReport
	if err := json.Unmarshal(stdout.Bytes(), &report); err != nil {
		t.Fatalf("stdout is not JSON: %v\n%s", err, stdout.String())
	}
	if report.Status != statusMatch || report.Matched != 1 || report.CcusageSnapshots != 1 {
		t.Errorf("report = %+v, want a one-row match", report)
	}
}

// TestParityBinarySeesTheNativeRegistry pins the blank import in main.go. The
// providers register both seams from their own init(), and Go only runs an
// imported package's init() when it is linked: without the import this binary
// compiles and runs, but every parity report says notImplemented on the native
// side because the registry it reads is empty.
func TestParityBinarySeesTheNativeRegistry(t *testing.T) {
	provider, ok := collect.LookupNative(contract.SourceClaudeCode)
	if !ok || provider == nil {
		t.Fatalf("collect.LookupNative(%q) = (%v, %v), want the claude-code native provider", contract.SourceClaudeCode, provider, ok)
	}
}
