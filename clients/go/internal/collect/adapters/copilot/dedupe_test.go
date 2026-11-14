package copilot

import (
	"strconv"
	"strings"
	"testing"
)

// chatSpanLine is one chat span with a response id and usage.
func chatSpanLine(traceID, spanID string, endSeconds int64, responseID string, input, output uint64) string {
	return `{"type":"span","traceId":"` + traceID + `","spanId":"` + spanID + `","name":"chat test-model","endTime":[` +
		itoa(endSeconds) + `,0],"attributes":{"gen_ai.operation.name":"chat","gen_ai.response.model":"test-model","gen_ai.conversation.id":"conv-1","gen_ai.response.id":"` +
		responseID + `","gen_ai.usage.input_tokens":` + utoa(input) + `,"gen_ai.usage.output_tokens":` + utoa(output) + `}}`
}

func itoa(value int64) string { return strconv.FormatInt(value, 10) }

func utoa(value uint64) string { return strconv.FormatUint(value, 10) }

// TestCopilotDuplicateChatSpanKeepsEarliest mirrors counts_a_re_exported_chat_span_once
// (loader.rs:670-692): a chat call exported again under a new trace or span id
// with the same response id and usage counts once, and the copy with the
// earliest timestamp is the one kept - whichever line came first.
func TestCopilotDuplicateChatSpanKeepsEarliest(t *testing.T) {
	entries := otelFixture(t,
		chatSpanLine("trace-1", "span-1", 1_775_934_264, "resp-1", 100, 10),
		chatSpanLine("trace-1", "span-2", 1_775_934_300, "resp-2", 200, 10),
		// The CLI exports some calls a second time, with the response ID and
		// usage of the call but a new trace or span ID.
		chatSpanLine("trace-2", "span-3", 1_775_934_368, "resp-1", 100, 10),
		chatSpanLine("trace-1", "span-4", 1_775_934_370, "resp-2", 200, 10),
		chatSpanLine("trace-3", "span-5", 1_775_934_500, "resp-3", 300, 10),
		// resp-3's true copy arrived earlier in the file than its original.
		chatSpanLine("trace-1", "span-6", 1_775_934_400, "resp-3", 300, 10),
	)
	if got, want := strings.Join(otelKinds(entries), ","), "trace-1:span-1,trace-1:span-2,trace-1:span-6"; got != want {
		t.Fatalf("dedup keys = %s, want %s", got, want)
	}
}

// TestCopilotSameResponseIDDifferentUsageBothCount mirrors
// keeps_calls_of_one_turn_that_share_a_response_id (loader.rs:694-712): VS Code
// reports the turn's response id on every call, so a different usage is a
// different call; the model and every usage bucket are part of the identity.
func TestCopilotSameResponseIDDifferentUsageBothCount(t *testing.T) {
	entries := otelFixture(t,
		chatSpanLine("trace-1", "span-1", 1_775_934_264, "turn-1", 1_000, 10),
		chatSpanLine("trace-1", "span-2", 1_775_934_270, "turn-1", 1_200, 10),
		chatSpanLine("trace-1", "span-3", 1_775_934280, "turn-1", 1_400, 10),
	)
	if got, want := strings.Join(otelKinds(entries), ","), "trace-1:span-1,trace-1:span-2,trace-1:span-3"; got != want {
		t.Fatalf("dedup keys = %s, want %s", got, want)
	}
	// Same usage but another model is another call.
	other := `{"type":"span","traceId":"trace-9","spanId":"span-9","name":"chat other","endTime":[1775934290,0],"attributes":{"gen_ai.operation.name":"chat","gen_ai.response.model":"other-model","gen_ai.response.id":"turn-1","gen_ai.usage.input_tokens":1000,"gen_ai.usage.output_tokens":10}}`
	entries = otelFixture(t,
		chatSpanLine("trace-1", "span-1", 1_775_934_264, "turn-1", 1_000, 10),
		other,
	)
	if len(entries) != 2 {
		t.Fatalf("entries = %s, want both models kept", strings.Join(otelKinds(entries), ","))
	}
}

// TestCopilotSuppressionMatrixOrder pins should_emit_candidate
// (parser.rs:584-621) and mirrors suppresses_lower_priority_records_for_same_response
// (loader.rs:580-637): an inference log is dropped when it shares a chat call's
// trace or response id, an agent turn when it shares a chat's or an inference
// log's, and an agent summary span when it shares any of the three.
func TestCopilotSuppressionMatrixOrder(t *testing.T) {
	chat := func(trace, span, response string) string {
		return `{"type":"span","traceId":"` + trace + `","spanId":"` + span + `","name":"chat m","endTime":[1775934000,0],"attributes":{"gen_ai.operation.name":"chat","gen_ai.response.model":"m","gen_ai.response.id":"` + response + `","gen_ai.usage.input_tokens":1}}`
	}
	inference := func(trace, span, response string) string {
		return `{"traceId":"` + trace + `","spanId":"` + span + `","hrTime":[1775934001,0],"attributes":{"event.name":"gen_ai.client.inference.operation.details","gen_ai.response.model":"m","gen_ai.response.id":"` + response + `","gen_ai.usage.input_tokens":2}}`
	}
	turn := func(trace, response string, index int) string {
		return `{"hrTime":[1775934002,0]` + traceAttr(trace) + `,"attributes":{"event.name":"copilot_chat.agent.turn","gen_ai.response.model":"m","gen_ai.response.id":"` + response + `","turn.index":` + itoa(int64(index)) + `,"gen_ai.usage.input_tokens":3}}`
	}
	summary := func(trace, span, response string) string {
		return `{"type":"span","traceId":"` + trace + `","spanId":"` + span + `","name":"invoke_agent X","endTime":[1775934003,0],"attributes":{"gen_ai.response.model":"m","gen_ai.response.id":"` + response + `","gen_ai.usage.input_tokens":4}}`
	}
	cases := []struct {
		name  string
		lines []string
		want  []string
	}{
		{
			name: "every class on one trace keeps only chat",
			lines: []string{
				chat("t", "c", "rc"), inference("t", "i", "ri"), turn("t", "rt", 1), summary("t", "a", "ra"),
			},
			want: []string{"t:c"},
		},
		{
			name: "inference survives beside a chat on another trace and response",
			lines: []string{
				chat("t1", "c", "r1"), inference("t2", "i", "r2"),
			},
			want: []string{"t1:c", "log:t2:i"},
		},
		{
			name: "inference by response id",
			lines: []string{
				chat("t1", "c", "shared"), inference("t2", "i", "shared"),
			},
			want: []string{"t1:c"},
		},
		{
			name: "agent turn suppressed by an inference trace",
			lines: []string{
				inference("t-i", "i", "r-i"), turn("t-i", "r-t", 2),
			},
			want: []string{"log:t-i:i"},
		},
		{
			name: "agent turn suppressed by a chat response id",
			lines: []string{
				chat("t-c", "c", "shared"), turn("t-t", "shared", 3),
			},
			want: []string{"t-c:c"},
		},
		{
			name: "agent turn survives an agent summary on its trace",
			lines: []string{
				turn("t-t", "r-t", 4), summary("t-t", "a", "r-a"),
			},
			want: []string{"agent-turn:t-t:4"},
		},
		{
			name: "agent summary suppressed by an agent turn trace",
			lines: []string{
				turn("t-a", "r-t", 5), summary("t-a", "a", "r-a"),
			},
			want: []string{"agent-turn:t-a:5"},
		},
		{
			name: "agent summary suppressed by an inference response id",
			lines: []string{
				inference("t-i", "i", "shared"), summary("t-a", "a", "shared"),
			},
			want: []string{"log:t-i:i"},
		},
		{
			name: "agent summary alone survives",
			lines: []string{
				turn("t-t", "r-t", 6), summary("t-a", "a", "r-a"),
			},
			want: []string{"agent-turn:t-t:6", "t-a:a"},
		},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			entries := otelFixture(t, test.lines...)
			if got := strings.Join(otelKinds(entries), ","); got != strings.Join(test.want, ",") {
				t.Fatalf("dedup keys = %s, want %s", got, strings.Join(test.want, ","))
			}
		})
	}
}

func traceAttr(trace string) string {
	if trace == "" {
		return ""
	}
	return `,"traceId":"` + trace + `"`
}

// TestCopilotDedupKeyFallbacks pins dedup_key_for_record (parser.rs:693-726): a
// chat or summary span without both ids keys on session and line index; an
// inference log without both keys `log:<session>:...`; an agent turn takes
// turn.index, then copilot_chat.turn.index, else idx-<line>; and a turn without
// a trace appends the line index after the turn.
func TestCopilotDedupKeyFallbacks(t *testing.T) {
	entries := otelFixture(t,
		// No span id: span key.
		`{"type":"span","traceId":"t-no-span","name":"chat m","endTime":[1775934000,0],"attributes":{"gen_ai.response.model":"m","session.id":"s","gen_ai.usage.input_tokens":1}}`,
		// Inference without span id: log key.
		`{"traceId":"t-no-span-2","hrTime":[1775934001,0],"attributes":{"event.name":"gen_ai.client.inference.operation.details","gen_ai.response.model":"m","session.id":"s","gen_ai.usage.input_tokens":2}}`,
		// Agent turn with the alternative index attribute and a trace.
		`{"traceId":"t-turn","hrTime":[1775934002,0],"attributes":{"event.name":"copilot_chat.agent.turn","gen_ai.response.model":"m","session.id":"s","copilot_chat.turn.index":"07","gen_ai.usage.input_tokens":3}}`,
		// Agent turn without trace or index.
		`{"hrTime":[1775934003,0],"attributes":{"event.name":"copilot_chat.agent.turn","gen_ai.response.model":"m","session.id":"s","gen_ai.usage.input_tokens":4}}`,
		// A spanContext-only span id.
		`{"type":"span","traceId":"t-ctx","spanContext":{"traceId":"t-ctx","spanId":"s-ctx"},"endTime":[1775934004,0],"attributes":{"gen_ai.operation.name":"chat","gen_ai.response.model":"m","session.id":"s","gen_ai.usage.input_tokens":5}}`,
	)
	if got, want := strings.Join(otelKinds(entries), ","), "span:s:1775934000000:0,log:s:1775934001000:1,agent-turn:t-turn:7,agent-turn:s:idx-3:3,t-ctx:s-ctx"; got != want {
		t.Fatalf("dedup keys = %s, want %s", got, want)
	}
}
