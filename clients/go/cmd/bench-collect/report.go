// Text output for bench-collect: this file turns a benchReport into what the
// operator reads. It consumes the report structs and never the measurement
// loop, and main.go stays the place where the run is wired together.
package main

import (
	"fmt"
	"io"
	"time"
)

// writeTextReport prints the summary, the per-round samples and every
// regression.
func writeTextReport(w io.Writer, report benchReport) {
	fmt.Fprintf(w, "bench-collect source=%s scenario=%s window=%s timezone=%s rounds=%d\n",
		report.Source, report.Scenario, report.Window.String(), report.Timezone, report.Rounds)
	fmt.Fprintf(w, "ccusage bin=%s platform=%s\n", report.CcusageBin, report.Platform)
	if report.CcusageConfigPath != "" {
		fmt.Fprintf(w, "pricing config=%s (%s catalogue) ccusageNetwork=%t\n",
			report.CcusageConfigPath, report.PricingSource, report.CcusageNetworkAllowed)
	}
	writeSideReport(w, report.Ccusage)
	writeSideReport(w, report.Native)
	if report.Ccusage.BytesReadPending || report.Native.BytesReadPending {
		fmt.Fprintf(w, "bytesRead: %d (pending — the adapter read counter lands in S2)\n", report.Ccusage.BytesRead)
	}
	for _, regression := range report.Regressions {
		fmt.Fprintf(w, "regression: %s\n", regression)
	}
	if !report.Regression && report.Native.Status == sideMeasured {
		fmt.Fprintf(w, "regression: none (native median wall %s vs ccusage %s)\n",
			formatDurationMs(report.Native.MedianWallMs), formatDurationMs(report.Ccusage.MedianWallMs))
	}
	for _, note := range report.Notes {
		fmt.Fprintf(w, "note: %s\n", note)
	}
}

func writeSideReport(w io.Writer, side sideReport) {
	if side.Status != sideMeasured {
		fmt.Fprintf(w, "%s: %s (no in-process provider for this source yet)\n", side.Kind, side.Status)
		return
	}
	fmt.Fprintf(w, "%s: measured (rss=%s)\n", side.Kind, side.RSSSource)
	for _, round := range side.Rounds {
		fmt.Fprintf(w, "  round %d wall=%s peak=%s output=%s bytesRead=%d%s calls=%d\n",
			round.Round,
			formatDurationMs(round.WallMs),
			formatBytes(round.PeakRSSBytes),
			formatBytes(round.OutputBytes),
			round.BytesRead,
			pendingMarker(round.BytesReadPending),
			round.Calls)
	}
	fmt.Fprintf(w, "  median wall=%s peak=%s output=%s\n",
		formatDurationMs(side.MedianWallMs),
		formatBytes(side.MedianPeakRSSBytes),
		formatBytes(side.MedianOutputBytes))
	fmt.Fprintf(w, "  max    wall=%s peak=%s output=%s\n",
		formatDurationMs(side.MaxWallMs),
		formatBytes(side.MaxPeakRSSBytes),
		formatBytes(side.MaxOutputBytes))
}

// formatBytes prints powers of 1024 with their exact unit names: the report
// feeds a comparison, so 7.7 GiB must not be written as 7.7 GB.
func formatBytes(bytes uint64) string {
	const (
		kib = 1024
		mib = 1024 * kib
		gib = 1024 * mib
	)
	switch {
	case bytes >= gib:
		return fmt.Sprintf("%.2f GiB", float64(bytes)/gib)
	case bytes >= mib:
		return fmt.Sprintf("%.1f MiB", float64(bytes)/mib)
	case bytes >= kib:
		return fmt.Sprintf("%.1f KiB", float64(bytes)/kib)
	}
	return fmt.Sprintf("%d B", bytes)
}

func formatDurationMs(ms float64) string {
	return time.Duration(ms * float64(time.Millisecond)).Round(time.Millisecond).String()
}

// pendingMarker marks a zero that is a placeholder, so a reader does not mistake
// "not measured yet" for "read nothing".
func pendingMarker(pending bool) string {
	if pending {
		return " (pending)"
	}
	return ""
}
