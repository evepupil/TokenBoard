ALTER TABLE profiles ADD COLUMN timezone_source TEXT NOT NULL DEFAULT 'default';

UPDATE profiles
SET timezone_source = 'user'
WHERE timezone <> 'UTC';
