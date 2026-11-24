package ccusage

import (
	"encoding/json"
	"fmt"
	"io"
)

// orderedRecord is a JSON object that remembers its key order. ccusage's
// breakdown objects are iterated in insertion order by the TS normalizer, and
// the session-count attribution keeps the first model on a token tie — Go's
// unordered maps would silently change that choice.
type orderedRecord struct {
	keys   []string
	values map[string]any
}

func newOrderedRecord() *orderedRecord {
	return &orderedRecord{values: map[string]any{}}
}

func (r *orderedRecord) set(key string, value any) {
	if _, exists := r.values[key]; !exists {
		r.keys = append(r.keys, key)
	}
	r.values[key] = value
}

// Get returns one value.
func (r *orderedRecord) Get(key string) (any, bool) {
	if r == nil {
		return nil, false
	}
	value, ok := r.values[key]
	return value, ok
}

// Keys returns the keys in document order.
func (r *orderedRecord) Keys() []string {
	if r == nil {
		return nil
	}
	out := make([]string, len(r.keys))
	copy(out, r.keys)
	return out
}

func (r *orderedRecord) Len() int {
	if r == nil {
		return 0
	}
	return len(r.keys)
}

// OrderedObject is one decoded JSON object that remembers its key order. The
// runner hands providers these records, so a provider that re-projects its
// output (the Codex subagent correction, the per-home row tag) reaches the
// fields and their order through this interface rather than the unexported
// type.
type OrderedObject interface {
	Keys() []string
	Get(key string) (any, bool)
}

// RecordWith returns a copy of an ordered row with key set — appended when the
// key is new — the way the TS `{ ...row, [key]: value }` spread behaves. ok is
// false when row is not an ordered object; the caller decides what to do with
// a row it cannot tag.
func RecordWith(row any, key string, value any) (any, bool) {
	record, ok := row.(*orderedRecord)
	if !ok || record == nil {
		return nil, false
	}
	copied := newOrderedRecord()
	for _, name := range record.keys {
		copied.set(name, record.values[name])
	}
	copied.set(key, value)
	return copied, true
}

// DecodeOrderedJSON decodes JSON with the runner's conventions: objects keep
// their document order and numbers are json.Number. It is what the exec
// package's subprocess decoder calls, so a report from the runner and a
// cached or fixture document have the same shape.
func DecodeOrderedJSON(data []byte) (any, error) {
	return decodeOrdered(data)
}

func decodeOrdered(data []byte) (any, error) {
	decoder := json.NewDecoder(newByteReader(data))
	decoder.UseNumber()
	value, err := decodeValue(decoder)
	if err != nil {
		return nil, err
	}
	// Reject trailing content the way JSON.parse does.
	if _, err := decoder.Token(); err != io.EOF {
		return nil, fmt.Errorf("unexpected trailing JSON content")
	}
	return value, nil
}

func decodeValue(decoder *json.Decoder) (any, error) {
	token, err := decoder.Token()
	if err != nil {
		return nil, err
	}
	switch typed := token.(type) {
	case json.Delim:
		switch typed {
		case '{':
			record := newOrderedRecord()
			for decoder.More() {
				keyToken, err := decoder.Token()
				if err != nil {
					return nil, err
				}
				key, ok := keyToken.(string)
				if !ok {
					return nil, fmt.Errorf("object key must be a string")
				}
				value, err := decodeValue(decoder)
				if err != nil {
					return nil, err
				}
				record.set(key, value)
			}
			if _, err := decoder.Token(); err != nil {
				return nil, err
			}
			return record, nil
		case '[':
			values := []any{}
			for decoder.More() {
				value, err := decodeValue(decoder)
				if err != nil {
					return nil, err
				}
				values = append(values, value)
			}
			if _, err := decoder.Token(); err != nil {
				return nil, err
			}
			return values, nil
		}
		return nil, fmt.Errorf("unexpected delimiter %v", typed)
	}
	return token, nil
}

type byteReader struct {
	data   []byte
	offset int
}

func newByteReader(data []byte) *byteReader {
	return &byteReader{data: data}
}

func (r *byteReader) Read(p []byte) (int, error) {
	if r.offset >= len(r.data) {
		return 0, io.EOF
	}
	read := copy(p, r.data[r.offset:])
	r.offset += read
	return read, nil
}
