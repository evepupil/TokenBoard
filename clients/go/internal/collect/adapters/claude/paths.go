// Package claude ports ccusage's Claude Code adapter, frozen at v20.0.33
// (commit 1308c416). This file is the discovery layer: which config roots
// exist, which JSONL transcripts can hold entries inside a --since window, and
// which session and project a transcript path names. Later steps add the line
// parser, the dedupe index, the report assembly and the collector entry.
//
// TokenBoard reads the same local tree ccusage does, so the rules below cite
// the upstream source they are ported from (rust/adapters/claude/src/paths.rs,
// rust/adapters/common/src/lib.rs and rust/crates/ccusage-core/src/date_utils.rs).
package claude

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/MisonL/TokenBoard/clients/go/internal/contract"
)

// millisPerDay is MILLIS_PER_DAY (crates/ccusage-core/src/date_utils.rs:8).
const millisPerDay = 24 * 60 * 60 * 1000

// mtimePruneMarginMs is MTIME_PRUNE_MARGIN_MS (paths.rs:84): the margin
// absorbs the gap between the timezone-resolved bound and wall-clock mtimes,
// plus sessions flushed well after the entries they hold.
const mtimePruneMarginMs = int64(millisPerDay)

// sessionIDMarker is the byte sequence recorded_session_id probes each line
// for before it parses it (paths.rs:224).
var sessionIDMarker = []byte(`"sessionId"`)

// Roots is the set of Claude config directories one collection reads.
type Roots struct {
	Dirs []string
}

// SessionFile is one discovered transcript. SessionID and ProjectPath come
// from the path layout (PathSessionParts); MTime is the file's modification
// time, and MTimeKnown is false when it could not be read (which keeps the
// file in a --since scan).
type SessionFile struct {
	Path      string
	SessionID string
	// ProjectPath is the project the session report groups on: the path-derived
	// value PathSessionParts returns (commands/mod.rs:186-206). It is NOT what
	// --project filters on. That filter uses extract_project - the first segment
	// after "projects" (paths.rs:269-288) - and is applied to entries at
	// lib.rs:173-178 and daily.rs:101-107 only when the flag is given. No
	// TokenBoard code path passes --project, so no entry-level filter is ported.
	ProjectPath string
	MTime       time.Time
	MTimeKnown  bool
}

// ResolveRoots ports claude_paths (paths.rs:23-55).
//
// CLAUDE_CONFIG_DIR, when set, is split on commas, each entry trimmed and ~
// expanded, an entry whose last segment is "projects" replaced by its parent,
// and the entries without a projects/ directory dropped. A variable that is
// set but names nothing usable is a hard error rather than a fallback: the
// user pointed at a specific install.
//
// homeDir is the TokenBoard seam, and it is a contract the provider must
// honour (Task 7):
//
//   - CLAUDE_CONFIG_DIR set → pass homeDir == "" so this function reads the
//     variable itself. That is the only path that keeps ccusage's comma
//     splitting, its hard error for an unusable value and its "never fall
//     back to XDG" rule in one place. Passing the raw value as homeDir
//     instead would turn a misconfiguration into an empty result.
//   - Otherwise → pass the resolved Claude home (readClaudeHome's result:
//     CLAUDE_HOME, else ~/.claude). A home without projects/ means the tool
//     is not installed, so it yields no roots instead of an error.
//
// An explicit home is still split on commas and stripped of a trailing
// "projects" segment, so a caller that forwards a list cannot smuggle a
// comma-separated value past the normalisation.
//
// Two known, accepted deviations from paths.rs: an empty CLAUDE_CONFIG_DIR (or
// an empty entry in it) reads as unset here because a func(string) string seam
// cannot tell "" from an absent variable, while ccusage's env::var returns
// Ok("") and hard-errors; and an empty XDG_CONFIG_HOME falls back to
// $HOME/.config instead of producing a relative "claude" path.
func ResolveRoots(env func(string) string, homeDir string) (Roots, error) {
	if env == nil {
		env = os.Getenv
	}
	home := lookupHome(env)

	if explicit := strings.TrimSpace(homeDir); explicit != "" {
		return Roots{Dirs: validConfigDirs(splitConfigList(explicit), home)}, nil
	}

	if configDir := strings.TrimSpace(env("CLAUDE_CONFIG_DIR")); configDir != "" {
		dirs := validConfigDirs(splitConfigList(configDir), home)
		if len(dirs) == 0 {
			return Roots{}, fmt.Errorf(
				"No valid Claude data directories found in CLAUDE_CONFIG_DIR. "+
					"Expected each path to be a Claude config directory containing 'projects/', "+
					"or the 'projects/' directory itself: %s", configDir)
		}
		return Roots{Dirs: dirs}, nil
	}

	// Unset: $XDG_CONFIG_HOME/claude and $HOME/.claude, each kept only when it
	// holds a projects/ directory (paths.rs:45-53). Missing both is an empty
	// result, not an error.
	if home == "" {
		return Roots{}, errors.New("home directory is not set")
	}
	xdgConfig := env("XDG_CONFIG_HOME")
	if xdgConfig == "" {
		xdgConfig = joinPath(home, ".config")
	}
	dirs := []string{}
	seen := map[string]bool{}
	for _, candidate := range []string{joinPath(xdgConfig, "claude"), joinPath(home, ".claude")} {
		if isDir(joinPath(candidate, "projects")) && !seen[candidate] {
			seen[candidate] = true
			dirs = append(dirs, candidate)
		}
	}
	return Roots{Dirs: dirs}, nil
}

// splitConfigList is the comma split of CLAUDE_CONFIG_DIR: each entry is
// trimmed and empty pieces are dropped (paths.rs:27-31).
func splitConfigList(value string) []string {
	entries := []string{}
	for _, raw := range strings.Split(value, ",") {
		if entry := strings.TrimSpace(raw); entry != "" {
			entries = append(entries, entry)
		}
	}
	return entries
}

// validConfigDirs normalizes each candidate and keeps the ones that are a
// Claude config directory, in input order and without duplicates
// (paths.rs:32-36).
func validConfigDirs(entries []string, home string) []string {
	dirs := []string{}
	seen := map[string]bool{}
	for _, raw := range entries {
		path := normalizeConfigPath(raw, home)
		if isDir(joinPath(path, "projects")) && !seen[path] {
			seen[path] = true
			dirs = append(dirs, path)
		}
	}
	return dirs
}

// normalizeConfigPath is normalize_claude_config_path (paths.rs:57-63): expand
// a leading ~, and when the path names the projects/ directory itself, use its
// parent.
func normalizeConfigPath(raw, home string) string {
	path := expandHomePath(raw, home)
	if name, ok := lastPathSegment(path); ok && name == "projects" && isDir(path) {
		if parent, ok := parentPath(path); ok {
			return parent
		}
	}
	return path
}

// expandHomePath is expand_home_path (path_utils.rs:3-15): only the literal
// "~" and a "~/" prefix expand; every other form is already a real path.
func expandHomePath(raw, home string) string {
	if home == "" {
		return raw
	}
	if raw == "~" {
		return home
	}
	if rest, ok := strings.CutPrefix(raw, "~/"); ok {
		return joinPath(home, rest)
	}
	return raw
}

// lookupHome ports home_dir_from_env (crates/ccusage-core/src/home.rs:12-31):
// HOME, then USERPROFILE, then HOMEDRIVE+HOMEPATH. The order is the same on
// every platform — a Windows-shaped test upstream asserts HOME wins — so a
// shell that exports HOME next to USERPROFILE (Git Bash, MSYS) resolves the
// same root on both sides. It does not use os.UserHomeDir, which prefers
// USERPROFILE on Windows and ignores HOMEDRIVE/HOMEPATH.
func lookupHome(env func(string) string) string {
	if value := env("HOME"); value != "" {
		return value
	}
	if value := env("USERPROFILE"); value != "" {
		return value
	}
	drive, path := env("HOMEDRIVE"), env("HOMEPATH")
	if drive == "" || path == "" {
		return ""
	}
	// OsString::push is plain concatenation, not a path join: "C:" + "\Users\runner"
	// → "C:\Users\runner". path is absolute, so a join would drop the drive.
	return drive + path
}

// joinPath mirrors PathBuf::join, which the upstream code uses for every
// configured path: an empty base yields the name, an absolute name replaces
// the base, and no component is cleaned away — a configured path keeps the
// "." and ".." segments the user wrote, exactly as ccusage does.
func joinPath(base, name string) string {
	if base == "" {
		return name
	}
	if filepath.IsAbs(name) {
		return name
	}
	if last := base[len(base)-1]; isSeparatorByte(last) {
		return base + name
	}
	return base + string(filepath.Separator) + name
}

// lastPathSegment mirrors Path::file_name: the segment after the final
// separator, with trailing separators ignored. ok is false for a bare root or
// the empty path, which have no file name.
func lastPathSegment(path string) (string, bool) {
	trimmed := trimTrailingSeparators(path)
	if trimmed == "" || isBareRoot(trimmed) {
		return "", false
	}
	index := lastSeparatorIndex(trimmed)
	if index < 0 {
		return trimmed, true
	}
	return trimmed[index+1:], true
}

// parentPath mirrors Path::parent: the path without its last component, with
// the root kept ("/projects" → "/", "C:\projects" → "C:\"). ok is false for a
// bare root or the empty path.
func parentPath(path string) (string, bool) {
	trimmed := trimTrailingSeparators(path)
	if trimmed == "" || isBareRoot(trimmed) {
		return "", false
	}
	index := lastSeparatorIndex(trimmed)
	if index < 0 {
		// A single relative component: the parent is the empty path.
		return "", true
	}
	if index == 0 {
		return trimmed[:1], true
	}
	if filepath.Separator == '\\' && index == 2 && trimmed[1] == ':' {
		return trimmed[:index+1], true
	}
	return trimmed[:index], true
}

// isBareRoot reports a path that is only a root: "C:" or "C:\" on Windows.
// Unix has no bare root left after trimTrailingSeparators ("/" trims to the
// empty path, which the callers treat as rootless).
func isBareRoot(path string) bool {
	if filepath.Separator != '\\' {
		return false
	}
	return (len(path) == 2 && path[1] == ':') ||
		(len(path) == 3 && path[1] == ':' && isSeparatorByte(path[2]))
}

func trimTrailingSeparators(path string) string {
	for len(path) > 0 && isSeparatorByte(path[len(path)-1]) {
		path = path[:len(path)-1]
	}
	return path
}

func lastSeparatorIndex(path string) int {
	for index := len(path) - 1; index >= 0; index-- {
		if isSeparatorByte(path[index]) {
			return index
		}
	}
	return -1
}

// isSeparatorByte: Windows accepts both separators, unix only "/" — a
// backslash is a legal file-name character there.
func isSeparatorByte(value byte) bool {
	if filepath.Separator == '\\' {
		return value == '\\' || value == '/'
	}
	return value == '/'
}

// isDir follows symlinks, like Path::is_dir: a projects/ directory reached
// through a link is still a projects directory (paths.rs:33, 50).
func isDir(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.IsDir()
}

// ScanFiles ports usage_files (paths.rs:65-79): every *.jsonl transcript below
// each root's projects/ directory, sorted by full path.
//
// A valid projectFilter narrows the scan to that one project directory. Anything
// else - the empty string, ".", "..", or a value with a separator - cannot name
// one project directory, so the whole tree is scanned (paths.rs:69-75,
// 248-254).
//
// ccusage also filters each entry by extract_project after loading it
// (paths.rs:269-288, applied at lib.rs:173-178 and daily.rs:101-107), but that
// entry-level filter is NOT ported: no TokenBoard code path passes --project, so
// it would be unreachable. projectFilter exists only for the directory-shortcut
// parity tests; it narrows the scan and never filters entries.
func ScanFiles(roots Roots, projectFilter string) ([]SessionFile, error) {
	files := []SessionFile{}
	for _, root := range roots.Dirs {
		projectsDir := joinPath(root, "projects")
		target := projectsDir
		if isProjectPathSegment(projectFilter) {
			target = joinPath(projectsDir, projectFilter)
		}
		collectJSONLFiles(target, &files)
	}
	// Only a full tie in the replacement ladder reaches this order: the ladder
	// decides the survivor whenever it finds a difference (lib.rs:198-212,
	// daily.rs:582-601), and a full tie keeps the first-seen entry, which is the
	// one this order added first. The dedupe also reports survivors in this
	// order (paths.rs:77).
	sort.SliceStable(files, func(left, right int) bool { return files[left].Path < files[right].Path })
	return files, nil
}

// isProjectPathSegment is is_project_path_segment (paths.rs:248-254).
func isProjectPathSegment(value string) bool {
	return value != "" &&
		value != "." &&
		value != ".." &&
		!strings.Contains(value, "/") &&
		!strings.Contains(value, "\\")
}

// collectJSONLFiles appends every *.jsonl regular file below dir at any depth,
// without following symbolic links (common/src/lib.rs:14-46). A directory that
// cannot be read is skipped silently: roots are validated when they are
// resolved, so an unreadable directory here is a race with the tool that owns
// the tree, not a configuration error. The walk is deliberately unbounded in
// depth — ccusage has no depth cap, and a transcript tree nests as deep as the
// subagent/workflow layout does.
func collectJSONLFiles(dir string, files *[]SessionFile) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, entry := range entries {
		name := entry.Name()
		path := joinPath(dir, name)
		entryType := entry.Type()
		if entryType&os.ModeSymlink != 0 {
			// Never follow a link: entry.file_type() classifies one as
			// neither a file nor a directory, so ccusage drops it.
			continue
		}
		var info os.FileInfo
		if entryType == 0 {
			// Type() is zero for a regular file and for a filesystem that did
			// not report a dirent type at all. Rust's entry.file_type() falls
			// back to symlink_metadata in the second case, so a plain lstat
			// decides here too.
			info, err = entry.Info()
			if err != nil {
				continue
			}
			entryType = info.Mode().Type()
			if entryType&os.ModeSymlink != 0 {
				continue
			}
		}
		if entryType.IsDir() {
			collectJSONLFiles(path, files)
			continue
		}
		if !entryType.IsRegular() {
			continue
		}
		if !hasJSONLExtension(name) {
			continue
		}
		if info == nil {
			info, err = entry.Info()
			if err != nil {
				// Rotated away mid-scan.
				continue
			}
		}
		modified := info.ModTime()
		sessionID, projectPath := PathSessionParts(path)
		*files = append(*files, SessionFile{
			Path:        path,
			SessionID:   sessionID,
			ProjectPath: projectPath,
			MTime:       modified,
			// Path::extension() reading and file_modified_millis: an mtime
			// before the Unix epoch has no duration to compare, so it counts
			// as unknown (paths.rs:236-246).
			MTimeKnown: !modified.Before(time.Unix(0, 0)),
		})
	}
}

// hasJSONLExtension is Path::extension() == "jsonl": the characters after the
// final dot, where a name that starts with a dot has no extension at all.
func hasJSONLExtension(name string) bool {
	index := strings.LastIndexByte(name, '.')
	return index > 0 && name[index+1:] == "jsonl"
}

// PathSessionParts ports extract_session_parts (paths.rs:290-331): the session
// and project a transcript path is attributed to.
//
//   - projects/<project>/<session>.jsonl names the session directly.
//   - <session>/subagents/<file> is that session's subagent transcript.
//   - A workflow transcript (…/subagents/workflows/<workflow>/<file>) only
//     looks like the second shape once: its second-to-last segment is the
//     workflow id, so it is attributed to the workflow, not the session.
//   - Anything else uses the second-to-last segment as the session and
//     everything above it as the project.
func PathSessionParts(path string) (sessionID, projectPath string) {
	parts := pathComponents(path)
	relative := parts
	for index, part := range parts {
		if part == "projects" {
			relative = parts[index+1:]
			break
		}
	}

	fileSessionID := ""
	hasFileSessionID := false
	if count := len(relative); count > 0 {
		if name := relative[count-1]; strings.HasSuffix(name, ".jsonl") {
			if id := strings.TrimSuffix(name, ".jsonl"); id != "" {
				fileSessionID, hasFileSessionID = id, true
			}
		}
	}

	if len(relative) == 2 && hasFileSessionID {
		return fileSessionID, relative[0]
	}

	if count := len(relative); count >= 4 && relative[count-2] == "subagents" {
		project := strings.Join(relative[:count-3], string(filepath.Separator))
		if project == "" {
			return relative[count-3], "Unknown Project"
		}
		return relative[count-3], project
	}

	sessionID = "unknown"
	if count := len(relative); count > 0 {
		index := count - 2
		if index < 0 {
			index = 0
		}
		sessionID = relative[index]
	}
	if len(relative) > 2 {
		return sessionID, strings.Join(relative[:len(relative)-2], string(filepath.Separator))
	}
	return sessionID, "Unknown Project"
}

// pathComponents splits a path into the segments Path::components() yields as
// strings: separator runs collapse (both separators on Windows), empty
// segments vanish, and "." components are dropped. ".." is kept, as Rust keeps
// it. Adapter-discovered paths always contain "projects" and never contain a
// "." segment, which is the case this split has to be exact for.
func pathComponents(path string) []string {
	components := []string{}
	start := 0
	for index := 0; index <= len(path); index++ {
		if index < len(path) && !isSeparatorByte(path[index]) {
			continue
		}
		if index > start {
			if segment := path[start:index]; segment != "." {
				components = append(components, segment)
			}
		}
		start = index + 1
	}
	return components
}

// PruneByMTime ports split_files_before_since (paths.rs:117-172): it drops the
// session groups whose files were all last written before the --since window.
//
// Transcripts are append-only, so a file last written before the window opened
// cannot hold an entry inside it. Files are kept or dropped per connected
// group of session ids, because deduplication matches sidechain replays
// against their parent by session id across files (subagent and workflow
// transcripts, legacy flat agent-*.jsonl files, copies in another config
// root): dropping a parent alone would let its replay count twice.
//
// sinceDate is the compact YYYYMMDD form. An empty or unparsable bound, a
// window that opens ahead of the clock, and an unreadable mtime all keep every
// file. --until never narrows the file list.
func PruneByMTime(files []SessionFile, sinceDate string, timezone string, now time.Time, pruned func(string)) ([]SessionFile, error) {
	if sinceDate == "" {
		return files, nil
	}
	location, err := pruneLocation(timezone)
	if err != nil {
		return nil, err
	}
	sinceMillis, ok := sinceBoundMillis(sinceDate, location)
	if !ok {
		return files, nil
	}
	if sinceMillis > now.UnixMilli() {
		// Entry timestamps can outrun any mtime the filesystem reports when
		// the window starts in the future, so an mtime cannot rule a file out
		// (paths.rs:132-136).
		return files, nil
	}
	threshold := sinceMillis - mtimePruneMarginMs

	// Union every file's session ids so files sharing any id share a group
	// (paths.rs:139-152).
	groups := &sessionGroups{ids: map[string]int{}}
	fileGroups := make([]int, len(files))
	for index, file := range files {
		group := groups.id(file.SessionID)
		if recorded, ok := recordedSessionID(file.Path); ok {
			groups.union(group, groups.id(recorded))
		}
		fileGroups[index] = group
	}
	liveGroups := map[int]bool{}
	for index, file := range files {
		if !file.MTimeKnown || file.MTime.UnixMilli() >= threshold {
			liveGroups[groups.root(fileGroups[index])] = true
		}
	}

	kept := make([]SessionFile, 0, len(files))
	for index, file := range files {
		if liveGroups[groups.root(fileGroups[index])] {
			kept = append(kept, file)
			continue
		}
		if pruned != nil {
			pruned(file.Path)
		}
	}
	return kept, nil
}

// pruneLocation resolves the configured timezone for the mtime bound. An
// unparsable zone is an error: pruning in the wrong zone would silently drop a
// day of the window at the boundary.
func pruneLocation(timezone string) (*time.Location, error) {
	switch timezone {
	case "", "local":
		// parse_tz (date_utils.rs:301-307) and its system fallback.
		return time.Local, nil
	case "UTC":
		return time.UTC, nil
	}
	location, err := contract.LoadLocation(timezone)
	if err != nil {
		return nil, fmt.Errorf("Unable to load the timezone %s for the Claude since prune: %s", timezone, err.Error())
	}
	return location, nil
}

// sinceBoundMillis is date_range_bounds_ms' start bound (date_utils.rs:212-241)
// for one compact YYYYMMDD date. ok is false for anything that is not a full
// valid compact date, which leaves the window open.
func sinceBoundMillis(value string, location *time.Location) (int64, bool) {
	if len(value) != 8 {
		return 0, false
	}
	digits := make([]int, 8)
	for index := 0; index < 8; index++ {
		character := value[index]
		if character < '0' || character > '9' {
			return 0, false
		}
		digits[index] = int(character - '0')
	}
	year := digits[0]*1000 + digits[1]*100 + digits[2]*10 + digits[3]
	month := time.Month(digits[4]*10 + digits[5])
	day := digits[6]*10 + digits[7]
	// IsoDate::from_ymd (date_utils.rs:81-86): an impossible calendar date is
	// rejected rather than rolled over.
	if month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month) {
		return 0, false
	}
	return startOfDayMillis(year, month, day, location), true
}

// daysInMonth is days_in_month (date_utils.rs:254-262).
func daysInMonth(year int, month time.Month) int {
	switch month {
	case 1, 3, 5, 7, 8, 10, 12:
		return 31
	case 4, 6, 9, 11:
		return 30
	case 2:
		if (year%4 == 0 && year%100 != 0) || year%400 == 0 {
			return 29
		}
		return 28
	}
	return 0
}

// startOfDayMillis is start_of_day_ms (date_utils.rs:227-241): the first
// instant of the local day. A midnight erased by a spring-forward transition
// resolves to the first instant that exists, so a bound never lands in the
// neighbouring day.
func startOfDayMillis(year int, month time.Month, day int, location *time.Location) int64 {
	wanted := fmt.Sprintf("%04d-%02d-%02d", year, int(month), day)
	start := time.Date(year, month, day, 0, 0, 0, 0, location)
	if start.In(location).Format("2006-01-02") == wanted {
		return start.UnixMilli()
	}

	// Go maps a civil time inside a gap onto the offset after the transition,
	// which for a midnight transition lands on the previous local day. jiff,
	// which ccusage pins, keeps the offset in effect before the transition and
	// so returns the first instant of the requested day (verified against
	// jiff 0.2.38: America/Havana 2026-03-08 resolves to 05:00:00Z, and Go's
	// plain time.Date returns 04:00:00Z). Search for the day flip instead.
	low := start
	high := start.Add(24 * time.Hour)
	for high.In(location).Format("2006-01-02") < wanted && high.Sub(start) < 7*24*time.Hour {
		high = high.Add(24 * time.Hour)
	}
	if high.In(location).Format("2006-01-02") < wanted {
		// The requested date does not exist in this zone (a whole local day
		// was skipped); the bound stays where the search left it.
		return high.UnixMilli()
	}
	for high.Sub(low) > time.Millisecond {
		middle := low.Add(high.Sub(low) / 2)
		if middle.In(location).Format("2006-01-02") >= wanted {
			high = middle
		} else {
			low = middle
		}
	}
	return high.UnixMilli()
}

// recordedSessionID returns the first sessionId a transcript records, which is
// the session its entries are attributed to (paths.rs:207-234). Reading stops
// at the first line that names one; a line whose sessionId is null, is not a
// string, or does not parse does not match and the probe moves on. ok is false
// when no line records one, and an I/O error reads the same way, matching the
// Rust probe's `ok()?` chain.
func recordedSessionID(path string) (string, bool) {
	file, err := os.Open(path)
	if err != nil {
		return "", false
	}
	defer file.Close()

	var probe struct {
		SessionID *string `json:"sessionId"`
	}
	reader := bufio.NewReader(file)
	for {
		line, readErr := reader.ReadBytes('\n')
		if bytes.Contains(line, sessionIDMarker) {
			probe.SessionID = nil
			// encoding/json accepts the shapes serde does here (an object with
			// a string or null sessionId, unknown fields ignored) except that
			// it keeps the last of two duplicate keys where serde rejects the
			// line. Claude Code never writes duplicate keys, and a wrong id
			// only changes which stale group a file joins.
			if json.Unmarshal(line, &probe) == nil && probe.SessionID != nil {
				return *probe.SessionID, true
			}
		}
		if readErr != nil {
			return "", false
		}
	}
}

// sessionGroups is the union-find over session ids (paths.rs:174-205), with
// the same path-halving lookup.
type sessionGroups struct {
	ids     map[string]int
	parents []int
}

func (groups *sessionGroups) id(session string) int {
	if id, ok := groups.ids[session]; ok {
		return id
	}
	id := len(groups.parents)
	groups.parents = append(groups.parents, id)
	groups.ids[session] = id
	return id
}

func (groups *sessionGroups) root(id int) int {
	for groups.parents[id] != id {
		groups.parents[id] = groups.parents[groups.parents[id]]
		id = groups.parents[id]
	}
	return id
}

func (groups *sessionGroups) union(left, right int) {
	leftRoot, rightRoot := groups.root(left), groups.root(right)
	groups.parents[leftRoot] = rightRoot
}
