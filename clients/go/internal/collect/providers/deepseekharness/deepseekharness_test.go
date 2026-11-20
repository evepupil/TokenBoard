package deepseekharness

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/MisonL/TokenBoard/clients/go/internal/collect/sessionscan"
	"github.com/MisonL/TokenBoard/clients/go/internal/contract"
	"github.com/klauspost/compress/zstd"
)

// The event envelope `{ type, seq, time, data }` with `time` in epoch
// milliseconds, and `usage` on `assistant/message`, follow DSH's session types.
var eventMs = time.Date(2026, 8, 14, 11, 42, 0, 0, time.UTC).UnixMilli()

const (
	fixtureTZ   = "Asia/Shanghai"
	fixtureAt   = "2026-08-14T12:00:00.000Z"
	fixtureDate = "2026-08-14"
)

// message builds one DSH event line. Defaults mirror the TS helper: the
// standard usage counters, the deepseek-v4-pro provenance and sequence 12.
type message struct {
	usage      map[string]any // merged over the default usage
	model      string
	occurredAt int64
	seq        *int64 // nil omits the sequence entirely
	extraData  map[string]any
}

func newMessage() message {
	seq := int64(12)
	return message{occurredAt: eventMs, seq: &seq}
}

func seqOf(value int64) *int64 { return &value }

func (m message) render(t *testing.T) string {
	t.Helper()
	usage := map[string]any{
		"inputTokens":      3272,
		"outputTokens":     802,
		"cacheReadTokens":  52_480,
		"cacheWriteTokens": 0,
		"reasoningTokens":  419,
	}
	for key, value := range m.usage {
		usage[key] = value
	}
	model := m.model
	if model == "" {
		model = "deepseek-v4-pro"
	}
	data := map[string]any{
		"turn": 1,
		"step": 0,
		"message": map[string]any{
			"id":   "msg-1",
			"role": "assistant",
			"content": []any{
				map[string]any{"type": "text", "text": "reply text that must never be uploaded"},
			},
			"source": map[string]any{"kind": "model", "provider": "deepseek", "model": model},
		},
		"usage": usage,
	}
	for key, value := range m.extraData {
		data[key] = value
	}
	envelope := map[string]any{
		"type": "assistant/message",
		"time": m.occurredAt,
		"data": data,
	}
	if m.seq != nil {
		envelope["seq"] = *m.seq
	}
	return marshalJSON(t, envelope)
}

// dshFile is one fixture file: its lines, and whether it is written
// Zstandard-compressed (one frame per line, the way DSH appends).
type dshFile struct {
	lines    []string
	compress bool
}

func dshHome(t *testing.T, files map[string]dshFile) string {
	t.Helper()
	home := t.TempDir()
	for relative, spec := range files {
		filePath := filepath.Join(append([]string{home, "sessions"}, strings.Split(relative, "/")...)...)
		if err := os.MkdirAll(filepath.Dir(filePath), 0o700); err != nil {
			t.Fatal(err)
		}
		var payload []byte
		if spec.compress {
			payload = compressLines(t, spec.lines)
		} else {
			payload = []byte(strings.Join(spec.lines, "\n") + "\n")
		}
		if err := os.WriteFile(filePath, payload, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return home
}

func compressLines(t *testing.T, lines []string) []byte {
	t.Helper()
	var out []byte
	for _, line := range lines {
		encoder, err := zstd.NewWriter(nil, zstd.WithEncoderConcurrency(1))
		if err != nil {
			t.Fatal(err)
		}
		out = append(out, encoder.EncodeAll([]byte(line+"\n"), nil)...)
		encoder.Close()
	}
	return out
}

func runCollect(t *testing.T, home string, mutate func(*Options)) ([]contract.Snapshot, error) {
	t.Helper()
	options := Options{
		DSHHome:     home,
		Timezone:    fixtureTZ,
		CollectedAt: fixtureAt,
		Since:       "all",
	}
	if mutate != nil {
		mutate(&options)
	}
	return Collect(options)
}

func mustCollect(t *testing.T, home string, mutate func(*Options)) []contract.Snapshot {
	t.Helper()
	snapshots, err := runCollect(t, home, mutate)
	if err != nil {
		t.Fatal(err)
	}
	return snapshots
}

func marshalJSON(t *testing.T, value any) string {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return string(encoded)
}

func TestNormalizesAssistantMessageIntoDailySnapshot(t *testing.T) {
	home := dshHome(t, map[string]dshFile{
		"project/session-a/session.jsonl": {lines: []string{newMessage().render(t)}},
	})

	snapshots := mustCollect(t, home, nil)

	want := []contract.Snapshot{{
		Source:        contract.SourceDeepSeekHarness,
		UsageDate:     fixtureDate,
		Timezone:      fixtureTZ,
		Model:         "deepseek-v4-pro",
		InputTokens:   3272,
		OutputTokens:  802, // reasoningTokens is already inside outputTokens.
		CacheCreation: 0,
		CacheRead:     52_480,
		TotalTokens:   56_554,
		CostUSD:       0,
		SessionCount:  1,
		CollectedAt:   fixtureAt,
	}}
	if len(snapshots) != 1 || snapshots[0] != want[0] {
		t.Errorf("snapshots = %+v, want %+v", snapshots, want)
	}
}

func TestReadsEveryFrameOfACompressedLog(t *testing.T) {
	// klauspost's reader stops after the first frame, and Node's did the same
	// until 24.22; the frame-by-frame reader must land all three regardless of
	// what a single-call decompressor would return.
	lines := []string{
		newMessage().withUsage(map[string]any{"inputTokens": 100, "outputTokens": 10, "cacheReadTokens": 0}).at(eventMs, 1).render(t),
		newMessage().withUsage(map[string]any{"inputTokens": 200, "outputTokens": 20, "cacheReadTokens": 0}).at(eventMs+1000, 2).render(t),
		newMessage().withUsage(map[string]any{"inputTokens": 300, "outputTokens": 30, "cacheReadTokens": 0}).at(eventMs+2000, 3).render(t),
	}
	home := dshHome(t, map[string]dshFile{
		"project/session-a/session.jsonl.zstd": {compress: true, lines: lines},
	})

	snapshot := mustCollect(t, home, nil)[0]
	if snapshot.InputTokens != 600 || snapshot.OutputTokens != 60 {
		t.Errorf("snapshot = %+v, want 600 input / 60 output", snapshot)
	}
}

func TestDeduplicatesOverlappingPlainAndCompressedFilesBySessionSequence(t *testing.T) {
	overlapping := newMessage().withUsage(map[string]any{"inputTokens": 20, "outputTokens": 2, "cacheReadTokens": 0}).at(eventMs, 2).render(t)
	tail := newMessage().withUsage(map[string]any{"inputTokens": 30, "outputTokens": 3, "cacheReadTokens": 0}).at(eventMs+1000, 3).render(t)
	home := dshHome(t, map[string]dshFile{
		"project/session-a/session.jsonl.zstd": {compress: true, lines: []string{
			newMessage().withUsage(map[string]any{"inputTokens": 10, "outputTokens": 1, "cacheReadTokens": 0}).at(eventMs, 1).render(t),
			overlapping,
		}},
		"project/session-a/session.jsonl": {lines: []string{overlapping, tail}},
	})

	snapshot := mustCollect(t, home, nil)[0]
	if snapshot.InputTokens != 60 || snapshot.OutputTokens != 6 {
		t.Errorf("snapshot = %+v, want 60 input / 6 output", snapshot)
	}
}

// The scanner recurses into a subdirectory as soon as it meets it in the sorted
// listing, so a subdirectory whose name sorts between session.jsonl and
// session.jsonl.zstd splits the session's two encodings in scan order. Dedup
// groups by directory, so the overlap still counts once.
func TestDeduplicatesAcrossEncodingsWhenSubdirectorySplitsScanOrder(t *testing.T) {
	overlapping := newMessage().withUsage(map[string]any{"inputTokens": 20, "outputTokens": 2, "cacheReadTokens": 0}).at(eventMs, 2).render(t)
	home := dshHome(t, map[string]dshFile{
		"project/session-a/session.jsonl": {lines: []string{
			newMessage().withUsage(map[string]any{"inputTokens": 10, "outputTokens": 1, "cacheReadTokens": 0}).at(eventMs, 1).render(t),
			overlapping,
		}},
		// Sorts after session.jsonl and before session.jsonl.zstd.
		"project/session-a/session.jsonl.bak/session.jsonl": {lines: []string{
			newMessage().withUsage(map[string]any{"inputTokens": 99, "outputTokens": 9, "cacheReadTokens": 0}).at(eventMs, 9).render(t),
		}},
		"project/session-a/session.jsonl.zstd": {compress: true, lines: []string{overlapping}},
	})

	snapshot := mustCollect(t, home, nil)[0]
	// seq 1 (10) + seq 2 (20, once) + seq 9 (99).
	if snapshot.InputTokens != 129 || snapshot.OutputTokens != 12 {
		t.Errorf("snapshot = %+v, want 129 input / 12 output", snapshot)
	}
}

func TestKeepsSessionsSeparateWhenSequencesCollide(t *testing.T) {
	// Sequences are per session, so the same number in two sessions is two
	// events. The expected total requires both properties at once: session-a's
	// two files are folded together, and the state resets before session-b.
	home := dshHome(t, map[string]dshFile{
		"project/session-a/session.jsonl.zstd": {compress: true, lines: []string{
			newMessage().withUsage(map[string]any{"inputTokens": 10, "outputTokens": 1, "cacheReadTokens": 0}).at(eventMs, 1).render(t),
			newMessage().withUsage(map[string]any{"inputTokens": 20, "outputTokens": 2, "cacheReadTokens": 0}).at(eventMs, 2).render(t),
		}},
		"project/session-a/session.jsonl": {lines: []string{
			newMessage().withUsage(map[string]any{"inputTokens": 20, "outputTokens": 2, "cacheReadTokens": 0}).at(eventMs, 2).render(t),
			newMessage().withUsage(map[string]any{"inputTokens": 30, "outputTokens": 3, "cacheReadTokens": 0}).at(eventMs, 3).render(t),
		}},
		"project/session-b/session.jsonl": {lines: []string{
			newMessage().withUsage(map[string]any{"inputTokens": 100, "outputTokens": 10, "cacheReadTokens": 0}).at(eventMs, 1).render(t),
		}},
	})

	snapshot := mustCollect(t, home, nil)[0]
	if snapshot.InputTokens != 160 || snapshot.OutputTokens != 16 || snapshot.SessionCount != 2 {
		t.Errorf("snapshot = %+v, want 160/16 across 2 sessions", snapshot)
	}
}

func TestKeepsDistinctSequencesWithIdenticalUsage(t *testing.T) {
	usage := map[string]any{"inputTokens": 20, "outputTokens": 2, "cacheReadTokens": 0}
	home := dshHome(t, map[string]dshFile{
		"project/session-a/session.jsonl": {lines: []string{
			newMessage().withUsage(usage).at(eventMs, 7).render(t),
			newMessage().withUsage(usage).at(eventMs+1000, 8).render(t),
		}},
	})

	snapshot := mustCollect(t, home, nil)[0]
	if snapshot.InputTokens != 40 || snapshot.OutputTokens != 4 {
		t.Errorf("snapshot = %+v, want 40 input / 4 output", snapshot)
	}
}

func TestCountsUsageEventsWithoutSequence(t *testing.T) {
	noSeq := newMessage()
	noSeq.seq = nil
	home := dshHome(t, map[string]dshFile{
		"project/session-a/session.jsonl": {lines: []string{
			noSeq.withUsage(map[string]any{"inputTokens": 17, "outputTokens": 3}).render(t),
		}},
	})

	snapshot := mustCollect(t, home, nil)[0]
	if snapshot.InputTokens != 17 || snapshot.OutputTokens != 3 {
		t.Errorf("snapshot = %+v, want 17 input / 3 output", snapshot)
	}
}

// A quoted sequence is not a sequence: the TypeScript side tests `typeof
// value === 'number'`, so a log that writes `"seq": "12"` gets no dedup key
// there. Go's lenient number reader would have accepted the string, and the
// two collectors would then merge (or keep) different rows for the same log.
func TestIgnoresAQuotedSequence(t *testing.T) {
	if _, ok := readEventSeq("12"); ok {
		t.Fatal(`readEventSeq("12") accepted a string; the TypeScript side only accepts a number`)
	}
	if seq, ok := readEventSeq(json.Number("12")); !ok || seq != 12 {
		t.Fatalf("readEventSeq(json.Number(12)) = %d, %v; want 12, true", seq, ok)
	}

	line := newMessage().withUsage(map[string]any{"inputTokens": 17, "outputTokens": 3}).render(t)
	var envelope map[string]any
	if err := json.Unmarshal([]byte(line), &envelope); err != nil {
		t.Fatal(err)
	}
	envelope["seq"] = "12"
	encoded, err := json.Marshal(envelope)
	if err != nil {
		t.Fatal(err)
	}
	home := dshHome(t, map[string]dshFile{
		"project/session-a/session.jsonl": {lines: []string{string(encoded)}},
	})

	snapshot := mustCollect(t, home, nil)[0]
	if snapshot.InputTokens != 17 {
		t.Errorf("snapshot = %+v, want the row counted without a key", snapshot)
	}
}

// Handing every frame the full 256 MiB cap bounds the *result* but not the
// peak: the frames already decoded plus one more at full size can reach twice
// the cap. Each frame is handed what is left instead. The peak-memory property
// cannot be observed from the output alone — both strategies produce identical
// bytes — so the budget the reader computes is asserted directly, which is the
// exact function it calls.
func TestBoundsEachFrameByRemainingBudget(t *testing.T) {
	firstLine := newMessage().withUsage(map[string]any{"inputTokens": 100, "outputTokens": 10, "cacheReadTokens": 0}).at(eventMs, 1).render(t) + "\n"
	secondLine := newMessage().withUsage(map[string]any{"inputTokens": 200, "outputTokens": 20, "cacheReadTokens": 0}).at(eventMs+1000, 2).render(t)

	if got := frameBudget(0); got != sessionscan.MaxSessionFileBytes {
		t.Errorf("frameBudget(0) = %d, want %d", got, sessionscan.MaxSessionFileBytes)
	}
	if got := frameBudget(len(firstLine)); got != sessionscan.MaxSessionFileBytes-len(firstLine) {
		t.Errorf("frameBudget(%d) = %d, want %d", len(firstLine), got, sessionscan.MaxSessionFileBytes-len(firstLine))
	}
	// The clamp keeps the case where the total lands exactly on the cap
	// decodable instead of passing a zero budget through.
	if got := frameBudget(sessionscan.MaxSessionFileBytes); got != 1 {
		t.Errorf("frameBudget(cap) = %d, want 1", got)
	}
	if got := frameBudget(sessionscan.MaxSessionFileBytes + 100); got != 1 {
		t.Errorf("frameBudget(over cap) = %d, want 1", got)
	}

	home := dshHome(t, map[string]dshFile{
		"project/session-a/session.jsonl.zstd": {compress: true, lines: []string{strings.TrimSuffix(firstLine, "\n"), secondLine}},
	})
	if got := mustCollect(t, home, nil)[0].InputTokens; got != 300 {
		t.Errorf("inputTokens = %d, want 300", got)
	}
}

func TestPreservesUTF8ModelIDSplitAcrossCompressedFrames(t *testing.T) {
	line := []byte(newMessage().withModel("模型-α").render(t) + "\n")
	splitAt := bytes.Index(line, []byte("模")) + 1
	if splitAt <= 0 || splitAt >= len(line) {
		t.Fatalf("split point %d out of range for %d bytes", splitAt, len(line))
	}
	home := t.TempDir()
	filePath := filepath.Join(home, "sessions", "project", "session-a", "session.jsonl.zstd")
	if err := os.MkdirAll(filepath.Dir(filePath), 0o700); err != nil {
		t.Fatal(err)
	}
	first := compressRaw(t, line[:splitAt])
	second := compressRaw(t, line[splitAt:])
	if err := os.WriteFile(filePath, append(first, second...), 0o600); err != nil {
		t.Fatal(err)
	}

	snapshot := mustCollect(t, home, nil)[0]
	if snapshot.Model != "模型-α" {
		t.Errorf("model = %q, want %q", snapshot.Model, "模型-α")
	}
}

func TestNeverReportsCostForDeepSeekHarness(t *testing.T) {
	m := newMessage()
	m.extraData = map[string]any{"costUsd": 1.23, "cost": map[string]any{"total": 4.56}}
	home := dshHome(t, map[string]dshFile{
		"project/session-a/session.jsonl": {lines: []string{m.render(t)}},
	})

	if got := mustCollect(t, home, nil)[0].CostUSD; got != 0 {
		t.Errorf("costUsd = %v, want 0", got)
	}
}

func TestKeepsCacheReadsAndWritesInTheirOwnBuckets(t *testing.T) {
	home := dshHome(t, map[string]dshFile{
		"project/session-a/session.jsonl": {lines: []string{
			newMessage().withUsage(map[string]any{
				"inputTokens": 1000, "outputTokens": 200, "cacheReadTokens": 5000, "cacheWriteTokens": 300,
			}).render(t),
		}},
	})

	snapshot := mustCollect(t, home, nil)[0]
	if snapshot.InputTokens != 1000 || snapshot.CacheRead != 5000 || snapshot.CacheCreation != 300 || snapshot.TotalTokens != 6500 {
		t.Errorf("snapshot = %+v, want 1000/5000/300/6500", snapshot)
	}
}

func TestIgnoresEventsOtherThanAssistantMessagesWithUsage(t *testing.T) {
	home := dshHome(t, map[string]dshFile{
		"project/session-a/session.jsonl": {lines: []string{
			marshalJSON(t, map[string]any{"type": "session", "version": 1, "id": "s", "createdAt": eventMs, "cwd": "/work"}),
			marshalJSON(t, map[string]any{"type": "turn/start", "seq": 1, "time": eventMs, "data": map[string]any{"turn": 1}}),
			marshalJSON(t, map[string]any{"type": "user/message", "seq": 2, "time": eventMs, "data": map[string]any{"content": "a prompt"}}),
			marshalJSON(t, map[string]any{"type": "assistant/chunk", "seq": 3, "time": eventMs, "data": map[string]any{"chunk": map[string]any{"text": "delta"}}}),
			marshalJSON(t, map[string]any{"type": "assistant/message", "seq": 4, "time": eventMs, "data": map[string]any{"turn": 1, "step": 0, "message": map[string]any{}}}),
			newMessage().render(t),
		}},
	})

	snapshots := mustCollect(t, home, nil)
	if len(snapshots) != 1 || snapshots[0].InputTokens != 3272 {
		t.Errorf("snapshots = %+v, want one with 3272 input", snapshots)
	}
}

func TestAggregatesAcrossSessionsAndDates(t *testing.T) {
	home := dshHome(t, map[string]dshFile{
		"project-a/session-a/session.jsonl": {lines: []string{newMessage().render(t)}},
		"project-b/session-b/session.jsonl.zstd": {compress: true, lines: []string{
			newMessage().at(time.Date(2026, 8, 15, 2, 0, 0, 0, time.UTC).UnixMilli(), 12).render(t),
		}},
	})

	snapshots := mustCollect(t, home, nil)
	if len(snapshots) != 2 ||
		snapshots[0].UsageDate != "2026-08-14" || snapshots[1].UsageDate != "2026-08-15" {
		t.Fatalf("snapshots = %+v", snapshots)
	}
	for _, snapshot := range snapshots {
		if snapshot.SessionCount != 1 {
			t.Errorf("sessionCount = %d, want 1", snapshot.SessionCount)
		}
	}
}

func TestFallsBackToPlaceholderModelWhenProvenanceAbsent(t *testing.T) {
	home := dshHome(t, map[string]dshFile{
		"project/session-a/session.jsonl": {lines: []string{
			marshalJSON(t, map[string]any{
				"type": "assistant/message", "seq": 1, "time": eventMs,
				"data": map[string]any{"turn": 1, "step": 0, "usage": map[string]any{"inputTokens": 10, "outputTokens": 2}},
			}),
		}},
	})

	if got := mustCollect(t, home, nil)[0].Model; got != "unknown" {
		t.Errorf("model = %q, want unknown", got)
	}
}

func TestFailsTheSourceWhenOneLogCannotBeRead(t *testing.T) {
	home := dshHome(t, map[string]dshFile{
		"project-a/broken/session.jsonl.zstd": {lines: []string{"not zstd at all"}},
		"project-b/session-b/session.jsonl":   {lines: []string{newMessage().render(t)}},
	})

	// A real read failure must fail the source instead of silently dropping
	// the broken log's usage.
	_, err := runCollect(t, home, nil)
	if err == nil || !strings.Contains(err.Error(), "not a Zstandard session log") {
		t.Errorf("err = %v, want 'not a Zstandard session log'", err)
	}
}

func TestKeepsCompleteFramesWhenTheLastOneIsTorn(t *testing.T) {
	// DSH may be appending while a scan runs, so the trailing frame can be
	// half-written. That is expected: the torn bytes are dropped and every
	// complete frame before them still counts.
	home := t.TempDir()
	filePath := filepath.Join(home, "sessions", "project", "session-a", "session.jsonl.zstd")
	if err := os.MkdirAll(filepath.Dir(filePath), 0o700); err != nil {
		t.Fatal(err)
	}
	complete := append(
		compressRaw(t, []byte(newMessage().at(eventMs, 1).render(t)+"\n")),
		compressRaw(t, []byte(newMessage().at(eventMs+1000, 2).render(t)+"\n"))...,
	)
	torn := compressRaw(t, []byte(newMessage().at(eventMs+2000, 3).render(t)+"\n"))
	payload := append(append([]byte{}, complete...), torn[:len(torn)-4]...)
	if err := os.WriteFile(filePath, payload, 0o600); err != nil {
		t.Fatal(err)
	}

	snapshot := mustCollect(t, home, nil)[0]
	if snapshot.InputTokens != 3272*2 || snapshot.OutputTokens != 802*2 {
		t.Errorf("snapshot = %+v, want %d input / %d output", snapshot, 3272*2, 802*2)
	}
}

func TestAppliesSinceWindowAndRejectsInvalidValue(t *testing.T) {
	home := dshHome(t, map[string]dshFile{
		"project/session-a/session.jsonl": {lines: []string{
			newMessage().at(time.Date(2026, 8, 10, 2, 0, 0, 0, time.UTC).UnixMilli(), 1).render(t),
			newMessage().at(time.Date(2026, 8, 20, 2, 0, 0, 0, time.UTC).UnixMilli(), 2).render(t),
		}},
	})

	if got := mustCollect(t, home, func(o *Options) { o.Since = "2026-08-15" }); len(got) != 1 {
		t.Errorf("dashed since = %d snapshots, want 1", len(got))
	}
	if got := mustCollect(t, home, func(o *Options) { o.Since = "20260815" }); len(got) != 1 {
		t.Errorf("compact since = %d snapshots, want 1", len(got))
	}
	if got := mustCollect(t, home, func(o *Options) { o.Since = "all" }); len(got) != 2 {
		t.Errorf("since all = %d snapshots, want 2", len(got))
	}
	_, err := runCollect(t, home, func(o *Options) { o.Since = "week" })
	if err == nil || !strings.Contains(err.Error(), "Invalid DeepSeek Harness since value") {
		t.Errorf("invalid since error = %v", err)
	}
}

func TestReportsNoSessionsInsteadOfEmptyUsage(t *testing.T) {
	_, err := runCollect(t, t.TempDir(), nil)
	if err == nil || !strings.Contains(err.Error(), "No DeepSeek Harness sessions found") {
		t.Errorf("error = %v", err)
	}
}

func TestReadsSessionRootConfiguredIndependentlyOfHome(t *testing.T) {
	home := dshHome(t, map[string]dshFile{
		"project/session-a/session.jsonl": {lines: []string{newMessage().render(t)}},
	})

	snapshots, err := Collect(Options{
		SessionRoot: filepath.Join(home, "sessions"),
		Timezone:    fixtureTZ,
		CollectedAt: fixtureAt,
		Since:       "all",
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshots) != 1 {
		t.Errorf("snapshots = %d, want 1", len(snapshots))
	}
}

func TestToleratesAnEmptyLogAndMalformedLines(t *testing.T) {
	home := dshHome(t, map[string]dshFile{
		"project/empty/session.jsonl": {lines: nil},
		"project/messy/session.jsonl": {lines: []string{"not-json", "[]", "", newMessage().render(t)}},
	})

	if got := mustCollect(t, home, nil); len(got) != 1 {
		t.Errorf("snapshots = %+v, want 1", got)
	}
}

// Taken from a real ~/.dsh/sessions/**/session.jsonl.zstd: one turn wrote 51
// frames, of which only two lines are assistant/message with usage. The log
// carries no cost field of any kind, and cacheWriteTokens is absent rather than
// zero when nothing was written to cache.
func TestMatchesTheShapeARealDSHSessionWrites(t *testing.T) {
	realMessage := func(seq int64, at int64, input, output, cacheRead, reasoning int) string {
		return marshalJSON(t, map[string]any{
			"type": "assistant/message", "seq": seq, "time": at,
			"data": map[string]any{
				"turn": 1, "step": 0,
				"message": map[string]any{
					"id": "msg-1", "role": "assistant",
					"content": []any{map[string]any{"type": "text", "text": "assembled reply"}},
					"source": map[string]any{
						"kind": "model", "provider": "deepseek-official", "model": "deepseek-v4-flash-vision-exp",
					},
				},
				"usage": map[string]any{
					"inputTokens": input, "outputTokens": output,
					"cacheReadTokens": cacheRead, "reasoningTokens": reasoning,
				},
			},
		})
	}
	home := dshHome(t, map[string]dshFile{
		"proj/session-real/session.jsonl.zstd": {compress: true, lines: []string{
			marshalJSON(t, map[string]any{"type": "turn/start", "seq": 1, "time": eventMs, "data": map[string]any{"turn": 1}}),
			marshalJSON(t, map[string]any{"type": "user/message", "seq": 2, "time": eventMs, "data": map[string]any{"content": []any{map[string]any{"type": "text", "text": "a real prompt"}}}}),
			// Packed chunk rows hold the model's raw output and must be ignored.
			marshalJSON(t, map[string]any{"type": "reasoning-chunks", "seq": 3, "time": eventMs, "data": map[string]any{"turn": 1, "step": 0, "texts": []string{"private reasoning"}}}),
			marshalJSON(t, map[string]any{"type": "text-chunks", "seq": 4, "time": eventMs, "data": map[string]any{"turn": 1, "step": 0, "texts": []string{"streamed reply"}}}),
			marshalJSON(t, map[string]any{"type": "assistant/chunk", "seq": 5, "time": eventMs, "data": map[string]any{"turn": 1, "step": 0, "chunk": map[string]any{"text": "delta"}}}),
			realMessage(6, eventMs, 4557, 434, 4224, 220),
			realMessage(7, eventMs+5000, 4638, 476, 5632, 256),
			marshalJSON(t, map[string]any{"type": "session/title", "seq": 8, "time": eventMs, "data": map[string]any{"title": "a session title"}}),
			marshalJSON(t, map[string]any{"type": "turn/end", "seq": 9, "time": eventMs, "data": map[string]any{"turn": 1, "reason": "completed"}}),
		}},
	})

	snapshots := mustCollect(t, home, nil)
	want := contract.Snapshot{
		Source:        contract.SourceDeepSeekHarness,
		UsageDate:     fixtureDate,
		Timezone:      fixtureTZ,
		Model:         "deepseek-v4-flash-vision-exp",
		InputTokens:   9195,
		OutputTokens:  910,
		CacheCreation: 0,
		CacheRead:     9856,
		TotalTokens:   19_961,
		CostUSD:       0,
		SessionCount:  1,
		CollectedAt:   fixtureAt,
	}
	if len(snapshots) != 1 || snapshots[0] != want {
		t.Errorf("snapshots = %+v, want %+v", snapshots, want)
	}
}

func TestKeepsSessionContentOutOfTheSnapshot(t *testing.T) {
	secrets := []string{"a real prompt", "private reasoning", "streamed reply", "assembled reply"}
	home := dshHome(t, map[string]dshFile{
		"proj/session-a/session.jsonl.zstd": {compress: true, lines: []string{
			marshalJSON(t, map[string]any{"type": "user/message", "seq": 1, "time": eventMs, "data": map[string]any{"content": []any{map[string]any{"type": "text", "text": secrets[0]}}}}),
			marshalJSON(t, map[string]any{"type": "reasoning-chunks", "seq": 2, "time": eventMs, "data": map[string]any{"texts": []string{secrets[1]}}}),
			marshalJSON(t, map[string]any{"type": "text-chunks", "seq": 3, "time": eventMs, "data": map[string]any{"texts": []string{secrets[2]}}}),
			marshalJSON(t, map[string]any{
				"type": "assistant/message", "seq": 4, "time": eventMs,
				"data": map[string]any{
					"turn": 1, "step": 0,
					"message": map[string]any{
						"id": "m", "role": "assistant",
						"content": []any{map[string]any{"type": "text", "text": secrets[3]}},
						"source": map[string]any{
							"kind": "model", "provider": "p", "model": "m",
							"replayState": map[string]any{"opaque": "provider state"},
						},
					},
					"usage": map[string]any{"inputTokens": 10, "outputTokens": 2},
				},
			}),
		}},
	})

	emitted := marshalJSON(t, mustCollect(t, home, nil))
	for _, secret := range secrets {
		if strings.Contains(emitted, secret) {
			t.Errorf("snapshot leaked %q: %s", secret, emitted)
		}
	}
	if strings.Contains(emitted, "provider state") {
		t.Errorf("snapshot leaked provider replay state: %s", emitted)
	}
}

func (m message) withUsage(usage map[string]any) message { m.usage = usage; return m }
func (m message) withModel(model string) message         { m.model = model; return m }
func (m message) at(at int64, seq int64) message {
	m.occurredAt = at
	m.seq = seqOf(seq)
	return m
}

func compressRaw(t *testing.T, payload []byte) []byte {
	t.Helper()
	encoder, err := zstd.NewWriter(nil, zstd.WithEncoderConcurrency(1))
	if err != nil {
		t.Fatal(err)
	}
	defer encoder.Close()
	return encoder.EncodeAll(payload, nil)
}
