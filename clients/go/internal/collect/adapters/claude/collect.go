package claude

// The collect entry point is the fifth layer of the port: it wires discovery
// (paths.go), the two line parsers (entry.go), the pricing pass (cost.go), the
// dedupe index (dedupe.go) and the report builders (daily.go, session.go) the
// same way ccusage's two report commands do, against ccusage v20.0.33
// (commit 1308c416):
//
//	rust/adapters/claude/src/paths.rs    usage_files, split_files_before_since
//	rust/adapters/claude/src/lib.rs      read_usage_file + push_deduped_entry (session chain)
//	rust/adapters/claude/src/daily.rs    read_daily_usage_file + push_deduped_daily_entry (daily chain)
//	rust/crates/ccusage-core/src/fast.rs ByteLines (line splitting)
//	rust/crates/ccusage/src/commands/mod.rs  run_daily, run_session
//
// The two chains are independent end to end. `ccusage claude daily` and
// `ccusage claude session` are separate processes upstream, each reading the
// files, pricing its own entries and running its own dedupe index; sharing one
// entry stream here would let one chain's parser or survives-set leak into the
// other. The daily parser accepts the AgentProgress wrapper and therefore sees
// a superset of lines (daily.rs:182-227).

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"time"
)

// Options configures one collection. Zero values mean "not configured": the
// caller (the claudecode provider) resolves the real timezone and roots.
type Options struct {
	// Timezone is the IANA zone every date is attributed to. It is required:
	// the zero value is NOT treated as UTC (see DailyOptions / SessionOptions).
	Timezone string
	// Since and Until bound the window in either documented spelling
	// (YYYY-MM-DD or YYYYMMDD, cli-parser parser.rs:1048); "" leaves that side
	// open. The provider validates them before calling here.
	Since string
	Until string
	// Roots is the resolved config-directory set (ResolveRoots). Empty Dirs is
	// an empty window, not an error.
	Roots Roots
	// Overrides is the provider's pricing.Prepare output; nil means none.
	Overrides map[string]any
	// Mode is ccusage's --mode. The zero value is ModeAuto, the ccusage
	// default (types.rs:65).
	Mode CostMode
	// Stderr receives progress lines such as the --since prune report. nil
	// discards them.
	Stderr func(string)
	// Now is the wall clock for clock-dependent decisions (the --since prune
	// bound). Zero means time.Now(); tests pin it.
	Now time.Time
}

// Collect produces the two ccusage-compatible reports for one collection:
// the daily document and the session document, both already-priced,
// deduplicated and date-filtered JSON.
//
// It does NOT normalize into contract snapshots; the provider feeds the two
// documents through ccusage.DecodeJSON and NormalizeCcusageDailyJSON.
//
// An empty window (no roots, no transcripts, everything pruned, every line
// dropped) returns the empty report documents, not nil and not an error.
func Collect(ctx context.Context, opts Options) (dailyJSON, sessionsJSON []byte, err error) {
	if err := ctx.Err(); err != nil {
		return nil, nil, err
	}
	now := opts.Now
	if now.IsZero() {
		now = time.Now()
	}
	stderr := opts.Stderr
	if stderr == nil {
		stderr = func(string) {}
	}

	// ScanFiles sorts by full path, and that order decides which duplicate
	// wins the dedupe (paths.rs:77). It must not be re-sorted or split across
	// goroutines.
	files, err := ScanFiles(opts.Roots, "")
	if err != nil {
		return nil, nil, err
	}
	// --since drops whole session groups from the file list; --until never
	// narrows it (paths.rs:117-172). Both report commands prune this way:
	// run_daily via daily.rs:36 and run_session via load_entries_since.
	files, err = PruneByMTime(files, compactDateBound(opts.Since), opts.Timezone, now, func(path string) {
		stderr("claude: skipping " + path + ": session last written before the --since window")
	})
	if err != nil {
		return nil, nil, err
	}

	// One pricing function per collection, exactly like each ccusage command
	// loads its pricing map once and prices every entry before dedup.
	cost, err := NewCostFunc(opts.Overrides, opts.Mode)
	if err != nil {
		return nil, nil, err
	}

	dailyEntries, err := streamChain(ctx, files, ParseDailyLineEntries, cost, NewDedupe(DedupeDaily))
	if err != nil {
		return nil, nil, err
	}
	sessionEntries, err := streamChain(ctx, files, ParseLineEntries, cost, NewDedupe(DedupeEntry))
	if err != nil {
		return nil, nil, err
	}

	dailyJSON = BuildDaily(dailyEntries, DailyOptions{
		Timezone: opts.Timezone,
		Since:    opts.Since,
		Until:    opts.Until,
	})
	sessionsJSON = BuildSessions(sessionEntries, SessionOptions{
		Timezone: opts.Timezone,
		Since:    opts.Since,
		Until:    opts.Until,
	})
	return dailyJSON, sessionsJSON, nil
}

// compactDateBound normalizes a --since bound to the compact YYYYMMDD form
// that parse_compact_date reads (date_utils.rs:179-204, 212-230), the way
// normalize_date_bound compacts the dashed spelling (cli/src/types.rs:82-110).
// Anything else passes through: an unparsable bound keeps every file, which is
// PruneByMTime's rule and matches date_range_bounds_ms returning None.
func compactDateBound(value string) string {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return ""
	}
	return strings.ReplaceAll(trimmed, "-", "")
}

// streamChain reads every kept transcript in discovery order, parses each line
// with parse, prices and indexes every resulting entry, and returns the dedupe
// survivors in first-seen order.
func streamChain(ctx context.Context, files []SessionFile, parse func(string) []Entry, cost CostFunc, index *Dedupe) ([]Entry, error) {
	for _, file := range files {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		if err := streamFile(ctx, file, parse, cost, index); err != nil {
			return nil, err
		}
	}
	return index.Entries(), nil
}

// streamFile feeds one transcript's lines through the chain.
//
// Every error here is a hard error, which is a deliberate divergence from
// ccusage: its loaders do `let Ok(content) = fs::read(path) else { return
// empty }` (lib.rs:505, daily.rs:298) and silently treat an unreadable
// transcript as an empty one. TokenBoard's collection contract is
// "a real read failure must be reported, never silently dropped"
// (AGENTS.md), so an unreadable file fails the whole collection instead of
// under-counting the user's usage.
func streamFile(ctx context.Context, file SessionFile, parse func(string) []Entry, cost CostFunc, index *Dedupe) error {
	handle, err := os.Open(file.Path)
	if err != nil {
		return fmt.Errorf("claude: open %s: %w", file.Path, err)
	}
	// A deferred Close keeps the read path simple; closing a read-only handle
	// cannot lose data, so its error is not worth failing the collection over.
	defer handle.Close()

	reader := bufio.NewReader(handle)
	for {
		// ReadBytes has no line-length cap (bufio.Scanner's 64 KiB token limit
		// would drop long transcript lines), and it returns the final
		// unterminated chunk together with io.EOF, so the last line still
		// counts - the same split as ByteLines (fast.rs:82-99).
		raw, readErr := reader.ReadBytes('\n')
		if len(raw) > 0 {
			if err := ctx.Err(); err != nil {
				return err
			}
			line := trimLineEnding(raw)
			entries := parse(string(line))
			for position := range entries {
				// Session identity comes from the PATH, not the line
				// (lib.rs:498-499, daily.rs:292-293). file.SessionID and
				// file.ProjectPath are ScanFiles' PathSessionParts results;
				// ProjectPath is what the session report groups on, and
				// PathSessionID is what dedupe falls back to when the line has
				// no sessionId (lib.rs:405-411).
				entries[position].PathSessionID = file.SessionID
				entries[position].ProjectPath = file.ProjectPath
				// Price before Add: the daily replacement ladder compares Cost
				// (daily.rs:317-330, 592-599).
				entries[position].Cost, entries[position].MissingPricing = cost(
					entries[position].Model, entries[position].Usage, entries[position].Timestamp)
				index.Add(entries[position])
			}
		}
		if readErr != nil {
			if errors.Is(readErr, io.EOF) {
				return nil
			}
			return fmt.Errorf("claude: read %s: %w", file.Path, readErr)
		}
	}
}

// trimLineEnding drops the \n ReadBytes kept and a trailing \r before it.
//
// Upstream does not strip \r: serde_json (and the scanner here) treats it as
// trailing whitespace, so a CRLF line parses identically either way. Removing
// it keeps the string the parser sees free of a character that only a Windows
// transcript carries.
func trimLineEnding(line []byte) []byte {
	line = bytes.TrimSuffix(line, []byte("\n"))
	return bytes.TrimSuffix(line, []byte("\r"))
}
