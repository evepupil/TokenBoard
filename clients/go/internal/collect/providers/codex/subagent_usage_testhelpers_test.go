package codex

// Shared fixtures for the Codex subagent usage correction tests. The shapes
// mirror codex-subagent-usage-test-helpers.ts; names are prefixed with
// `subagent` because this package already declares several generic test
// helpers (writeJSONL, sessionMeta, tokenCount, childUsageEvent, ...).

import (
	"testing"

	"github.com/MisonL/TokenBoard/clients/go/internal/contract"
)

// subagentTokens builds a Codex token usage object. total 0 means "omit the
// explicit total", which is the TS helper's `totalTokens ?? input + output`.
func subagentTokens(inputTokens, cacheReadTokens, outputTokens float64) map[string]any {
	return map[string]any{
		"input_tokens":        inputTokens,
		"cached_input_tokens": cacheReadTokens,
		"output_tokens":       outputTokens,
		"total_tokens":        inputTokens + outputTokens,
	}
}

// subagentTokensWithTotal builds a token object with an explicit total.
func subagentTokensWithTotal(inputTokens, cacheReadTokens, outputTokens, totalTokens float64) map[string]any {
	return map[string]any{
		"input_tokens":        inputTokens,
		"cached_input_tokens": cacheReadTokens,
		"output_tokens":       outputTokens,
		"total_tokens":        totalTokens,
	}
}

// subagentSessionMeta is a plain session_meta row (no subagent metadata).
func subagentSessionMeta(id, timestamp string) map[string]any {
	return map[string]any{
		"type":      "session_meta",
		"timestamp": timestamp,
		"payload": map[string]any{
			"id":        id,
			"timestamp": timestamp,
		},
	}
}

// subagentChildSessionMeta is a session_meta row carrying the subagent
// envelope. An empty parentThreadID omits the thread_spawn parent, which newer
// Codex versions do.
func subagentChildSessionMeta(id, parentThreadID, timestamp string) map[string]any {
	subagent := map[string]any{}
	if parentThreadID != "" {
		subagent["thread_spawn"] = map[string]any{"parent_thread_id": parentThreadID}
	} else {
		subagent["thread_spawn"] = map[string]any{}
	}
	return map[string]any{
		"type":      "session_meta",
		"timestamp": timestamp,
		"payload": map[string]any{
			"id":        id,
			"timestamp": timestamp,
			"source":    map[string]any{"subagent": subagent},
		},
	}
}

// subagentUsageEvent builds one token_count event whose cumulative and
// per-request counters are the same.
func subagentUsageEvent(timestamp string, usage map[string]any, model string) map[string]any {
	return subagentUsageEventWithLast(timestamp, usage, usage, model)
}

// subagentUsageEventWithLast builds one token_count event with distinct
// cumulative and per-request counters.
func subagentUsageEventWithLast(timestamp string, usage, lastUsage map[string]any, model string) map[string]any {
	if model == "" {
		model = "gpt-5"
	}
	return map[string]any{
		"type":      "event_msg",
		"timestamp": timestamp,
		"payload": map[string]any{
			"type": "token_count",
			"info": map[string]any{
				"model":             model,
				"total_token_usage": usage,
				"last_token_usage":  lastUsage,
			},
		},
	}
}

// subagentCumulativeOnlyEvent builds a token_count event that reports only the
// cumulative counter (the child's inherited baseline).
func subagentCumulativeOnlyEvent(timestamp string, usage map[string]any, model string) map[string]any {
	if model == "" {
		model = "gpt-5"
	}
	return map[string]any{
		"type":      "event_msg",
		"timestamp": timestamp,
		"payload": map[string]any{
			"type": "token_count",
			"info": map[string]any{
				"model":             model,
				"total_token_usage": usage,
			},
		},
	}
}

func subagentCodexSnapshot() contract.Snapshot {
	return contract.Snapshot{
		Source:        contract.SourceCodex,
		UsageDate:     "2026-05-25",
		Timezone:      "Asia/Shanghai",
		Model:         "gpt-5",
		InputTokens:   1100,
		OutputTokens:  120,
		CacheCreation: 0,
		CacheRead:     1950,
		TotalTokens:   3170,
		CostUSD:       3.17,
		SessionCount:  1,
		CollectedAt:   "2026-05-25T01:20:00.000Z",
	}
}

func subagentInheritedSessionResult() map[string]any {
	return map[string]any{
		"sessions": []any{
			map[string]any{
				"sessionId":    "2026/05/25/rollout-child-thread",
				"lastActivity": "2026-05-25T01:10:00.000Z",
				"totalTokens":  float64(3170),
				"costUSD":      float64(3.17),
				"models": map[string]any{
					"gpt-5": map[string]any{
						"inputTokens":       float64(1100),
						"cachedInputTokens": float64(1950),
						"outputTokens":      float64(120),
						"totalTokens":       float64(3170),
						"costUSD":           float64(3.17),
					},
				},
			},
		},
	}
}

func subagentIndependentSessionResult() map[string]any {
	return map[string]any{
		"sessions": []any{
			map[string]any{
				"sessionId":    "2026/05/25/rollout-child-thread",
				"lastActivity": "2026-05-25T01:10:00.000Z",
				"totalTokens":  float64(220),
				"costUSD":      float64(0.22),
				"models": map[string]any{
					"gpt-5": map[string]any{
						"inputTokens":       float64(50),
						"cachedInputTokens": float64(150),
						"outputTokens":      float64(20),
						"totalTokens":       float64(220),
						"costUSD":           float64(0.22),
					},
				},
			},
		},
	}
}

func subagentMergedProfileSessionResult() map[string]any {
	return map[string]any{
		"sessions": []any{
			map[string]any{
				"sessionId":    "2026/05/25/rollout-child-thread",
				"lastActivity": "2026-05-25T01:20:00.000Z",
				"totalTokens":  float64(6340),
				"costUSD":      float64(6.34),
				"models": map[string]any{
					"gpt-5": map[string]any{
						"inputTokens":       float64(2200),
						"cachedInputTokens": float64(3900),
						"outputTokens":      float64(240),
						"totalTokens":       float64(6340),
						"costUSD":           float64(6.34),
					},
				},
			},
		},
	}
}

func subagentMultiDaySessionResult() map[string]any {
	return map[string]any{
		"sessions": []any{
			map[string]any{
				"sessionId":    "2026/05/26/rollout-child-thread",
				"lastActivity": "2026-05-26T00:10:00.000Z",
				"totalTokens":  float64(6340),
				"costUSD":      float64(6.34),
				"models": map[string]any{
					"gpt-5": map[string]any{
						"inputTokens":       float64(2200),
						"cachedInputTokens": float64(3900),
						"outputTokens":      float64(240),
						"totalTokens":       float64(6340),
						"costUSD":           float64(6.34),
					},
				},
			},
		},
	}
}

func subagentInheritedMultiModelSessionResult() map[string]any {
	return map[string]any{
		"sessions": []any{
			map[string]any{
				"sessionId":    "2026/05/25/rollout-child-thread",
				"lastActivity": "2026-05-25T01:10:00.000Z",
				"totalTokens":  float64(3170),
				"costUSD":      float64(3.17),
				"models": map[string]any{
					"gpt-5.4": map[string]any{
						"inputTokens":       float64(100),
						"cachedInputTokens": float64(300),
						"outputTokens":      float64(20),
						"totalTokens":       float64(420),
						"costUSD":           float64(0),
					},
					"gpt-5.5": map[string]any{
						"inputTokens":       float64(1000),
						"cachedInputTokens": float64(1650),
						"outputTokens":      float64(100),
						"totalTokens":       float64(2750),
						"costUSD":           float64(0),
					},
				},
			},
		},
	}
}

func subagentSkewedMultiModelSessionResult() map[string]any {
	return map[string]any{
		"sessions": []any{
			map[string]any{
				"sessionId":    "2026/05/25/rollout-child-thread",
				"lastActivity": "2026-05-25T01:10:00.000Z",
				"totalTokens":  float64(2112),
				"costUSD":      float64(2.112),
				"models": map[string]any{
					"gpt-5.4": map[string]any{
						"inputTokens":       float64(10),
						"cachedInputTokens": float64(1),
						"outputTokens":      float64(1),
						"totalTokens":       float64(12),
						"costUSD":           float64(0),
					},
					"gpt-5.5": map[string]any{
						"inputTokens":       float64(1000),
						"cachedInputTokens": float64(1000),
						"outputTokens":      float64(100),
						"totalTokens":       float64(2100),
						"costUSD":           float64(0),
					},
				},
			},
		},
	}
}

// subagentWriteInheritedChildSession writes a child session with the parent's
// copied history as a cumulative-only baseline plus one charged request.
func subagentWriteInheritedChildSession(t *testing.T, filePath string) {
	t.Helper()
	writeJSONL(t, filePath, []map[string]any{
		subagentChildSessionMeta("child-thread", "parent-thread", "2026-05-25T01:00:00.000Z"),
		subagentCumulativeOnlyEvent(
			"2026-05-25T01:00:00.000Z",
			subagentTokensWithTotal(1000, 900, 50, 1050),
			"",
		),
		subagentUsageEventWithLast(
			"2026-05-25T01:10:00.000Z",
			subagentTokensWithTotal(1200, 1050, 70, 1270),
			subagentTokensWithTotal(200, 150, 20, 220),
			"",
		),
	})
}

// subagentWriteCachedChildSession writes a child session whose only charged
// request is 200/150/20 (220 total).
func subagentWriteCachedChildSession(t *testing.T, filePath, id string) {
	t.Helper()
	writeJSONL(t, filePath, []map[string]any{
		subagentChildSessionMeta(id, "parent-thread", "2026-05-25T01:00:00.000Z"),
		subagentUsageEventWithLast(
			"2026-05-25T01:10:00.000Z",
			subagentTokensWithTotal(1200, 1050, 70, 1270),
			subagentTokensWithTotal(200, 150, 20, 220),
			"",
		),
	})
}
