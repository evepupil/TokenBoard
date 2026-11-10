// Package ccusage owns the ccusage integration: which binary to run, how to
// run it safely (timeouts, retries, Windows shell quoting), and — per the Go
// client spec §4 — the three-layer fail-closed acquisition
//
//	bundled (<configDir>/bin) > PATH probe > download (never in hook mode).
//
// The expected version mirrors packages/collector/package.json's ccusage pin;
// scripts/check-deps.sh enforces the same equality in CI, and
// TestPackageSpecifierMatchesCollectorPackageJSON re-checks it from the repo
// checkout so a bump on one side cannot silently drift the other.
package acquire

// Version is the ccusage release the client expects. Upgrading ccusage means
// changing this constant and packages/collector/package.json in the same PR,
// then re-running scripts/check-deps.sh.
const Version = "20.0.33"

// PackageSpecifier is the npm specifier the TS collector passes to its package
// runner. Kept here so both sides spell the version once.
const PackageSpecifier = "ccusage@" + Version
