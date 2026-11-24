package sessionfile

// Semantics of the line reader that the hook path relies on. It ports
// `JSON.parse` through encoding/json/v2, so these tests pin the behaviours the
// v1 decoder used to provide with a two-Decode dance: a duplicated member keeps
// the last value, trailing garbage is a syntax error, and numbers arrive as
// float64 (v2's `any` shape) rather than json.Number.

import (
	"encoding/json"
	"math"
	"testing"
)

func TestReadLineRecordMatchesJSONParse(t *testing.T) {
	cases := []struct {
		name      string
		line      string
		wantNil   bool
		malformed bool
		check     func(t *testing.T, record map[string]any)
	}{
		{
			name: "duplicate member keeps the last value",
			line: `{"input_tokens":1,"input_tokens":2}`,
			check: func(t *testing.T, record map[string]any) {
				if got := record["input_tokens"]; got != float64(2) {
					t.Fatalf("input_tokens = %v, want the last duplicate (2)", got)
				}
			},
		},
		{
			name:      "trailing garbage is a syntax error",
			line:      `{"a":1}garbage`,
			malformed: true,
		},
		{
			name:      "trailing whitespace is not garbage",
			line:      "{\"a\":1}  \t",
			check:     func(t *testing.T, record map[string]any) {},
			malformed: false,
		},
		{
			name:    "non-object top level",
			line:    `[1,2,3]`,
			wantNil: true,
		},
		{
			name: "empty and whitespace-only lines are skipped silently",
			line: "",
			// readLineRecord returns (nil, false): not a record, not malformed.
			wantNil: true,
		},
		{
			name: "numbers decode as float64",
			line: `{"input_tokens":7000000000123}`,
			check: func(t *testing.T, record map[string]any) {
				got, ok := record["input_tokens"].(float64)
				if !ok || got != 7000000000123 {
					t.Fatalf("input_tokens = %#v, want the float64 7000000000123", record["input_tokens"])
				}
			},
		},
		{
			name: "invalid UTF-8 preserved on the fast path",
			line: "{\"model\":\"\xff\xfe\"}",
			check: func(t *testing.T, record map[string]any) {
				if _, ok := record["model"].(string); !ok {
					t.Fatalf("model = %#v, want a string", record["model"])
				}
			},
		},
		{
			name: "float64 overflow keeps the pre-v2 behaviour on the fallback path",
			line: `{"input_tokens":1e400}`,
			check: func(t *testing.T, record map[string]any) {
				// v2 refuses 1e400, so the line falls back to the v1 decoder,
				// which yields json.Number("1e400"); optionalNumber's conversion
				// then fails and treats the number as absent, exactly as before.
				if _, ok := record["input_tokens"].(json.Number); !ok {
					t.Fatalf("input_tokens = %#v, want the fallback decoder's json.Number", record["input_tokens"])
				}
				if _, ok := optionalNumber(record, "input_tokens"); ok {
					t.Fatalf("optionalNumber accepted an overflowing number")
				}
			},
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			record, malformed := readLineRecord(testCase.line)
			if malformed != testCase.malformed {
				t.Fatalf("malformed = %v, want %v", malformed, testCase.malformed)
			}
			if testCase.malformed {
				if record != nil {
					t.Fatalf("record = %v, want nil for a malformed line", record)
				}
				return
			}
			if testCase.wantNil {
				if record != nil {
					t.Fatalf("record = %v, want nil", record)
				}
				return
			}
			if record == nil {
				t.Fatalf("record = nil, want a decoded object")
			}
			if testCase.check != nil {
				testCase.check(t, record)
			}
		})
	}
}

// TestOptionalNumberAcceptsBothDecodedShapes pins the two numeric shapes the
// hook path can produce: float64 from the v2 reader and json.Number from any
// caller that still hands over a record decoded by the v1 decoder.
func TestOptionalNumberAcceptsBothDecodedShapes(t *testing.T) {
	record := map[string]any{
		"float":  float64(42),
		"number": json.Number("43"),
		"string": "44",
		"nan":    math.NaN(),
		"inf":    math.Inf(1),
	}
	if value, ok := optionalNumber(record, "float"); !ok || value != 42 {
		t.Fatalf("optionalNumber(float) = (%v, %v), want (42, true)", value, ok)
	}
	if value, ok := optionalNumber(record, "number"); !ok || value != 43 {
		t.Fatalf("optionalNumber(number) = (%v, %v), want (43, true)", value, ok)
	}
	for _, key := range []string{"string", "nan", "inf", "missing"} {
		if _, ok := optionalNumber(record, key); ok {
			t.Fatalf("optionalNumber(%q) accepted a value it must ignore", key)
		}
	}
}
