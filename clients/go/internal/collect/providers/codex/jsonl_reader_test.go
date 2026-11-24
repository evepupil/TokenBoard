package codex

// Port of codex-subagent-usage-json.test.ts (the reader half). The child
// session module's tests (usage-event limits, merging, date formatting) live
// with that module; the cases here exercise only the JSONL reader and the
// record accessors, including the child read limits, which are reproduced
// locally so the reader's bounded behavior is covered without depending on the
// child module.

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// childUsageEvent builds the row shape the child scans read: one event with
// identical cumulative and per-request usage.
func childUsageEvent(index int) UnknownRecord {
	return UnknownRecord{
		"type":      "event_msg",
		"timestamp": "2026-05-25T01:10:00.000Z",
		"payload": map[string]any{
			"info": map[string]any{
				"total_token_usage": map[string]any{
					"input_tokens": float64(index),
					"total_tokens": float64(index),
				},
				"last_token_usage": map[string]any{
					"input_tokens": float64(index),
					"total_tokens": float64(index),
				},
			},
		},
	}
}

// testChildSessionReadLimits mirrors codexChildSessionReadLimits from
// codex-subagent-usage-child.ts.
func testChildSessionReadLimits() JSONLReadLimits {
	fourGiB := int64(4 * 1024 * 1024 * 1024)
	maxLine := int64(1024 * 1024)
	maxDiscarded := int64(64 * 1024 * 1024)
	return JSONLReadLimits{
		MaxBytes:              &fourGiB,
		MaxLineBytes:          &maxLine,
		MaxDiscardedLineBytes: &maxDiscarded,
		RelevantMetadataKeys:  []string{"total_token_usage", "last_token_usage", "subagent"},
		CodexUsageOnly:        true,
		DiscardableLineTypes:  []string{"compacted", "event_msg", "response_item", "turn_context"},
		Label:                 "Codex child session",
	}
}

func int64Ptr(value int64) *int64 { return &value }

// chunkedReader yields exactly the chunks it is given, so the reader sees the
// same read boundaries the TS suite drives Readable.from with.
type chunkedReader struct {
	chunks [][]byte
	index  int
	closed bool
}

func newChunkedReader(chunks ...[]byte) *chunkedReader {
	return &chunkedReader{chunks: chunks}
}

func (r *chunkedReader) Read(buffer []byte) (int, error) {
	if r.index >= len(r.chunks) {
		return 0, io.EOF
	}
	chunk := r.chunks[r.index]
	r.index++
	copied := copy(buffer, chunk)
	if copied < len(chunk) {
		// The reader contract allows short reads; keep the remainder for the
		// next call so no bytes are lost.
		r.chunks[r.index-1] = chunk[copied:]
		r.index--
	}
	return copied, nil
}

func (r *chunkedReader) Close() error {
	r.closed = true
	return nil
}

func collectRecords(t *testing.T, stream io.Reader, limits JSONLReadLimits, warnings *[]string) []UnknownRecord {
	t.Helper()
	records := []UnknownRecord{}
	var stderr func(string)
	if warnings != nil {
		stderr = func(line string) { *warnings = append(*warnings, line) }
	}
	if err := ReadJSONLRecordsFromStream(stream, stderr, limits, func(record UnknownRecord) error {
		records = append(records, record)
		return nil
	}); err != nil {
		t.Fatalf("ReadJSONLRecordsFromStream: %v", err)
	}
	return records
}

func readStreamError(stream io.Reader, limits JSONLReadLimits) error {
	return ReadJSONLRecordsFromStream(stream, nil, limits, func(UnknownRecord) error { return nil })
}

func TestNormalizesInconsistentCodexChildTotals(t *testing.T) {
	total := ReadTotalTokens(UnknownRecord{
		"input_tokens":             float64(10),
		"output_tokens":            float64(4),
		"cache_write_input_tokens": float64(3),
		"cached_input_tokens":      float64(20),
		"total_tokens":             float64(15),
	})
	if total != 37 {
		t.Fatalf("ReadTotalTokens = %v, want 37", total)
	}
}

func TestIgnoresNegativeAndFractionalTokenFields(t *testing.T) {
	if got := ReadNumber(UnknownRecord{"input_tokens": float64(-10)}, []string{"input_tokens"}); got != 0 {
		t.Fatalf("negative = %v, want 0", got)
	}
	if got := ReadNumber(UnknownRecord{"input_tokens": 1.5}, []string{"input_tokens"}); got != 0 {
		t.Fatalf("fractional = %v, want 0", got)
	}
	if got := ReadNumber(UnknownRecord{"input_tokens": float64(9007199254740992)}, []string{"input_tokens"}); got != 0 {
		t.Fatalf("above max safe integer = %v, want 0", got)
	}
	if got := ReadNumber(UnknownRecord{"input_tokens": float64(12)}, []string{"input_tokens"}); got != 12 {
		t.Fatalf("valid = %v, want 12", got)
	}
}

func TestDestroysTheInputStreamWhenTheConsumerStopsEarly(t *testing.T) {
	stream := newChunkedReader([]byte(`{"type":"session_meta"}` + "\n"))
	stopped := false
	err := ReadJSONLRecordsFromStream(stream, nil, JSONLReadLimits{}, func(record UnknownRecord) error {
		if record["type"] != "session_meta" {
			t.Fatalf("unexpected record: %v", record)
		}
		stopped = true
		return ErrStopJSONL
	})
	if err != nil {
		t.Fatalf("ReadJSONLRecordsFromStream: %v", err)
	}
	if !stopped {
		t.Fatal("the callback never saw a record")
	}
	if !stream.closed {
		t.Fatal("stream was not destroyed after an early stop")
	}
}

func TestRejectsAnEarlyChildSessionReaderExitAfterASameSizeSourceReplacement(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("same-size replacement detection needs dev/ino, which os.FileInfo does not carry on Windows")
	}
	root := t.TempDir()
	filePath := filepath.Join(root, "child.jsonl")
	original := `{"type":"session_meta","id":"a"}` + "\n" + `{"type":"event_msg"}` + "\n"
	replacement := `{"type":"session_meta","id":"b"}` + "\n" + `{"type":"event_msg"}` + "\n"
	if len(original) != len(replacement) {
		t.Fatalf("fixture lengths differ: %d vs %d", len(original), len(replacement))
	}
	if err := os.WriteFile(filePath, []byte(original), 0o600); err != nil {
		t.Fatal(err)
	}

	seen := 0
	err := ReadJSONLRecords(filePath, nil, JSONLReadLimits{
		MaxBytes:     int64Ptr(1024),
		MaxLineBytes: int64Ptr(128),
		Label:        "Codex child session",
	}, func(record UnknownRecord) error {
		seen++
		if record["id"] != "a" {
			t.Fatalf("unexpected record: %v", record)
		}
		if err := os.WriteFile(filePath, []byte(replacement), 0o600); err != nil {
			t.Fatal(err)
		}
		// The in-place rewrite leaves dev/ino/size untouched, so the fingerprint
		// can only differ through a timestamp. Push mtime forward explicitly: on a
		// filesystem with a coarse clock (ext4 under some mounts: 1 ms) an
		// immediate rewrite can land on the same mtimeMs and ctimeMs, which made
		// this test pass or fail with the host's clock granularity rather than
		// with the detection it is meant to pin.
		forward := time.Now().Add(2 * time.Second)
		if err := os.Chtimes(filePath, forward, forward); err != nil {
			t.Fatal(err)
		}
		return ErrStopJSONL
	})
	if seen != 1 {
		t.Fatalf("records seen = %d, want 1", seen)
	}
	if err == nil || err.Error() != "Codex child session changed while reading; retry the sync" {
		t.Fatalf("error = %v, want the changed-while-reading error", err)
	}
}

func TestRejectsAnEarlyChildSessionReaderExitAfterAnAtomicReplacement(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("atomic replacement identity check needs dev/ino")
	}
	root := t.TempDir()
	filePath := filepath.Join(root, "child.jsonl")
	replacementPath := filepath.Join(root, "replacement.jsonl")
	original := `{"type":"session_meta","id":"a"}` + "\n" + `{"type":"event_msg"}` + "\n"
	replacement := `{"type":"session_meta","id":"b"}` + "\n" + `{"type":"event_msg"}` + "\n"
	if err := os.WriteFile(filePath, []byte(original), 0o600); err != nil {
		t.Fatal(err)
	}

	err := ReadJSONLRecords(filePath, nil, JSONLReadLimits{
		MaxBytes:     int64Ptr(1024),
		MaxLineBytes: int64Ptr(128),
		Label:        "Codex child session",
	}, func(record UnknownRecord) error {
		if record["id"] != "a" {
			t.Fatalf("unexpected record: %v", record)
		}
		if err := os.WriteFile(replacementPath, []byte(replacement), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.Rename(replacementPath, filePath); err != nil {
			t.Fatal(err)
		}
		return ErrStopJSONL
	})
	if err == nil || err.Error() != "Codex child session changed while reading; retry the sync" {
		t.Fatalf("error = %v, want the changed-while-reading error", err)
	}
}

func TestReadsCRLFDelimitedRecordsSplitAcrossChunks(t *testing.T) {
	stream := newChunkedReader(
		[]byte(`{"type":"session_meta"}`+"\r"),
		[]byte("\n"+`{"type":"event_msg"}`+"\r\n"),
	)
	records := collectRecords(t, stream, JSONLReadLimits{MaxLineBytes: int64Ptr(64)}, nil)
	if len(records) != 2 || records[0]["type"] != "session_meta" || records[1]["type"] != "event_msg" {
		t.Fatalf("records = %v", records)
	}
}

func TestDoesNotTurnADelayedCRLFContinuationIntoABlankRow(t *testing.T) {
	stream := newChunkedReader(
		[]byte(`{"type":"session_meta"}`+"\r"),
		[]byte{},
		[]byte("\n"+`{"type":"event_msg"}`+"\n"),
	)
	warnings := []string{}
	records := collectRecords(t, stream, JSONLReadLimits{MaxLineBytes: int64Ptr(64)}, &warnings)
	if len(warnings) != 0 {
		t.Fatalf("warnings = %v, want none", warnings)
	}
	if len(records) != 2 {
		t.Fatalf("records = %v, want 2", records)
	}
}

func TestEmitsALineWhenItsLFTerminatorStartsTheNextChunk(t *testing.T) {
	stream := newChunkedReader(
		[]byte(`{"type":"session_meta"}`),
		[]byte("\n"+`{"type":"event_msg"}`+"\n"),
	)
	records := collectRecords(t, stream, JSONLReadLimits{MaxLineBytes: int64Ptr(64)}, nil)
	if len(records) != 2 || records[0]["type"] != "session_meta" || records[1]["type"] != "event_msg" {
		t.Fatalf("records = %v", records)
	}
}

func TestPreservesStandaloneCRLineDelimiters(t *testing.T) {
	stream := newChunkedReader([]byte(`{"type":"session_meta"}` + "\r" + `{"type":"event_msg"}` + "\r"))
	records := collectRecords(t, stream, JSONLReadLimits{MaxLineBytes: int64Ptr(64)}, nil)
	if len(records) != 2 || records[0]["type"] != "session_meta" || records[1]["type"] != "event_msg" {
		t.Fatalf("records = %v", records)
	}
}

func TestDefersAnIncompleteFinalJSONLRowWhenProjectingAnActiveSession(t *testing.T) {
	pending := []int64{}
	records := []UnknownRecord{}
	limits := JSONLReadLimits{
		AllowIncompleteFinalLine: true,
		OnIncompleteFinalLine:    func(byteLength int64) { pending = append(pending, byteLength) },
		MaxLineBytes:             int64Ptr(1024),
	}
	stream := newChunkedReader([]byte(`{"type":"session_meta"}` + "\n" + `{"type":"event_msg","payload":{"info":`))
	if err := ReadJSONLRecordsFromStream(stream, nil, limits, func(record UnknownRecord) error {
		records = append(records, record)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if len(records) != 1 || records[0]["type"] != "session_meta" {
		t.Fatalf("records = %v", records)
	}
	want := int64(len(`{"type":"event_msg","payload":{"info":`))
	if len(pending) != 1 || pending[0] != want {
		t.Fatalf("pending = %v, want [%d]", pending, want)
	}
}

func TestDefersAnIncompleteFinalRowWhoseTailSplitsAMultiByteCharacter(t *testing.T) {
	pending := []int64{}
	records := []UnknownRecord{}
	prefix := []byte(`{"type":"session_meta"}` + "\n" + `{"type":"event_msg","payload":"`)
	// The first two bytes of U+4F60, which is what a writer interrupted
	// mid-character leaves behind.
	tail := append(append([]byte{}, prefix...), 0xe4, 0xbd)
	limits := JSONLReadLimits{
		AllowIncompleteFinalLine: true,
		OnIncompleteFinalLine:    func(byteLength int64) { pending = append(pending, byteLength) },
		MaxLineBytes:             int64Ptr(1024),
	}
	if err := ReadJSONLRecordsFromStream(newChunkedReader(tail), nil, limits, func(record UnknownRecord) error {
		records = append(records, record)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if len(records) != 1 || records[0]["type"] != "session_meta" {
		t.Fatalf("records = %v", records)
	}
	want := int64(len(tail) - len(`{"type":"session_meta"}`+"\n"))
	if len(pending) != 1 || pending[0] != want {
		t.Fatalf("pending = %v, want [%d]", pending, want)
	}
}

func TestFailsClosedOnIllegalLeadBytesInsteadOfDeferringTheRow(t *testing.T) {
	cases := []struct {
		lead byte
		name string
	}{
		{0xc0, "an overlong two-byte lead"},
		{0xc1, "an overlong two-byte lead"},
		{0xf5, "a four-byte lead past U+10FFFF"},
		{0xf6, "a four-byte lead past U+10FFFF"},
		{0xf7, "a four-byte lead past U+10FFFF"},
	}
	for _, testCase := range cases {
		t.Run(fmt.Sprintf("lead %#x (%s)", testCase.lead, testCase.name), func(t *testing.T) {
			prefix := []byte(`{"type":"session_meta"}` + "\n" + `{"type":"event_msg","payload":"`)
			tail := append(append([]byte{}, prefix...), testCase.lead)
			err := readStreamError(newChunkedReader(tail), JSONLReadLimits{
				AllowIncompleteFinalLine: true,
				MaxLineBytes:             int64Ptr(1024),
			})
			if err == nil || !strings.Contains(err.Error(), "contains invalid UTF-8") {
				t.Fatalf("error = %v, want an invalid UTF-8 failure", err)
			}
		})
	}
}

func TestFailsClosedOnConstrainedSecondBytesInsteadOfDeferringTheRow(t *testing.T) {
	cases := []struct {
		lead   byte
		second byte
		name   string
	}{
		{0xe0, 0x80, "an overlong three-byte lead"},
		{0xed, 0xa0, "a surrogate three-byte lead"},
		{0xf0, 0x8f, "an overlong four-byte lead"},
		{0xf4, 0x90, "a four-byte lead past U+10FFFF"},
	}
	for _, testCase := range cases {
		t.Run(fmt.Sprintf("lead %#x second %#x (%s)", testCase.lead, testCase.second, testCase.name), func(t *testing.T) {
			prefix := []byte(`{"type":"session_meta"}` + "\n" + `{"type":"event_msg","payload":"`)
			tail := append(append([]byte{}, prefix...), testCase.lead, testCase.second)
			err := readStreamError(newChunkedReader(tail), JSONLReadLimits{
				AllowIncompleteFinalLine: true,
				MaxLineBytes:             int64Ptr(1024),
			})
			if err == nil || !strings.Contains(err.Error(), "contains invalid UTF-8") {
				t.Fatalf("error = %v, want an invalid UTF-8 failure", err)
			}
		})
	}
}

func TestStillDefersAnUnfinishedTailAtEachLegalLeadByte(t *testing.T) {
	cases := []struct {
		lead          byte
		continuations []byte
		name          string
	}{
		{0xc3, nil, "a two-byte lead with no continuation"},
		{0xdf, nil, "the last two-byte lead"},
		{0xe4, nil, "a three-byte lead with no continuation"},
		{0xe4, []byte{0x80}, "a three-byte lead with one continuation"},
		{0xef, []byte{0x80}, "the last three-byte lead"},
		{0xf0, []byte{0x90, 0x80}, "a four-byte lead with two continuations"},
		{0xf4, []byte{0x80, 0x80}, "the last four-byte lead"},
	}
	for _, testCase := range cases {
		t.Run(fmt.Sprintf("lead %#x with %d continuation byte(s) (%s)", testCase.lead, len(testCase.continuations), testCase.name), func(t *testing.T) {
			pending := []int64{}
			warnings := 0
			prefix := []byte(`{"type":"session_meta"}` + "\n" + `{"type":"event_msg","payload":"`)
			tail := append(append([]byte{}, prefix...), testCase.lead)
			tail = append(tail, testCase.continuations...)
			limits := JSONLReadLimits{
				AllowIncompleteFinalLine: true,
				OnIncompleteFinalLine:    func(byteLength int64) { pending = append(pending, byteLength) },
				MaxLineBytes:             int64Ptr(1024),
			}
			if err := ReadJSONLRecordsFromStream(newChunkedReader(tail), func(string) { warnings++ }, limits,
				func(UnknownRecord) error { return nil }); err != nil {
				t.Fatal(err)
			}
			if warnings != 0 {
				t.Fatalf("warnings = %d, want 0", warnings)
			}
			want := int64(len(tail) - len(`{"type":"session_meta"}`+"\n"))
			if len(pending) != 1 || pending[0] != want {
				t.Fatalf("pending = %v, want [%d]", pending, want)
			}
		})
	}
}

func TestKeepsACompleteFinalJSONLRowWithoutANewline(t *testing.T) {
	records := collectRecords(t, newChunkedReader([]byte(`{"type":"session_meta"}`)), JSONLReadLimits{
		AllowIncompleteFinalLine: true,
		MaxLineBytes:             int64Ptr(1024),
	}, nil)
	if len(records) != 1 || records[0]["type"] != "session_meta" {
		t.Fatalf("records = %v", records)
	}
}

func TestDoesNotDeferACompleteMalformedFinalJSONLRow(t *testing.T) {
	warnings := []string{}
	collectRecords(t, newChunkedReader([]byte(`{"type":}`)), JSONLReadLimits{
		AllowIncompleteFinalLine: true,
		MaxLineBytes:             int64Ptr(1024),
	}, &warnings)
	if len(warnings) != 1 || warnings[0] != "Skipping malformed Codex subagent JSONL row at line 1" {
		t.Fatalf("warnings = %v", warnings)
	}
}

func TestRejectsInvalidUTF8BeforeAShortChildRowCanBeDecoded(t *testing.T) {
	malformed := append([]byte(`{"type":"event_msg","payload":"`), 0xc3, 0x28)
	malformed = append(malformed, []byte(`"}`+"\n")...)
	limits := testChildSessionReadLimits()
	limits.MaxLineBytes = int64Ptr(1024)
	err := readStreamError(newChunkedReader(malformed), limits)
	if err == nil || err.Error() != "Codex child session contains invalid UTF-8" {
		t.Fatalf("error = %v", err)
	}
}

func TestDoesNotSkipAMalformedOversizedChildRow(t *testing.T) {
	malformed := `{"type":"compacted","payload":"` + strings.Repeat("x", 128)
	limits := testChildSessionReadLimits()
	limits.MaxLineBytes = int64Ptr(64)
	limits.MaxDiscardedLineBytes = int64Ptr(512)
	err := readStreamError(newChunkedReader([]byte(malformed)), limits)
	if err == nil || err.Error() != "Codex child session contains a malformed oversized line" {
		t.Fatalf("error = %v", err)
	}
}

func TestDoesNotSkipAnOversizedChildRowWithInvalidUTF8Content(t *testing.T) {
	malformed := append([]byte(`{"type":"compacted","payload":"`), []byte(strings.Repeat("x", 128))...)
	malformed = append(malformed, 0xc3, 0x28)
	malformed = append(malformed, []byte(`"}`)...)
	limits := testChildSessionReadLimits()
	limits.MaxLineBytes = int64Ptr(64)
	limits.MaxDiscardedLineBytes = int64Ptr(512)
	err := readStreamError(newChunkedReader(malformed), limits)
	if err == nil || err.Error() != "Codex child session contains a malformed oversized line" {
		t.Fatalf("error = %v", err)
	}
}

func TestDoesNotSkipInvalidUTF8SplitAcrossOversizedChildRowChunks(t *testing.T) {
	firstChunk := append([]byte(`{"type":"compacted","payload":"`), []byte(strings.Repeat("x", 128))...)
	firstChunk = append(firstChunk, 0xc3)
	secondChunk := append([]byte{0x28}, []byte(`"}`)...)
	limits := testChildSessionReadLimits()
	limits.MaxLineBytes = int64Ptr(64)
	limits.MaxDiscardedLineBytes = int64Ptr(512)
	err := readStreamError(newChunkedReader(firstChunk, secondChunk), limits)
	if err == nil || err.Error() != "Codex child session contains a malformed oversized line" {
		t.Fatalf("error = %v", err)
	}
}

func TestDoesNotSkipAnOversizedChildRowWithAnEscapedUsageKey(t *testing.T) {
	oversized := `{"type":"event_msg","payload":{"info":{"total_token_usage":{"input_tokens":1}}},"padding":"` +
		strings.Repeat("x", 128) + `"}`
	limits := testChildSessionReadLimits()
	limits.MaxLineBytes = int64Ptr(64)
	limits.MaxDiscardedLineBytes = int64Ptr(512)
	err := readStreamError(newChunkedReader([]byte(oversized)), limits)
	if err == nil || err.Error() != "Codex child session contains an oversized line with usage or subagent metadata" {
		t.Fatalf("error = %v", err)
	}
}

func TestRejectsAnOversizedLineAcrossChunksBeforeBufferingTheFullLine(t *testing.T) {
	stream := newChunkedReader(
		[]byte(strings.Repeat("a", 16)),
		[]byte(strings.Repeat("b", 17)),
		[]byte(strings.Repeat("c", 64)),
	)
	err := readStreamError(stream, JSONLReadLimits{
		MaxLineBytes: int64Ptr(32),
		Label:        "Codex child session",
	})
	if err == nil || err.Error() != "Codex child session contains a line exceeding the 32-byte limit" {
		t.Fatalf("error = %v", err)
	}
	if !stream.closed {
		t.Fatal("stream was not destroyed")
	}
}

func TestEnforcesTheTotalByteLimitForDirectJSONLStreams(t *testing.T) {
	stream := newChunkedReader(
		[]byte(`{"type":"session_meta"}`+"\n"),
		[]byte(`{"type":"event_msg"}`+"\n"),
	)
	err := readStreamError(stream, JSONLReadLimits{
		MaxBytes:     int64Ptr(32),
		MaxLineBytes: int64Ptr(64),
		Label:        "Codex child session",
	})
	if err == nil || err.Error() != "Codex child session exceeds the 32-byte limit" {
		t.Fatalf("error = %v", err)
	}
	if !stream.closed {
		t.Fatal("stream was not destroyed")
	}
}

func TestBoundsDiscardedOversizedLinesWhenAnExplicitStreamingPolicyIsEnabled(t *testing.T) {
	stream := newChunkedReader(
		[]byte(`{"type":"compacted","payload":"`),
		[]byte(strings.Repeat("x", 65)),
	)
	err := readStreamError(stream, JSONLReadLimits{
		MaxLineBytes:          int64Ptr(32),
		MaxDiscardedLineBytes: int64Ptr(64),
		RelevantMetadataKeys:  []string{"total_token_usage"},
		DiscardableLineTypes:  []string{"compacted"},
		Label:                 "Codex child session",
	})
	if err == nil || err.Error() != "Codex child session contains a line exceeding the 64-byte discarded-line limit" {
		t.Fatalf("error = %v", err)
	}
	if !stream.closed {
		t.Fatal("stream was not destroyed")
	}
}

func TestRejectsImpossibleISOCalendarDatesInsteadOfNormalizingThem(t *testing.T) {
	for _, value := range []string{
		"2026-02-30T00:00:00.000Z",
		"2026-02-30",
		"2026-02-30 00:00:00",
		"2026-02-30Z",
	} {
		if _, err := NormalizeDate(value); err == nil || err.Error() != "Invalid Codex date" {
			t.Fatalf("NormalizeDate(%q) error = %v", value, err)
		}
	}
	got, err := NormalizeDate("2024-02-29T00:00:00.000Z")
	if err != nil || got != "2024-02-29" {
		t.Fatalf("NormalizeDate(leap day) = %q, %v", got, err)
	}
}

func TestRejectsAnOversizedChildRowContainingTokenUsageMetadata(t *testing.T) {
	usage := map[string]any{"input_tokens": float64(1), "total_tokens": float64(1)}
	oversized := mustMarshalJSON(t, map[string]any{
		"type": "event_msg",
		"payload": map[string]any{
			"info": map[string]any{
				"total_token_usage": usage,
				"last_token_usage":  usage,
				"padding":           strings.Repeat("x", 1024*1024+1),
			},
		},
	})
	err := readStreamError(newChunkedReader([]byte(oversized+"\n")), testChildSessionReadLimits())
	if err == nil || err.Error() != "Codex child session contains an oversized line with usage or subagent metadata" {
		t.Fatalf("error = %v", err)
	}
}

func TestRejectsAnOversizedChildRowContainingSubagentMetadata(t *testing.T) {
	oversized := mustMarshalJSON(t, map[string]any{
		"type": "session_meta",
		"payload": map[string]any{
			"source": map[string]any{
				"subagent": map[string]any{
					"thread_spawn": map[string]any{"parent_thread_id": "parent"},
				},
			},
			"padding": strings.Repeat("x", 1024*1024+1),
		},
	})
	err := readStreamError(newChunkedReader([]byte(oversized+"\n")), testChildSessionReadLimits())
	if err == nil || err.Error() != "Codex child session contains an oversized line with usage or subagent metadata" {
		t.Fatalf("error = %v", err)
	}
}

// TestSkipsOversizedChildRowsWithoutUsageOrSubagentMetadata covers the
// file-backed half of the TS "skips oversized child rows…" cases at the reader
// layer: the row is dropped, the warning names the largest row, and the usage
// event after it is still read.
func TestSkipsOversizedChildRowsWithoutUsageOrSubagentMetadata(t *testing.T) {
	root := t.TempDir()
	filePath := filepath.Join(root, "child.jsonl")
	oversized := mustMarshalJSON(t, map[string]any{
		"type":    "compacted",
		"payload": map[string]any{"summary": strings.Repeat("x", 1024*1024+1)},
	})
	usage := mustMarshalJSON(t, childUsageEvent(1))
	if err := os.WriteFile(filePath, []byte(oversized+"\n"+usage+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	warnings := []string{}
	records := []UnknownRecord{}
	if err := ReadJSONLRecords(filePath, func(line string) { warnings = append(warnings, line) },
		testChildSessionReadLimits(), func(record UnknownRecord) error {
			records = append(records, record)
			return nil
		}); err != nil {
		t.Fatal(err)
	}
	if len(records) != 1 || records[0]["type"] != "event_msg" {
		t.Fatalf("records = %v", records)
	}
	want := fmt.Sprintf(
		"Skipped 1 oversized Codex child session JSONL row without usage or subagent metadata (largest %d bytes)",
		len(oversized))
	if len(warnings) != 1 || warnings[0] != want {
		t.Fatalf("warnings = %v, want [%q]", warnings, want)
	}
}

func mustMarshalJSON(t *testing.T, value any) string {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return string(encoded)
}

// Date.parse accepts timestamp forms the layout lists did not spell out: a
// missing seconds field, a colon-less offset, and a space instead of "T". The
// TS collector normalizes all of them to a calendar date; returning the raw
// value instead hands the contract a timestamp where a date belongs, and
// validation rejects the whole sync.
func TestNormalizeDateAcceptsTheFormsDateParseAccepts(t *testing.T) {
	cases := map[string]string{
		"2025-08-08T10:00Z":        "2025-08-08",
		"2025-08-08T10:00:00+0200": "2025-08-08",
		"2025-08-08 10:00":         "2025-08-08",
		"2025-08-08 10:00:00":      "2025-08-08",
	}
	for value, want := range cases {
		got, err := NormalizeDate(value)
		if err != nil {
			t.Fatalf("NormalizeDate(%q): %v", value, err)
		}
		if got != want {
			t.Errorf("NormalizeDate(%q) = %q, want %q", value, got, want)
		}
	}
}
