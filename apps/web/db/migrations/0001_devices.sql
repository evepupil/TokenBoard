CREATE TABLE IF NOT EXISTS pairing_codes (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  code_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  platform TEXT NOT NULL,
  last_synced_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS pairing_codes_code_hash_idx ON pairing_codes(code_hash);
CREATE INDEX IF NOT EXISTS devices_user_id_idx ON devices(user_id);

INSERT INTO pairing_codes (id, user_id, code_hash, expires_at, consumed_at, created_at)
VALUES (
  'pair_dev_seed',
  'seed-user',
  '2fb2770cbfd167e945dd3495b21f241f03bb5ed864e153b0ef841eb1a19282bc',
  '2099-01-01T00:00:00.000Z',
  NULL,
  '2026-04-28T00:00:00.000Z'
)
ON CONFLICT(id) DO NOTHING;

