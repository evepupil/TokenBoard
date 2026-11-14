#!/usr/bin/env bash
#
# check-deps.sh — the ccusage dependency gate (docs/specs/go-client-spec.md §5).
#
# ccusage publishes no schemaVersion and no machine-readable changelog, so a
# change to its --json output is silent until a collector mis-parses it and
# uploads wrong numbers. This gate is the only line of defence: it runs a fixed
# fixture tree through the collector's own invocation and diffs the result
# against recorded goldens.
#
# The tool-source goldens are the contract the Go client's in-process adapters
# are written against. Since S5 (2026-11-10) the client no longer runs ccusage:
# this gate now protects the TypeScript collector, which still does, and the
# frozen 20.0.33 the adapters' own goldens were minted from. The binary comes
# from the workspace install because packages/collector still depends on it
# (spec D6); the day that dependency goes, so does this gate's binary.
#
# Native side: claude-code also has an in-process adapter whose goldens are
# minted by scripts/gen-claude-goldens.mjs and compared by
# internal/collect/adapters/claude/goldens_test.go. That is a separate gate over
# a separate invocation: it runs WITHOUT --config (adapter parity, so every
# overridden model would otherwise mismatch) while this script passes the
# shipped packages/collector/ccusage.json. Re-mint those goldens when the
# adapter's parsing or pricing semantics change, and these when ccusage's own
# JSON output changes; a change to one set does not imply the other. Both are
# meant to be minted from ccusage 20.0.33 by the same version, but not
# necessarily the same executable file (this script prefers
# node_modules/.bin/ccusage, the generator ~/.tokenboard/bin/ccusage).
# The Go client itself runs none of this: S5 removed the ccusage acquisition
# layer and the in-process adapter is now the only path
# (docs/specs/go-client-spec.md §4).
#
# The codex adapter's row-level goldens get the same gate through their own
# generator: gen-codex-goldens.mjs --check re-mints in memory from the committed
# fixture tree and fails on any drift from goldens/codex-reports.json, in both
# verify and --update mode (this gate never writes those files). That keeps the
# frozen rows honest in CI without writing files (CI runs this script against
# the pnpm-installed ccusage; the fixture-hash half of the gate lives in the Go
# test).
#
# Usage:
#   scripts/check-deps.sh                      # verify against the goldens
#   scripts/check-deps.sh --update             # re-mint goldens after review
#   CCUSAGE_BIN=/path/to/ccusage scripts/...   # test a specific binary
#
# Exit codes: 0 in agreement, 1 drift or a setup failure.

set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
golden_dir="$repo_root/clients/go/testdata/ccusage-golden"
collector_dir="$repo_root/packages/collector"
config_path="$collector_dir/ccusage.json"

update=0
if [[ "${1:-}" == "--update" ]]; then
  update=1
elif [[ $# -gt 0 ]]; then
  echo "usage: $(basename "$0") [--update]" >&2
  exit 1
fi

# The expected version is the TS collector's pin: the two implementations must
# agree on it, and bumping it is a deliberate act that runs this gate.
expected_version=$(node -e \
  "process.stdout.write(require('$collector_dir/package.json').dependencies.ccusage)")

ccusage_bin="${CCUSAGE_BIN:-}"
if [[ -z "$ccusage_bin" ]]; then
  if [[ -x "$collector_dir/node_modules/.bin/ccusage" ]]; then
    ccusage_bin="$collector_dir/node_modules/.bin/ccusage"
  elif command -v ccusage >/dev/null 2>&1; then
    ccusage_bin=$(command -v ccusage)
  else
    echo "check-deps: no ccusage binary found. Run 'pnpm install', or set CCUSAGE_BIN." >&2
    exit 1
  fi
fi

actual_version=$("$ccusage_bin" --version | awk '{print $2}')
if [[ "$actual_version" != "$expected_version" ]]; then
  echo "check-deps: ccusage version drift — packages/collector pins $expected_version, $ccusage_bin is $actual_version." >&2
  echo "            Upgrade deliberately, then re-run with --update after reviewing the diff." >&2
  exit 1
fi

work_dir=$(mktemp -d)
cleanup() { rm -rf "$work_dir"; }
trap cleanup EXIT

# A fixed fixture, not the developer's own history: two models, two dates, and
# the cache buckets the normalizer reads. Timestamps are literal so the output
# is reproducible on any machine.
mkdir -p "$work_dir/claude/projects/proj-a"
cat > "$work_dir/claude/projects/proj-a/session-1.jsonl" <<'FIXTURE'
{"type":"assistant","timestamp":"2026-04-28T02:00:00.000Z","requestId":"req_1","message":{"id":"msg_1","model":"claude-sonnet-4-5","usage":{"input_tokens":1,"output_tokens":2,"cache_creation_input_tokens":3,"cache_read_input_tokens":4}}}
{"type":"assistant","timestamp":"2026-04-29T02:00:00.000Z","requestId":"req_2","message":{"id":"msg_2","model":"claude-opus-4-5","usage":{"input_tokens":10,"output_tokens":20,"cache_creation_input_tokens":0,"cache_read_input_tokens":40}}}
FIXTURE

# Key order is not part of the contract, so it is normalised away; the fixture
# keeps dates, ids and paths fixed, so nothing else is volatile.
canonicalize() {
  node -e '
    let input = ""
    process.stdin.on("data", (chunk) => { input += chunk })
    process.stdin.on("end", () => {
      const sortKeys = (value) => {
        if (Array.isArray(value)) return value.map(sortKeys)
        if (value && typeof value === "object") {
          return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]))
        }
        return value
      }
      process.stdout.write(JSON.stringify(sortKeys(JSON.parse(input)), null, 2) + "\n")
    })
  '
}

run_ccusage() {
  # CCUSAGE_BIN can point at any binary; strip the collector credentials before
  # exec, the same four keys the collector itself removes (AGENTS.md
  # "跨端协议不变量").
  CLAUDE_CONFIG_DIR="$work_dir/claude" env \
    -u TOKENBOARD_UPLOAD_TOKEN -u TOKENBOARD_PAIRING_CODE \
    -u TOKENBOARD_RELEASE_BASE_URL -u TOKENBOARD_REPO_URL \
    "$ccusage_bin" "$@" --config "$config_path" -z UTC -s 20260428 -u 20260429
}

status=0
mkdir -p "$golden_dir"
for report in daily session; do
  golden="$golden_dir/claude-$report.json"
  if [[ "$report" == "daily" ]]; then
    produced=$(run_ccusage claude daily --json --breakdown | canonicalize)
  else
    produced=$(run_ccusage claude session --json | canonicalize)
  fi

  if [[ $update -eq 1 ]]; then
    printf '%s\n' "$produced" > "$golden"
    echo "check-deps: wrote $golden"
    continue
  fi
  if [[ ! -f "$golden" ]]; then
    echo "check-deps: missing golden $golden — run with --update to mint it." >&2
    status=1
    continue
  fi
  if ! diff -u "$golden" <(printf '%s\n' "$produced") > "$work_dir/$report.diff"; then
    echo "check-deps: ccusage $report output drifted from $golden:" >&2
    cat "$work_dir/$report.diff" >&2
    status=1
  fi
done

if [[ $status -ne 0 ]]; then
  echo "check-deps: shape drift is a breaking change for the collector — review it before updating the goldens." >&2
  exit 1
fi

# The claude adapter's goldens come from the same version of ccusage over the
# committed claude-fixture tree. --check re-mints both reports in memory and
# compares the committed bytes, so a fixture edit or a ccusage output change on
# the claude path fails here like it does for every other native adapter.
CCUSAGE_BIN="$ccusage_bin" node "$repo_root/clients/go/scripts/gen-claude-goldens.mjs" --check || status=1

# The codex adapter's frozen reports come from the same version of ccusage over
# a committed fixture tree. --check re-mints them in memory and compares the
# committed bytes, so this gate never writes: after a deliberate ccusage bump,
# re-mint with gen-codex-goldens.mjs (no flag) and review the diff.
CCUSAGE_BIN="$ccusage_bin" node "$repo_root/clients/go/scripts/gen-codex-goldens.mjs" --check || status=1

# The native pricing engine's cost goldens are re-derived from the same pinned
# ccusage and the shipped config (packages/collector/ccusage.json). --check
# re-mints them in memory and compares the committed bytes; a changed config or
# a drift in ccusage's own answer fails here instead of leaving the pricing
# parity anchor stale.
CCUSAGE_BIN="$ccusage_bin" node "$repo_root/clients/go/scripts/gen-native-pricing-goldens.mjs" --check || status=1

# The twelve ccusage tool adapters carry the same kind of frozen reports, minted
# by gen-tool-goldens.mjs over the committed fixture trees under
# clients/go/testdata/tool-goldens-fixtures. --check verifies the committed
# fixture trees against the generator's definitions and re-mints every report in
# memory: a drifted fixture and a drifted report both fail here, and this gate
# never writes.
CCUSAGE_BIN="$ccusage_bin" node "$repo_root/clients/go/scripts/gen-tool-goldens.mjs" --check || status=1

# The copilot adapter's goldens (the twelfth tool adapter) come from
# gen-copilot-goldens.mjs over the fixture tree upstream's own CLI snapshots use.
# --check re-hashes that tree, re-mints both reports under --mode auto and
# calculate, and re-derives the committed copilot_cli__* upstream snapshots from
# the same binary, so a drift between the two sources of truth fails here too.
CCUSAGE_BIN="$ccusage_bin" node "$repo_root/clients/go/scripts/gen-copilot-goldens.mjs" --check || status=1

if [[ $status -ne 0 ]]; then
  echo "check-deps: a native adapter golden drifted — review the diff, then re-mint it after review." >&2
  exit 1
fi
if [[ $update -eq 0 ]]; then
  echo "check-deps: ccusage $actual_version output matches the goldens."
fi