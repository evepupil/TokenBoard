package codex

// The byte layer of ccusage's Codex adapter, ported from v20.0.33
// (commit 1308c416): rust/adapters/codex/src/reader.rs and the line loop in
// rust/adapters/codex/src/parser.rs:266-277. What this layer reads and what it
// hands to the classifier decides which events the parser can ever see, so
// every rule cites its source.

import (
	"bufio"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"github.com/klauspost/compress/zstd"
)

// readBufferSize mirrors READ_BUFFER_SIZE (reader.rs:7). It is a read-ahead
// buffer, not a line limit: lines may be arbitrarily long.
const readBufferSize = 128 * 1024

// rolloutReader is the buffered reader plus the handle that must be released
// under it (the file, and the zstd decoder for compressed rollouts).
type rolloutReader struct {
	reader *bufio.Reader
	close  func() error
}

func (r *rolloutReader) Read(p []byte) (int, error) { return r.reader.Read(p) }
func (r *rolloutReader) Close() error               { return r.close() }

// buffered exposes the read buffer so ReadLines does not stack a second one on
// top when it is handed a reader that OpenRollout built.
func (r *rolloutReader) buffered() *bufio.Reader { return r.reader }

// OpenRollout is open_rollout_reader (reader.rs:36-49): open the rollout in
// whichever encoding survives. Codex may compress or restore a rollout between
// discovery and this open, so a NotFound from the given path retries the other
// encoding, and the path actually opened is returned so fallback timestamps
// come from the file that was read. Any other open error is reported as-is.
func OpenRollout(path string) (io.ReadCloser, string, error) {
	reader, err := openEncodedRollout(path)
	if err == nil {
		return reader, path, nil
	}
	if !errors.Is(err, fs.ErrNotExist) {
		return nil, "", err
	}
	other := otherEncodingPath(path)
	reader, otherErr := openEncodedRollout(other)
	if otherErr != nil {
		return nil, "", otherErr
	}
	return reader, other, nil
}

// otherEncodingPath is other_encoding_path (reader.rs:51-59).
func otherEncodingPath(path string) string {
	if isCompressedRollout(path) {
		return strings.TrimSuffix(path, ".zst")
	}
	return path + ".zst"
}

// isCompressedRollout is is_compressed_rollout (reader.rs:14-20): the
// extension is "zst" and the stem still ends in ".jsonl". Case sensitive.
func isCompressedRollout(path string) bool {
	if filepath.Ext(path) != ".zst" {
		return false
	}
	return filepath.Ext(strings.TrimSuffix(path, ".zst")) == ".jsonl"
}

// openEncodedRollout is open_encoded_rollout (reader.rs:61-75): plain rollouts
// are read directly, compressed ones through a zstd stream decoder. The
// streaming decoder decodes concatenated frames - Codex appends whole frames -
// and surfaces a truncated tail frame as a read error after the data before it
// has been delivered; ReadLines turns that error into a normal end of the log,
// matching compression_tests.rs:194-213.
func openEncodedRollout(path string) (io.ReadCloser, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	if !isCompressedRollout(path) {
		return &rolloutReader{
			reader: bufio.NewReaderSize(file, readBufferSize),
			close:  file.Close,
		}, nil
	}
	decoder, err := zstd.NewReader(file, zstd.WithDecoderConcurrency(1))
	if err != nil {
		file.Close()
		return nil, err
	}
	return &rolloutReader{
		reader: bufio.NewReaderSize(decoder, readBufferSize),
		close: func() error {
			decoder.Close()
			return file.Close()
		},
	}, nil
}

// ReadLines is the line loop's read half (parser.rs:267-277): read_until(b'\n')
// over the rollout, handing every line - including the trailing newline, and
// including a final line that has none - to visit. A read or decompression
// error ends the read without an error of its own, keeping the complete lines
// that came before it: the data buffered for the failed call is dropped without
// being visited, exactly as the Rust caller breaks before looking at it. An
// error from visit is returned unchanged.
func ReadLines(r io.Reader, visit func(line []byte) error) error {
	reader := bufio.NewReaderSize(r, readBufferSize)
	if source, ok := r.(interface{ buffered() *bufio.Reader }); ok {
		reader = source.buffered()
	}
	for {
		line, err := reader.ReadBytes('\n')
		if err != nil {
			if len(line) > 0 && errors.Is(err, io.EOF) {
				// A final line without a newline is still a line: read_until
				// returns it before the empty read that ends the loop.
				return visit(line)
			}
			return nil
		}
		if err := visit(line); err != nil {
			return err
		}
	}
}
