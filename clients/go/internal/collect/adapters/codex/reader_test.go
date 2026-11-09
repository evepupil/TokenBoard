package codex

// The Codex adapter's reader and line prefilter, pinned against ccusage
// v20.0.33 (commit 1308c416): rust/adapters/codex/src/reader.rs and
// codex_line_usage_kind / codex_line_type_flags in parser.rs, with the
// compression expectations taken from compression_tests.rs:172-220.

import (
	"bytes"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/klauspost/compress/zstd"
)

func zstdFrame(t *testing.T, payload string) []byte {
	t.Helper()
	var buffer bytes.Buffer
	writer, err := zstd.NewWriter(&buffer, zstd.WithEncoderConcurrency(1))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := writer.Write([]byte(payload)); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}

func concatFrames(parts ...[]byte) []byte {
	var out []byte
	for _, part := range parts {
		out = append(out, part...)
	}
	return out
}

func readAllLines(t *testing.T, reader io.Reader) []string {
	t.Helper()
	lines := []string{}
	err := ReadLines(reader, func(line []byte) error {
		lines = append(lines, string(line))
		return nil
	})
	if err != nil {
		t.Fatalf("ReadLines returned %v, want nil", err)
	}
	return lines
}

func assertLines(t *testing.T, got, want []string) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("lines = %q, want %q", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("lines[%d] = %q, want %q", i, got[i], want[i])
		}
	}
}

// TestOpenRolloutFallsBackToTheOtherEncoding pins open_rollout_reader
// (reader.rs:36-49): a rollout that Codex recompressed or restored between
// discovery and the open is read through its other encoding, and the opened
// path is reported so fallback timestamps come from the file actually read.
func TestOpenRolloutFallsBackToTheOtherEncoding(t *testing.T) {
	dir := t.TempDir()
	plain := filepath.Join(dir, "session.jsonl")
	compressed := plain + ".zst"

	if err := os.WriteFile(compressed, zstdFrame(t, "one\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	reader, opened, err := OpenRollout(plain)
	if err != nil {
		t.Fatal(err)
	}
	if opened != compressed {
		t.Fatalf("opened = %s, want the surviving compressed twin", opened)
	}
	if data, err := io.ReadAll(reader); err != nil || string(data) != "one\n" {
		reader.Close()
		t.Fatalf("read = (%q, %v), want the compressed payload", data, err)
	}
	if err := reader.Close(); err != nil {
		t.Fatal(err)
	}

	if err := os.Remove(compressed); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(plain, []byte("two\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	reader, opened, err = OpenRollout(compressed)
	if err != nil {
		t.Fatal(err)
	}
	if opened != plain {
		t.Fatalf("opened = %s, want the surviving plain twin", opened)
	}
	if data, err := io.ReadAll(reader); err != nil || string(data) != "two\n" {
		reader.Close()
		t.Fatalf("read = (%q, %v), want the plain payload", data, err)
	}
	if err := reader.Close(); err != nil {
		t.Fatal(err)
	}

	if _, _, err := OpenRollout(filepath.Join(dir, "missing.jsonl")); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("OpenRollout(missing) = %v, want a not-exist error from the fallback attempt", err)
	}
}

// TestReadLinesKeepsEverythingBeforeATruncatedZstdFrame pins
// keeps_usage_decoded_before_a_truncated_frame (compression_tests.rs:194-213):
// a tail frame cut mid-write is a normal end of the log - every complete line
// before it is visited, the partial frame contributes nothing, and nothing is
// reported as an error.
func TestReadLinesKeepsEverythingBeforeATruncatedZstdFrame(t *testing.T) {
	first := zstdFrame(t, "first\n")
	second := zstdFrame(t, "dropped\n")
	stream := concatFrames(first, second[:len(second)/2])

	dir := t.TempDir()
	path := filepath.Join(dir, "session.jsonl.zst")
	if err := os.WriteFile(path, stream, 0o644); err != nil {
		t.Fatal(err)
	}
	reader, _, err := OpenRollout(path)
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()

	assertLines(t, readAllLines(t, reader), []string{"first\n"})
}

// TestReadLinesHandlesConcatenatedFrames pins
// counts_cumulative_deltas_across_concatenated_zstd_frames
// (compression_tests.rs:172-192): Codex appends whole frames, so the reader
// must decode every frame of the stream, not just the first.
func TestReadLinesHandlesConcatenatedFrames(t *testing.T) {
	stream := concatFrames(
		zstdFrame(t, "one\n"),
		zstdFrame(t, "two\n"),
		zstdFrame(t, "three\n"),
	)
	dir := t.TempDir()
	path := filepath.Join(dir, "session.jsonl.zst")
	if err := os.WriteFile(path, stream, 0o644); err != nil {
		t.Fatal(err)
	}
	reader, _, err := OpenRollout(path)
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()

	assertLines(t, readAllLines(t, reader), []string{"one\n", "two\n", "three\n"})
}

// TestReadLinesAcceptsFinalLineWithoutNewline pins read_until semantics
// (parser.rs:271-277): the last line of a log that is still being written
// arrives without a newline and is still a line.
func TestReadLinesAcceptsFinalLineWithoutNewline(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "session.jsonl")
	if err := os.WriteFile(path, []byte("one\ntwo"), 0o644); err != nil {
		t.Fatal(err)
	}
	reader, _, err := OpenRollout(path)
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()

	assertLines(t, readAllLines(t, reader), []string{"one\n", "two"})
}

// TestClassifyLineMatchesCompactAndSpacedForms pins codex_line_usage_kind and
// codex_line_type_flags (parser.rs:661-790): every session record shape counts
// as Session whether Codex wrote it compactly, with a space after the colon,
// or with whitespace around the colon; the structural scan matches the six
// enum values exactly.
func TestClassifyLineMatchesCompactAndSpacedForms(t *testing.T) {
	cases := []struct {
		name string
		line string
	}{
		{"compact turn_context", `{"type":"turn_context","payload":{}}`},
		{"spaced turn_context", `{"type": "turn_context", "payload": {}}`},
		{"spaced-before-colon turn_context", `{"type" : "turn_context"}`},
		{"compact token_count", `{"type":"event_msg","payload":{"type":"token_count"}}`},
		{"spaced token_count", `{"type": "event_msg", "payload": {"type": "token_count"}}`},
		{"compact thread_settings_applied", `{"type":"event_msg","payload":{"type":"thread_settings_applied"}}`},
		{"spaced thread_settings_applied", `{"type": "event_msg", "payload": {"type": "thread_settings_applied"}}`},
		{"compact token_usage_record", `{"type":"token_usage_record"}`},
		{"spaced token_usage_record", `{"type": "token_usage_record"}`},
		{"compact compacted", `{"type":"compacted"}`},
		{"spaced compacted", `{"type": "compacted"}`},
	}
	for _, tc := range cases {
		if got := ClassifyLine([]byte(tc.line)); got != Session {
			t.Fatalf("%s: ClassifyLine = %v, want Session", tc.name, got)
		}
	}

	// A token_count under a "type" key without event_msg is not a session
	// record; the outer type decides (parser.rs:700-711).
	if got := ClassifyLine([]byte(`{"type":"tool_call","payload":{"type":"token_count"}}`)); got == Session {
		t.Fatal("token_count nested under a non-event_msg type must not be Session")
	}
}

// TestClassifyLineExcludesSpacedTokenCountOver64KiB pins the 64 KiB gate
// (parser.rs:683-690): the nested search for a spaced token_count is skipped
// for lines at or above 64 KiB, so such a line falls through to the headless
// and skip tests.
func TestClassifyLineExcludesSpacedTokenCountOver64KiB(t *testing.T) {
	padding := strings.Repeat(" ", 64*1024)
	line := `{"type": "event_msg", "payload": {"type": "token_count", "pad": "` + padding + `"}}`
	if len(line) < 64*1024 {
		t.Fatalf("fixture is %d bytes, want at least 64 KiB", len(line))
	}
	if got := ClassifyLine([]byte(line)); got != Skip {
		t.Fatalf("ClassifyLine(over 64 KiB) = %v, want Skip", got)
	}

	// The same shape just under the gate is still a session record, so the
	// test above fails on the length check and not on the line's content.
	short := `{"type": "event_msg", "payload": {"type": "token_count", "pad": "` + strings.Repeat(" ", 32*1024) + `"}}`
	if got := ClassifyLine([]byte(short)); got != Session {
		t.Fatalf("ClassifyLine(under 64 KiB) = %v, want Session", got)
	}
}

// TestClassifyLineFallsBackToHeadlessUsageFields pins the headless arm
// (parser.rs:708-713): a line with a usage field but no session record shape
// is Headless, not skipped.
func TestClassifyLineFallsBackToHeadlessUsageFields(t *testing.T) {
	for _, line := range []string{
		`{"usage":{"input_tokens":1}}`,
		`{"input_tokens": 12}`,
		`{"prompt_tokens": 7}`,
	} {
		if got := ClassifyLine([]byte(line)); got != Headless {
			t.Fatalf("ClassifyLine(%s) = %v, want Headless", line, got)
		}
	}
}

// TestClassifyLineTreatsInputOnlyAsSkip pins that the "input"/"output"
// aliases are not headless triggers (parser.rs:708-710): only the three
// exact field names count, so an input-only line is Skip.
func TestClassifyLineTreatsInputOnlyAsSkip(t *testing.T) {
	for _, line := range []string{
		`{"input": 12, "output": 4}`,
		`{"reasoning_output": 1}`,
		`{"message": "hello"}`,
	} {
		if got := ClassifyLine([]byte(line)); got != Skip {
			t.Fatalf("ClassifyLine(%s) = %v, want Skip", line, got)
		}
	}
}
