package copilot

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"
	"strings"
)

// This file ports adapters/common/src/jsonl.rs: a file is read line by line,
// a prefilter drops lines that cannot carry a record before JSON parsing, and a
// line that does not decode is skipped on its own rather than failing the file.

// jsonlBufferBytes is the per-file read buffer. A line longer than this grows
// the reader automatically; the size only sets how many lines share a read.
const jsonlBufferBytes = 64 * 1024

// scanJSONL reads path line by line. Lines accepted by prefilter are decoded
// and handed to visit when they decode; a file that cannot be opened or read is
// an error, while a bad line is not. decode is the line's Deserialize: it
// returns the value to visit, or false for a line this reader cannot own.
func scanJSONL(path string, prefilter func([]byte) bool, decode func(line []byte) (any, bool),
	visit func(value any)) error {
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()
	reader := bufio.NewReaderSize(file, jsonlBufferBytes)
	for {
		line, readErr := readJSONLLine(reader)
		if len(line) > 0 && prefilter(line) {
			if value, ok := decode(line); ok {
				visit(value)
			}
		}
		if errors.Is(readErr, io.EOF) {
			return nil
		}
		if readErr != nil {
			return readErr
		}
	}
}

// readJSONLLine returns the next line without its terminator. The final line
// of a file without a newline is returned with io.EOF.
func readJSONLLine(reader *bufio.Reader) ([]byte, error) {
	line, err := reader.ReadBytes('\n')
	line = bytes.TrimSuffix(line, []byte("\n"))
	line = bytes.TrimSuffix(line, []byte("\r"))
	return line, err
}

func containsBytes(line, needle []byte) bool {
	return bytes.Contains(line, needle)
}

// trimRustSpace is Rust's str::trim: Unicode White_Space on both ends.
func trimRustSpace(value string) string {
	return strings.TrimFunc(value, RustSpace)
}

// RustSpace is Rust's char::is_whitespace: the Unicode White_Space property.
func RustSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0x85, 0xA0, 0x1680,
		0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008,
		0x2009, 0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000:
		return true
	}
	return false
}

// stripSuffix is Rust's str::strip_suffix.
func stripSuffix(value, suffix string) string {
	if strings.HasSuffix(value, suffix) {
		return value[:len(value)-len(suffix)]
	}
	return value
}

// decodeJSONLineStrict decodes one JSONL line and rejects trailing content, as
// serde_json::from_slice does.
func decodeJSONLineStrict(line []byte) (any, bool) {
	decoder := json.NewDecoder(bytes.NewReader(line))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return nil, false
	}
	if _, err := decoder.Token(); !errors.Is(err, io.EOF) {
		return nil, false
	}
	return value, true
}
