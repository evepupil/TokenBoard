UPDATE profiles
SET is_public = 1
WHERE participates_in_leaderboards = 1
  AND is_public <> 1;
