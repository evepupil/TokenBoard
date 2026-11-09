package tools

import (
	"os"
	"path/filepath"
	"sort"
)

// CollectFiles is collect_files_matching (adapters/common/src/lib.rs:18-46): a
// recursive walk under root that keeps regular files whose base name satisfies
// accept, returns them as full paths sorted by byte order, and never follows a
// symlink. A missing or unreadable root yields nil: the tool is simply not
// installed.
//
// The Rust walk is unbounded; this one carries explicit ceilings for the same
// reason sessionwalk does (the tree belongs to another program), sized far
// above any real tool layout so they never change a normal result.
const (
	maxWalkDepth   = 16
	maxWalkEntries = 100_000
)

// IsDirectory reports whether path names a directory (the keep predicate the
// Rust adapters give collect_files_with_extension callers resolving roots).
func IsDirectory(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.IsDir()
}

func CollectFiles(root string, accept func(name string) bool) []string {
	info, err := os.Stat(root)
	if err != nil || !info.IsDir() {
		return nil
	}
	files := []string{}
	walk(root, 0, accept, &files)
	sort.Strings(files)
	return files
}

func walk(dir string, depth int, accept func(string) bool, files *[]string) {
	if depth > maxWalkDepth {
		return
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	if len(entries) > maxWalkEntries {
		entries = entries[:maxWalkEntries]
	}
	for _, entry := range entries {
		path := filepath.Join(dir, entry.Name())
		switch {
		case entry.IsDir():
			walk(path, depth+1, accept, files)
		case entry.Type().IsRegular() && accept(entry.Name()):
			*files = append(*files, path)
		}
	}
}
