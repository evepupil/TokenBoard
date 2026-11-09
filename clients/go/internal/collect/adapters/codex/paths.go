package codex

// The discovery layer of ccusage's Codex adapter, ported from v20.0.33
// (commit 1308c416): rust/adapters/codex/src/paths.rs, reader.rs and the
// home_dir helper in crates/ccusage-core/src/home.rs. Every rule cites its
// source, because this layer decides which transcripts are read at all.
//
// Nothing here reads file contents: the reader (Task 2) owns bytes. A file
// that this layer drops never reaches the parser, so the pruning rules below
// are the only place where `--since`/`--until` may shrink the scan.

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
	"unicode/utf8"
)

// Source is one directory tree to scan (paths.rs:34-73): sessions and
// archived_sessions of one home, or the home itself when it has neither. The
// scope key drives the cross-source file dedupe.
type Source struct {
	Dir         string
	DedupeScope string
}

// FileGroup is one source's surviving file list, in discovery order.
type FileGroup struct {
	Dir   string
	Files []string
}

// ResolveHomeDir is home_dir (home.rs:3-32): the first non-empty candidate of
// $HOME, $USERPROFILE, $HOMEDRIVE+$HOMEPATH. os.UserHomeDir alone misses the
// Windows fallback pair, and an all-empty result is the caller's error case.
func ResolveHomeDir(env func(string) (string, bool)) (string, error) {
	for _, key := range []string{"HOME", "USERPROFILE"} {
		if value, ok := env(key); ok && strings.TrimSpace(value) != "" {
			return value, nil
		}
	}
	drive, hasDrive := env("HOMEDRIVE")
	path, hasPath := env("HOMEPATH")
	if hasDrive && hasPath && strings.TrimSpace(drive) != "" && strings.TrimSpace(path) != "" {
		return drive + path, nil
	}
	return "", errors.New("codex: home directory is not set")
}

// HomePaths is codex_home_paths (paths.rs:236-247): a set CODEX_HOME is a
// comma list, trimmed, empty entries dropped - and a set-but-empty value
// yields zero homes rather than a fallback (the empty result surfaces as an
// empty report downstream). An unset variable falls back to <home>/.codex.
//
// The lookup seam must distinguish unset from set-to-empty, which os.Getenv
// cannot; production passes os.LookupEnv.
func HomePaths(env func(string) (string, bool), homeDir func() (string, error)) ([]string, error) {
	if raw, ok := env("CODEX_HOME"); ok {
		homes := []string{}
		for _, part := range strings.Split(raw, ",") {
			if trimmed := strings.TrimSpace(part); trimmed != "" {
				homes = append(homes, trimmed)
			}
		}
		return homes, nil
	}
	home, err := homeDir()
	if err != nil {
		return nil, fmt.Errorf("codex: home directory is not set: %w", err)
	}
	return []string{filepath.Join(home, ".codex")}, nil
}

// UsageSources is codex_usage_sources_from_homes (paths.rs:34-67): per home,
// sessions first, then archived_sessions, then the home itself when it has
// neither. Identical directory paths dedupe by literal path - no
// canonicalization, matching the Rust set.
func UsageSources(homes []string) []Source {
	sources := []Source{}
	seen := map[string]bool{}
	consider := func(dir, scope string) {
		if !seen[dir] {
			seen[dir] = true
			sources = append(sources, Source{Dir: dir, DedupeScope: scope})
		}
	}
	for _, home := range homes {
		sessions := filepath.Join(home, "sessions")
		archived := filepath.Join(home, "archived_sessions")
		foundUsageDir := false
		if isDir(sessions) {
			consider(sessions, home)
			foundUsageDir = true
		}
		if isDir(archived) {
			consider(archived, home)
			foundUsageDir = true
		}
		if !foundUsageDir {
			consider(home, home)
		}
	}
	return sources
}

func isDir(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.IsDir()
}

// isRolloutFile is is_rollout_file (reader.rs:9-20): extension exactly
// "jsonl", or "zst" whose stem still ends in "jsonl". Case sensitive.
func isRolloutFile(name string) bool {
	if filepath.Ext(name) == ".jsonl" {
		return true
	}
	if filepath.Ext(name) == ".zst" {
		return filepath.Ext(strings.TrimSuffix(name, ".zst")) == ".jsonl"
	}
	return false
}

// uncompressedRolloutPath maps x.jsonl.zst to x.jsonl for dedupe keys
// (reader.rs:22-26).
func uncompressedRolloutPath(path string) string {
	return strings.TrimSuffix(path, ".zst")
}

// CollectFiles is collect_codex_usage_files (paths.rs:77-95): recurse without
// following symlinks, keep regular *.jsonl[.zst] files, sort by full path, and
// drop a compressed twin whose plain copy also exists (the sort puts
// x.jsonl before x.jsonl.zst, so the plain copy wins the retain). An
// unreadable directory contributes nothing, like Rust's read_dir error path.
func CollectFiles(dir string) []string {
	files := []string{}
	err := filepath.WalkDir(dir, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			// A missing root or an unreadable subtree yields an empty list
			// rather than an error (paths.rs:82 delegates to read_dir).
			return nil
		}
		if entry.IsDir() {
			return nil
		}
		if !entry.Type().IsRegular() {
			// Symbolic links are neither collected nor followed
			// (collect_files_matching only stats non-symlink entries).
			return nil
		}
		if isRolloutFile(entry.Name()) {
			files = append(files, path)
		}
		return nil
	})
	if err != nil {
		return nil
	}
	sort.Strings(files)
	seen := map[string]bool{}
	kept := files[:0]
	for _, file := range files {
		if seen[uncompressedRolloutPath(file)] {
			continue
		}
		seen[uncompressedRolloutPath(file)] = true
		kept = append(kept, file)
	}
	return kept
}

// CollectDedupedSources is collect_deduped_codex_usage_files (paths.rs:99-115):
// per source, keep the files whose (dedupe scope, uncompressed relative path)
// key has not been claimed by an earlier source. Every source produces a
// group, even an empty one, so callers keep the source order.
func CollectDedupedSources(sources []Source) []FileGroup {
	seen := map[string]bool{}
	groups := make([]FileGroup, 0, len(sources))
	for _, source := range sources {
		kept := []string{}
		for _, file := range CollectFiles(source.Dir) {
			relative, err := filepath.Rel(source.Dir, file)
			if err != nil {
				relative = file
			}
			key := source.DedupeScope + "\x00" + uncompressedRolloutPath(relative)
			if seen[key] {
				continue
			}
			seen[key] = true
			kept = append(kept, file)
		}
		groups = append(groups, FileGroup{Dir: source.Dir, Files: kept})
	}
	return groups
}

// pathDate is a civil calendar date (jiff::civil::Date) reduced to a yyyymmdd
// integer so bounds compare as numbers.
type pathDate int

func (d pathDate) year() int  { return int(d) / 10000 }
func (d pathDate) month() int { return int(d) / 100 % 100 }
func (d pathDate) day() int   { return int(d) % 100 }
func (d pathDate) valid() bool {
	month := d.month()
	if d.year() < 1 || month < 1 || month > 12 {
		return false
	}
	return d.day() >= 1 && d.day() <= daysInMonth(d.year(), month)
}

// daysInMonth follows the Gregorian calendar jiff::civil::Date enforces.
func daysInMonth(year, month int) int {
	switch month {
	case 4, 6, 9, 11:
		return 30
	case 2:
		if year%4 == 0 && (year%100 != 0 || year%400 == 0) {
			return 29
		}
		return 28
	default:
		return 31
	}
}

// parseDatePart is parse_date_part (paths.rs:220-227): exactly `length` ASCII
// digits.
func parseDatePart(value string, length int) (int, bool) {
	if len(value) != length {
		return 0, false
	}
	number := 0
	for i := 0; i < len(value); i++ {
		if value[i] < '0' || value[i] > '9' {
			return 0, false
		}
		number = number*10 + int(value[i]-'0')
	}
	return number, true
}

// parseCompactDate is parse_compact_date (paths.rs:210-218): exactly eight
// ASCII digits forming a real calendar date.
func parseCompactDate(value string) (pathDate, bool) {
	if len(value) != 8 {
		return 0, false
	}
	year, okY := parseDatePart(value[:4], 4)
	month, okM := 0, false
	day, okD := 0, false
	if okY {
		month, okM = parseDatePart(value[4:6], 2)
		if okM {
			day, okD = parseDatePart(value[6:8], 2)
		}
	}
	if !okY || !okM || !okD {
		return 0, false
	}
	date := pathDate(year*10000 + month*100 + day)
	return date, date.valid()
}

// codexFileDate is codex_file_date (paths.rs:196-208): the first run of three
// path components shaped like a real YYYY/MM/DD, read from the path relative
// to the sessions root.
func codexFileDate(sessionsDir, file string) (pathDate, bool) {
	relative, err := filepath.Rel(sessionsDir, file)
	if err != nil {
		relative = file
	}
	parts := strings.Split(relative, string(filepath.Separator))
	for i := 0; i+2 < len(parts); i++ {
		year, okY := parseDatePart(parts[i], 4)
		month, okM := parseDatePart(parts[i+1], 2)
		day, okD := parseDatePart(parts[i+2], 2)
		if !okY || !okM || !okD {
			continue
		}
		date := pathDate(year*10000 + month*100 + day)
		if date.valid() {
			return date, true
		}
	}
	return 0, false
}

// filterEligibility is CodexFileEligibility (paths.rs:137-176). Both bounds
// arrive pre-normalized to YYYYMMDD; a bound that does not parse disables
// pruning entirely (parse failure is None in Rust, and the provider rejects
// malformed bounds before this layer).
type filterEligibility struct {
	sinceDate     pathDate
	untilPathDate pathDate
	sinceMillis   int64
	hasSince      bool
	hasUntil      bool
}

func newFilterEligibility(since, until, timezone string) *filterEligibility {
	sinceDate, hasSince := parseCompactDate(since)
	untilDate, hasUntil := parseCompactDate(until)
	if !hasSince && !hasUntil {
		return nil
	}
	location, err := time.LoadLocation(timezone)
	if err != nil {
		// parse_tz falls back to the system zone (paths.rs:146-147).
		location = time.Local
	}
	eligibility := &filterEligibility{sinceDate: sinceDate, untilPathDate: untilDate}
	if hasSince {
		midnight := time.Date(sinceDate.year(), time.Month(sinceDate.month()), sinceDate.day(), 0, 0, 0, 0, location)
		eligibility.sinceMillis = midnight.UnixMilli()
		eligibility.hasSince = true
	}
	if hasUntil {
		nextMidnight := time.Date(untilDate.year(), time.Month(untilDate.month()), untilDate.day(), 0, 0, 0, 0, location).AddDate(0, 0, 1)
		utc := nextMidnight.UTC()
		eligibility.untilPathDate = pathDate(utc.Year()*10000 + int(utc.Month())*100 + utc.Day())
		eligibility.hasUntil = true
	}
	return eligibility
}

// contains is CodexFileEligibility::contains (paths.rs:165-175): the until
// bound compares path dates only; the since bound passes when the path date is
// in range or the file's mtime is at or after the since midnight. A missing
// path date or mtime keeps the file.
func (e *filterEligibility) contains(startDate pathDate, hasStartDate bool, modifiedMillis int64, hasModified bool) bool {
	if e.hasUntil && hasStartDate && startDate > e.untilPathDate {
		return false
	}
	if !e.hasSince {
		return true
	}
	if !hasStartDate {
		// start_date.is_none_or(...) is true: no date to compare (paths.rs:171).
		return true
	}
	if startDate >= e.sinceDate {
		return true
	}
	if !hasModified {
		return true
	}
	return modifiedMillis >= e.sinceMillis
}

func fileModifiedMillis(file string) (int64, bool) {
	info, err := os.Stat(file)
	if err != nil {
		return 0, false
	}
	if info.ModTime().Before(time.Unix(0, 0)) {
		return 0, false
	}
	return info.ModTime().UnixMilli(), true
}

// FilterByEligibility is filter_codex_usage_files (paths.rs:117-135).
func FilterByEligibility(sessionsDir string, files []string, since, until, timezone string) []string {
	eligibility := newFilterEligibility(since, until, timezone)
	if eligibility == nil {
		return files
	}
	kept := make([]string, 0, len(files))
	for _, file := range files {
		startDate, hasStartDate := codexFileDate(sessionsDir, file)
		modifiedMillis, hasModified := fileModifiedMillis(file)
		if eligibility.contains(startDate, hasStartDate, modifiedMillis, hasModified) {
			kept = append(kept, file)
		}
	}
	return kept
}

// SessionID is codex_session_id (parser.rs:892-904): the path relative to the
// sessions root, uncompressed, without its extension, components joined by
// "/"; a non-UTF-8 component is dropped and an empty result is "unknown".
func SessionID(sessionsDir, file string) string {
	relative, err := filepath.Rel(sessionsDir, file)
	if err != nil {
		relative = file
	}
	uncompressed := uncompressedRolloutPath(relative)
	if extension := filepath.Ext(uncompressed); extension != "" {
		uncompressed = strings.TrimSuffix(uncompressed, extension)
	}
	parts := strings.Split(uncompressed, string(filepath.Separator))
	kept := make([]string, 0, len(parts))
	for _, part := range parts {
		// Path::components() drops CurDir and empty separators; ".." stays.
		if part == "" || part == "." {
			continue
		}
		if utf8.ValidString(part) {
			kept = append(kept, part)
		}
	}
	if len(kept) == 0 {
		return "unknown"
	}
	return strings.Join(kept, "/")
}
