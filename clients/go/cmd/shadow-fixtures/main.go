// Command shadow-fixtures writes a self-contained home tree for each collector
// source that reads local files, so `tokenboard shadow` can run in CI without
// touching a real user's data.
//
// Every directory it writes is created under -root; the printed shell
// assignments point the provider environment variables at those trees. The
// JSONL and SQLite shapes mirror the ones the provider tests use, which are in
// turn copied from real tool output.
//
// Usage:
//
//	go run ./cmd/shadow-fixtures -root /tmp/fixtures > env.sh
//	. /tmp/fixtures/env.sh
//	tokenboard shadow --source pi
package main

import (
	"database/sql"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/klauspost/compress/zstd"

	_ "modernc.org/sqlite"
)

func main() {
	root := flag.String("root", "", "directory to write the fixtures under (required)")
	format := flag.String("format", "shell", `output format: "shell" (export lines) or "env" (NAME=value, for $GITHUB_ENV)`)
	flag.Parse()
	if strings.TrimSpace(*root) == "" {
		fmt.Fprintln(os.Stderr, "usage: shadow-fixtures -root <dir>")
		os.Exit(2)
	}
	if err := os.MkdirAll(*root, 0o700); err != nil {
		fail(err)
	}

	assignments := []struct{ name, value string }{}
	if dir, err := writeGrok(filepath.Join(*root, "grok")); err != nil {
		fail(err)
	} else {
		assignments = append(assignments, struct{ name, value string }{"TOKENBOARD_GROK_HOME", dir})
	}
	if dir, err := writePi(filepath.Join(*root, "pi")); err != nil {
		fail(err)
	} else {
		assignments = append(assignments, struct{ name, value string }{"TOKENBOARD_PI_AGENT_DIR", dir})
	}
	if dir, err := writeDeepSeekHarness(filepath.Join(*root, "dsh")); err != nil {
		fail(err)
	} else {
		assignments = append(assignments, struct{ name, value string }{"TOKENBOARD_DSH_HOME", dir})
	}
	if path, err := writeOpenCode(filepath.Join(*root, "opencode")); err != nil {
		fail(err)
	} else {
		assignments = append(assignments, struct{ name, value string }{"TOKENBOARD_OPENCODE_DB", path})
	}
	if dir, err := writeClaude(filepath.Join(*root, "claude")); err != nil {
		fail(err)
	} else {
		assignments = append(assignments, struct{ name, value string }{"CLAUDE_CONFIG_DIR", dir})
	}
	if dir, err := writeCodex(filepath.Join(*root, "codex")); err != nil {
		fail(err)
	} else {
		assignments = append(assignments, struct{ name, value string }{"CODEX_HOME", dir})
	}

	var out strings.Builder
	for _, assignment := range assignments {
		switch *format {
		case "shell":
			fmt.Fprintf(&out, "export %s=%q\n", assignment.name, assignment.value)
		case "env":
			fmt.Fprintf(&out, "%s=%s\n", assignment.name, assignment.value)
		default:
			fmt.Fprintf(os.Stderr, "unknown -format %q\n", *format)
			os.Exit(2)
		}
	}
	fmt.Print(out.String())
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, "shadow-fixtures:", err)
	os.Exit(1)
}

// writeJSONL writes one JSONL file, creating its parents.
func writeJSONL(path string, lines []any) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	var out strings.Builder
	for _, line := range lines {
		encoded, err := json.Marshal(line)
		if err != nil {
			return err
		}
		out.Write(encoded)
		out.WriteByte('\n')
	}
	return os.WriteFile(path, []byte(out.String()), 0o600)
}

// writeGrok mirrors the Grok Build fixture: turn_completed is a per-turn total,
// so two turns in one session must both be recorded at face value. One turn
// reports a non-zero cachedReadTokens inside inputTokens, which the providers
// must subtract back out (input is the inclusive total, unlike TokenBoard's
// disjoint snapshot fields) — a fixture with every cached counter at zero
// never exercises that branch on either side.
func writeGrok(home string) (string, error) {
	session := filepath.Join(home, "sessions", "enc-cwd", "session-1")
	turn := func(timestamp int64, input, cachedRead, output int64) map[string]any {
		return map[string]any{
			"method":    "_x.ai/session/update",
			"timestamp": timestamp,
			"params": map[string]any{
				"update": map[string]any{
					"sessionUpdate": "turn_completed",
					"usage": map[string]any{
						"inputTokens":      input,
						"outputTokens":     output,
						"cachedReadTokens": cachedRead,
						"modelUsage": map[string]any{
							"grok-4.5": map[string]any{
								"inputTokens":      input,
								"outputTokens":     output,
								"cachedReadTokens": cachedRead,
							},
						},
					},
				},
			},
		}
	}
	return home, writeJSONL(filepath.Join(session, "updates.jsonl"), []any{
		turn(1785528000, 1000, 0, 10),
		// inputTokens includes the 400 cached tokens; fresh input is 500.
		turn(1785528060, 900, 400, 5),
	})
}

// writePi mirrors the Pi fixture: usage rides on assistant messages, tool
// results that did nested model work, compaction and branch-summary entries,
// and a forked session copies its parent's history. The audit found the old
// fixture covered only a single assistant message, so three carrier shapes and
// the fork dedup were never compared across implementations. The second
// assistant message also splits its cache write across the two TTL tiers —
// dropping `cacheWrite1h` under-reports usage on providers that offer it.
func writePi(agentDir string) (string, error) {
	sessions := filepath.Join(agentDir, "sessions", "project")
	assistant := func(id, parent, timestamp string, usage map[string]any) map[string]any {
		return map[string]any{
			"type":      "message",
			"id":        id,
			"parentId":  parent,
			"timestamp": timestamp,
			"message": map[string]any{
				"role":     "assistant",
				"api":      "anthropic",
				"provider": "deepseek",
				"model":    "deepseek-v4-pro",
				"usage":    usage,
			},
		}
	}
	cost := func(total float64) map[string]any {
		return map[string]any{"input": 0.0009, "output": 0.0014, "cacheRead": 0.0001, "cacheWrite": 0, "total": total}
	}
	first := assistant("entry-1", "entry-0", "2026-07-31T20:01:00.000Z", map[string]any{
		"input": 3272, "output": 383, "cacheRead": 52480, "cacheWrite": 0, "cost": cost(0.0024),
	})
	parent := []any{
		map[string]any{"type": "session", "id": "s1", "timestamp": "2026-07-31T20:00:00.000Z"},
		first,
		// A tool result that performed nested model work: same usage shape,
		// role `toolResult` instead of `assistant`.
		map[string]any{
			"type":      "message",
			"id":        "entry-2",
			"parentId":  "entry-1",
			"timestamp": "2026-07-31T20:02:00.000Z",
			"message": map[string]any{
				"role":     "toolResult",
				"provider": "deepseek",
				"model":    "deepseek-v4-pro",
				"usage": map[string]any{
					"input": 100, "output": 20, "cacheRead": 0, "cacheWrite": 0, "cost": cost(0.0002),
				},
			},
		},
		// Compaction: usage sits on the entry itself, no message wrapper.
		map[string]any{
			"type":      "compaction",
			"id":        "entry-3",
			"parentId":  "entry-2",
			"timestamp": "2026-07-31T20:03:00.000Z",
			"usage": map[string]any{
				"input": 200, "output": 40, "cacheRead": 0, "cacheWrite": 10, "cacheWrite1h": 5,
				"cost": cost(0.0004),
			},
		},
	}
	fork := []any{
		map[string]any{"type": "session", "id": "s2", "timestamp": "2026-07-31T21:00:00.000Z"},
		// The fork copies the shared prefix verbatim; only the new tail counts.
		first,
		map[string]any{
			"type":      "branch_summary",
			"id":        "entry-4",
			"parentId":  "entry-1",
			"timestamp": "2026-07-31T21:01:00.000Z",
			"usage": map[string]any{
				"input": 300, "output": 60, "cacheRead": 0, "cacheWrite": 0, "cost": cost(0.0006),
			},
		},
	}
	if err := writeJSONL(filepath.Join(sessions, "session-a.jsonl"), parent); err != nil {
		return "", err
	}
	return agentDir, writeJSONL(filepath.Join(sessions, "session-b-fork.jsonl"), fork)
}

// writeDeepSeekHarness mirrors the DSH fixture. The real log is
// Zstandard-compressed by default and appended in batches, so the fixture
// carries a plain session, a multi-frame compressed session whose tail frame is
// truncated (a live log being written), and a session directory that holds both
// encodings with an overlapping sequence — the three shapes the provider's
// frame reader and its per-directory dedup exist for.
func writeDeepSeekHarness(home string) (string, error) {
	sessions := filepath.Join(home, "sessions", "project")
	message := func(seq int64, occurredAtMs int64, input, output int64) map[string]any {
		return map[string]any{
			"type": "assistant/message",
			"seq":  seq,
			"time": occurredAtMs,
			"data": map[string]any{
				"turn": 1,
				"step": 0,
				"message": map[string]any{
					"id":     "m" + strconv.FormatInt(seq, 10),
					"role":   "assistant",
					"source": map[string]any{"kind": "model", "model": "deepseek-v4-pro"},
				},
				"usage": map[string]any{
					"inputTokens": input, "outputTokens": output,
					"cacheReadTokens": 0, "cacheWriteTokens": 0,
				},
			},
		}
	}
	if err := writeJSONL(filepath.Join(sessions, "session-1", "session.jsonl"),
		[]any{message(1, 1785528000000, 1000, 10)}); err != nil {
		return "", err
	}

	// Multi-frame log with a torn trailing frame.
	frames := [][]byte{
		mustJSONLine(message(1, 1785528060000, 100, 10)),
		mustJSONLine(message(2, 1785528061000, 200, 20)),
		mustJSONLine(message(3, 1785528062000, 300, 30)),
	}
	log, err := appendZstdFrames(frames, 1)
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(filepath.Join(sessions, "session-2"), 0o700); err != nil {
		return "", err
	}
	if err := os.WriteFile(filepath.Join(sessions, "session-2", "session.jsonl.zstd"), log, 0o600); err != nil {
		return "", err
	}

	// Both encodings of one session, overlapping on seq 2.
	if err := os.MkdirAll(filepath.Join(sessions, "session-3"), 0o700); err != nil {
		return "", err
	}
	overlapping := []byte(string(mustJSONLine(message(2, 1785528070000, 20, 2))))
	if err := writeJSONL(filepath.Join(sessions, "session-3", "session.jsonl"), []any{
		message(2, 1785528070000, 20, 2),
		message(3, 1785528071000, 30, 3),
	}); err != nil {
		return "", err
	}
	compressed, err := appendZstdFrames([][]byte{mustJSONLine(message(1, 1785528069000, 10, 1)), overlapping}, 0)
	if err != nil {
		return "", err
	}
	if err := os.WriteFile(filepath.Join(sessions, "session-3", "session.jsonl.zstd"), compressed, 0o600); err != nil {
		return "", err
	}
	return home, nil
}

// mustJSONLine encodes one fixture record; a marshal failure here is a
// programming error, not a runtime condition.
func mustJSONLine(value any) []byte {
	encoded, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	return append(encoded, '\n')
}

// appendZstdFrames concatenates one Zstandard frame per payload, the way DSH
// appends its batches, and optionally truncates the last frame to mimic a
// session still being written.
func appendZstdFrames(payloads [][]byte, truncatedFrames int) ([]byte, error) {
	var out []byte
	for _, payload := range payloads {
		encoder, err := zstd.NewWriter(nil, zstd.WithEncoderConcurrency(1))
		if err != nil {
			return nil, err
		}
		out = append(out, encoder.EncodeAll(payload, nil)...)
		encoder.Close()
	}
	for index := 0; index < truncatedFrames; index++ {
		frameStart := len(out)
		encoder, err := zstd.NewWriter(nil, zstd.WithEncoderConcurrency(1))
		if err != nil {
			return nil, err
		}
		frame := encoder.EncodeAll(mustJSONLine(map[string]any{"type": "assistant/message"}), nil)
		encoder.Close()
		// Keep the frame header and part of the body: the reader must drop the
		// incomplete frame and still return every frame before it.
		out = append(out, frame[:len(frame)-8]...)
		if len(out)-frameStart < 8 {
			return nil, fmt.Errorf("truncated frame fixture is too short")
		}
	}
	return out, nil
}

// writeOpenCode mirrors the OpenCode fixture: the message table with the
// token fields the query projects out of the data blob. The database is built
// through the same pure-Go driver the providers use, so CI needs no sqlite3
// executable.
func writeOpenCode(dir string) (string, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	path := filepath.Join(dir, "opencode.db")
	// Re-running the fixture writer over an existing root must not fail on
	// the table it created last time.
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		return "", err
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return "", err
	}
	defer db.Close()
	if _, err := db.Exec(`CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT)`); err != nil {
		return "", err
	}
	data := `{"role":"assistant","modelID":"gpt-4o",` +
		`"tokens":{"input":1000,"output":10,"reasoning":0,"cache":{"read":0,"write":0}},` +
		`"cost":0.01,"time":{"created":1785528000000,"completed":1785528060000}}`
	if _, err := db.Exec(`INSERT INTO message VALUES ('m1', 'ses_a', 1785528000000, ?)`, data); err != nil {
		return "", err
	}
	return path, nil
}

// writeClaude mirrors the Claude Code fixture: assistant entries carrying the
// message.usage block ccusage aggregates, under the projects directory the
// provider and ccusage both read.
func writeClaude(home string) (string, error) {
	entry := func(uuid, parent, model string, input, cacheCreate, cacheRead, output int64) map[string]any {
		return map[string]any{
			"parentUuid":  parent,
			"isSidechain": false,
			"userType":    "external",
			"cwd":         "/work",
			"sessionId":   "s1",
			"version":     "2.1.0",
			"type":        "assistant",
			"uuid":        uuid,
			"timestamp":   "2026-07-31T20:00:00.000Z",
			"message": map[string]any{
				"id": "msg_" + uuid, "type": "message", "role": "assistant", "model": model,
				"usage": map[string]any{
					"input_tokens":                input,
					"cache_creation_input_tokens": cacheCreate,
					"cache_read_input_tokens":     cacheRead,
					"output_tokens":               output,
				},
			},
		}
	}
	return home, writeJSONL(filepath.Join(home, "projects", "enc-proj", "session-1.jsonl"), []any{
		entry("a1", "u1", "claude-sonnet-5", 1000, 200, 3000, 50),
		entry("a2", "a1", "claude-sonnet-5", 10, 0, 500, 20),
	})
}

// writeCodex mirrors the Codex fixture: a session rollout whose token_count
// event carries the cumulative usage ccusage reads.
func writeCodex(home string) (string, error) {
	session := filepath.Join(home, "sessions", "2026", "07", "31", "rollout-2026-07-31T20-00-00-s1.jsonl")
	lines := []any{
		map[string]any{"timestamp": "2026-07-31T19:59:00.000Z", "type": "session_meta", "payload": map[string]any{
			"id": "s1", "timestamp": "2026-07-31T19:59:00.000Z", "cwd": "/work",
			"originator": "codex_cli_rs", "cli_version": "0.50.0",
		}},
		map[string]any{"timestamp": "2026-07-31T20:00:00.000Z", "type": "turn_context", "payload": map[string]any{"model": "gpt-6.1-sol"}},
		map[string]any{"timestamp": "2026-07-31T20:00:05.000Z", "type": "event_msg", "payload": map[string]any{
			"type": "token_count",
			"info": map[string]any{
				"total_token_usage": map[string]any{
					"input_tokens": 1000, "cached_input_tokens": 400,
					"output_tokens": 50, "reasoning_output_tokens": 10, "total_tokens": 1050,
				},
				"last_token_usage": map[string]any{
					"input_tokens": 1000, "cached_input_tokens": 400,
					"output_tokens": 50, "reasoning_output_tokens": 10, "total_tokens": 1050,
				},
			},
		}},
	}
	return home, writeJSONL(session, lines)
}
