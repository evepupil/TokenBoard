-- The public-card path reads MAX(daily_usage_summary.updated_at) per user on every
-- request: it is part of the cache key/version stamp in
-- features/public-card/service/profile.ts. The only index over this table that starts
-- with user_id is the (user_id, usage_date, source, model) primary key, and it does not
-- carry updated_at, so the MAX had to range-scan every summary row for that user. An
-- index whose rightmost column is updated_at lets SQLite answer the MAX with a
-- covering-index min/max seek — constant cost regardless of how much history a user has.
-- That is what keeps the unauthenticated public-card read (whose cache hits are
-- deliberately exempt from the rate-limit ceiling) from turning a data-heavy user into an
-- unbounded D1 read under anonymous flood.
CREATE INDEX IF NOT EXISTS daily_usage_summary_user_updated_idx
ON daily_usage_summary(user_id, updated_at);