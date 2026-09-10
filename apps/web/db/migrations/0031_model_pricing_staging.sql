CREATE TABLE IF NOT EXISTS model_pricing_staging (
  generation_id TEXT NOT NULL,
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
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (generation_id, provider, model_id)
);

CREATE INDEX IF NOT EXISTS model_pricing_staging_generation_idx
  ON model_pricing_staging(generation_id);
