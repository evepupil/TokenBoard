package copilot

// This file ports CandidateSets and should_emit_candidate
// (parser.rs:494-621), the suppression matrix applied to every candidate of one
// exporter file.

// CandidateSets is CandidateSets (parser.rs:494-522). Every set is built from
// all candidates of the file, survivors or not, so suppression never depends on
// what was emitted before.
type CandidateSets struct {
	ChatTraces       map[string]bool
	InferenceTraces  map[string]bool
	AgentTurnTraces  map[string]bool
	ChatResponseIDs  map[string]bool
	InferenceRespIDs map[string]bool
	AgentTurnRespIDs map[string]bool
	RepeatedChat     map[int]bool
}

// newCandidateSets is CandidateSets::new (parser.rs:505-521).
func newCandidateSets(candidates []candidate) *CandidateSets {
	return &CandidateSets{
		RepeatedChat:     repeatedChatSpans(candidates),
		ChatTraces:       sourceTraceIDs(candidates, chatSpan),
		InferenceTraces:  sourceTraceIDs(candidates, inferenceLog),
		AgentTurnTraces:  sourceTraceIDs(candidates, agentTurnLog),
		ChatResponseIDs:  sourceResponseIDs(candidates, chatSpan),
		InferenceRespIDs: sourceResponseIDs(candidates, inferenceLog),
		AgentTurnRespIDs: sourceResponseIDs(candidates, agentTurnLog),
	}
}

// sourceTraceIDs is source_trace_ids (parser.rs:524-533).
func sourceTraceIDs(candidates []candidate, source otelUsageSource) map[string]bool {
	out := map[string]bool{}
	for _, cand := range candidates {
		if cand.source == source && cand.hasTrace {
			out[cand.traceID] = true
		}
	}
	return out
}

// sourceResponseIDs is source_response_ids (parser.rs:535-544).
func sourceResponseIDs(candidates []candidate, source otelUsageSource) map[string]bool {
	out := map[string]bool{}
	for _, cand := range candidates {
		if cand.source == source && cand.hasResponse {
			out[cand.responseID] = true
		}
	}
	return out
}

// repeatedChatCall is the identity key of repeated_chat_spans (parser.rs:560-569):
// the response id and the eight usage facets. It is compared only among chat
// spans, so the source is not part of it.
type repeatedChatCall struct {
	responseID  string
	model       string
	input       uint64
	output      uint64
	cacheCreate uint64
	cacheRead   uint64
	reasoning   uint64
	extra       uint64
}

// repeatedChatSpans is repeated_chat_spans (parser.rs:546-582): the Copilot CLI
// exports some chat calls a second time under a new trace or span id; the copy
// is recognised by its response id and usage, and the earliest copy is kept.
// One response id with different usage (VS Code reports the turn's id on every
// call) stays several calls.
func repeatedChatSpans(candidates []candidate) map[int]bool {
	earliest := map[repeatedChatCall]int{}
	repeated := map[int]bool{}
	for index, cand := range candidates {
		if cand.source != chatSpan || !cand.hasResponse {
			continue
		}
		call := repeatedChatCall{cand.responseID, cand.model, cand.input, cand.output,
			cand.cacheCreate, cand.cacheRead, cand.reasoning, cand.extra}
		kept, present := earliest[call]
		if !present {
			earliest[call] = index
			continue
		}
		if cand.timestamp < candidates[kept].timestamp {
			repeated[kept] = true
			earliest[call] = index
			continue
		}
		repeated[index] = true
	}
	return repeated
}

// shouldEmitCandidate is should_emit_candidate (parser.rs:584-621).
func shouldEmitCandidate(index int, cand candidate, sets *CandidateSets) bool {
	traceMatch := func(values map[string]bool) bool { return cand.hasTrace && values[cand.traceID] }
	responseMatch := func(values map[string]bool) bool { return cand.hasResponse && values[cand.responseID] }
	switch cand.source {
	case chatSpan:
		return !sets.RepeatedChat[index]
	case inferenceLog:
		return !traceMatch(sets.ChatTraces) && !responseMatch(sets.ChatResponseIDs)
	case agentTurnLog:
		return !traceMatch(sets.ChatTraces) && !traceMatch(sets.InferenceTraces) &&
			!responseMatch(sets.ChatResponseIDs) && !responseMatch(sets.InferenceRespIDs)
	default:
		return !traceMatch(sets.ChatTraces) && !traceMatch(sets.InferenceTraces) &&
			!traceMatch(sets.AgentTurnTraces) && !responseMatch(sets.ChatResponseIDs) &&
			!responseMatch(sets.InferenceRespIDs) && !responseMatch(sets.AgentTurnRespIDs)
	}
}
