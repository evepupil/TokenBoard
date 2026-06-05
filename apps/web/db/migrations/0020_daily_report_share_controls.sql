ALTER TABLE profiles
ADD COLUMN daily_report_share_enabled INTEGER NOT NULL DEFAULT 0;

ALTER TABLE daily_report_history
ADD COLUMN share_revoked_at TEXT;
