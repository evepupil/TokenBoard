package codex

// The fork replay plan of ccusage's Codex adapter, ported from v20.0.33
// (commit 1308c416): rust/adapters/codex/src/replay.rs. A forked Codex session
// starts by copying its parent's usage events; counting them again would bill
// the same tokens twice, so this plan reconstructs the prefix the child
// replayed and the compaction identities it copied from the parent.
//
// The Rust version parallelizes metadata probing and parent parsing across
// threads; this port reads them in order. The results are identical - the
// bucket order is the file discovery order either way - and the parallelism can
// be added where a profile shows it matters.

import (
	"bufio"
	"encoding/json"
	"errors"
	"io"
	"unicode/utf8"
)

// compactionStamp is one entry of the parent's compaction map
// (replay.rs:342-347): the parsed timestamp of the usage record a marker
// claimed. ok is false when the record's timestamp did not parse, which counts
// as "before the fork" for is_replayed_compaction.
type compactionStamp struct {
	millis int64
	ok     bool
}

// parentReplay is ParentReplay (replay.rs:361-366).
type parentReplay struct {
	// hasPath is false when the referenced parent log is not part of the
	// scanned files.
	path      string
	hasPath   bool
	forkedAt  int64
	hasForked bool
}

// parentUsage is ParentUsage (replay.rs:340-345): the parent's non-compaction
// events in order plus the compaction identities it recorded.
type parentUsage struct {
	timestamps   []int64
	hasTimestamp []bool
	usage        []RawUsage
	compactions  map[string]compactionStamp
}

// ReplayPlan is CodexReplayPlan (replay.rs:64-67).
type ReplayPlan struct {
	parentByChild map[string]parentReplay
	usageByParent map[string]*parentUsage
}

type replayFile struct {
	path        string
	sessionsDir string
}

// NewReplayPlan is CodexReplayPlan::new (replay.rs:70-93): every file is both a
// potential child and a potential parent.
func NewReplayPlan(groups []FileGroup) *ReplayPlan {
	files := collectReplayFiles(groups)
	return buildReplayPlan(files, files)
}

// NewBoundedReplayPlan is CodexReplayPlan::for_bounded_files (replay.rs:95-135):
// children are the date-filtered files, while available is the unfiltered set
// used to index session ids and read parent logs that pruning removed.
func NewBoundedReplayPlan(children, available []FileGroup) *ReplayPlan {
	return buildReplayPlan(collectReplayFiles(children), collectReplayFiles(available))
}

func collectReplayFiles(groups []FileGroup) []replayFile {
	files := []replayFile{}
	for _, group := range groups {
		for _, path := range group.Files {
			files = append(files, replayFile{path: path, sessionsDir: group.Dir})
		}
	}
	return files
}

func buildReplayPlan(children, available []replayFile) *ReplayPlan {
	availableMetadata := make([]sessionMetadata, len(available))
	for i, file := range available {
		availableMetadata[i] = readSessionMetadata(file.path)
	}
	metadataByPath := make(map[string]sessionMetadata, len(available))
	for i, file := range available {
		if _, seen := metadataByPath[file.path]; !seen {
			metadataByPath[file.path] = availableMetadata[i]
		}
	}
	filesBySessionID := make(map[string][]string, len(available))
	for i, file := range available {
		if availableMetadata[i].hasSessionID {
			filesBySessionID[availableMetadata[i].sessionID] = append(filesBySessionID[availableMetadata[i].sessionID], file.path)
		}
	}

	parentByChild := make(map[string]parentReplay, len(children))
	for _, child := range children {
		metadata, known := metadataByPath[child.path]
		if !known {
			metadata = readSessionMetadata(child.path)
		}
		if !metadata.hasParentID {
			continue
		}
		parentID := metadata.parentID
		parent := parentReplay{forkedAt: metadata.timestamp, hasForked: metadata.hasTimestamp}
		for _, candidate := range filesBySessionID[parentID] {
			if candidate != child.path {
				parent.path, parent.hasPath = candidate, true
				break
			}
		}
		parentByChild[child.path] = parent
	}

	parentPaths := make(map[string]struct{}, len(parentByChild))
	for _, parent := range parentByChild {
		if parent.hasPath {
			parentPaths[parent.path] = struct{}{}
		}
	}
	usageByParent := make(map[string]*parentUsage, len(parentPaths))
	for _, file := range available {
		if _, isParent := parentPaths[file.path]; !isParent {
			continue
		}
		if _, done := usageByParent[file.path]; done {
			continue
		}
		usageByParent[file.path] = readParentUsage(file.sessionsDir, file.path)
	}

	return &ReplayPlan{parentByChild: parentByChild, usageByParent: usageByParent}
}

// Prefix is replay_prefix (replay.rs:159-178): the usage history child
// replayed from its parent.
//
// nil means the child is not a fork. A fork whose parent log is unavailable
// returns an empty, non-nil slice, which tells the parser to fall back to the
// rewritten-burst heuristic. Usage the parent recorded after the fork was never
// replayed, so the prefix stops at the first parent event strictly after
// forked_at.
func (p *ReplayPlan) Prefix(child string) []RawUsage {
	parent, ok := p.parentByChild[child]
	if !ok {
		return nil
	}
	stream, ok := p.usageByParent[parent.path]
	if !parent.hasPath || !ok {
		return []RawUsage{}
	}
	length := len(stream.usage)
	if parent.hasForked {
		for i, timestamp := range stream.timestamps {
			if stream.hasTimestamp[i] && timestamp > parent.forkedAt {
				length = i
				break
			}
		}
	}
	return stream.usage[:length]
}

// IsReplayedCompaction is is_replayed_compaction (replay.rs:182-200): whether a
// compaction request child recorded was copied from its parent - recognized
// even when date filtering excluded the parent from the report. Requests after
// the fork stay countable.
func (p *ReplayPlan) IsReplayedCompaction(child, responseID string) bool {
	if responseID == "" {
		return false
	}
	parent, ok := p.parentByChild[child]
	if !ok || !parent.hasPath {
		return false
	}
	stream, ok := p.usageByParent[parent.path]
	if !ok {
		return false
	}
	stamp, recorded := stream.compactions[responseID]
	if !recorded {
		return false
	}
	if !parent.hasForked || !stamp.ok {
		return true
	}
	return stamp.millis <= parent.forkedAt
}

// readParentUsage is read_usage_events (replay.rs:355-385): the parent's
// non-compaction events in order, plus the compaction identities the parser
// collected.
func readParentUsage(sessionsDir, path string) *parentUsage {
	stream := &parentUsage{compactions: map[string]compactionStamp{}}
	_ = parseFile(sessionsDir, path, nil, stream.compactions, func(event Event) error {
		// Response ids deduplicate compactions independently of this normal
		// token-count prefix, including when a fork omits compaction records.
		if event.ResponseID != "" {
			return nil
		}
		millis, ok := ParseTimestamp(event.Timestamp)
		stream.timestamps = append(stream.timestamps, millis)
		stream.hasTimestamp = append(stream.hasTimestamp, ok)
		stream.usage = append(stream.usage, event.RawUsage)
		return nil
	})
	return stream
}

// sessionMetadata is CodexSessionMetadata (replay.rs:388-394).
type sessionMetadata struct {
	sessionID    string
	hasSessionID bool
	parentID     string
	hasParentID  bool
	timestamp    int64
	hasTimestamp bool
}

// readSessionMetadata is read_codex_session_metadata (replay.rs:396-430): the
// first line of the log, and only that line, decides whether it is a fork of
// which session and when it forked.
func readSessionMetadata(path string) sessionMetadata {
	reader, _, err := OpenRollout(path)
	if err != nil {
		return sessionMetadata{}
	}
	defer reader.Close()
	buffered, ok := reader.(interface{ buffered() *bufio.Reader })
	if !ok {
		return sessionMetadata{}
	}
	line, err := buffered.buffered().ReadBytes('\n')
	if err != nil && !errors.Is(err, io.EOF) {
		return sessionMetadata{}
	}
	if len(line) == 0 || !utf8.Valid(line) {
		// serde_json::from_str requires valid UTF-8; ReadString would have
		// failed on the same input.
		return sessionMetadata{}
	}
	var root map[string]json.RawMessage
	if err := json.Unmarshal(line, &root); err != nil || root == nil {
		return sessionMetadata{}
	}
	object := newValue(root)
	metadata := sessionMetadata{}
	if timestamp, state := object.timestamp("timestamp"); state == timestampValid {
		metadata.timestamp, metadata.hasTimestamp = timestampMillis(timestamp)
	}
	if entryType, _ := object.stringField("type"); entryType != "session_meta" {
		return metadata
	}
	payload := object.object("payload")
	if payload.fields == nil {
		return metadata
	}
	metadata.sessionID, metadata.hasSessionID = payload.stringField("id")
	parentID, hasParent := payload.stringField("forked_from_id")
	if !hasParent || parentID == "" {
		parentID, hasParent = subagentParentID(payload)
	}
	if hasParent && parentID != "" {
		metadata.parentID, metadata.hasParentID = parentID, true
	}
	return metadata
}

// subagentParentID follows the JSON pointer
// /source/subagent/thread_spawn/parent_thread_id (replay.rs:298-306).
func subagentParentID(payload value) (string, bool) {
	source := payload.object("source")
	if source.fields == nil {
		return "", false
	}
	subagent := source.object("subagent")
	if subagent.fields == nil {
		return "", false
	}
	spawn := subagent.object("thread_spawn")
	if spawn.fields == nil {
		return "", false
	}
	return spawn.stringField("parent_thread_id")
}
