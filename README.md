# TokenBoard

TokenBoard collects local AI token usage from Claude Code and Codex, uploads normalized daily
aggregates to Cloudflare Workers + D1, and shows usage stats on a hosted dashboard.

## Install Collector

Open the deployed site and visit:

```txt
https://tokenboard.yeton92479.workers.dev/settings/install
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
