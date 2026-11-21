-- Asserts the 0039 public-card index really exists, by name *and* columns.
--
-- 0039 creates `daily_usage_summary_user_updated_idx` over `(user_id, updated_at)`, which
-- is what lets the unauthenticated public-card read answer MAX(updated_at) per user with a
-- covering-index seek instead of a range scan of every summary row that user owns
-- (`features/public-card/service/profile.ts`). The migration is `CREATE INDEX IF NOT
-- EXISTS`, so a wrong apply order, or an index already present under that name over the
-- wrong columns, applies "successfully" and reports nothing — SQLite skips a same-name
-- index without comparing definitions. This check turns that silent degradation into a
-- hard failure.
--
-- Kept separate from verify-critical-schema.sql because that file is also run against a
-- deliberately partial schema (the migration-ordering gate), where this index does not
-- exist yet — the same reason verify-rate-limit-index.sql is separate.
--
-- `abs(-9223372036854775808)` raises "integer overflow" only when the WHERE clause lets a
-- row through, which a plain `SELECT ... LIMIT 0` could not do.
SELECT abs(-9223372036854775808)
WHERE NOT EXISTS (
  SELECT 1
  FROM sqlite_master
  WHERE type = 'index'
    AND name = 'daily_usage_summary_user_updated_idx'
    AND lower(replace(sql, ' ', '')) LIKE '%ondaily_usage_summary(user_id,updated_at)%'
);