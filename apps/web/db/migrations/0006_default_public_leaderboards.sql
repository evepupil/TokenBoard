UPDATE profiles
SET
  is_public = 1,
  participates_in_leaderboards = 1,
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE is_public = 0
  AND participates_in_leaderboards = 0
  AND updated_at = created_at;
