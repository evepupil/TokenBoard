# Daily Report Share Validation - 2026-06-05

## Scope

- Daily report share controls and public report page.
- Daily report delivery link eligibility.
- D1 sqlite test adapter coverage for string bindings, multi-result JSON output, `RETURNING`, and history read parsing.
- External read-only review follow-up from Claude and Gemini.
- Reviewer P2 follow-up for failed webhook deliveries with existing report history rows.
- Reviewer P2 follow-up for sqlite JSON output containing bracket characters inside string values.
- Reviewer P2 follow-up for cleanup of shared report history rows used by another successful delivery.
- Reviewer P2 follow-up for enforcing daily report history retention on shared report reads.
- Cleanup follow-up for delivery helper export scope, core retention route tests, and README behavior notes.

## Commands

```bash
pnpm --filter @tokenboard/web test -- app/features/notifications/report-history-delivery.test.ts app/features/notifications/report-share.test.ts 'app/routes/reports/daily/[id].test.tsx'
```

Exit code: 0

Result: 52 test files passed, 350 tests passed.

```bash
pnpm --filter @tokenboard/web test -- app/features/notifications/report-history.sqlite.test.ts app/test/sqlite-d1.test.ts
```

Exit code: 0

Result: 52 test files passed, 347 tests passed.

```bash
pnpm --filter @tokenboard/web test -- app/features/notifications/report-share.test.ts 'app/routes/reports/daily/[id].test.tsx'
```

Exit code: 0

Result: 52 test files passed, 348 tests passed.

```bash
pnpm --filter @tokenboard/web test -- app/features/notifications/report-share.test.ts app/features/notifications/report-history.sqlite.test.ts app/test/sqlite-d1.test.ts 'app/routes/reports/daily/[id].test.tsx'
```

Exit code: 0

Result: 52 test files passed, 348 tests passed.

```bash
pnpm --filter @tokenboard/web test -- app/features/notifications/report-history-delivery.test.ts app/features/notifications/service.test.ts
```

Exit code: 0

Result: 52 test files passed, 347 tests passed.

```bash
pnpm --filter @tokenboard/web test -- app/test/sqlite-d1.test.ts app/features/notifications/report-history.sqlite.test.ts app/features/notifications/report-history.test.ts app/features/notifications/report-share.test.ts 'app/routes/reports/daily/[id].test.tsx'
```

Exit code: 0

Result: 51 test files passed, 343 tests passed.

```bash
pnpm --filter @tokenboard/web test -- app/features/notifications/report-share.test.ts app/features/notifications/report-history-delivery.test.ts app/features/notifications/report-history.test.ts app/features/notifications/service.test.ts
```

Exit code: 0

Result: 51 test files passed, 343 tests passed.

```bash
pnpm --filter @tokenboard/web test -- app/features/notifications/report-history-save.test.ts app/features/notifications/report-history.test.ts app/features/notifications/report-history.sqlite.test.ts app/features/notifications/service.test.ts
```

Exit code: 0

Result: 52 test files passed, 345 tests passed.

```bash
pnpm typecheck
```

Exit code: 0

Result: `packages/usage-core`, `packages/collector`, and `apps/web` typecheck passed.

```bash
pnpm test
```

Exit code: 0

Result: `packages/usage-core` 2 tests passed, `packages/collector` 141 tests passed, `apps/web` 350 tests passed.

```bash
pnpm --filter @tokenboard/web build
```

Exit code: 0

Result: client and SSR builds passed. SSR output: `dist/index.js 922.78 kB`, gzip `240.12 kB`.

```bash
claude -p --effort max --permission-mode plan "<staged diff review prompt>"
```

Exit code: 0

Result: Claude reviewed the staged diff in read-only plan mode, without `--max-budget-usd`, and reported: "未发现需要作者修复的离散缺陷。"

```bash
gemini --skip-trust --approval-mode plan --prompt "<staged diff review prompt>"
```

Exit code: 0

Result: Gemini reviewed the staged diff in read-only plan mode and reported: "未发现需要作者修复的离散缺陷。"

```bash
git diff --check
```

Exit code: 0

Result: no whitespace errors.

## Review Notes

- The sqlite D1 test adapter now loads parameters through `temp.sqlite_parameters`, preserving placeholder execution while supporting quoted JSON strings.
- `RETURNING` statements are executed directly in `.first()`, which keeps the sqlite contract test aligned with the persisted D1 path.
- Gemini review found that sqlite `.run()` could receive multiple JSON result sets when a statement contains `RETURNING`; the adapter now parses multiple top-level JSON arrays.
- Claude review found that adapter-level `sourceSplit` and `topModels` JSON parsing conflicted with `report-history-parser.ts`; the adapter now returns raw SQLite values and the sqlite contract test covers `listDailyReportHistory`.
- Reviewer P2 found that a failed webhook send could overwrite an existing report history snapshot before provider delivery. Delivery now prepares existing share metadata without updating the snapshot, then persists the snapshot only after provider success.
- Reviewer P2 found that sqlite JSON result splitting treated brackets inside string values as structural JSON. The scanner now tracks quoted strings and escapes, and `sqlite-d1.test.ts` covers TEXT values containing `[` and `]`.
- Reviewer P2 found that cleanup could delete a report history row already used by another successful subscription. Cleanup now deletes only when no matching daily success log exists for the row's user, report date, and schedule slot.
- Reviewer P2 found that stale daily report history rows could remain publicly readable after the configured retention window. Shared report reads now bind a retention cutoff and reject rows with `report_date` before that cutoff before rendering.
- Final Claude and Gemini read-only reviews of the staged diff found no discrete defects requiring author fixes.
- Cleanup narrowed private delivery helpers back to file scope, added tests for owner retention enforcement, route retention configuration, and existing-share cleanup no-op behavior, and updated README sharing semantics.
- Files touched by the new sqlite contract and delivery/share helpers are under the 300 line repository limit.
