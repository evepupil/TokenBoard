UPDATE profiles
SET timezone_source = 'user'
WHERE timezone = 'UTC'
  AND timezone_source = 'default';
