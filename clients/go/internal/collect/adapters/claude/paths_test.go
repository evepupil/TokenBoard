package claude

// The discovery layer is the part of ccusage's Claude adapter that decides
// which files are read at all, so every expectation here is pinned against
// ccusage v20.0.33 (commit 1308c416): rust/adapters/claude/src/paths.rs,
// rust/adapters/common/src/lib.rs and rust/crates/ccusage-core/src/date_utils.rs.

import (
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"sort"
	"strings"
	"testing"
	"time"
)

// stubEnv is the env seam the resolver reads configuration through. A missing
// key reads as the empty string, exactly like os.Getenv.
func stubEnv(values map[string]string) func(string) string {
	return func(key string) string { return values[key] }
}

// homeEnv answers the home lookup whatever platform the suite runs on, so ~
// expansion and the fallback roots are exercised on darwin, linux and windows.
func homeEnv(home string, extra map[string]string) func(string) string {
	values := map[string]string{"HOME": home, "USERPROFILE": home}
	for key, value := range extra {
		values[key] = value
	}
	return stubEnv(values)
}

func mkdirAll(t *testing.T, path string) {
	t.Helper()
	if err := os.MkdirAll(path, 0o700); err != nil {
		t.Fatal(err)
	}
}

func writeFixture(t *testing.T, path, content string) {
	t.Helper()
	mkdirAll(t, filepath.Dir(path))
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}

func mustTime(t *testing.T, value string) time.Time {
	t.Helper()
	parsed, err := time.Parse(time.RFC3339, value)
	if err != nil {
		t.Fatal(err)
	}
	return parsed
}

func filePaths(files []SessionFile) []string {
	paths := make([]string, 0, len(files))
	for _, file := range files {
		paths = append(paths, file.Path)
	}
	return paths
}

// requirePaths compares a result against an expectation, treating "no entries"
// the same whether it arrives as nil or as an empty slice.
func requirePaths(t *testing.T, got, want []string) {
	t.Helper()
	if len(got) == 0 && len(want) == 0 {
		return
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("paths = %v, want %v", got, want)
	}
}

// deepNames are the directory names the deep fixture nests, 15 levels below
// projects/<project>/deep.
func deepNames() []string {
	names := make([]string, 0, 15)
	for level := 0; level < 15; level++ {
		names = append(names, fmt.Sprintf("l%02d", level))
	}
	return names
}

// sessionFile builds the SessionFile ScanFiles would produce for an existing
// path, with an explicit mtime so a prune decision never depends on the clock.
func sessionFile(t *testing.T, path string, modified time.Time) SessionFile {
	t.Helper()
	sessionID, projectPath := PathSessionParts(path)
	return SessionFile{
		Path:        path,
		SessionID:   sessionID,
		ProjectPath: projectPath,
		MTime:       modified,
		MTimeKnown:  true,
	}
}

func TestResolveRootsUsesConfigDirListAndRejectsAllInvalid(t *testing.T) {
	// CLAUDE_CONFIG_DIR is split on commas, each entry trimmed, ~ expanded and
	// a trailing "projects" segment replaced by its parent (paths.rs:26-43,
	// path_utils.rs:3-15, paths.rs:57-63).
	t.Run("normalizes every entry and drops the unusable ones", func(t *testing.T) {
		home := t.TempDir()
		alpha := filepath.Join(home, "alpha")
		beta := filepath.Join(home, "beta")
		gamma := filepath.Join(home, "gamma")
		tilde := filepath.Join(home, "tilde")
		for _, dir := range []string{alpha, gamma, tilde} {
			mkdirAll(t, filepath.Join(dir, "projects"))
		}
		// beta has no projects/ directory, so it is not a Claude config dir.
		mkdirAll(t, beta)

		env := homeEnv(home, map[string]string{
			// Spaces around entries, an empty piece, a trailing comma, a
			// duplicate and a path that ends in "projects" all appear.
			"CLAUDE_CONFIG_DIR": " " + alpha + " , " + beta + " ,~/tilde," +
				filepath.Join(gamma, "projects") + "," + alpha + " ",
		})

		roots, err := ResolveRoots(env, "")
		if err != nil {
			t.Fatal(err)
		}
		want := []string{alpha, tilde, gamma}
		requirePaths(t, roots.Dirs, want)
	})

	t.Run("fails closed when nothing in the list is a config dir", func(t *testing.T) {
		home := t.TempDir()
		beta := filepath.Join(home, "beta")
		mkdirAll(t, beta)
		// Both fallback directories are real: a set CLAUDE_CONFIG_DIR must
		// never fall back to them (paths.rs:37-42).
		mkdirAll(t, filepath.Join(home, ".claude", "projects"))
		mkdirAll(t, filepath.Join(home, ".config", "claude", "projects"))

		invalid := beta + ",/definitely/not/a/claude/config"
		env := homeEnv(home, map[string]string{"CLAUDE_CONFIG_DIR": invalid})

		roots, err := ResolveRoots(env, "")
		if err == nil {
			t.Fatalf("ResolveRoots = %v, want an error", roots.Dirs)
		}
		if len(roots.Dirs) != 0 {
			t.Fatalf("Dirs = %v, want none", roots.Dirs)
		}
		// The error names the variable and echoes the value it rejected.
		if !strings.Contains(err.Error(), "CLAUDE_CONFIG_DIR") || !strings.Contains(err.Error(), invalid) {
			t.Fatalf("error = %q, want it to name CLAUDE_CONFIG_DIR and %q", err, invalid)
		}
	})

	t.Run("treats an explicit home as a single config dir", func(t *testing.T) {
		// TokenBoard's provider resolves the Claude home itself (readClaudeHome)
		// and passes it here; a single directory is the CLAUDE_CONFIG_DIR
		// equivalent input, so the same normalization applies.
		home := t.TempDir()
		alpha := filepath.Join(home, "alpha")
		beta := filepath.Join(home, "beta")
		gamma := filepath.Join(home, "gamma")
		tilde := filepath.Join(home, "tilde")
		for _, dir := range []string{alpha, gamma, tilde} {
			mkdirAll(t, filepath.Join(dir, "projects"))
		}
		mkdirAll(t, beta)

		env := homeEnv(home, nil)
		for _, testCase := range []struct {
			name string
			home string
			want []string
		}{
			{"config dir", alpha, []string{alpha}},
			{"projects dir", filepath.Join(gamma, "projects"), []string{gamma}},
			{"tilde", "~/tilde", []string{tilde}},
			{"not installed", beta, []string{}},
			// A forwarded list is still split and validated, so a caller that
			// passes CLAUDE_CONFIG_DIR's raw value cannot smuggle "a,b" in as
			// one directory name.
			{"comma list", alpha + "," + filepath.Join(gamma, "projects") + ",~/tilde", []string{alpha, gamma, tilde}},
			// A missing home is "unavailable", never a hard error.
			{"comma list with nothing usable", beta + ",/nonexistent/claude", []string{}},
		} {
			t.Run(testCase.name, func(t *testing.T) {
				roots, err := ResolveRoots(env, testCase.home)
				if err != nil {
					t.Fatal(err)
				}
				requirePaths(t, roots.Dirs, testCase.want)
			})
		}
	})
}

// The home lookup is home_dir_from_env (ccusage-core/src/home.rs:12-31): HOME,
// then USERPROFILE, then HOMEDRIVE+HOMEPATH, in that order on every platform.
// Upstream's own tests assert HOME wins over a Windows-shaped USERPROFILE, so a
// shell that exports both (Git Bash, MSYS) must resolve the same root ccusage
// does or parity diffs on a Windows machine.
func TestLookupHomeMatchesCcusageHomeResolution(t *testing.T) {
	for _, testCase := range []struct {
		name   string
		values map[string]string
		want   string
	}{
		{"home wins over user profile", map[string]string{
			"HOME": "/home/user", "USERPROFILE": `C:\Users\runner`,
		}, "/home/user"},
		{"user profile without home", map[string]string{
			"HOME": "", "USERPROFILE": `C:\Users\runner`,
		}, `C:\Users\runner`},
		// OsString::push concatenates: "C:" + "\Users\runner".
		{"home drive and path", map[string]string{
			"HOMEDRIVE": "C:", "HOMEPATH": `\Users\runner`,
		}, `C:\Users\runner`},
		{"empty home drive", map[string]string{
			"HOMEDRIVE": "", "HOMEPATH": `\Users\runner`,
		}, ""},
		{"empty home path", map[string]string{
			"HOMEDRIVE": "C:", "HOMEPATH": "",
		}, ""},
		{"nothing set", map[string]string{}, ""},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			if got := lookupHome(stubEnv(testCase.values)); got != testCase.want {
				t.Fatalf("lookupHome = %q, want %q", got, testCase.want)
			}
		})
	}

	// End to end: with both variables pointing at real trees, the HOME tree is
	// the one that becomes a root.
	home := t.TempDir()
	homeClaude := filepath.Join(home, ".claude")
	mkdirAll(t, filepath.Join(homeClaude, "projects"))
	other := t.TempDir()
	mkdirAll(t, filepath.Join(other, ".claude", "projects"))

	roots, err := ResolveRoots(stubEnv(map[string]string{"HOME": home, "USERPROFILE": other}), "")
	if err != nil {
		t.Fatal(err)
	}
	requirePaths(t, roots.Dirs, []string{homeClaude})
}

func TestResolveRootsFallsBackToXdgAndHome(t *testing.T) {
	// With CLAUDE_CONFIG_DIR unset the candidates are $XDG_CONFIG_HOME/claude
	// and $HOME/.claude, each kept only when it holds a projects/ directory
	// (paths.rs:45-53).
	t.Run("keeps both candidates in order", func(t *testing.T) {
		home := t.TempDir()
		xdg := filepath.Join(home, "xdg")
		xdgClaude := filepath.Join(xdg, "claude")
		homeClaude := filepath.Join(home, ".claude")
		mkdirAll(t, filepath.Join(xdgClaude, "projects"))
		mkdirAll(t, filepath.Join(homeClaude, "projects"))

		roots, err := ResolveRoots(homeEnv(home, map[string]string{"XDG_CONFIG_HOME": xdg}), "")
		if err != nil {
			t.Fatal(err)
		}
		want := []string{xdgClaude, homeClaude}
		requirePaths(t, roots.Dirs, want)
	})

	t.Run("defaults xdg to home dot config", func(t *testing.T) {
		home := t.TempDir()
		xdgClaude := filepath.Join(home, ".config", "claude")
		homeClaude := filepath.Join(home, ".claude")
		mkdirAll(t, filepath.Join(xdgClaude, "projects"))
		mkdirAll(t, filepath.Join(homeClaude, "projects"))

		roots, err := ResolveRoots(homeEnv(home, nil), "")
		if err != nil {
			t.Fatal(err)
		}
		want := []string{xdgClaude, homeClaude}
		requirePaths(t, roots.Dirs, want)
	})

	t.Run("skips a candidate without projects", func(t *testing.T) {
		home := t.TempDir()
		xdg := filepath.Join(home, "xdg")
		homeClaude := filepath.Join(home, ".claude")
		mkdirAll(t, filepath.Join(xdg, "claude"))
		mkdirAll(t, filepath.Join(homeClaude, "projects"))

		roots, err := ResolveRoots(homeEnv(home, map[string]string{"XDG_CONFIG_HOME": xdg}), "")
		if err != nil {
			t.Fatal(err)
		}
		want := []string{homeClaude}
		requirePaths(t, roots.Dirs, want)
	})

	t.Run("returns no roots when the tool is not installed", func(t *testing.T) {
		// An absent Claude install is not an error: ccusage returns an empty
		// list and the source reports "unavailable" (paths.rs:49-54).
		home := t.TempDir()

		roots, err := ResolveRoots(homeEnv(home, nil), "")
		if err != nil {
			t.Fatal(err)
		}
		if len(roots.Dirs) != 0 {
			t.Fatalf("Dirs = %v, want none", roots.Dirs)
		}
	})

	t.Run("requires a home directory", func(t *testing.T) {
		// paths.rs:45: the fallback has no candidates without $HOME.
		roots, err := ResolveRoots(stubEnv(nil), "")
		if err == nil {
			t.Fatalf("ResolveRoots = %v, want an error", roots.Dirs)
		}
	})
}

func TestScanFilesSortsByFullPathAndSkipsSymlinks(t *testing.T) {
	root := t.TempDir()
	projects := filepath.Join(root, "projects")
	nested := filepath.Join(projects, "p", "a", "c.jsonl")
	flat := filepath.Join(projects, "p", "b.jsonl")
	subagent := filepath.Join(projects, "p", "sess", "subagents", "agent-a.jsonl")
	notJSONL := filepath.Join(projects, "p", "notes.txt")

	// A sibling pair where the walk order and the sorted order disagree:
	// ReadDir lists "a" before "a.jsonl", so a depth-first walk yields
	// p/a/x.jsonl before p/a.jsonl, but "." (0x2E) sorts before "/" (0x2F), so
	// the required order is the other way round (paths.rs:77). Without the
	// full-path sort this assertion fails.
	prefixDirFile := filepath.Join(projects, "p", "a", "x.jsonl")
	prefixFile := filepath.Join(projects, "p", "a.jsonl")

	// Deep enough that the bounded scanners' depth cap of 8 would miss it:
	// ccusage recurses without a depth limit (paths.rs:65-79,
	// common/src/lib.rs:14-46).
	deep := filepath.Join(projects, "p", "deep")
	deepParts := append([]string{"p", "deep"}, deepNames()...)
	for _, part := range deepNames() {
		deep = filepath.Join(deep, part)
	}
	deepLeaf := filepath.Join(deep, "leaf.jsonl")

	for _, path := range []string{nested, flat, subagent, deepLeaf, prefixDirFile, prefixFile} {
		writeFixture(t, path, "{}\n")
	}
	writeFixture(t, notJSONL, "not a session\n")
	// Path::extension() is the text after the final dot and is case sensitive,
	// so a name that starts with a dot has no extension at all.
	for _, name := range []string{".jsonl", "UPPER.JSONL", "trailing."} {
		writeFixture(t, filepath.Join(projects, "p", name), "{}\n")
	}

	// A second root whose files all sort before the first root's: the walk
	// visits roots in the order they are given, so only the full-path sort can
	// interleave them. It is passed first on purpose.
	parent := t.TempDir()
	earlierRoot := filepath.Join(parent, "aaa")
	laterRoot := filepath.Join(parent, "bbb")
	earlier := filepath.Join(earlierRoot, "projects", "p", "z.jsonl")
	later := filepath.Join(laterRoot, "projects", "p", "a.jsonl")
	writeFixture(t, earlier, "{}\n")
	writeFixture(t, later, "{}\n")

	// The file mtime is carried out of the scan so the prune step does not
	// have to re-stat, and it is the file's own time.
	flatMtime := mustTime(t, "2026-09-19T12:00:00Z")
	if err := os.Chtimes(flat, flatMtime, flatMtime); err != nil {
		t.Fatal(err)
	}

	files, err := ScanFiles(Roots{Dirs: []string{laterRoot, earlierRoot, root}}, "")
	if err != nil {
		t.Fatal(err)
	}

	want := []string{nested, flat, subagent, deepLeaf, prefixDirFile, prefixFile, earlier, later}
	sort.Strings(want)
	if got := filePaths(files); !reflect.DeepEqual(got, want) {
		t.Fatalf("paths = %v, want %v", got, want)
	}
	// The prefix pair, spelled out: the file sorts before the directory's
	// transcript, which is the opposite of the order the walk produces.
	paths := filePaths(files)
	fileIndex, dirFileIndex := indexOfString(paths, prefixFile), indexOfString(paths, prefixDirFile)
	if fileIndex < 0 || fileIndex > dirFileIndex {
		t.Fatalf("%s at %d, %s at %d; want the file before the directory transcript",
			prefixFile, fileIndex, prefixDirFile, dirFileIndex)
	}
	// Roots interleave: the first root given sorts after the files already
	// emitted, so the full-path sort has to move the second root's file ahead.
	earlierIndex, laterIndex := indexOfString(paths, earlier), indexOfString(paths, later)
	if earlierIndex < 0 || laterIndex < 0 || earlierIndex > laterIndex {
		t.Fatalf("%s at %d, %s at %d; want the earlier root's file first",
			earlier, earlierIndex, later, laterIndex)
	}
	if got := fileByPath(t, files, flat); !got.MTimeKnown || !got.MTime.Equal(flatMtime) {
		t.Fatalf("flat mtime = %v (known %v), want %v", got.MTime, got.MTimeKnown, flatMtime)
	}
	// Session id and project path come from the path layout (paths.rs:290-331).
	for _, testCase := range []struct {
		path    string
		session string
		project string
	}{
		{nested, "a", "p"},
		{flat, "b", "p"},
		{subagent, "sess", "p"},
		{prefixFile, "a", "p"},
		{prefixDirFile, "a", "p"},
		// 15 nested directories below p/deep: the 14th is the session and the
		// rest is the project.
		{deepLeaf, deepNames()[14], filepath.Join(deepParts[:len(deepParts)-1]...)},
	} {
		file := fileByPath(t, files, testCase.path)
		if file.SessionID != testCase.session || file.ProjectPath != testCase.project {
			t.Errorf("%s = (%q, %q), want (%q, %q)",
				testCase.path, file.SessionID, file.ProjectPath, testCase.session, testCase.project)
		}
	}

	t.Run("skips symlinks", func(t *testing.T) {
		if runtime.GOOS == "windows" {
			t.Skip("creating a symlink on Windows needs developer mode or an elevated process")
		}
		root := t.TempDir()
		projects := filepath.Join(root, "projects")
		real := filepath.Join(projects, "p", "real.jsonl")
		writeFixture(t, real, "{}\n")
		// A symlinked jsonl is not a usage file: ccusage classifies entries
		// with file_type(), which never follows a link (paths.rs:40-44 of
		// common/src/lib.rs).
		if err := os.Symlink(real, filepath.Join(projects, "p", "link.jsonl")); err != nil {
			t.Skip("symlinks unavailable")
		}
		// Neither is a symlinked directory, whatever it points at. Its target
		// lives outside the scanned tree so the only way it could be reached
		// is by following the link.
		elsewhere := filepath.Join(t.TempDir(), "elsewhere")
		writeFixture(t, filepath.Join(elsewhere, "hidden.jsonl"), "{}\n")
		if err := os.Symlink(elsewhere, filepath.Join(projects, "p", "dirlink")); err != nil {
			t.Skip("directory symlinks unavailable")
		}
		// A dangling link is skipped without an error, like any other link.
		if err := os.Symlink(filepath.Join(projects, "p", "gone.jsonl"), filepath.Join(projects, "p", "dangling.jsonl")); err != nil {
			t.Fatal(err)
		}

		files, err := ScanFiles(Roots{Dirs: []string{root}}, "")
		if err != nil {
			t.Fatal(err)
		}
		if got, want := filePaths(files), []string{real}; !reflect.DeepEqual(got, want) {
			t.Fatalf("paths = %v, want %v", got, want)
		}
	})
}

func fileByPath(t *testing.T, files []SessionFile, path string) SessionFile {
	t.Helper()
	for _, file := range files {
		if file.Path == path {
			return file
		}
	}
	t.Fatalf("no scanned file at %s in %v", path, filePaths(files))
	return SessionFile{}
}

// indexOfString returns the position of value in paths, or -1 when absent.
func indexOfString(paths []string, value string) int {
	for index, path := range paths {
		if path == value {
			return index
		}
	}
	return -1
}

func TestScanFilesAppliesTheProjectFilterAsADirectoryShortcut(t *testing.T) {
	root := t.TempDir()
	alpha := filepath.Join(root, "projects", "alpha", "a.jsonl")
	beta := filepath.Join(root, "projects", "beta", "b.jsonl")
	writeFixture(t, alpha, "{}\n")
	writeFixture(t, beta, "{}\n")
	roots := Roots{Dirs: []string{root}}

	for _, testCase := range []struct {
		name   string
		filter string
		want   []string
	}{
		// A valid path segment addresses the project directory directly
		// (paths.rs:69-75).
		{"segment", "alpha", []string{alpha}},
		// Anything else cannot be a single project directory, so the whole
		// tree is scanned (paths.rs:248-254). ccusage would then filter the
		// entries by extract_project; that entry-level filter is not ported
		// (no TokenBoard path passes --project), so this scan keeps them all.
		// These values would be cleaned into "alpha" by filepath.Join, which
		// is exactly what must not happen to a shortcut.
		{"path", "beta/../alpha", []string{alpha, beta}},
		{"backslash", `beta\..\alpha`, []string{alpha, beta}},
		{"dot", ".", []string{alpha, beta}},
		{"dotdot", "..", []string{alpha, beta}},
		{"empty", "", []string{alpha, beta}},
		// The shortcut never falls back to a full scan: ccusage reads the
		// directory it was pointed at, and a missing one yields nothing.
		{"missing", "missing", []string{}},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			files, err := ScanFiles(roots, testCase.filter)
			if err != nil {
				t.Fatal(err)
			}
			got := filePaths(files)
			want := append([]string{}, testCase.want...)
			sort.Strings(got)
			sort.Strings(want)
			requirePaths(t, got, want)
		})
	}
}

func TestPruneByMTimeKeepsWholeSessionGroup(t *testing.T) {
	// A session's transcripts are pruned or kept together: deduplication
	// matches sidechain replays by session id across files, so dropping a
	// parent alone would let its replay count twice (paths.rs:95-111). The
	// bound opens at 2026-09-20 00:00 UTC and the margin is one day, so
	// anything written from 2026-09-19 00:00 UTC counts as live.
	root := t.TempDir()
	liveParent := filepath.Join(root, "projects", "p", "live.jsonl")
	liveAgent := filepath.Join(root, "projects", "p", "live", "subagents", "agent-a.jsonl")
	staleParent := filepath.Join(root, "projects", "p", "stale.jsonl")
	staleAgent := filepath.Join(root, "projects", "p", "stale", "subagents", "agent-b.jsonl")
	for _, path := range []string{liveParent, liveAgent, staleParent, staleAgent} {
		writeFixture(t, path, "{}\n")
	}

	aWeekEarly := mustTime(t, "2026-09-01T12:00:00Z")
	files := []SessionFile{
		sessionFile(t, liveParent, aWeekEarly),
		sessionFile(t, liveAgent, mustTime(t, "2026-09-21T12:00:00Z")),
		sessionFile(t, staleParent, aWeekEarly),
		sessionFile(t, staleAgent, mustTime(t, "2026-09-02T12:00:00Z")),
	}

	var pruned []string
	kept, err := PruneByMTime(files, "20260920", "UTC", mustTime(t, "2026-09-24T00:00:00Z"), func(path string) {
		pruned = append(pruned, path)
	})
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{liveParent, liveAgent}; !reflect.DeepEqual(filePaths(kept), want) {
		t.Fatalf("kept = %v, want %v", filePaths(kept), want)
	}
	if want := []string{staleParent, staleAgent}; !reflect.DeepEqual(pruned, want) {
		t.Fatalf("pruned = %v, want %v", pruned, want)
	}
}

func TestPruneByMTimeIgnoresUntil(t *testing.T) {
	// Only --since prunes (paths.rs:113-115): an until-only window reaches
	// this layer as an empty sinceDate, and every file stays regardless of how
	// old it is.
	root := t.TempDir()
	first := filepath.Join(root, "projects", "p", "one.jsonl")
	second := filepath.Join(root, "projects", "p", "two.jsonl")
	for _, path := range []string{first, second} {
		writeFixture(t, path, "{}\n")
	}
	ancient := mustTime(t, "2020-01-01T00:00:00Z")
	files := []SessionFile{sessionFile(t, first, ancient), sessionFile(t, second, ancient)}

	pruneCalls := 0
	kept, err := PruneByMTime(files, "", "UTC", mustTime(t, "2026-09-24T00:00:00Z"), func(string) {
		pruneCalls++
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(kept) != len(files) || pruneCalls != 0 {
		t.Fatalf("kept %d files with %d prune reports, want %d files and none",
			len(kept), pruneCalls, len(files))
	}
}

func TestPruneByMTimeKeepsFilesWithUnknownMtime(t *testing.T) {
	// An mtime that cannot be read must never rule a file out (paths.rs:155-156).
	missing := filepath.Join("nonexistent", "projects", "p", "gone.jsonl")
	files := []SessionFile{{
		Path:        missing,
		SessionID:   "gone",
		ProjectPath: "p",
	}}

	kept, err := PruneByMTime(files, "20260920", "UTC", mustTime(t, "2026-09-24T00:00:00Z"), nil)
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{missing}; !reflect.DeepEqual(filePaths(kept), want) {
		t.Fatalf("kept = %v, want %v", filePaths(kept), want)
	}
}

func TestPruneByMTimeKeepsEveryFileWhenTheWindowOpensInTheFuture(t *testing.T) {
	// A window that starts ahead of the clock cannot rule anything out: entry
	// timestamps can outrun any mtime the filesystem reports (paths.rs:132-136).
	root := t.TempDir()
	path := filepath.Join(root, "projects", "p", "old.jsonl")
	writeFixture(t, path, "{}\n")
	files := []SessionFile{sessionFile(t, path, mustTime(t, "2026-09-01T12:00:00Z"))}

	now := mustTime(t, "2026-09-30T00:00:00Z").Add(-24 * time.Hour)
	kept, err := PruneByMTime(files, "20260930", "UTC", now, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(kept) != 1 {
		t.Fatalf("kept %d files, want 1", len(kept))
	}
}

func TestPruneByMTimeLinksSessionsByTheirRecordedSessionID(t *testing.T) {
	// Subagent and workflow transcripts record the session they belong to, and
	// that id can differ from the one their path implies. Reading the first
	// recorded id links the files into one group (paths.rs:139-152, 207-234).
	root := t.TempDir()
	liveParent := filepath.Join(root, "projects", "p", "session-y.jsonl")
	liveWorkflow := filepath.Join(root, "projects", "p", "session-x", "subagents", "workflows", "wf_1", "agent-a.jsonl")
	staleParent := filepath.Join(root, "projects", "p", "session-z.jsonl")
	staleWorkflow := filepath.Join(root, "projects", "p", "session-w", "subagents", "workflows", "wf_2", "agent-b.jsonl")
	writeFixture(t, liveParent, `{"sessionId":"session-y"}`)
	// The id is recorded below a long leading line that has no sessionId, and
	// with whitespace after the key.
	writeFixture(t, liveWorkflow, "{\"type\":\"summary\"}\n{\"sessionId\" : \"session-y\"}")
	writeFixture(t, staleParent, `{"sessionId":"session-stale"}`)
	writeFixture(t, staleWorkflow, `{"sessionId":"session-stale"}`)

	aWeekEarly := mustTime(t, "2026-09-01T12:00:00Z")
	files := []SessionFile{
		sessionFile(t, liveParent, aWeekEarly),
		sessionFile(t, liveWorkflow, mustTime(t, "2026-09-21T12:00:00Z")),
		sessionFile(t, staleParent, aWeekEarly),
		sessionFile(t, staleWorkflow, aWeekEarly),
	}

	var pruned []string
	kept, err := PruneByMTime(files, "20260920", "UTC", mustTime(t, "2026-09-24T00:00:00Z"), func(path string) {
		pruned = append(pruned, path)
	})
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{liveParent, liveWorkflow}; !reflect.DeepEqual(filePaths(kept), want) {
		t.Fatalf("kept = %v, want %v", filePaths(kept), want)
	}
	if want := []string{staleParent, staleWorkflow}; !reflect.DeepEqual(pruned, want) {
		t.Fatalf("pruned = %v, want %v", pruned, want)
	}
}

func TestPruneByMTimeDoesNotPruneForAnUnparsableBound(t *testing.T) {
	// Only a compact YYYYMMDD bound has an instant to compare against: a
	// dashed date still filters entries later, but it never narrows the file
	// list (date_utils.rs:174-188, 212-225).
	root := t.TempDir()
	path := filepath.Join(root, "projects", "p", "old.jsonl")
	writeFixture(t, path, "{}\n")
	files := []SessionFile{sessionFile(t, path, mustTime(t, "2026-09-01T12:00:00Z"))}

	kept, err := PruneByMTime(files, "2026-09-20", "UTC", mustTime(t, "2026-09-24T00:00:00Z"), nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(kept) != 1 {
		t.Fatalf("kept %d files, want 1", len(kept))
	}
}

func TestPruneByMTimeResolvesAGapMidnightToTheFirstInstant(t *testing.T) {
	// America/Havana springs forward at midnight on 2026-03-08, so local
	// 00:00 does not exist. ccusage resolves the bound with the offset in
	// effect before the transition — 2026-03-08T05:00:00Z, the first instant
	// of the local day (date_utils.rs:227-241) — which jiff 0.2.38, the crate
	// ccusage pins, returns for that date. Go's time.Date alone lands on
	// 04:00Z, which renders as March 7 23:00 local, so the bound must be
	// carried forward or it would sit in the neighbouring day.
	// The bound is 2026-03-08T05:00:00Z minus the one-day mtime margin, so the
	// files straddle 2026-03-07T05:00:00Z. Go's plain time.Date for that
	// midnight is an hour earlier (04:00:00Z), which would keep both files.
	threshold := mustTime(t, "2026-03-07T05:00:00Z")
	root := t.TempDir()
	justBefore := filepath.Join(root, "projects", "p", "before.jsonl")
	atThreshold := filepath.Join(root, "projects", "p", "bound.jsonl")
	for _, path := range []string{justBefore, atThreshold} {
		writeFixture(t, path, "{}\n")
	}
	files := []SessionFile{
		sessionFile(t, justBefore, threshold.Add(-time.Millisecond)),
		sessionFile(t, atThreshold, threshold),
	}

	var pruned []string
	kept, err := PruneByMTime(files, "20260308", "America/Havana", mustTime(t, "2026-03-10T00:00:00Z"), func(path string) {
		pruned = append(pruned, path)
	})
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{atThreshold}; !reflect.DeepEqual(filePaths(kept), want) {
		t.Fatalf("kept = %v, want %v", filePaths(kept), want)
	}
	if want := []string{justBefore}; !reflect.DeepEqual(pruned, want) {
		t.Fatalf("pruned = %v, want %v", pruned, want)
	}
}

func TestPruneByMTimeRejectsAnUnknownTimezone(t *testing.T) {
	// A zone that cannot be loaded is a configuration error the caller must
	// see: pruning with the wrong zone silently drops whole days.
	root := t.TempDir()
	path := filepath.Join(root, "projects", "p", "old.jsonl")
	writeFixture(t, path, "{}\n")
	files := []SessionFile{sessionFile(t, path, mustTime(t, "2026-09-01T12:00:00Z"))}

	if _, err := PruneByMTime(files, "20260920", "Not/AZone", mustTime(t, "2026-09-24T00:00:00Z"), nil); err == nil {
		t.Fatal("PruneByMTime accepted an unknown timezone")
	}
}

// The bound is the start of the local day (start_of_day_ms), and every want
// below is the millisecond instant jiff 0.2.38 — the crate ccusage pins —
// returns for that date, so the arithmetic is pinned across an eastward
// offset, a midnight gap, a midnight fold and a date with no gap at all.
func TestPruneByMTimeResolvesTheSinceBoundLikeJiff(t *testing.T) {
	for _, testCase := range []struct {
		zone   string
		date   string
		wantMs int64
		ok     bool
	}{
		{"UTC", "20260920", 1789862400000, true},
		{"Pacific/Kiritimati", "20260102", 1767261600000, true},
		{"America/New_York", "20260308", 1772946000000, true},
		{"America/Havana", "20260308", 1772946000000, true},
		{"America/Havana", "20261101", 1793505600000, true},
		// A compact date must be a real day: February 31 has no instant, and a
		// dashed value is not the compact form at all (date_utils.rs:163-188).
		{"UTC", "20260231", 0, false},
		{"UTC", "2026-09-2", 0, false},
		{"UTC", "2026092", 0, false},
	} {
		location, err := time.LoadLocation(testCase.zone)
		if err != nil {
			t.Fatalf("load %s: %v", testCase.zone, err)
		}
		got, ok := sinceBoundMillis(testCase.date, location)
		if ok != testCase.ok {
			t.Fatalf("%s %s: ok = %v, want %v", testCase.zone, testCase.date, ok, testCase.ok)
		}
		if ok && got != testCase.wantMs {
			t.Fatalf("%s %s: bound = %d, want %d", testCase.zone, testCase.date, got, testCase.wantMs)
		}
	}
}

func TestPathSessionParts(t *testing.T) {
	separator := string(filepath.Separator)
	for _, testCase := range []struct {
		name    string
		path    string
		session string
		project string
	}{
		{
			// projects/<project>/<session>.jsonl (paths.rs:303-307).
			name:    "flat session file",
			path:    filepath.Join("claude", "projects", "p", "sess-1.jsonl"),
			session: "sess-1",
			project: "p",
		},
		{
			// <session>/subagents/<agent>.jsonl is the session's subagent
			// (paths.rs:308-319).
			name:    "subagent transcript",
			path:    filepath.Join("claude", "projects", "p", "sess-2", "subagents", "agent-a.jsonl"),
			session: "sess-2",
			project: "p",
		},
		{
			// A workflow transcript nests deeper under subagents, so the
			// second-to-last segment is not "subagents" and the file must not
			// be attributed to the session that holds the workflow
			// (paths.rs:308, 320-331).
			name:    "workflow transcript",
			path:    filepath.Join("claude", "projects", "p", "sess-3", "subagents", "workflows", "wf_1", "a.jsonl"),
			session: "wf_1",
			project: strings.Join([]string{"p", "sess-3", "subagents", "workflows"}, separator),
		},
		{
			// Any other depth takes the second-to-last segment as the session
			// and everything above it as the project (paths.rs:320-329).
			name:    "generic shape",
			path:    filepath.Join("claude", "projects", "p", "sess-4", "extra", "deep.jsonl"),
			session: "extra",
			project: strings.Join([]string{"p", "sess-4"}, separator),
		},
		{
			// Without a "projects" segment the whole path is relative.
			name:    "no projects marker",
			path:    filepath.Join("plain", "here.jsonl"),
			session: "here",
			project: "plain",
		},
		{
			// The defaults for a path that ends at projects/ (paths.rs:320-329).
			name:    "bare projects directory",
			path:    filepath.Join("claude", "projects"),
			session: "unknown",
			project: "Unknown Project",
		},
		{
			// One segment below projects/ is too shallow for the generic
			// shape: the component keeps its extension (paths.rs:320-324).
			name:    "single component",
			path:    "solo.jsonl",
			session: "solo.jsonl",
			project: "Unknown Project",
		},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			session, project := PathSessionParts(testCase.path)
			if session != testCase.session || project != testCase.project {
				t.Fatalf("PathSessionParts(%q) = (%q, %q), want (%q, %q)",
					testCase.path, session, project, testCase.session, testCase.project)
			}
		})
	}
}
