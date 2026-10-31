package sessionfile

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/MisonL/TokenBoard/clients/go/internal/contract"
)

// The fixtures below mirror session-jsonl-line-reader.test.ts byte for byte:
// the oversized-row scanner is a byte-level state machine, so field order and
// separators are part of each case.

func writeSessionJSONL(t *testing.T, name string, content []byte) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(path, content, 0o600); err != nil {
		t.Fatalf("write fixture: %v", err)
	}
	return path
}

func collectLines(t *testing.T, input ReadInput) ([]Line, error) {
	t.Helper()
	var lines []Line
	err := Read(input, func(line Line) error {
		lines = append(lines, line)
		return nil
	})
	return lines, err
}

func requireReadError(t *testing.T, err error, want string) {
	t.Helper()
	if err == nil {
		t.Fatalf("expected error containing %q, got nil", want)
	}
	if !strings.Contains(err.Error(), want) {
		t.Fatalf("expected error containing %q, got %q", want, err.Error())
	}
}

func requireSkippedLine(t *testing.T, line Line) {
	t.Helper()
	if !line.Skipped {
		t.Fatalf("expected a skipped-oversized marker, got text line %q", line.Text)
	}
}

func TestReadSessionJSONLPreservesLFCRLFAndCRSeparators(t *testing.T) {
	path := writeSessionJSONL(t, "separators.jsonl",
		[]byte("{\"type\":\"session_meta\"}\n{\"type\":\"summary\"}\r\n{\"type\":\"progress\"}\r"))

	lines, err := collectLines(t, ReadInput{FilePath: path, MaxLineBytes: 1024})
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	want := []string{`{"type":"session_meta"}`, `{"type":"summary"}`, `{"type":"progress"}`}
	if len(lines) != len(want) {
		t.Fatalf("got %d lines, want %d: %#v", len(lines), len(want), lines)
	}
	for i, expected := range want {
		if lines[i].Skipped || lines[i].Text != expected {
			t.Fatalf("line %d = %#v, want %q", i, lines[i], expected)
		}
	}
}

func TestReadSessionJSONLRejectsInvalidUTF8BeforeShortRowDecoding(t *testing.T) {
	malformed := append([]byte(`{"type":"response_item","payload":"`), 0xc3, 0x28)
	malformed = append(malformed, []byte("\"}\n")...)
	path := writeSessionJSONL(t, "invalid-short-utf8.jsonl", malformed)

	_, err := collectLines(t, ReadInput{FilePath: path, MaxLineBytes: 1024})
	requireReadError(t, err, "Session JSONL contains invalid UTF-8")
}

func TestReadSessionJSONLYieldsBoundedSkipMarkerForNonUsageLine(t *testing.T) {
	oversized := `{"type":"response_item","payload":{"text":"` + strings.Repeat("x", 512) + `"}}`
	later := `{"type":"session_meta"}`
	path := writeSessionJSONL(t, "oversized.jsonl", []byte(oversized+"\n"+later+"\n"))

	lines, err := collectLines(t, ReadInput{FilePath: path, MaxLineBytes: 64, MaxDiscardBytes: 1024})
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if len(lines) != 2 {
		t.Fatalf("got %d lines, want 2: %#v", len(lines), lines)
	}
	requireSkippedLine(t, lines[0])
	if lines[0].ByteLength != int64(len(oversized)) {
		t.Fatalf("skipped line byteLength = %d, want %d", lines[0].ByteLength, len(oversized))
	}
	if lines[1].Skipped || lines[1].Text != later {
		t.Fatalf("second line = %#v, want %q", lines[1], later)
	}
}

func TestReadSessionJSONLRecognizesKnownNonUsageTypeAfterOversizedContentField(t *testing.T) {
	oversized := `{"payload":{"text":"` + strings.Repeat("x", 512) + `"},"type":"response_item"}`
	path := writeSessionJSONL(t, "late-type.jsonl", []byte(oversized+"\n"))

	lines, err := collectLines(t, ReadInput{FilePath: path, MaxLineBytes: 64, MaxDiscardBytes: 1024})
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if len(lines) != 1 {
		t.Fatalf("got %d lines, want 1: %#v", len(lines), lines)
	}
	requireSkippedLine(t, lines[0])
}

func TestReadSessionJSONLSkipsKnownNonUsageRecordWithOversizedIrrelevantKey(t *testing.T) {
	oversized := `{"` + strings.Repeat("x", 512) + `":"irrelevant","type":"response_item"}`
	path := writeSessionJSONL(t, "oversized-key.jsonl", []byte(oversized+"\n"))

	lines, err := collectLines(t, ReadInput{FilePath: path, MaxLineBytes: 64, MaxDiscardBytes: 1024})
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if len(lines) != 1 {
		t.Fatalf("got %d lines, want 1: %#v", len(lines), lines)
	}
	requireSkippedLine(t, lines[0])
}

func TestReadSessionJSONLDetectsUsageMetadataAfterOversizedIrrelevantKey(t *testing.T) {
	oversized := `{"` + strings.Repeat("x", 512) + `":"irrelevant","type":"event_msg","payload":{"info":{"last_token_usage":{"input_tokens":1}}}}`
	path := writeSessionJSONL(t, "oversized-key-with-usage.jsonl", []byte(oversized+"\n"))

	_, err := collectLines(t, ReadInput{
		FilePath:        path,
		MaxLineBytes:    64,
		MaxDiscardBytes: 1024,
		Source:          contract.SourceCodex,
	})
	requireReadError(t, err, "Session JSONL contains an oversized line with token or usage metadata")
}

func TestReadSessionJSONLFailsWhenUsageMetadataAppearsAfterLineLimit(t *testing.T) {
	oversized := `{"type":"event_msg","padding":"` + strings.Repeat("x", 128*1024) +
		`","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":1}}}}`
	path := writeSessionJSONL(t, "usage-after-limit.jsonl", []byte(oversized+"\n"))

	_, err := collectLines(t, ReadInput{FilePath: path, MaxLineBytes: 64, MaxDiscardBytes: 256 * 1024})
	requireReadError(t, err, "Session JSONL contains an oversized line with token or usage metadata")
}

func TestReadSessionJSONLSkipsNonMetricUsageString(t *testing.T) {
	oversized := `{"type":"response_item","payload":{"usage":"render diagnostics only","text":"` +
		strings.Repeat("x", 512) + `"}}`
	path := writeSessionJSONL(t, "usage-string.jsonl", []byte(oversized+"\n"))

	lines, err := collectLines(t, ReadInput{FilePath: path, MaxLineBytes: 64, MaxDiscardBytes: 1024})
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if len(lines) != 1 {
		t.Fatalf("got %d lines, want 1: %#v", len(lines), lines)
	}
	requireSkippedLine(t, lines[0])
}

func TestReadSessionJSONLDoesNotTreatTokenShapedTextAsMetadata(t *testing.T) {
	oversized := `{"type":"response_item","payload":{"text":"` + strings.Repeat("x", 256) +
		` {\"usage\":{\"input_tokens\":1}} ` + strings.Repeat("y", 256) + `"}}`
	path := writeSessionJSONL(t, "token-text.jsonl", []byte(oversized+"\n"))

	lines, err := collectLines(t, ReadInput{FilePath: path, MaxLineBytes: 64, MaxDiscardBytes: 1024})
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if len(lines) != 1 {
		t.Fatalf("got %d lines, want 1: %#v", len(lines), lines)
	}
	requireSkippedLine(t, lines[0])
}

func TestReadSessionJSONLFailsWhenOversizedUsageObjectSplitAcrossChunks(t *testing.T) {
	oversized := `{"type":"assistant","padding":"` + strings.Repeat("x", 128*1024) +
		`","usage" : {"input_tokens":1}}`
	path := writeSessionJSONL(t, "usage-object.jsonl", []byte(oversized+"\n"))

	_, err := collectLines(t, ReadInput{FilePath: path, MaxLineBytes: 64, MaxDiscardBytes: 256 * 1024})
	requireReadError(t, err, "Session JSONL contains an oversized line with token or usage metadata")
}

func TestReadSessionJSONLFailsForOversizedEmptyUsageObject(t *testing.T) {
	oversized := `{"type":"assistant","timestamp":"2026-05-22T02:00:00.000Z","padding":"` +
		strings.Repeat("x", 128*1024) + `","usage":{}}`
	path := writeSessionJSONL(t, "empty-usage.jsonl", []byte(oversized+"\n"))

	_, err := collectLines(t, ReadInput{
		FilePath:        path,
		MaxLineBytes:    64,
		MaxDiscardBytes: 256 * 1024,
		Source:          contract.SourceClaudeCode,
	})
	requireReadError(t, err, "Session JSONL contains an oversized line with token or usage metadata")
}

func TestReadSessionJSONLSkipsOversizedCodexRowWithTokenFieldsOutsideUsage(t *testing.T) {
	oversized := `{"type":"event_msg","payload":{"type":"token_count","padding":"` +
		strings.Repeat("x", 128*1024) + `","unrelated":{"input_tokens":1}}}`
	path := writeSessionJSONL(t, "unparsed-token.jsonl", []byte(oversized+"\n"))

	lines, err := collectLines(t, ReadInput{
		FilePath:        path,
		MaxLineBytes:    64,
		MaxDiscardBytes: 256 * 1024,
		Source:          contract.SourceCodex,
	})
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if len(lines) != 1 {
		t.Fatalf("got %d lines, want 1: %#v", len(lines), lines)
	}
	requireSkippedLine(t, lines[0])
}

func TestReadSessionJSONLFailsForOversizedCodexPayloadLevelTotalUsage(t *testing.T) {
	oversized := `{"type":"event_msg","payload":{"type":"token_count","total_token_usage":{"input_tokens":1,"total_tokens":1},"padding":"` +
		strings.Repeat("x", 128*1024) + `"}}`
	path := writeSessionJSONL(t, "payload-total-usage.jsonl", []byte(oversized+"\n"))

	_, err := collectLines(t, ReadInput{
		FilePath:        path,
		MaxLineBytes:    64,
		MaxDiscardBytes: 256 * 1024,
		Source:          contract.SourceCodex,
	})
	requireReadError(t, err, "Session JSONL contains an oversized line with token or usage metadata")
}

func TestReadSessionJSONLDoesNotSilentlySkipMalformedOversizedRow(t *testing.T) {
	malformed := `{"type":"response_item","payload":"` + strings.Repeat("x", 512)
	path := writeSessionJSONL(t, "malformed.jsonl", []byte(malformed+"\n"))

	_, err := collectLines(t, ReadInput{FilePath: path, MaxLineBytes: 64, MaxDiscardBytes: 1024})
	requireReadError(t, err, "Session JSONL contains a malformed oversized line")
}

func TestReadSessionJSONLDoesNotSilentlySkipOversizedRowWithTrailingComma(t *testing.T) {
	malformed := `{"type":"response_item","payload":{"text":"` + strings.Repeat("x", 512) + `"},}`
	path := writeSessionJSONL(t, "trailing-comma.jsonl", []byte(malformed+"\n"))

	_, err := collectLines(t, ReadInput{FilePath: path, MaxLineBytes: 64, MaxDiscardBytes: 1024})
	requireReadError(t, err, "Session JSONL contains a malformed oversized line")
}

func TestReadSessionJSONLDoesNotSilentlySkipOversizedRowWithTrailingCommaAfterScalar(t *testing.T) {
	malformed := `{"type":"response_item","payload":"` + strings.Repeat("x", 512) + `","count":1,}`
	path := writeSessionJSONL(t, "scalar-trailing-comma.jsonl", []byte(malformed+"\n"))

	_, err := collectLines(t, ReadInput{FilePath: path, MaxLineBytes: 64, MaxDiscardBytes: 1024})
	requireReadError(t, err, "Session JSONL contains a malformed oversized line")
}

func TestReadSessionJSONLDoesNotSilentlySkipOversizedRowWithTrailingCommaInArray(t *testing.T) {
	malformed := `{"type":"response_item","payload":["` + strings.Repeat("x", 512) + `",]}`
	path := writeSessionJSONL(t, "array-trailing-comma.jsonl", []byte(malformed+"\n"))

	_, err := collectLines(t, ReadInput{FilePath: path, MaxLineBytes: 64, MaxDiscardBytes: 1024})
	requireReadError(t, err, "Session JSONL contains a malformed oversized line")
}

func TestReadSessionJSONLSkipsOversizedRowWithValidScalarFieldsAfterComma(t *testing.T) {
	oversized := `{"type":"response_item","payload":"` + strings.Repeat("x", 512) + `","count":1,"next":2}`
	path := writeSessionJSONL(t, "scalar-fields.jsonl", []byte(oversized+"\n"))

	lines, err := collectLines(t, ReadInput{FilePath: path, MaxLineBytes: 64, MaxDiscardBytes: 1024})
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if len(lines) != 1 {
		t.Fatalf("got %d lines, want 1: %#v", len(lines), lines)
	}
	requireSkippedLine(t, lines[0])
}

func TestReadSessionJSONLSkipsOversizedKnownRecordWithMultibyteUTF8(t *testing.T) {
	oversized := `{"type":"response_item","payload":"` + strings.Repeat("x", 512) + "中" + `"}`
	path := writeSessionJSONL(t, "utf8.jsonl", []byte(oversized+"\n"))

	lines, err := collectLines(t, ReadInput{FilePath: path, MaxLineBytes: 64, MaxDiscardBytes: 1024})
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if len(lines) != 1 {
		t.Fatalf("got %d lines, want 1: %#v", len(lines), lines)
	}
	requireSkippedLine(t, lines[0])
}

func TestReadSessionJSONLDoesNotSilentlySkipOversizedRowWithInvalidUTF8(t *testing.T) {
	malformed := append([]byte(`{"type":"response_item","payload":"`+strings.Repeat("x", 512)), 0xc3, 0x28)
	malformed = append(malformed, []byte("\"}\n")...)
	path := writeSessionJSONL(t, "invalid-utf8.jsonl", malformed)

	_, err := collectLines(t, ReadInput{FilePath: path, MaxLineBytes: 64, MaxDiscardBytes: 1024})
	requireReadError(t, err, "Session JSONL contains a malformed oversized line")
}

func TestReadSessionJSONLUsesFinalRootTypeWhenOversizedRecordRepeatsTypeKey(t *testing.T) {
	path := filepath.Join(t.TempDir(), "repeated-type.jsonl")
	unknownFinalType := `{"type":"response_item","payload":"` + strings.Repeat("x", 512) + `","type":1}`
	knownFinalType := `{"type":"unknown_record","payload":"` + strings.Repeat("x", 512) + `","type":"response_item"}`

	if err := os.WriteFile(path, []byte(unknownFinalType+"\n"), 0o600); err != nil {
		t.Fatalf("write fixture: %v", err)
	}
	_, err := collectLines(t, ReadInput{FilePath: path, MaxLineBytes: 64, MaxDiscardBytes: 1024})
	requireReadError(t, err, "Session JSONL contains an oversized line with an unknown record type")

	if err := os.WriteFile(path, []byte(knownFinalType+"\n"), 0o600); err != nil {
		t.Fatalf("rewrite fixture: %v", err)
	}
	lines, err := collectLines(t, ReadInput{FilePath: path, MaxLineBytes: 64, MaxDiscardBytes: 1024})
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if len(lines) != 1 {
		t.Fatalf("got %d lines, want 1: %#v", len(lines), lines)
	}
	requireSkippedLine(t, lines[0])
}

func TestReadSessionJSONLCapsDiscardedNonUsageLineScanning(t *testing.T) {
	content := `{"type":"response_item","payload":{"text":"` + strings.Repeat("x", 65) + `"}}` + "\n"
	path := writeSessionJSONL(t, "discard-limit.jsonl", []byte(content))

	_, err := collectLines(t, ReadInput{FilePath: path, MaxLineBytes: 32, MaxDiscardBytes: 64})
	requireReadError(t, err, "Session JSONL contains a non-usage line exceeding the 64-byte discard limit")
}

// Claude Code writes `attachment` rows for hook output, listings and queued
// prompts. They carry no usage, but a queued command can embed base64 images
// and push one row past the in-memory line limit. Left off the discard list,
// that single row fails the whole source.
func TestReadSessionJSONLSkipsOversizedAttachmentRowWithoutUsage(t *testing.T) {
	oversized := `{"type":"attachment","attachment":{"type":"queued_command","prompt":"` +
		strings.Repeat("x", 512) + `"}}`
	path := writeSessionJSONL(t, "oversized-attachment.jsonl", []byte(oversized+"\n"))

	lines, err := collectLines(t, ReadInput{FilePath: path, MaxLineBytes: 64, MaxDiscardBytes: 1024})
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if len(lines) != 1 {
		t.Fatalf("got %d lines, want 1: %#v", len(lines), lines)
	}
	requireSkippedLine(t, lines[0])
}

// `attachment.usage` is a subagent task summary ({totalTokens, toolUses,
// durationMs}), not an uploadable usage object. Only a root-level `usage` is a
// metric row, so an oversized attachment carrying this nested object must
// still be skipped rather than parsed as usage.
func TestReadSessionJSONLSkipsOversizedAttachmentRowWithNestedTaskSummaryUsage(t *testing.T) {
	oversized := `{"type":"attachment","attachment":{"type":"queued_command","usage":{"totalTokens":493090,"toolUses":199,"durationMs":2164518},"prompt":"` +
		strings.Repeat("x", 512) + `"}}`
	path := writeSessionJSONL(t, "oversized-attachment-usage.jsonl", []byte(oversized+"\n"))

	lines, err := collectLines(t, ReadInput{FilePath: path, MaxLineBytes: 64, MaxDiscardBytes: 1024})
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if len(lines) != 1 {
		t.Fatalf("got %d lines, want 1: %#v", len(lines), lines)
	}
	requireSkippedLine(t, lines[0])
}

// `result` rows carry a subagent result key and no usage. Same shape of risk
// as `attachment`: invisible until one grows past the limit, then fatal for
// the whole source.
func TestReadSessionJSONLSkipsOversizedResultRowWithoutUsage(t *testing.T) {
	oversized := `{"type":"result","key":"v2:abc","agentId":"a1ba4da2eec27c917","result":"` +
		strings.Repeat("x", 512) + `"}`
	path := writeSessionJSONL(t, "oversized-result.jsonl", []byte(oversized+"\n"))

	lines, err := collectLines(t, ReadInput{FilePath: path, MaxLineBytes: 64, MaxDiscardBytes: 1024})
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if len(lines) != 1 {
		t.Fatalf("got %d lines, want 1: %#v", len(lines), lines)
	}
	requireSkippedLine(t, lines[0])
}

// Being on the discard list must not make a type's rows blanket-trusted: the
// list says the *type* is not a metric row, but usage in a shape the parser
// actually reads still makes the row billable. `readClaudeMetric` reads
// `record.message.usage` and `record.usage`, so an oversized `attachment`
// carrying either is a real usage row past the in-memory limit and must fail
// loudly. Both shapes the parser reads are pinned.
func TestReadSessionJSONLFailsClosedOnOversizedAttachmentRowWithUsage(t *testing.T) {
	for _, usageLocation := range []string{"root", "message"} {
		t.Run(usageLocation, func(t *testing.T) {
			var oversized string
			if usageLocation == "root" {
				oversized = `{"type":"attachment","usage":{"input_tokens":10,"output_tokens":5},"attachment":{"prompt":"` +
					strings.Repeat("x", 512) + `"}}`
			} else {
				oversized = `{"type":"attachment","message":{"usage":{"input_tokens":10,"output_tokens":5}},"attachment":{"prompt":"` +
					strings.Repeat("x", 512) + `"}}`
			}
			path := writeSessionJSONL(t, "oversized-attachment-usage-"+usageLocation+".jsonl", []byte(oversized+"\n"))

			_, err := collectLines(t, ReadInput{
				FilePath:        path,
				Source:          contract.SourceClaudeCode,
				MaxLineBytes:    64,
				MaxDiscardBytes: 1024,
			})
			requireReadError(t, err, "Session JSONL contains an oversized line with token or usage metadata")
		})
	}
}

func TestReadSessionJSONLDoesNotSilentlySkipOversizedRowWithUnknownRecordType(t *testing.T) {
	content := `{"type":"unknown_record","payload":{"text":"` + strings.Repeat("x", 512) + `"}}` + "\n"
	path := writeSessionJSONL(t, "unknown-type.jsonl", []byte(content))

	_, err := collectLines(t, ReadInput{FilePath: path, MaxLineBytes: 64, MaxDiscardBytes: 1024})
	requireReadError(t, err, "Session JSONL contains an oversized line with an unknown record type")
}

// Claude Code writes `api-request-blob` rows carrying a request payload and a
// content hash, with no usage anywhere in the row (`message` holds only
// `role`/`content`). Same shape of risk as `attachment` and `result`: one
// 1.15 MiB row in a real session stopped every claude-code hook sync from
// 2026-10-23 until the type was listed.
func TestReadSessionJSONLSkipsOversizedAPIRequestBlobRowWithoutUsage(t *testing.T) {
	oversized := `{"type":"api-request-blob","hash":"` + strings.Repeat("a", 64) +
		`","sessionId":"e0f1a435-14af-4b66-959c-b5e754b8a33a","message":{"role":"user","content":[{"type":"text","text":"` +
		strings.Repeat("x", 512) + `"}]}}`
	path := writeSessionJSONL(t, "oversized-api-request-blob.jsonl", []byte(oversized+"\n"))

	lines, err := collectLines(t, ReadInput{
		FilePath:        path,
		Source:          contract.SourceClaudeCode,
		MaxLineBytes:    64,
		MaxDiscardBytes: 1024,
	})
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if len(lines) != 1 {
		t.Fatalf("got %d lines, want 1: %#v", len(lines), lines)
	}
	requireSkippedLine(t, lines[0])
}

// Listing the type must not blanket-trust it: an oversized `api-request-blob`
// whose `message.usage` the parser would read is still billable and must fail
// loudly rather than vanish into the skip.
func TestReadSessionJSONLFailsClosedOnOversizedAPIRequestBlobRowWithUsage(t *testing.T) {
	oversized := `{"type":"api-request-blob","hash":"` + strings.Repeat("a", 64) +
		`","message":{"role":"user","usage":{"input_tokens":10,"output_tokens":5},"content":"` +
		strings.Repeat("x", 512) + `"}}`
	path := writeSessionJSONL(t, "oversized-api-request-blob-usage.jsonl", []byte(oversized+"\n"))

	_, err := collectLines(t, ReadInput{
		FilePath:        path,
		Source:          contract.SourceClaudeCode,
		MaxLineBytes:    64,
		MaxDiscardBytes: 1024,
	})
	requireReadError(t, err, "Session JSONL contains an oversized line with token or usage metadata")
}

// Ports hook-oversized-jsonl.test.ts cases 1 and 2 at the reader layer: the
// hook suite's 1 MiB fixture rows span multiple 64 KiB reads, so the reader
// must both keep a long buffered row intact and report the usage-bearing row
// with the same diagnostic the TS reader throws.

// A text row longer than one read must survive buffering unchanged. Segments
// are views into a reused read buffer, so appending one without copying lets
// the next read overwrite bytes the line still needs.
func TestReadSessionJSONLKeepsLongBufferedRowIntactAcrossReads(t *testing.T) {
	row := `{"type":"session_meta","payload":"` + strings.Repeat("y", 1024*1024+64) + `"}`
	path := writeSessionJSONL(t, "long-buffered.jsonl", []byte(row+"\n"))

	lines, err := collectLines(t, ReadInput{FilePath: path, MaxLineBytes: 4 * 1024 * 1024})
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if len(lines) != 1 {
		t.Fatalf("got %d lines, want 1", len(lines))
	}
	if lines[0].Skipped || lines[0].Text != row {
		t.Fatalf("buffered row corrupted: got %d bytes, want %d", len(lines[0].Text), len(row))
	}
}

// The TS fixture: a `response_item` row whose filler crosses the line limit,
// carrying no usage. The reader must yield the skip marker and, for the same
// file read through the hook cursor, count one skipped row of the full size.
func TestReadSessionJSONLSkipsOneMiBResponseItemRowWithoutUsage(t *testing.T) {
	oversized := `{"type":"response_item","payload":{"text":"` + strings.Repeat("x", 1024*1024+64) + `"}}`
	path := writeSessionJSONL(t, "one-mib-response-item.jsonl", []byte(oversized+"\n"))

	lines, err := collectLines(t, ReadInput{
		FilePath:        path,
		Source:          contract.SourceCodex,
		MaxLineBytes:    1024 * 1024, // sessioncursor.DefaultSessionLineBytes
		MaxDiscardBytes: 64 * 1024 * 1024,
	})
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if len(lines) != 1 {
		t.Fatalf("got %d lines, want 1: %#v", len(lines), lines)
	}
	requireSkippedLine(t, lines[0])
	if lines[0].ByteLength != int64(len(oversized)) {
		t.Fatalf("skipped line byteLength = %d, want %d", lines[0].ByteLength, len(oversized))
	}
}

// The TS fixture: a `token_count` payload whose usage metadata sits after the
// line limit. The reader must fail closed with the usage diagnostic rather
// than drop a billable row.
func TestReadSessionJSONLFailsOnOneMiBTokenCountRowWithUsageAfterLimit(t *testing.T) {
	oversized := `{"type":"event_msg","padding":"` + strings.Repeat("x", 1024*1024+64) +
		`","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":1}}}}`
	path := writeSessionJSONL(t, "one-mib-token-count.jsonl", []byte(oversized+"\n"))

	_, err := collectLines(t, ReadInput{
		FilePath:        path,
		Source:          contract.SourceCodex,
		MaxLineBytes:    1024 * 1024, // sessioncursor.DefaultSessionLineBytes
		MaxDiscardBytes: 64 * 1024 * 1024,
	})
	requireReadError(t, err, "Session JSONL contains an oversized line with token or usage metadata")
}

// An append-only read starts at an offset but the recorded digest covers the
// whole file. Hashing only the tail made every such read fail its own
// verification, which surfaced as "Session file changed while reading" on the
// hook incremental path.
func TestReadSessionJSONLVerifiesAWholeFileDigestFromAMidFileOffset(t *testing.T) {
	content := []byte("{\"type\":\"session_meta\"}\n{\"type\":\"summary\"}\n")
	path := writeSessionJSONL(t, "incremental.jsonl", content)
	digest, size, err := FingerprintFile(path, nil)
	if err != nil {
		t.Fatalf("fingerprint: %v", err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	dev, ino, _ := FileIdentity(info)
	start := int64(len("{\"type\":\"session_meta\"}\n"))
	var lines []Line
	err = Read(ReadInput{
		FilePath:     path,
		StartOffset:  start,
		MaxLineBytes: 1024,
		Fingerprint:  &Fingerprint{Dev: dev, Ino: ino, Size: size, SHA256: digest},
	}, func(line Line) error {
		lines = append(lines, line)
		return nil
	})
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if len(lines) != 1 || !strings.Contains(lines[0].Text, `"summary"`) {
		t.Fatalf("lines = %+v, want only the tail row", lines)
	}
}

// The TS side decodes each line with `new TextDecoder('utf-8', {fatal: true})`, which drops a
// leading BOM. A session file stamped by an editor or a PowerShell `>` redirect therefore parses
// there; without the same strip the first line fails the JSON decode here and is silently counted
// as a malformed row.
func TestReadSessionJSONLDropsALeadingBOM(t *testing.T) {
	line := append([]byte{0xef, 0xbb, 0xbf}, []byte(`{"type":"session_meta"}`)...)
	line = append(line, '\n')
	path := writeSessionJSONL(t, "bom.jsonl", line)

	lines, err := collectLines(t, ReadInput{FilePath: path, MaxLineBytes: 1024})
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if len(lines) != 1 {
		t.Fatalf("got %d lines, want 1: %#v", len(lines), lines)
	}
	if lines[0].Skipped || lines[0].Text != `{"type":"session_meta"}` {
		t.Fatalf("line = %#v, want the BOM-stripped text", lines[0])
	}
}
