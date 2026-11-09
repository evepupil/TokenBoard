// Package copilot is the in-process replacement for `ccusage copilot
// daily|session --json`. It reads the GitHub Copilot CLI's session-state
// snapshots (~/.copilot/session-state/<id>/events.jsonl) and OpenTelemetry
// file exports (~/.copilot/otel/**/*.jsonl), reconciles the two sources the way
// the Copilot client needs them reconciled, and produces the same report rows
// ccusage prints.
//
// The rules are ports of ccusage v20.0.33 (commit 1308c416):
// rust/adapters/copilot/src/{paths,parser,loader,report}.rs. Every function
// names the Rust function it mirrors.
package copilot

import (
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/MisonL/TokenBoard/clients/go/internal/collect/adapters/tools"
)

// SourceKind is CopilotSourceKind (paths.rs:10-13).
type SourceKind int

const (
	// KindOtel is one OpenTelemetry file-export JSONL file.
	KindOtel SourceKind = iota
	// KindSessionState is one session's events.jsonl snapshot log.
	KindSessionState
)

// SourceFile is CopilotSourceFile (paths.rs:15-19): the kind a file is read as.
// A file's kind decides its parser, so the first registration wins.
type SourceFile struct {
	Kind SourceKind
	Path string
}

// SourcePaths is paths() (paths.rs:23-54): every Copilot data file, with
// COPILOT_HOME's trees first and the explicit OTel exporter path last, deduped
// by path (first kind kept) and sorted by path.
func SourcePaths(o tools.Options) ([]SourceFile, error) {
	files := []SourceFile{}
	seen := map[string]bool{}
	add := func(kind SourceKind, path string) {
		if seen[path] {
			return
		}
		seen[path] = true
		files = append(files, SourceFile{Kind: kind, Path: path})
	}
	root, ok, err := copilotRoot(o)
	if err != nil {
		return nil, err
	}
	if ok {
		otelDir := filepath.Join(root, "otel")
		if tools.IsDirectory(otelDir) {
			for _, path := range tools.CollectFiles(otelDir, func(name string) bool {
				return strings.HasSuffix(name, ".jsonl")
			}) {
				add(KindOtel, path)
			}
		}
		// Only <session-state>/<dir>/events.jsonl counts: the session id is the
		// parent directory name, and deeper layouts belong to nested tooling.
		if entries, err := os.ReadDir(filepath.Join(root, "session-state")); err == nil {
			// Sorted: os.ReadDir's order is a filesystem order, and the merge
			// downstream (the tie order of equal-timestamp snapshots) depends
			// on it.
			sort.Slice(entries, func(i, j int) bool { return entries[i].Name() < entries[j].Name() })
			for _, entry := range entries {
				if !entry.IsDir() {
					continue
				}
				path := filepath.Join(root, "session-state", entry.Name(), "events.jsonl")
				if info, err := os.Stat(path); err == nil && info.Mode().IsRegular() {
					add(KindSessionState, path)
				}
			}
		}
	}
	if path, ok := exporterPath(o); ok {
		add(KindOtel, path)
	}
	sort.SliceStable(files, func(i, j int) bool { return files[i].Path < files[j].Path })
	return files, nil
}

// copilotRoot is copilot_root (paths.rs:56-64): a trimmed, non-empty
// COPILOT_HOME, otherwise ~/.copilot. A set-but-empty COPILOT_HOME falls back
// to the home directory, unlike the comma-list roots of the other tools.
func copilotRoot(o tools.Options) (string, bool, error) {
	if value, ok := o.EnvLookup()("COPILOT_HOME"); ok {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			return trimmed, true, nil
		}
	}
	home, err := o.Home()
	if err != nil {
		return "", false, nil
	}
	return filepath.Join(home, ".copilot"), true, nil
}

// exporterPath is copilot_exporter_path (paths.rs:70-79): a trimmed
// COPILOT_OTEL_FILE_EXPORTER_PATH naming an existing regular file.
func exporterPath(o tools.Options) (string, bool) {
	value, ok := o.EnvLookup()("COPILOT_OTEL_FILE_EXPORTER_PATH")
	if !ok {
		return "", false
	}
	path := strings.TrimSpace(value)
	if path == "" {
		return "", false
	}
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() {
		return "", false
	}
	return path, true
}
