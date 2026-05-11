---
name: tokenboard
description: Install and manage TokenBoard AI token usage collection for Claude Code and Codex. Use when the user asks to install TokenBoard, connect TokenBoard, bind a TokenBoard pairing code, sync AI token usage, preview usage, check TokenBoard status, or set up daily token statistics.
---

# TokenBoard

Use the bundled scripts to install TokenBoard collection on the user's machine. Never print upload tokens. Never upload prompts, completions, file contents, or raw conversation logs.

## Install

When the user provides a pairing code, run:

```bash
TOKENBOARD_CODEX_BATCH_SIZE=200 node scripts/setup.mjs --pairing-code <pairing-code>
```

Optional flags:

```bash
--base-url https://tokenboard.chaosyn.com
--timezone Asia/Shanghai
--device-name "Codex Desktop"
--skip-collector
--skip-schedule
--skip-initial-sync
--repo-url https://github.com/evepupil/TokenBoard.git
```

After setup, report whether config was written, schedule was installed, and initial sync succeeded. Do not show `uploadToken`.

The setup script clones or updates `https://github.com/evepupil/TokenBoard.git` into `~/.tokenboard/TokenBoard`, runs `pnpm install`, writes local config, installs the daily schedule unless skipped, and runs a full-history initial sync unless skipped. Do not change the initial sync to a 7-day window unless the user explicitly asks. Codex history is processed in batches during full scans; use `TOKENBOARD_CODEX_BATCH_SIZE=200` by default, lower it only when the user needs lower peak resource usage. Use `--repo-url` or `TOKENBOARD_REPO_URL` only when the local environment requires a non-default collector source.

If the user pasted a TokenBoard install prompt from the website, follow the prompt and run the included setup command. Treat pairing codes as short-lived secrets and do not repeat them unless needed to execute setup.

## Sync

Daily and manual sync default to a 7-day lookback window. Use `--since all` only when the user explicitly asks for a full-history backfill.

Preview without upload:

```bash
node scripts/sync.mjs --mode preview --source all
```

Upload:

```bash
node scripts/sync.mjs --mode sync --source all
node scripts/sync.mjs --mode sync --source all --since all
```

## Status

Check local config and schedule hint:

```bash
node scripts/status.mjs
```

## Troubleshooting

- If Node is missing, ask the user to install Node.js 20 or newer.
- If the collector cannot reach `https://tokenboard.chaosyn.com`, ask the user to configure proxy environment variables or verify the TokenBoard custom domain.
- If pairing fails, ask the user to generate a new pairing code from TokenBoard.
