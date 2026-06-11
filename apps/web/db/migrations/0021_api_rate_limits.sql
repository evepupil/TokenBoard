CREATE TABLE api_rate_limits (
  key TEXT PRIMARY KEY NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  reset_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX api_rate_limits_reset_idx
  ON api_rate_limits(reset_at);
