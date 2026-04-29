CREATE TABLE daily_usage_new (
  user_id TEXT NOT NULL,
  device_id TEXT NOT NULL DEFAULT 'legacy',
  source TEXT NOT NULL,
  usage_date TEXT NOT NULL,
  timezone TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  session_count INTEGER NOT NULL DEFAULT 0,
  synced_at TEXT NOT NULL,
  PRIMARY KEY (user_id, device_id, source, usage_date, model),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

INSERT INTO daily_usage_new (
  user_id,
  device_id,
  source,
  usage_date,
  timezone,
  model,
  input_tokens,
  output_tokens,
  cache_creation_tokens,
  cache_read_tokens,
  total_tokens,
  cost_usd,
  session_count,
  synced_at
)
SELECT
  user_id,
  'legacy',
  source,
  usage_date,
  timezone,
  model,
  input_tokens,
  output_tokens,
  cache_creation_tokens,
  cache_read_tokens,
  total_tokens,
  cost_usd,
  session_count,
  synced_at
FROM daily_usage;

DROP TABLE daily_usage;

ALTER TABLE daily_usage_new RENAME TO daily_usage;

CREATE INDEX IF NOT EXISTS daily_usage_usage_date_idx ON daily_usage(usage_date);
CREATE INDEX IF NOT EXISTS daily_usage_user_date_idx ON daily_usage(user_id, usage_date);
CREATE INDEX IF NOT EXISTS daily_usage_user_device_date_idx ON daily_usage(user_id, device_id, usage_date);
