package codex

// Port of codex-subagent-usage-json.ts: the bounded JSONL reader the Codex
// subagent/context-pricing scans share, plus the record accessors they use.
//
// A Codex session row can be megabytes of prompt or attachment content, and a
// live session is appended to while it is read. The reader therefore never
// buffers an oversized row whole: it streams it through the byte-level
// metadata scanner and fails closed when the row might carry token or usage
// metadata. A file it opened itself is pinned by a stat identity and
// re-verified after the read, so a row can never be attributed to bytes that
// were replaced underneath the scan.
//
// The TS module is an async generator; the Go port drives the same state
// machine from a pull loop and exposes it as a callback. A consumer stops
// early by returning ErrStopJSONL, which keeps the TS `iterator.return()`
// semantics: the file verification still runs, and any change is reported.

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/MisonL/TokenBoard/clients/go/internal/codexusage"
	"github.com/MisonL/TokenBoard/clients/go/internal/collect/jsonl"
	"github.com/MisonL/TokenBoard/clients/go/internal/contract"
	"github.com/MisonL/TokenBoard/clients/go/internal/jsdate"
)

// UnknownRecord is one decoded JSONL row, the TS `UnknownRecord`.
type UnknownRecord = map[string]any

// ErrStopJSONL ends a read early. It mirrors the TS consumer breaking out of
// the async iterator: the reader stops, the input stream is closed when this
// reader owns it, and a file-backed read still verifies the file afterwards.
var ErrStopJSONL = errors.New("stop Codex JSONL read")

// JSONLReadLimits mirrors JsonlReadLimits. The numeric fields are pointers
// because the TS options distinguish "absent" (no limit) from a limit of
// zero; a zero maxBytes refuses any non-empty input.
type JSONLReadLimits struct {
	MaxBytes                 *int64
	MaxLineBytes             *int64
	MaxDiscardedLineBytes    *int64
	RelevantMetadataKeys     []string
	CodexUsageOnly           bool
	DiscardableLineTypes     []string
	AllowIncompleteFinalLine bool
	OnIncompleteFinalLine    func(byteLength int64)
	Label                    string
}

const (
	// jsonlDefaultLabel is the TS `limits.label ?? 'Codex JSONL input'`.
	jsonlDefaultLabel = "Codex JSONL input"
	// jsonlReadBufferBytes matches the chunk size the other bounded readers
	// in this client use; a fresh buffer per read keeps line slices valid
	// until the line is finished.
	jsonlReadBufferBytes = 64 * 1024
	// jsonlMaxEmptyReads mirrors io.Copy's no-progress guard: a reader that
	// keeps returning (0, nil) must not spin forever.
	jsonlMaxEmptyReads = 100
)

// ReadJSONLRecords streams filePath. With MaxBytes set the file is opened
// through the verified-open path: symlinks are refused, the size is bounded
// before reading, and the identity is re-checked after the last record. The
// callback receives each record; returning ErrStopJSONL ends the read, any
// other error is returned unchanged.
func ReadJSONLRecords(
	filePath string,
	stderr func(string),
	limits JSONLReadLimits,
	yield func(UnknownRecord) error,
) error {
	if limits.MaxBytes == nil {
		// The TS reader falls back to createReadStream: no verification and
		// no size bound.
		file, err := os.Open(filePath)
		if err != nil {
			return err
		}
		defer file.Close()
		_, readErr := jsonlReadStreamWithLifecycle(file, stderr, limits, true, yield)
		return readErr
	}

	label := jsonlLabel(limits)
	file, fingerprint, err := jsonlOpenVerifiedFile(filePath, *limits.MaxBytes, label)
	if err != nil {
		return err
	}
	defer file.Close()

	// `end: size - 1` in the TS createReadStream: exactly the fingerprinted
	// byte range, never a byte appended after the stat.
	stream := io.NewSectionReader(file, 0, fingerprint.size)
	readerFailed, readErr := jsonlReadStreamWithLifecycle(stream, stderr, limits, false, yield)
	if readerFailed {
		// A reader error skips the unchanged assertion, exactly like the TS
		// `readerFailed` flag: the error already says what went wrong.
		return readErr
	}
	if err := jsonlAssertFileUnchanged(filePath, file, fingerprint, label); err != nil {
		return err
	}
	return readErr
}

// ReadJSONLRecordsFromStream reads an already-open stream. The stream is
// closed (when it implements io.Closer) if the read stops before its end,
// mirroring the TS `stream.destroy()` on an incomplete read.
func ReadJSONLRecordsFromStream(
	stream io.Reader,
	stderr func(string),
	limits JSONLReadLimits,
	yield func(UnknownRecord) error,
) error {
	_, err := jsonlReadStreamWithLifecycle(stream, stderr, limits, true, yield)
	return err
}

// jsonlReadStreamWithLifecycle ports readJsonlRecordsFromStreamWithLifecycle.
// It reports whether the failure came from the reader (which suppresses the
// file verification) separately from the error itself.
func jsonlReadStreamWithLifecycle(
	stream io.Reader,
	stderr func(string),
	limits JSONLReadLimits,
	destroyOnIncomplete bool,
	yield func(UnknownRecord) error,
) (bool, error) {
	lineNumber := 0
	discardedRows := 0
	projectedRows := 0
	var largestDiscardedBytes int64
	onDiscarded := func(lineBytes int64, projection UnknownRecord) {
		if projection != nil {
			projectedRows++
		} else {
			discardedRows++
		}
		if lineBytes > largestDiscardedBytes {
			largestDiscardedBytes = lineBytes
		}
	}

	reader := newJSONLLineReader(stream, limits, onDiscarded)
	completed := false
	readerFailed := false
	var failure error
	for {
		line, ok, err := reader.next()
		if err != nil {
			readerFailed = true
			failure = err
			break
		}
		if !ok {
			completed = true
			break
		}
		lineNumber++
		var record UnknownRecord
		if line.isText {
			if jsonl.TrimJSWhitespace(line.text) == "" {
				continue
			}
			parsed, malformed := jsonlParseRecord(line.text)
			if malformed {
				jsonlEmit(stderr, fmt.Sprintf("Skipping malformed Codex subagent JSONL row at line %d", lineNumber))
				continue
			}
			if parsed == nil {
				continue
			}
			record = parsed
		} else {
			if line.projection == nil {
				continue
			}
			record = line.projection
		}
		if err := yield(record); err != nil {
			if errors.Is(err, ErrStopJSONL) {
				break
			}
			// A consumer error is thrown into the TS generator at its yield
			// point, which the file-backed wrapper counts as a reader failure
			// and therefore does not follow with a verification error.
			readerFailed = true
			failure = err
			break
		}
	}

	// The TS reader emits both summaries from its finally block, so they are
	// reported for a completed read, an early stop and a failure alike.
	label := jsonlLabel(limits)
	if discardedRows > 0 {
		jsonlEmit(stderr, fmt.Sprintf(
			"Skipped %d oversized %s JSONL row%s without usage or subagent metadata (largest %d bytes)",
			discardedRows, label, jsonlPlural(discardedRows), largestDiscardedBytes))
	}
	if projectedRows > 0 {
		jsonlEmit(stderr, fmt.Sprintf(
			"Retained bounded turn_context metadata from %d oversized %s JSONL row%s (largest %d bytes)",
			projectedRows, label, jsonlPlural(projectedRows), largestDiscardedBytes))
	}
	if destroyOnIncomplete && !completed {
		if closer, ok := stream.(io.Closer); ok {
			_ = closer.Close()
		}
	}
	return readerFailed, failure
}

// jsonlLine is one completed line: text, a bounded metadata projection, or
// neither (the deferred incomplete final line, which yields no record).
type jsonlLine struct {
	text       string
	isText     bool
	projection UnknownRecord
}

type jsonlLineState struct {
	chunks            [][]byte
	bytes             int64
	skipping          bool
	scanner           *jsonl.Scanner
	startsAsObject    bool
	startsAsObjectSet bool
}

type jsonlLineReader struct {
	stream io.Reader
	limits JSONLReadLimits
	// onDiscardedLine mirrors the TS runtime option: it counts skipped and
	// projected rows and tracks the largest skipped row.
	onDiscardedLine func(lineBytes int64, projection UnknownRecord)

	currentChunk []byte
	chunkOffset  int
	line         jsonlLineState
	// skipLeadingLineFeed carries the state between chunks: a CR that ended
	// the previous chunk may be followed by an LF at the start of the next.
	skipLeadingLineFeed bool
	totalBytes          int64
	eof                 bool
}

func newJSONLLineReader(
	stream io.Reader,
	limits JSONLReadLimits,
	onDiscardedLine func(lineBytes int64, projection UnknownRecord),
) *jsonlLineReader {
	return &jsonlLineReader{
		stream:          stream,
		limits:          limits,
		onDiscardedLine: onDiscardedLine,
		line:            jsonlNewLineState(limits),
	}
}

func jsonlNewLineState(limits JSONLReadLimits) jsonlLineState {
	return jsonlLineState{
		scanner: jsonl.NewScanner(limits.RelevantMetadataKeys, limits.CodexUsageOnly),
	}
}

// next returns the next completed line. ok is false at end of input.
func (r *jsonlLineReader) next() (jsonlLine, bool, error) {
	for {
		if r.chunkOffset >= len(r.currentChunk) {
			if r.eof {
				return jsonlLine{}, false, nil
			}
			chunk, ok, err := r.readChunk()
			if err != nil {
				return jsonlLine{}, false, err
			}
			if !ok {
				r.eof = true
				if r.line.bytes > 0 {
					if !r.limits.AllowIncompleteFinalLine {
						line, err := r.finishLine()
						if err != nil {
							return jsonlLine{}, false, err
						}
						r.line = jsonlNewLineState(r.limits)
						return line, true, nil
					}
					line, emit, err := r.finishIncompleteFinalLine()
					if err != nil {
						return jsonlLine{}, false, err
					}
					r.line = jsonlNewLineState(r.limits)
					if emit {
						return line, true, nil
					}
				}
				return jsonlLine{}, false, nil
			}
			r.totalBytes += int64(len(chunk))
			if err := r.assertTotalBytesLimit(); err != nil {
				return jsonlLine{}, false, err
			}
			r.currentChunk = chunk
			r.chunkOffset = 0
			if r.skipLeadingLineFeed {
				if len(chunk) == 0 {
					continue
				}
				if chunk[0] == '\n' {
					r.chunkOffset = 1
				}
				r.skipLeadingLineFeed = false
			}
			continue
		}

		chunk := r.currentChunk
		terminator := jsonlFindLineTerminator(chunk, r.chunkOffset)
		end := len(chunk)
		if terminator != -1 {
			end = terminator
		}
		if err := r.appendSegment(chunk[r.chunkOffset:end]); err != nil {
			return jsonlLine{}, false, err
		}
		if terminator == -1 {
			r.chunkOffset = len(chunk)
			continue
		}
		line, err := r.finishLine()
		if err != nil {
			return jsonlLine{}, false, err
		}
		r.line = jsonlNewLineState(r.limits)
		terminatorByte := chunk[terminator]
		r.chunkOffset = terminator + 1
		if terminatorByte == '\r' {
			if r.chunkOffset < len(chunk) && chunk[r.chunkOffset] == '\n' {
				r.chunkOffset++
			} else if r.chunkOffset == len(chunk) {
				r.skipLeadingLineFeed = true
			}
		}
		return line, true, nil
	}
}

// readChunk returns the next non-empty chunk. A zero-length read is legal for
// an io.Reader and means "no progress yet", which is what the TS reader's
// empty chunk is; a reader that never makes progress is bounded the way
// io.Copy bounds it.
func (r *jsonlLineReader) readChunk() ([]byte, bool, error) {
	emptyReads := 0
	for {
		buffer := make([]byte, jsonlReadBufferBytes)
		read, err := r.stream.Read(buffer)
		if read > 0 {
			return buffer[:read], true, nil
		}
		if err == io.EOF {
			return nil, false, nil
		}
		if err != nil {
			return nil, false, err
		}
		emptyReads++
		if emptyReads >= jsonlMaxEmptyReads {
			return nil, false, io.ErrNoProgress
		}
	}
}

func (r *jsonlLineReader) appendSegment(segment []byte) error {
	if len(segment) == 0 {
		return nil
	}
	r.recordLinePrefix(segment)
	nextBytes := r.line.bytes + int64(len(segment))
	if !r.line.skipping && (r.limits.MaxLineBytes == nil || nextBytes <= *r.limits.MaxLineBytes) {
		r.line.chunks = append(r.line.chunks, segment)
		r.line.bytes = nextBytes
		return nil
	}
	if !r.line.skipping && !(r.line.startsAsObjectSet && r.line.startsAsObject) {
		return r.lineLimitError()
	}
	segments := [][]byte{segment}
	if !r.line.skipping {
		segments = make([][]byte, 0, len(r.line.chunks)+1)
		segments = append(segments, r.line.chunks...)
		segments = append(segments, segment)
	}
	r.line.scanner.Scan(segments, contract.SourceCodex, !r.limits.AllowIncompleteFinalLine)
	if r.line.scanner.Invalid() {
		return r.malformedOversizedLineError()
	}
	if !r.limits.AllowIncompleteFinalLine && r.line.scanner.HasRelevantMetadata(contract.SourceCodex) {
		return r.oversizedRelevantLineError()
	}
	r.line.bytes = nextBytes
	if !r.line.skipping {
		if r.limits.MaxDiscardedLineBytes == nil {
			return r.lineLimitError()
		}
		r.line.skipping = true
		r.line.chunks = nil
	}
	return r.assertDiscardedLineLimit()
}

func (r *jsonlLineReader) finishLine() (jsonlLine, error) {
	if r.line.skipping {
		if r.line.scanner == nil || !r.line.scanner.Finish() {
			return jsonlLine{}, r.malformedOversizedLineError()
		}
		if r.line.scanner.HasRelevantMetadata(contract.SourceCodex) {
			return jsonlLine{}, r.oversizedRelevantLineError()
		}
		if !r.isDiscardableLineType() {
			return jsonlLine{}, r.unknownOversizedLineTypeError()
		}
		projection := jsonlProjectionRecord(r.line.scanner)
		r.onDiscardedLine(r.line.bytes, projection)
		return jsonlLine{projection: projection}, nil
	}
	value := jsonlJoinChunks(r.line.chunks, r.line.bytes)
	text, err := jsonlDecodeLine(value, r.label())
	if err != nil {
		return jsonlLine{}, err
	}
	return jsonlLine{text: text, isText: true}, nil
}

func (r *jsonlLineReader) finishIncompleteFinalLine() (jsonlLine, bool, error) {
	if r.line.skipping {
		if r.line.scanner.Invalid() {
			line, err := r.finishLine()
			return line, err == nil, err
		}
		if !r.line.scanner.Finish() {
			r.incompleteFinalLine(r.line.bytes)
			return jsonlLine{}, false, nil
		}
		line, err := r.finishLine()
		return line, err == nil, err
	}

	value := jsonlJoinChunks(r.line.chunks, r.line.bytes)
	if len(value) > 0 && value[len(value)-1] == '\r' {
		value = value[:len(value)-1]
	}
	// This line never reached a terminator, so it is still being written. A
	// tail that stops inside a multi-byte character is unfinished rather than
	// corrupt, and this is the branch that exists to defer exactly that.
	// Bytes that are already invalid UTF-8 despite ending on a character
	// boundary stay fail-closed in jsonlDecodeLine below.
	if r.limits.AllowIncompleteFinalLine && jsonlEndsWithinMultiByteCharacter(value) {
		r.incompleteFinalLine(r.line.bytes)
		return jsonlLine{}, false, nil
	}
	text, err := jsonlDecodeLine(value, r.label())
	if err != nil {
		return jsonlLine{}, false, err
	}
	r.line.scanner.Scan([][]byte{value}, contract.SourceCodex, false)
	if r.line.scanner.Invalid() {
		return jsonlLine{text: text, isText: true}, true, nil
	}
	if !r.line.scanner.Finish() {
		r.incompleteFinalLine(r.line.bytes)
		return jsonlLine{}, false, nil
	}
	if !json.Valid([]byte(text)) {
		r.incompleteFinalLine(r.line.bytes)
		return jsonlLine{}, false, nil
	}
	return jsonlLine{text: text, isText: true}, true, nil
}

func (r *jsonlLineReader) incompleteFinalLine(byteLength int64) {
	if r.limits.OnIncompleteFinalLine != nil {
		r.limits.OnIncompleteFinalLine(byteLength)
	}
}

func (r *jsonlLineReader) isDiscardableLineType() bool {
	types := r.limits.DiscardableLineTypes
	if len(types) == 0 {
		return false
	}
	recordType, ok := r.line.scanner.RecordType()
	if !ok {
		return false
	}
	for _, candidate := range types {
		if candidate == recordType {
			return true
		}
	}
	return false
}

func (r *jsonlLineReader) assertDiscardedLineLimit() error {
	if r.limits.MaxDiscardedLineBytes == nil || r.line.bytes <= *r.limits.MaxDiscardedLineBytes {
		return nil
	}
	return fmt.Errorf("%s contains a line exceeding the %d-byte discarded-line limit",
		r.label(), *r.limits.MaxDiscardedLineBytes)
}

func (r *jsonlLineReader) assertTotalBytesLimit() error {
	if r.limits.MaxBytes == nil || r.totalBytes <= *r.limits.MaxBytes {
		return nil
	}
	return fmt.Errorf("%s exceeds the %d-byte limit", r.label(), *r.limits.MaxBytes)
}

func (r *jsonlLineReader) label() string {
	return jsonlLabel(r.limits)
}

func (r *jsonlLineReader) lineLimitError() error {
	return fmt.Errorf("%s contains a line exceeding the %d-byte limit", r.label(), jsonlLimitValue(r.limits.MaxLineBytes))
}

func (r *jsonlLineReader) oversizedRelevantLineError() error {
	return fmt.Errorf("%s contains an oversized line with usage or subagent metadata", r.label())
}

func (r *jsonlLineReader) malformedOversizedLineError() error {
	return fmt.Errorf("%s contains a malformed oversized line", r.label())
}

func (r *jsonlLineReader) unknownOversizedLineTypeError() error {
	return fmt.Errorf("%s contains an oversized line with an unknown record type", r.label())
}

func (r *jsonlLineReader) recordLinePrefix(segment []byte) {
	if r.line.startsAsObjectSet {
		return
	}
	for _, b := range segment {
		if b == 0x09 || b == 0x0a || b == 0x0d || b == 0x20 {
			continue
		}
		r.line.startsAsObject = b == '{'
		r.line.startsAsObjectSet = true
		return
	}
}

// jsonlProjectionRecord converts the scanner's bounded turn_context
// projection to the record shape the TS reader yields.
func jsonlProjectionRecord(scanner *jsonl.Scanner) UnknownRecord {
	projection := scanner.MetadataRecord()
	if projection == nil {
		return nil
	}
	return UnknownRecord{
		"type":    "turn_context",
		"payload": map[string]any{"model": projection.Payload.Model},
	}
}

func jsonlFindLineTerminator(chunk []byte, offset int) int {
	for index := offset; index < len(chunk); index++ {
		if chunk[index] == '\r' || chunk[index] == '\n' {
			return index
		}
	}
	return -1
}

func jsonlJoinChunks(chunks [][]byte, length int64) []byte {
	if len(chunks) == 1 && int64(len(chunks[0])) == length {
		return chunks[0]
	}
	out := make([]byte, 0, length)
	for _, chunk := range chunks {
		out = append(out, chunk...)
	}
	return out
}

// jsonlDecodeLine decodes one line the way `new TextDecoder('utf-8', {fatal:
// true})` does: invalid UTF-8 is a hard error and a leading BOM is dropped.
func jsonlDecodeLine(value []byte, label string) (string, error) {
	if !utf8.Valid(value) {
		return "", fmt.Errorf("%s contains invalid UTF-8", label)
	}
	if len(value) >= 3 && value[0] == 0xef && value[1] == 0xbb && value[2] == 0xbf {
		value = value[3:]
	}
	return string(value), nil
}

// jsonlEndsWithinMultiByteCharacter is true only when the buffer ends partway
// through a multi-byte UTF-8 sequence, which is what a writer interrupted
// mid-character leaves behind. Bytes that are invalid for any other reason —
// an isolated continuation byte, an overlong encoding, a surrogate — are real
// corruption and must keep failing closed, so this checks the trailing
// sequence specifically rather than whether the buffer decodes.
func jsonlEndsWithinMultiByteCharacter(value []byte) bool {
	if len(value) == 0 {
		return false
	}
	index := len(value) - 1
	continuationBytes := 0
	for index >= 0 && value[index]&0xc0 == 0x80 {
		continuationBytes++
		index--
		if continuationBytes > 3 {
			return false
		}
	}
	if index < 0 {
		return false
	}
	lead := value[index]
	expected := 0
	switch {
	case lead&0x80 == 0x00:
		expected = 1
	case lead >= 0xc2 && lead <= 0xdf:
		// 0xC2-0xDF is the only legal two-byte lead range. 0xC0 and 0xC1
		// would encode an overlong sequence, so they are corruption even when
		// the tail looks short.
		expected = 2
	case lead >= 0xe0 && lead <= 0xef:
		expected = 3
	case lead >= 0xf0 && lead <= 0xf4:
		// 0xF0-0xF4 is the only legal four-byte lead range. 0xF5-0xF7 would
		// encode a code point past U+10FFFF, which is never a valid writer
		// state.
		expected = 4
	}
	// A lead byte whose sequence is longer than what is present is a truncated
	// tail. An illegal lead byte yields 0 here and therefore fails closed.
	if !(expected > 1 && continuationBytes+1 < expected) {
		return false
	}
	// The lead byte alone does not pin the second byte: 0xE0 requires >= 0xA0
	// and 0xED requires <= 0x9F, or the sequence is overlong or encodes a
	// surrogate. Those are corruption, not a writer caught mid-character.
	if continuationBytes == 0 {
		return true
	}
	second := value[index+1]
	if lead == 0xe0 && second < 0xa0 {
		return false
	}
	if lead == 0xed && second > 0x9f {
		return false
	}
	// 0xF0 requires >= 0x90 and 0xF4 requires <= 0x8F, for the same reason.
	if lead == 0xf0 && second < 0x90 {
		return false
	}
	if lead == 0xf4 && second > 0x8f {
		return false
	}
	return true
}

func jsonlParseRecord(line string) (UnknownRecord, bool) {
	value, err := jsonlDecodeJSON(line)
	if err != nil {
		return nil, true
	}
	return ReadRecord(value), false
}

// jsonlDecodeJSON ports `JSON.parse`: numbers become float64 values (a value
// outside float64's range becomes ±Infinity, as in JS), trailing content is a
// syntax error, and duplicate keys keep the last value.
func jsonlDecodeJSON(text string) (any, error) {
	decoder := json.NewDecoder(strings.NewReader(text))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return nil, err
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		return nil, errors.New("Codex JSONL row has trailing content")
	}
	return jsonlNormalizeJSONValue(value), nil
}

func jsonlNormalizeJSONValue(value any) any {
	switch typed := value.(type) {
	case json.Number:
		parsed, err := typed.Float64()
		if err != nil {
			if strings.HasPrefix(typed.String(), "-") {
				return math.Inf(-1)
			}
			return math.Inf(1)
		}
		return parsed
	case map[string]any:
		for key, item := range typed {
			typed[key] = jsonlNormalizeJSONValue(item)
		}
		return typed
	case []any:
		for index, item := range typed {
			typed[index] = jsonlNormalizeJSONValue(item)
		}
		return typed
	}
	return value
}

// ExtractRows ports extractRows: the record list inside a wrapper object, or
// the array itself.
func ExtractRows(input any) []UnknownRecord {
	switch typed := input.(type) {
	case []any:
		return jsonlFilterRecords(typed)
	case map[string]any:
		for _, key := range []string{"sessions", "data", "rows", "items"} {
			if values, ok := typed[key].([]any); ok {
				return jsonlFilterRecords(values)
			}
		}
	}
	return nil
}

func jsonlFilterRecords(values []any) []UnknownRecord {
	out := make([]UnknownRecord, 0, len(values))
	for _, value := range values {
		if record, ok := value.(map[string]any); ok {
			out = append(out, record)
		}
	}
	return out
}

// NormalizeDate ports normalizeDate. An impossible calendar date is rejected
// rather than normalized; a timestamp becomes its UTC calendar date.
func NormalizeDate(value string) (string, error) {
	if err := jsonlAssertValidCalendarDate(value, "Invalid Codex date"); err != nil {
		return "", err
	}
	if codexDateOnlyPattern.MatchString(value) {
		return value, nil
	}
	if codexTimestampPrefixPattern.MatchString(value) {
		if parsed, ok := jsonlParseJSDate(value); ok {
			return parsed.UTC().Format("2006-01-02"), nil
		}
	}
	if parsed, ok := jsonlParseJSDate(value + " UTC"); ok {
		return parsed.UTC().Format("2006-01-02"), nil
	}
	return value, nil
}

var (
	codexDateOnlyPattern        = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)
	codexTimestampPrefixPattern = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T`)
)

// jsonlParseJSDate is the Date.parse subset these records carry: the ISO date
// and date-time forms, plus the legacy shapes V8 falls back to — the "… UTC"
// suffix the NormalizeDate retry appends, a space-separated offset, and the
// human-written dates that occasionally reach an exported record. A value
// outside this subset is reported as unparseable rather than guessed at; the
// caller then keeps the raw string, which is what the TS code does when
// Date.parse returns NaN.
func jsonlParseJSDate(value string) (time.Time, bool) {
	// The ISO forms go through the shared parser so both clients agree on them,
	// including V8's refusal to trim a padded "T" form (which the previous
	// TrimSpace here accepted, accepting a value the TS side drops).
	if parsed, ok := jsdate.Parse(value); ok {
		return parsed, true
	}
	// V8's legacy layer is reached only for a value the ISO grammar did not
	// cover. That layer does trim, so the retry works on the trimmed value.
	trimmed := strings.TrimSpace(value)
	for _, layout := range []string{
		"2006-01-02 15:04:05.999999999 MST",
		"2006-01-02 15:04:05 MST",
		// JS resolves "2025-08-08 10:00 UTC" (the retry the caller appends),
		// so the space-separated form has to resolve here too — otherwise the
		// raw value reaches the contract where a date belongs.
		"2006-01-02 15:04 MST",
		"Jan 2, 2006 MST",
		"Jan 2, 2006 15:04:05 MST",
		"Jan 2, 2006",
		"January 2, 2006 MST",
		"January 2, 2006",
	} {
		if parsed, err := time.ParseInLocation(layout, trimmed, time.UTC); err == nil {
			return parsed, true
		}
	}
	return time.Time{}, false
}

// jsonlAssertValidCalendarDate mirrors assertValidIsoCalendarDate: the check
// only applies when the value starts with a YYYY-MM-DD prefix, and then the
// month and day must exist in that year (2024-02-29 is valid, 2026-02-30 is
// not).
func jsonlAssertValidCalendarDate(value, message string) error {
	match := codexCalendarDatePrefix.FindStringSubmatch(value)
	if match == nil {
		return nil
	}
	year, err := jsonlAtoi(match[1])
	if err != nil {
		return nil
	}
	month, err := jsonlAtoi(match[2])
	if err != nil {
		return nil
	}
	day, err := jsonlAtoi(match[3])
	if err != nil {
		return nil
	}
	date := time.Date(year, time.Month(month), day, 0, 0, 0, 0, time.UTC)
	if date.Year() != year || int(date.Month()) != month || date.Day() != day {
		return errors.New(message)
	}
	return nil
}

var codexCalendarDatePrefix = regexp.MustCompile(`^(\d{4})-(\d{2})-(\d{2})`)

func jsonlAtoi(value string) (int, error) {
	number := 0
	for _, digit := range value {
		if digit < '0' || digit > '9' {
			return 0, errors.New("not a number")
		}
		number = number*10 + int(digit-'0')
	}
	return number, nil
}

// ReadNumber ports readNumber: the first key holding a non-negative safe
// integer, else 0.
func ReadNumber(record UnknownRecord, keys []string) float64 {
	for _, key := range keys {
		if value, ok := jsonlSafeInteger(record[key]); ok {
			return value
		}
	}
	return 0
}

const jsonlMaxSafeInteger = float64(1<<53 - 1)

func jsonlSafeInteger(value any) (float64, bool) {
	var number float64
	switch typed := value.(type) {
	case float64:
		number = typed
	case json.Number:
		parsed, err := typed.Float64()
		if err != nil {
			return 0, false
		}
		number = parsed
	case int:
		number = float64(typed)
	case int64:
		number = float64(typed)
	default:
		return 0, false
	}
	if math.IsNaN(number) || math.IsInf(number, 0) || number < 0 || number > jsonlMaxSafeInteger {
		return 0, false
	}
	if number != math.Trunc(number) {
		return 0, false
	}
	return number, true
}

// ReadTotalTokens ports readTotalTokens through the shared codexusage rules,
// so this reader and the hook parser cannot drift apart on how a raw Codex row
// is totalled.
func ReadTotalTokens(row UnknownRecord) float64 {
	explicitTotal := ReadNumber(row, []string{"totalTokens", "total_tokens"})
	var explicit *float64
	if explicitTotal > 0 {
		explicit = &explicitTotal
	}
	return codexusage.NormalizeTotal(codexusage.Totals{
		InputTokens:         ReadNumber(row, []string{"inputTokens", "input_tokens"}),
		OutputTokens:        ReadNumber(row, []string{"outputTokens", "output_tokens"}),
		CacheCreationTokens: ReadCacheCreationTokens(row),
		CacheReadTokens:     ReadCacheReadTokens(row),
		ExplicitTotal:       explicit,
	})
}

// ReadCacheCreationTokens ports readCacheCreationTokens.
func ReadCacheCreationTokens(row UnknownRecord) float64 {
	return ReadNumber(row, []string{
		"cacheCreationTokens",
		"cacheCreationInputTokens",
		"inputCacheCreationTokens",
		"cache_creation_tokens",
		"cache_creation_input_tokens",
		"input_cache_creation_tokens",
		"cache_write_input_tokens",
	})
}

// ReadCacheReadTokens ports readCacheReadTokens.
func ReadCacheReadTokens(row UnknownRecord) float64 {
	return ReadNumber(row, []string{
		"cacheReadTokens",
		"cacheReadInputTokens",
		"cachedInputTokens",
		"cache_read_tokens",
		"cache_read_input_tokens",
		"cached_input_tokens",
	})
}

// ReadString ports readString: the first non-empty string value.
func ReadString(record UnknownRecord, keys []string) string {
	if record == nil {
		return ""
	}
	for _, key := range keys {
		if value, ok := record[key].(string); ok && value != "" {
			return value
		}
	}
	return ""
}

// ReadRecord ports readRecord: a JSON object, or nil for anything else.
func ReadRecord(value any) UnknownRecord {
	if record, ok := value.(map[string]any); ok {
		return record
	}
	return nil
}

// IsRecord ports isRecord.
func IsRecord(value any) bool {
	_, ok := value.(map[string]any)
	return ok
}

func jsonlLabel(limits JSONLReadLimits) string {
	if limits.Label != "" {
		return limits.Label
	}
	return jsonlDefaultLabel
}

func jsonlLimitValue(value *int64) int64 {
	if value == nil {
		return 0
	}
	return *value
}

func jsonlPlural(count int) string {
	if count == 1 {
		return ""
	}
	return "s"
}

func jsonlEmit(stderr func(string), line string) {
	if stderr != nil {
		stderr(line)
	}
}

// jsonlFileFingerprint is the stat identity a verified read pins. The JSONL
// reader shares the attribution cache's stat shape so both fingerprint the
// same file the same way.
type jsonlFileFingerprint = codexFileStat

func jsonlOpenVerifiedFile(filePath string, maxBytes int64, label string) (*os.File, jsonlFileFingerprint, error) {
	pathBefore, err := os.Lstat(filePath)
	if err != nil {
		return nil, jsonlFileFingerprint{}, err
	}
	if err := jsonlAssertFileAtPath(pathBefore, label); err != nil {
		return nil, jsonlFileFingerprint{}, err
	}
	if pathBefore.Size() > maxBytes {
		return nil, jsonlFileFingerprint{}, fmt.Errorf("%s exceeds the %d-byte limit", label, maxBytes)
	}
	file, err := os.Open(filePath)
	if err != nil {
		return nil, jsonlFileFingerprint{}, err
	}
	opened, statErr := file.Stat()
	pathAfterOpen, lstatErr := os.Lstat(filePath)
	if statErr != nil || lstatErr != nil {
		file.Close()
		if statErr != nil {
			return nil, jsonlFileFingerprint{}, statErr
		}
		return nil, jsonlFileFingerprint{}, lstatErr
	}
	if err := jsonlAssertFileAtPath(pathAfterOpen, label); err != nil {
		file.Close()
		return nil, jsonlFileFingerprint{}, err
	}
	fingerprint := codexStatOf(opened)
	if !sameCodexFileStat(codexStatOf(pathBefore), fingerprint) ||
		!sameCodexFileStat(codexStatOf(pathAfterOpen), fingerprint) {
		file.Close()
		return nil, jsonlFileFingerprint{}, fmt.Errorf("%s changed before reading; retry the sync", label)
	}
	return file, fingerprint, nil
}

func jsonlAssertFileUnchanged(
	filePath string,
	file *os.File,
	fingerprint jsonlFileFingerprint,
	label string,
) error {
	handleAfter, statErr := file.Stat()
	pathAfter, lstatErr := os.Lstat(filePath)
	if statErr != nil {
		return statErr
	}
	if lstatErr != nil {
		return lstatErr
	}
	if err := jsonlAssertFileAtPath(pathAfter, label); err != nil {
		return err
	}
	if !sameCodexFileStat(codexStatOf(handleAfter), fingerprint) ||
		!sameCodexFileStat(codexStatOf(pathAfter), fingerprint) {
		return fmt.Errorf("%s changed while reading; retry the sync", label)
	}
	return nil
}

func jsonlAssertFileAtPath(info os.FileInfo, label string) error {
	if info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("Unable to read %s: symbolic links are not supported", label)
	}
	if !info.Mode().IsRegular() {
		return fmt.Errorf("Unable to read %s: path is not a file", label)
	}
	return nil
}
