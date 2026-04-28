CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY NOT NULL,
  email TEXT UNIQUE,
  name TEXT,
  image TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS profiles (
  user_id TEXT PRIMARY KEY NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  is_public INTEGER NOT NULL DEFAULT 0,
  participates_in_leaderboards INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS upload_tokens (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  last_used_at TEXT,
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS daily_usage (
  user_id TEXT NOT NULL,
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
  PRIMARY KEY (user_id, source, usage_date, model),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS daily_usage_usage_date_idx ON daily_usage(usage_date);
CREATE INDEX IF NOT EXISTS daily_usage_user_date_idx ON daily_usage(user_id, usage_date);
CREATE INDEX IF NOT EXISTS profiles_public_leaderboard_idx ON profiles(is_public, participates_in_leaderboards);

INSERT INTO users (id, email, name, image, created_at, updated_at)
VALUES ('seed-user', NULL, 'Seed User', NULL, '2026-04-28T00:00:00.000Z', '2026-04-28T00:00:00.000Z')
ON CONFLICT(id) DO NOTHING;

INSERT INTO profiles (
  user_id,
  slug,
  display_name,
  timezone,
  is_public,
  participates_in_leaderboards,
  created_at,
  updated_at
)
VALUES (
  'seed-user',
  'seed-user',
  'Seed User',
  'Asia/Shanghai',
  1,
  1,
  '2026-04-28T00:00:00.000Z',
  '2026-04-28T00:00:00.000Z'
)
ON CONFLICT(user_id) DO NOTHING;

