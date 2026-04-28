ALTER TABLE upload_tokens ADD COLUMN device_id TEXT;

CREATE INDEX IF NOT EXISTS upload_tokens_device_id_idx ON upload_tokens(device_id);
