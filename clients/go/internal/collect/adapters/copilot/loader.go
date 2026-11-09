package copilot

import (
	"sort"
	"sync"
	"time"

	"github.com/MisonL/TokenBoard/clients/go/internal/collect/adapters/tools"
	"github.com/MisonL/TokenBoard/clients/go/internal/nativepricing"
)

// This file ports load_entries and load_entries_inner (loader.rs:22-125, 434-521):
// reading every source file, the reconciliation, the OTel suppression and the
// conversion into the shared tools.Entry every tool report is built from.

// LoadInput is what Load reads besides the files: the shared options and the
// window, in both of the forms copilot needs (the string comparison the report
// filter uses and the millisecond bounds the reconciliation uses).
type LoadInput struct {
	Options tools.Options
	// Since and Until are the string window the report filter compares dates
	// with (filter_loaded_entries_by_date); the reconciliation reads them too
	// (loader.rs:81-85). An absent bound is the empty string.
	Since string
	Until string
	// SinceMs and UntilMs are tools.DateRangeBoundsMs(Since, Until, timezone):
	// the half-open window the session-state reconciliation narrows itself by.
	SinceMs *int64
	UntilMs *int64
	// Now replaces utc_now - the timestamp an OTel record whose file has no
	// readable mtime falls back to. Zero means time.Now(); tests pin it.
	Now time.Time
}

// Load is load_entries (loader.rs:22-36): every Copilot row, priced, dated in
// the report timezone and sorted by timestamp. The string window is not
// applied here - the caller filters by Date, as filter_loaded_entries_by_date
// does (loader.rs:34).
func Load(input LoadInput) ([]tools.Entry, error) {
	o := input.Options
	sources, err := SourcePaths(o)
	if err != nil {
		return nil, err
	}
	now := input.Now
	if now.IsZero() {
		now = time.Now()
	}
	ceiling := now.UnixMilli()
	parsed := make([]SourceUsage, len(sources))
	failures := make([]error, len(sources))
	// Files are read in parallel but keep their discovery order, so the merge
	// below is the serial one.
	var group sync.WaitGroup
	for index, source := range sources {
		group.Add(1)
		go func(index int, source SourceFile) {
			defer group.Done()
			usage, err := readSourceFile(source, ceiling)
			parsed[index], failures[index] = usage, err
		}(index, source)
	}
	group.Wait()

	otelEntries := []Entry{}
	sessionStateEntries := []Entry{}
	creditSnapshots := []CreditSnapshot{}
	for index, source := range sources {
		if err := failures[index]; err != nil {
			// A failed file only loses its own rows (loader.rs:54-68).
			kind := "OTEL"
			if source.Kind == KindSessionState {
				kind = "session-state"
			}
			if o.Debug != nil {
				o.Debug("Failed to read Copilot " + kind + " file " + source.Path + ": " + err.Error())
			}
			continue
		}
		switch source.Kind {
		case KindOtel:
			otelEntries = append(otelEntries, parsed[index].Entries...)
		case KindSessionState:
			sessionStateEntries = append(sessionStateEntries, parsed[index].Entries...)
			creditSnapshots = append(creditSnapshots, parsed[index].CreditSnapshots...)
		}
	}

	otelSessions := map[string]bool{}
	for _, entry := range otelEntries {
		otelSessions[entry.SessionID] = true
	}
	reconciliation := Reconcile(ReconcileInput{
		Entries:        sessionStateEntries,
		Snapshots:      creditSnapshots,
		OTelEntries:    otelEntries,
		Since:          input.Since,
		Until:          input.Until,
		SinceMs:        input.SinceMs,
		UntilMs:        input.UntilMs,
		Timezone:       input.Options.Timezone,
		SkippedSession: func(sessionID string) bool { return otelSessions[sessionID] },
	})
	// OpenTelemetry rows record every model call, so sessions that have them
	// are left to that source rather than to the coarser credit totals.
	kept := otelEntries[:0]
	for _, entry := range otelEntries {
		after, suppressed := reconciliation.OTelAfter[otelKey(entry.SessionID, entry.Model)]
		if !suppressed || entry.Timestamp > after {
			kept = append(kept, entry)
		}
	}

	merged := make([]Entry, 0, len(reconciliation.Intervals)+len(kept)+len(reconciliation.Gaps))
	merged = append(merged, reconciliation.Intervals...)
	merged = append(merged, kept...)
	merged = append(merged, reconciliation.Gaps...)
	entries := make([]tools.Entry, 0, len(merged))
	for _, entry := range merged {
		entries = append(entries, usageEntryToLoaded(entry, input.Options))
	}
	sort.SliceStable(entries, func(i, j int) bool { return entries[i].Timestamp < entries[j].Timestamp })
	return entries, nil
}

// readSourceFile is read_source_file (loader.rs:434-442).
func readSourceFile(source SourceFile, ceiling int64) (SourceUsage, error) {
	switch source.Kind {
	case KindOtel:
		entries, err := parseOtelFile(source.Path, ceiling)
		if err != nil {
			return SourceUsage{}, err
		}
		return SourceUsage{Entries: entries}, nil
	default:
		return parseSessionStateFile(source.Path)
	}
}

// usageEntryToLoaded is usage_entry_to_loaded (loader.rs:458-521). Pricing
// goes through nativepricing.Cost with the entry's timestamp (find_at), the
// mode, and the reported cost a credit gap carries; the extra total tokens
// join the output bucket for the bill only, never in the stored usage.
func usageEntryToLoaded(entry Entry, o tools.Options) tools.Entry {
	at := tools.PriceAt(entry.Timestamp)
	costUsage := nativepricing.Usage{
		Input:         tools.TokenCount(entry.Input),
		Output:        tools.TokenCount(tools.SaturatingAddU64(entry.Output, entry.Extra)),
		CacheCreate5m: tools.TokenCount(entry.CacheCreation),
		CacheRead:     tools.TokenCount(entry.CacheRead),
		ReportedCost:  entry.CostUSD,
	}
	cost, missing := nativepricing.Cost(o.Corpus, entry.Model, costUsage, at, o.Mode, false, false)
	// Copilot uses missing_pricing_model_for_usage (cost.rs:48-59): quiet under
	// --mode display and under auto when the entry reports its cost (a credit
	// gap does), quiet for an entry without tokens, and otherwise a miss on the
	// static lookup Find - not the timestamped one. A credit gap ("unknown",
	// zero tokens) therefore never reaches unpricedModels.
	if o.Mode == nativepricing.ModeDisplay || (o.Mode == nativepricing.ModeAuto && entry.CostUSD != nil) ||
		costUsage.Input+costUsage.Output+costUsage.CacheCreate5m+costUsage.CacheRead == 0 {
		missing = false
	} else if _, ok := o.Corpus.Find(entry.Model); ok {
		missing = false
	}
	var messageCount *uint64
	if entry.RequestCount > 0 {
		count := entry.RequestCount
		messageCount = &count
	}
	// The session accumulator reads the entry's own timestamp for
	// lastActivity/firstActivity (copilot's report passes
	// include_session_metadata=true, loader.rs:509 + report.rs).

	return tools.Entry{
		Timestamp: entry.Timestamp,
		Date:      tools.FormatDateTZ(entry.Timestamp, o.Timezone),
		Model:     entry.Model,
		Usage: tools.Usage{
			Input:         entry.Input,
			Output:        entry.Output,
			CacheCreation: entry.CacheCreation,
			CacheRead:     entry.CacheRead,
			Extra:         entry.Extra,
		},
		CostUSD:        cost,
		ReportedCost:   entry.CostUSD,
		SessionID:      entry.SessionID,
		MessageID:      entry.DedupKey,
		ProjectPath:    "GitHub Copilot CLI",
		MessageCount:   messageCount,
		MissingPricing: missing,
		LastActivity:   entry.Timestamp,
		FirstActivity:  entry.Timestamp,
	}
}
