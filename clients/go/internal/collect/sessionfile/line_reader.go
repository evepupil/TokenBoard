// Package sessionfile ports session-jsonl-line-reader.ts: bounded, verified
// line reading for session JSONL files.
//
// A hook sync reads files the user's AI tool is still writing, so the reader
// pins the file identity it saw during the scan (device, inode, size) and
// re-verifies both the prefix hash and the content hash after reading. A file
// that changed underneath the scan fails the sync instead of recording
// snapshots against bytes that were never parsed.
package sessionfile

import (
	"encoding/hex"
	"errors"
	"fmt"
	"hash"
	"io"
	"os"
	"unicode/utf8"

	"github.com/MisonL/TokenBoard/clients/go/internal/collect/jsonl"
	"github.com/MisonL/TokenBoard/clients/go/internal/contract"
)

// Fingerprint pins one session file revision: identity fields plus the digest
// of its content.
type Fingerprint struct {
	Dev    uint64
	Ino    uint64
	SHA256 string
	Size   int64
}

// Line is one session JSONL row: either its text, or a marker for an oversized
// row that was proven not to carry usage metadata.
type Line struct {
	Text       string
	Skipped    bool
	ByteLength int64
}

// ReadInput describes one read window.
type ReadInput struct {
	FilePath        string
	StartOffset     int64
	EndOffset       *int64
	MaxLineBytes    int
	MaxDiscardBytes int64
	CodexUsageOnly  bool
	Source          contract.Source
	Fingerprint     *Fingerprint
}

// DefaultMaxDiscardedLineBytes is the TS maxDiscardedSessionJsonlLineBytes: a
// non-usage line larger than this is refused rather than silently dropped.
const DefaultMaxDiscardedLineBytes = 64 * 1024 * 1024

// HashBufferBytes is the TS sessionJsonlHashBufferBytes. Measured on a 1.2 GB
// session, 64 KiB reached 0.10 GB/s while 4 MiB reached 0.25 GB/s; prefix
// verification re-hashes from byte 0 and decides how long a hook sync takes.
const HashBufferBytes = 4 * 1024 * 1024

// discardableRecordTypes never carry a root-level `usage`, so an oversized row
// of one of these can be dropped instead of failing the whole source. Every
// entry is a claim that the type is not a metric row; a type left out is
// treated as potentially billable and its oversized row is fatal.
//
// `attachment` and `result` are the two that were missing once: Claude Code
// writes `attachment` rows for hook output and queued prompts (a queued command
// can embed base64 images), and `result` rows hold a subagent result key.
// `api-request-blob` is the third: a request payload with a content hash whose
// `message` holds only `role`/`content` — one such row stopped every
// claude-code hook sync from 2026-10-23 until it was listed here.
var discardableRecordTypes = map[string]bool{
	"api-request-blob":      true,
	"assistant":             true,
	"attachment":            true,
	"compacted":             true,
	"event_msg":             true,
	"file-history-snapshot": true,
	"progress":              true,
	"queue-operation":       true,
	"response_item":         true,
	"result":                true,
	"session_meta":          true,
	"summary":               true,
	"task_complete":         true,
	"task_started":          true,
	"turn_context":          true,
	"user":                  true,
}

// Read streams the requested window line by line. yield returning an error
// stops the read and is returned unchanged.
func Read(input ReadInput, yield func(Line) error) error {
	codexUsageOnly := input.CodexUsageOnly || input.Source == contract.SourceCodex
	maxDiscard := input.MaxDiscardBytes
	if maxDiscard == 0 {
		maxDiscard = DefaultMaxDiscardedLineBytes
	}

	var file *os.File
	var err error
	endOffset := input.EndOffset
	if input.Fingerprint != nil {
		file, err = openVerified(input.FilePath, *input.Fingerprint)
		if err != nil {
			return err
		}
		expectedEnd := input.Fingerprint.Size
		if endOffset != nil && *endOffset != expectedEnd {
			file.Close()
			return fmt.Errorf("Invalid verified session JSONL range: %s", input.FilePath)
		}
		endOffset = &expectedEnd
	} else {
		file, err = os.Open(input.FilePath)
		if err != nil {
			return err
		}
	}
	defer file.Close()

	// The recorded digest covers the whole file, so an append-only read must
	// keep hashing from the prefix into the same hasher the line reader feeds:
	// a fresh hasher for the tail would never match the fingerprint's SHA256.
	// (The TS reader opens one contentHash and updates it with the prefix and
	// then every chunk.)
	contentHash := newContentHasher()
	if input.Fingerprint != nil {
		// blake2b512 is the TS content hash; the fingerprint check uses the
		// recorded digest, so the file is hashed with the same algorithm.
		if err := hashPrefix(file, input.StartOffset, contentHash, input.FilePath); err != nil {
			return err
		}
	}
	if endOffset != nil && *endOffset <= input.StartOffset {
		return assertVerified(input.StartOffset, input.Fingerprint, contentHash, input.FilePath)
	}

	reader := &lineReader{
		file:                   file,
		position:               input.StartOffset,
		endOffset:              endOffset,
		maxLineBytes:           input.MaxLineBytes,
		maxDiscardBytes:        maxDiscard,
		source:                 input.Source,
		codexUsageOnly:         codexUsageOnly,
		additionalRelevantKeys: codexAdditionalRelevantKeys(codexUsageOnly),
		contentHash:            contentHash,
		yield:                  yield,
	}
	skipLeadingLineFeed, err := startsAfterCarriageReturn(file, input.StartOffset, input.FilePath)
	if err != nil {
		return err
	}
	reader.skipLeadingLineFeed = skipLeadingLineFeed
	if err := reader.run(); err != nil {
		return err
	}
	if input.Fingerprint != nil {
		digest := hex.EncodeToString(contentHash.Sum(nil))
		if reader.position != input.Fingerprint.Size || digest != input.Fingerprint.SHA256 {
			return fmt.Errorf("Session file changed while reading: %s", input.FilePath)
		}
	}
	return nil
}

// newContentHasher returns the blake2b512 hasher the TS side records as
// contentHashAlgo. The algorithm is part of the shared cursor contract, so it
// cannot be substituted even though the field is named sha256.
func newContentHasher() hash.Hash {
	return newBlake2b512()
}

type lineReader struct {
	file            *os.File
	position        int64
	endOffset       *int64
	maxLineBytes    int
	maxDiscardBytes int64
	source          contract.Source
	codexUsageOnly  bool
	// additionalRelevantKeys mirrors the TS scanner construction: in Codex
	// mode the payload-level token fields mark an oversized row as
	// metric-bearing even though they sit outside the usage object.
	additionalRelevantKeys []string
	contentHash            hash.Hash
	yield                  func(Line) error

	skipLeadingLineFeed bool

	chunks     [][]byte
	byteLength int64
	skipping   bool
	scanner    *jsonl.Scanner
}

func (r *lineReader) run() error {
	for {
		// A fresh buffer per read, matching the TS reader's stream chunks: a
		// line spanning two reads keeps slices of the previous chunk in
		// r.chunks, and reusing one buffer would overwrite them before the
		// line is finished.
		readSize := 64 * 1024
		if r.endOffset != nil {
			left := *r.endOffset - r.position
			if left <= 0 {
				break
			}
			if left < int64(readSize) {
				readSize = int(left)
			}
		}
		buffer := make([]byte, readSize)
		read, err := r.file.ReadAt(buffer, r.position)
		if read > 0 {
			chunk := buffer[:read]
			r.contentHash.Write(chunk)
			r.position += int64(read)
			if err := r.consume(chunk); err != nil {
				return err
			}
		}
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}
		if r.endOffset != nil && r.position >= *r.endOffset {
			break
		}
	}
	if r.byteLength > 0 {
		return r.finishLine()
	}
	return nil
}

func (r *lineReader) consume(chunk []byte) error {
	offset := 0
	if r.skipLeadingLineFeed {
		if len(chunk) == 0 {
			return nil
		}
		if chunk[0] == '\n' {
			offset = 1
		}
		r.skipLeadingLineFeed = false
	}
	for offset < len(chunk) {
		terminator := findLineTerminator(chunk, offset)
		end := len(chunk)
		if terminator != -1 {
			end = terminator
		}
		if err := r.appendSegment(chunk[offset:end]); err != nil {
			return err
		}
		if terminator == -1 {
			break
		}
		if err := r.finishLine(); err != nil {
			return err
		}
		r.chunks = nil
		r.byteLength = 0
		r.skipping = false
		r.scanner = jsonl.NewScanner(r.additionalRelevantKeys, r.codexUsageOnly)
		terminatorByte := chunk[terminator]
		offset = terminator + 1
		if terminatorByte == '\r' {
			if offset < len(chunk) && chunk[offset] == '\n' {
				offset++
			} else if offset == len(chunk) {
				r.skipLeadingLineFeed = true
			}
		}
	}
	return nil
}

func (r *lineReader) appendSegment(segment []byte) error {
	if len(segment) == 0 {
		return nil
	}
	nextLength := r.byteLength + int64(len(segment))
	if !r.skipping && nextLength <= int64(r.maxLineBytes) {
		r.chunks = append(r.chunks, segment)
		r.byteLength = nextLength
		return nil
	}
	if r.scanner == nil {
		r.scanner = jsonl.NewScanner(r.additionalRelevantKeys, r.codexUsageOnly)
	}
	var segments [][]byte
	if r.skipping {
		segments = [][]byte{segment}
	} else {
		segments = append(append([][]byte{}, r.chunks...), segment)
	}
	r.scanner.Scan(segments, r.source, true)
	if r.scanner.Invalid() {
		return errors.New("Session JSONL contains a malformed oversized line")
	}
	if r.scanner.HasRelevantMetadata(r.source) {
		return errors.New("Session JSONL contains an oversized line with token or usage metadata")
	}
	r.byteLength = nextLength
	if !r.skipping {
		r.chunks = nil
		r.skipping = true
	}
	if r.byteLength > r.maxDiscardBytes {
		return fmt.Errorf(
			"Session JSONL contains a non-usage line exceeding the %d-byte discard limit", r.maxDiscardBytes)
	}
	return nil
}

func (r *lineReader) finishLine() error {
	if r.skipping {
		if r.scanner == nil || !r.scanner.Finish() {
			return errors.New("Session JSONL contains a malformed oversized line")
		}
		if r.scanner.HasRelevantMetadata(r.source) {
			return errors.New("Session JSONL contains an oversized line with token or usage metadata")
		}
		recordType, ok := r.scanner.RecordType()
		if !ok || !discardableRecordTypes[recordType] {
			return errors.New("Session JSONL contains an oversized line with an unknown record type")
		}
		return r.yield(Line{Skipped: true, ByteLength: r.byteLength})
	}
	value := joinChunks(r.chunks, r.byteLength)
	if len(value) > 0 && value[len(value)-1] == '\r' {
		value = value[:len(value)-1]
	}
	if !utf8.Valid(value) {
		return errors.New("Session JSONL contains invalid UTF-8")
	}
	// `new TextDecoder('utf-8', {fatal: true})` (what the TS side decodes every line with) drops a
	// leading BOM, so a file written by an editor or a PowerShell redirect that stamps one parses
	// there and must parse here. Without this the first line would fail the JSON decode and be
	// reported as a malformed row, silently dropping it.
	if len(value) >= 3 && value[0] == 0xef && value[1] == 0xbb && value[2] == 0xbf {
		value = value[3:]
	}
	return r.yield(Line{Text: string(value)})
}

func joinChunks(chunks [][]byte, length int64) []byte {
	if int64(len(chunks)) == 1 && int64(len(chunks[0])) == length {
		return chunks[0]
	}
	out := make([]byte, 0, length)
	for _, chunk := range chunks {
		out = append(out, chunk...)
	}
	return out
}

func findLineTerminator(chunk []byte, offset int) int {
	carriageReturn := -1
	lineFeed := -1
	for i := offset; i < len(chunk); i++ {
		if chunk[i] == '\r' {
			carriageReturn = i
			break
		}
		if chunk[i] == '\n' {
			lineFeed = i
			break
		}
	}
	if carriageReturn == -1 {
		return lineFeed
	}
	if lineFeed == -1 {
		return carriageReturn
	}
	if carriageReturn < lineFeed {
		return carriageReturn
	}
	return lineFeed
}

// startsAfterCarriageReturn reports whether the byte before the read window is
// a CR, so an append-only read that starts between \r and \n does not emit an
// empty leading line.
func startsAfterCarriageReturn(file *os.File, startOffset int64, filePath string) (bool, error) {
	if startOffset == 0 {
		return false, nil
	}
	buffer := make([]byte, 1)
	read, err := file.ReadAt(buffer, startOffset-1)
	if err != nil && err != io.EOF {
		return false, err
	}
	if read != 1 {
		return false, fmt.Errorf("Session file changed before reading: %s", filePath)
	}
	return buffer[0] == '\r', nil
}

func hashPrefix(file *os.File, endOffset int64, hasher hash.Hash, filePath string) error {
	if endOffset == 0 {
		return nil
	}
	buffer := make([]byte, HashBufferBytes)
	position := int64(0)
	for position < endOffset {
		length := int64(len(buffer))
		if remaining := endOffset - position; remaining < length {
			length = remaining
		}
		read, err := file.ReadAt(buffer[:length], position)
		if read > 0 {
			hasher.Write(buffer[:read])
			position += int64(read)
		}
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}
	}
	if position != endOffset {
		return fmt.Errorf("Session file changed while reading: %s", filePath)
	}
	return nil
}

func openVerified(filePath string, expected Fingerprint) (*os.File, error) {
	pathInfo, err := os.Lstat(filePath)
	if err != nil {
		return nil, fmt.Errorf("Session file changed before reading: %s", filePath)
	}
	if pathInfo.Mode()&os.ModeSymlink != 0 || !pathInfo.Mode().IsRegular() ||
		!matchesIdentity(pathInfo, expected) {
		return nil, fmt.Errorf("Session file changed before reading: %s", filePath)
	}
	file, err := os.Open(filePath)
	if err != nil {
		return nil, fmt.Errorf("Session file changed before reading: %s", filePath)
	}
	handleInfo, statErr := file.Stat()
	pathInfoAfter, lstatErr := os.Lstat(filePath)
	if statErr != nil || lstatErr != nil || pathInfoAfter.Mode()&os.ModeSymlink != 0 ||
		!pathInfoAfter.Mode().IsRegular() ||
		!matchesIdentity(handleInfo, expected) || !matchesIdentity(pathInfoAfter, expected) {
		file.Close()
		return nil, fmt.Errorf("Session file changed before reading: %s", filePath)
	}
	return file, nil
}

func matchesIdentity(info os.FileInfo, expected Fingerprint) bool {
	dev, ino, ok := fileIdentity(info)
	if !ok {
		// A platform without file identity (or a synthetic FileInfo in tests)
		// cannot prove the file is the same one the scan saw; the size check
		// still catches truncation and the content hash catches rewrites.
		return info.Size() >= expected.Size
	}
	return dev == expected.Dev && ino == expected.Ino && info.Size() >= expected.Size
}

func assertVerified(bytesRead int64, expected *Fingerprint, hasher hash.Hash, filePath string) error {
	if expected == nil {
		return nil
	}
	if bytesRead != expected.Size || hex.EncodeToString(hasher.Sum(nil)) != expected.SHA256 {
		return fmt.Errorf("Session file changed while reading: %s", filePath)
	}
	return nil
}

// codexAdditionalRelevantKeys mirrors the TS emptyLineState: the two payload
// token fields are only relevant when scanning Codex rows.
func codexAdditionalRelevantKeys(codexUsageOnly bool) []string {
	if !codexUsageOnly {
		return nil
	}
	return []string{"total_token_usage", "last_token_usage"}
}
