package codex

// The Codex adapter's discovery layer, pinned against ccusage v20.0.33
// (commit 1308c416): rust/adapters/codex/src/paths.rs and
// rust/adapters/codex/src/reader.rs. Every assertion below names the rule it
// protects, because these rules decide which transcripts are read at all.

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func envMap(values map[string]string) func(string) (string, bool) {
	return func(key string) (string, bool) {
		value, ok := values[key]
		return value, ok
	}
}

// TestHomePathsSplitsEnvListAndKeepsZeroHomes pins codex_home_paths
// (paths.rs:236-247): CODEX_HOME is a comma list, whitespace-trimmed, empty
// entries dropped, and a set-but-empty value means zero homes rather than a
// fallback to ~/.codex. An unset variable falls back to <home>/.codex.
func TestHomePathsSplitsEnvListAndKeepsZeroHomes(t *testing.T) {
	home := func() (string, error) { return "/home/u", nil }

	got, err := HomePaths(envMap(map[string]string{"CODEX_HOME": " /a , ,/b "}), home)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0] != "/a" || got[1] != "/b" {
		t.Fatalf("HomePaths(split) = %v, want [/a /b]", got)
	}

	got, err = HomePaths(envMap(map[string]string{"CODEX_HOME": ""}), home)
	if err != nil {
		t.Fatalf("HomePaths(empty) returned an error: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("HomePaths(empty) = %v, want zero homes without fallback", got)
	}

	got, err = HomePaths(envMap(map[string]string{}), home)
	if err != nil {
		t.Fatal(err)
	}
	if want := filepath.Join("/home/u", ".codex"); len(got) != 1 || got[0] != want {
		t.Fatalf("HomePaths(unset) = %v, want [%s]", got, want)
	}

	if _, err := HomePaths(envMap(map[string]string{}), func() (string, error) {
		return "", os.ErrNotExist
	}); err == nil {
		t.Fatal("HomePaths(unset, no home) = nil error, want 'home directory is not set'")
	}
}

// TestUsageSourcesPrefersSessionsThenArchivedThenHome pins
// codex_usage_sources_from_homes (paths.rs:34-67): each home yields
// <home>/sessions before <home>/archived_sessions, a home with neither yields
// itself, and identical directory paths dedupe by literal path.
func TestUsageSourcesPrefersSessionsThenArchivedThenHome(t *testing.T) {
	root := t.TempDir()
	both := filepath.Join(root, "both")
	sessionsOnly := filepath.Join(root, "sessions-only")
	plain := filepath.Join(root, "plain")
	for _, dir := range []string{
		filepath.Join(both, "sessions"),
		filepath.Join(both, "archived_sessions"),
		filepath.Join(sessionsOnly, "sessions"),
	} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}

	sources := UsageSources([]string{both, plain, sessionsOnly, both})
	want := []Source{
		{Dir: filepath.Join(both, "sessions"), DedupeScope: both},
		{Dir: filepath.Join(both, "archived_sessions"), DedupeScope: both},
		{Dir: plain, DedupeScope: plain},
		{Dir: filepath.Join(sessionsOnly, "sessions"), DedupeScope: sessionsOnly},
	}
	if len(sources) != len(want) {
		t.Fatalf("UsageSources = %+v, want %+v", sources, want)
	}
	for i, source := range sources {
		if source != want[i] {
			t.Fatalf("UsageSources[%d] = %+v, want %+v", i, source, want[i])
		}
	}
}

// TestCollectFilesKeepsJsonlAndZstAndDropsSymlinks pins is_rollout_file
// (reader.rs:9-20) and collect_files_matching (common/src/lib.rs:26-46):
// *.jsonl and *.jsonl.zst are collected, other extensions are not, symlinked
// files and symlinked directories are skipped entirely, and the result is
// sorted by full path.
func TestCollectFilesKeepsJsonlAndZstAndDropsSymlinks(t *testing.T) {
	root := t.TempDir()
	write := func(rel string) string {
		path := filepath.Join(root, rel)
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte("{}\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		return path
	}
	write("a.jsonl")
	write("b.jsonl.zst")
	write("c.json")
	write("sub/d.jsonl")
	write("nested/deep/e.jsonl.zst")
	target := filepath.Join(root, "target.txt")
	if err := os.WriteFile(target, []byte("{}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, filepath.Join(root, "link.jsonl")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(root, "sub"), filepath.Join(root, "dirlink")); err != nil {
		t.Fatal(err)
	}

	got := CollectFiles(root)
	want := []string{
		filepath.Join(root, "a.jsonl"),
		filepath.Join(root, "b.jsonl.zst"),
		filepath.Join(root, "nested/deep/e.jsonl.zst"),
		filepath.Join(root, "sub/d.jsonl"),
	}
	if len(got) != len(want) {
		t.Fatalf("CollectFiles = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("CollectFiles[%d] = %s, want %s", i, got[i], want[i])
		}
	}
}

// TestCollectFilesPrefersPlainOverCompressed pins the uncompressed dedupe
// (paths.rs:88-95): when x.jsonl and x.jsonl.zst coexist, the plain copy wins
// because it sorts first.
func TestCollectFilesPrefersPlainOverCompressed(t *testing.T) {
	root := t.TempDir()
	for _, name := range []string{"x.jsonl", "x.jsonl.zst"} {
		if err := os.WriteFile(filepath.Join(root, name), []byte("{}\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	got := CollectFiles(root)
	if len(got) != 1 || got[0] != filepath.Join(root, "x.jsonl") {
		t.Fatalf("CollectFiles = %v, want only the plain copy", got)
	}
}

// TestCollectDedupedAcrossSourcesKeepsFirst pins codex_usage_file_key
// (paths.rs:228-234): the dedupe key is (dedupe scope, uncompressed relative
// path), and the first source to claim a key keeps it.
func TestCollectDedupedAcrossSourcesKeepsFirst(t *testing.T) {
	root := t.TempDir()
	first := filepath.Join(root, "first")
	second := filepath.Join(root, "second")
	for _, dir := range []string{first, second, filepath.Join(root, "shared")} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	for _, dir := range []string{first, second} {
		if err := os.WriteFile(filepath.Join(dir, "rollout.jsonl"), []byte("{}\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	sources := []Source{
		{Dir: first, DedupeScope: "scope"},
		{Dir: second, DedupeScope: "scope"},
	}
	groups := CollectDedupedSources(sources)
	if len(groups) != 2 {
		t.Fatalf("groups = %d, want 2", len(groups))
	}
	if len(groups[0].Files) != 1 || len(groups[1].Files) != 0 {
		t.Fatalf("first = %v, second = %v; the first source must claim the shared key",
			groups[0].Files, groups[1].Files)
	}

	shared := filepath.Join(root, "shared")
	if err := os.WriteFile(filepath.Join(shared, "rollout.jsonl"), []byte("{}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	groups = CollectDedupedSources([]Source{
		{Dir: first, DedupeScope: first},
		{Dir: shared, DedupeScope: shared},
	})
	if len(groups[0].Files) != 1 || len(groups[1].Files) != 1 {
		t.Fatalf("distinct scopes must not dedupe: %v / %v", groups[0].Files, groups[1].Files)
	}
}

func setMTime(t *testing.T, path string, at time.Time) {
	t.Helper()
	if err := os.Chtimes(path, at, at); err != nil {
		t.Fatal(err)
	}
}

// TestFilterKeepsFileWhenPathDateInRangeOrMtimeNewer pins CodexFileEligibility
// (paths.rs:117-218): a file survives when its path date is inside the window,
// or when its path date is outside but its mtime is at or after the since
// midnight; a file with no path date is never dropped by --since; --until
// never consults mtime.
func TestFilterKeepsFileWhenPathDateInRangeOrMtimeNewer(t *testing.T) {
	root := t.TempDir()
	fresh := time.Date(2026, 1, 20, 12, 0, 0, 0, time.UTC)
	old := time.Date(2025, 1, 1, 0, 0, 0, 0, time.UTC)
	files := map[string]time.Time{
		"2026/01/15/in-range.jsonl":      old,
		"2025/12/01/out-but-fresh.jsonl": fresh,
		"2025/12/01/out-and-old.jsonl":   old,
		"misc/no-path-date.jsonl":        old,
		"2026/02/01/until-edge.jsonl":    old,
		"2026/02/02/past-until.jsonl":    fresh,
	}
	for rel, at := range files {
		path := filepath.Join(root, rel)
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte("{}\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		setMTime(t, path, at)
	}

	ordered := []string{
		"2025/12/01/out-and-old.jsonl",
		"2025/12/01/out-but-fresh.jsonl",
		"2026/01/15/in-range.jsonl",
		"2026/02/01/until-edge.jsonl",
		"2026/02/02/past-until.jsonl",
		"misc/no-path-date.jsonl",
	}
	paths := make([]string, 0, len(ordered))
	for _, rel := range ordered {
		paths = append(paths, filepath.Join(root, rel))
	}

	got := FilterByEligibility(root, paths, "20260101", "20260201", "Asia/Shanghai")
	want := []string{
		filepath.Join(root, "2025/12/01/out-but-fresh.jsonl"),
		filepath.Join(root, "2026/01/15/in-range.jsonl"),
		filepath.Join(root, "2026/02/01/until-edge.jsonl"),
		filepath.Join(root, "misc/no-path-date.jsonl"),
	}
	if len(got) != len(want) {
		t.Fatalf("FilterByEligibility = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("FilterByEligibility[%d] = %s, want %s", i, got[i], want[i])
		}
	}
}

// TestUntilPathDateIsUtcDateOfNextLocalMidnight pins utc_path_date
// (paths.rs:178-182): the until bound converts "until+1 day at local midnight"
// to its UTC date, which for a +08 zone is the until date itself and for a
// UTC-5 zone is until+1. The brief's single-direction example had the sign
// backwards; see the ledger ruling.
func TestUntilPathDateIsUtcDateOfNextLocalMidnight(t *testing.T) {
	root := t.TempDir()
	make := func(rel string) string {
		path := filepath.Join(root, rel)
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte("{}\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		return path
	}
	d1 := make("2026/01/01/on-until.jsonl")
	d2 := make("2026/01/02/day-after.jsonl")
	d3 := make("2026/01/03/two-after.jsonl")

	got := FilterByEligibility(root, []string{d1, d2, d3}, "", "20260101", "Asia/Shanghai")
	if len(got) != 1 || got[0] != d1 {
		t.Fatalf("+08: until 20260101 should keep only the until-dated file, got %v", got)
	}

	got = FilterByEligibility(root, []string{d1, d2, d3}, "", "20260101", "Etc/GMT+5")
	if len(got) != 2 || got[0] != d1 || got[1] != d2 {
		t.Fatalf("UTC-5: until 20260101 should keep through the next day, got %v", got)
	}
}

// TestSessionIDStripsCompressionAndExtensions pins codex_session_id
// (parser.rs:892-904): the relative path loses .zst then .jsonl, components
// join with "/", and an empty result becomes "unknown".
func TestSessionIDStripsCompressionAndExtensions(t *testing.T) {
	root := t.TempDir()
	cases := map[string]string{
		"2026/01/05/rollout-abc.jsonl":     "2026/01/05/rollout-abc",
		"2026/01/05/rollout-abc.jsonl.zst": "2026/01/05/rollout-abc",
		"rollout.jsonl":                    "rollout",
	}
	for rel, want := range cases {
		if got := SessionID(root, filepath.Join(root, rel)); got != want {
			t.Fatalf("SessionID(%s) = %q, want %q", rel, got, want)
		}
	}
	if got := SessionID(root, root+string(filepath.Separator)); got != "unknown" {
		t.Fatalf("SessionID(empty relative) = %q, want unknown", got)
	}
}

// TestResolveHomeDirOrder pins home_dir (home.rs:3-32): HOME first, then
// USERPROFILE, then HOMEDRIVE+HOMEPATH; empty values are skipped and no
// candidate is a hard error.
func TestResolveHomeDirOrder(t *testing.T) {
	cases := []struct {
		name string
		env  map[string]string
		want string
	}{
		{"home wins", map[string]string{"HOME": "/h", "USERPROFILE": "/u", "HOMEDRIVE": "C:", "HOMEPATH": "\\p"}, "/h"},
		{"profile second", map[string]string{"USERPROFILE": "/u", "HOMEDRIVE": "C:", "HOMEPATH": "\\p"}, "/u"},
		{"drive plus path", map[string]string{"HOMEDRIVE": "C:", "HOMEPATH": "\\p"}, "C:\\p"},
		{"empty skipped", map[string]string{"HOME": " ", "USERPROFILE": "/u"}, "/u"},
	}
	for _, tc := range cases {
		got, err := ResolveHomeDir(envMap(tc.env))
		if err != nil || got != tc.want {
			t.Fatalf("%s: ResolveHomeDir = (%q, %v), want %q", tc.name, got, err, tc.want)
		}
	}
	if _, err := ResolveHomeDir(envMap(map[string]string{"HOME": ""})); err == nil {
		t.Fatal("ResolveHomeDir(no candidates) = nil error, want failure")
	}
}
