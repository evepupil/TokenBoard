# TokenBoard

TokenBoard collects local AI token usage from Claude Code and Codex, uploads normalized daily
aggregates to Cloudflare Workers + D1, and shows usage stats on a hosted dashboard.

## Install Collector

Open the deployed site and visit:

```txt
https://tokenboard.chaosyn.com/settings/install
```

Generate an install prompt, paste it into Codex or Claude Code, and let the agent install the
TokenBoard skill. The skill runs `setup.mjs`, exchanges the short-lived pairing code for an upload
token, installs the collector, creates the daily schedule, and runs the first sync.

The collector uploads aggregate token counts only. It does not upload prompts, completions, file
contents, or raw conversation logs.

## Development

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm build
```

Deploy:

```bash
pnpm run deploy
```

## Package Managers

The repository defaults to pnpm for development and CI. The collector install and sync scripts also
support Bun and npm for local agent environments:

```bash
node skills/tokenboard/scripts/install-collector.mjs --package-manager pnpm
node skills/tokenboard/scripts/install-collector.mjs --package-manager bun
node skills/tokenboard/scripts/install-collector.mjs --package-manager npm
```

The same option is available for sync:

```bash
node skills/tokenboard/scripts/sync.mjs --mode sync --source all --package-manager pnpm
```

You can also set `TOKENBOARD_PACKAGE_MANAGER=pnpm|bun|npm`. When unset, scripts use pnpm.
