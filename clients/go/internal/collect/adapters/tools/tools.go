// Package tools holds the shared layer for the twelve ccusage tool-source
// adapters (amp, droid, codebuff, hermes, goose, kilo, gemini, kimi, qwen,
// zcode, openclaw and, in its own package, copilot). Each adapter reads one
// tool's local logs and produces the same report shape `ccusage <tool>
// daily|session --json` prints, so the existing normalize path can turn it into
// a contract.Snapshot unchanged.
//
// The rules here are ports of ccusage v20.0.33 (commit 1308c416):
// rust/adapters/common/src/{lib,jsonl,report}.rs and
// rust/crates/ccusage-core/src/{utils,date_utils,agent_report,output,summary}.rs.
// Every function names the Rust function it mirrors.
package tools

// ReportKind is one of the three CLI-reachable report granularities
// (STANDARD_AGENT_REPORTS, types.rs:199-203). Weekly exists in the Rust report
// layer but no CLI subcommand reaches it, so it is deliberately absent here.
type ReportKind int

const (
	// Daily groups by local calendar day.
	Daily ReportKind = iota
	// Monthly groups by local calendar month.
	Monthly
	// Session groups by session identifier.
	Session
)

// Usage is the token accounting one entry contributes. Extra carries tokens a
// source reported beyond the four named buckets; it is folded into the cost
// formula by the caller and into totalTokens by the report layer, and it is
// never emitted in a model breakdown (types.rs:98-112).
type Usage struct {
	Input         uint64
	Output        uint64
	CacheCreation uint64
	CacheRead     uint64
	Extra         uint64
}

// Total is input + output + cache creation + cache read + extra.
func (u Usage) Total() uint64 {
	return u.Input + u.Output + u.CacheCreation + u.CacheRead + u.Extra
}

// Entry is one priced record. Date is the entry's local-time calendar day under
// the report timezone. CostUSD is nil when the source reported no cost.
type Entry struct {
	Timestamp int64 // epoch milliseconds
	Date      string
	Model     string // display name
	Usage     Usage
	// CostUSD is the final billed cost for this entry; the adapter computes it
	// with nativepricing and stores the result here.
	CostUSD float64
	// ReportedCost is the cost the source tool recorded, used as the pricing
	// input (calculate_cost_for_usage_at, cost.rs:31-46). Nil when absent.
	ReportedCost   *float64
	SessionID      string
	MessageID      string
	ProjectPath    string
	Version        string
	LastActivity   int64
	FirstActivity  int64
	MessageCount   *uint64
	Credits        *float64
	MissingPricing bool
}

// Breakdown is one model's row inside a report row (model_breakdowns).
type Breakdown struct {
	Model   string
	Usage   Usage
	Cost    float64
	Missing bool
}

// Row is one aggregated report row. Key is the period value (date, month or
// session id).
type Row struct {
	Key           string
	Usage         Usage
	Cost          float64
	ModelsUsed    []string
	Breakdowns    []Breakdown
	Credits       *float64
	MessageCount  *uint64
	LastActivity  int64
	FirstActivity int64
	ProjectPath   string
	Version       string
}

// Totals is the document totals block (totals_json, output.rs:79-121).
// UnpricedModels is derived from the row breakdowns at emission time
// (unpriced_models, output.rs:122-136), not carried here.
type Totals struct {
	Usage   Usage
	Cost    float64
	Credits *float64
}
