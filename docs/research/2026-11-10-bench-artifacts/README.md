# S5 bench-collect raw output (2026-11-10)

Raw stdout of `go run ./cmd/bench-collect -source S -scenario SC -rounds 5` on the
maintainer's machine (darwin/amd64, Go 1.27.3), captured before the acquisition
layers were deleted (commit `7959fae`). The numbers are reported in
`docs/research/2026-11-10-native-vs-ccusage-benchmark.md`.

- Machine load during the run: 76–142 (load average), i.e. heavily shared; the
  5-round median and max in each file are the numbers to read, not single rounds.
- Codex runs set `TOKENBOARD_CODEX_SYMLINK_ROOTS_JSON='["<HOME>/.codex/archived_sessions.local"]'`
  because `~/.codex/archived_sessions` is a symlink and the native walk refuses
  symlinks without an explicit allow-list.
- `/tmp/tokenboard-bench-*` pricing config paths in the files are per-run temp
  directories and no longer exist; the config is `packages/collector/ccusage.json`
  (the run reports "static catalogue" because no endpoint was configured).
