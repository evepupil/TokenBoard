package tools

import "strings"

// This file ports the path helpers the Rust tool adapters share. Each adapter
// owns its own defaults and env-var name; the shape of the resolution is the
// same (adapters/<tool>/src/paths.rs).

// SplitEnvList is the comma-separated list parse every adapter applies to its
// data-directory environment variable: split on `,`, trim each part, drop the
// empties (e.g. amp paths.rs:10-21).
func SplitEnvList(raw string) []string {
	parts := strings.Split(raw, ",")
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		trimmed := strings.TrimSpace(part)
		if trimmed != "" {
			out = append(out, trimmed)
		}
	}
	return out
}

// DedupePaths keeps the first occurrence of each path, preserving order. The
// Rust adapters dedupe candidate directories by literal path (no
// canonicalization) except goose, which canonicalizes before deduping.
func DedupePaths(paths []string) []string {
	seen := make(map[string]bool, len(paths))
	out := make([]string, 0, len(paths))
	for _, path := range paths {
		if !seen[path] {
			seen[path] = true
			out = append(out, path)
		}
	}
	return out
}
