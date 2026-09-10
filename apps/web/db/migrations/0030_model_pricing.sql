CREATE TABLE IF NOT EXISTS model_pricing (
  provider TEXT NOT NULL,
  model_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  input_cost_per_million REAL NOT NULL,
  output_cost_per_million REAL NOT NULL,
  cache_read_cost_per_million REAL,
  cache_write_cost_per_million REAL,
  context_window INTEGER NOT NULL,
  max_input_tokens INTEGER,
  max_output_tokens INTEGER,
  release_date TEXT,
  source_updated_at TEXT,
  official_docs_url TEXT NOT NULL,
  source_url TEXT NOT NULL,
  pricing_json TEXT NOT NULL,
  is_deprecated INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  sync_generation TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (provider, model_id)
);

CREATE INDEX IF NOT EXISTS model_pricing_active_idx
  ON model_pricing(is_active, provider, model_id);

CREATE INDEX IF NOT EXISTS model_pricing_source_updated_idx
  ON model_pricing(source_updated_at);

CREATE INDEX IF NOT EXISTS model_pricing_active_generation_idx
  ON model_pricing(is_active, sync_generation, provider, model_id);

CREATE TABLE IF NOT EXISTS model_pricing_sync_state (
  id TEXT PRIMARY KEY,
  source_url TEXT NOT NULL,
  status TEXT NOT NULL,
  lock_token TEXT,
  locked_until TEXT,
  last_started_at TEXT NOT NULL,
  last_success_at TEXT,
  last_failure_at TEXT,
  last_source_updated_at TEXT,
  model_count INTEGER NOT NULL DEFAULT 0,
  active_generation TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL
);
