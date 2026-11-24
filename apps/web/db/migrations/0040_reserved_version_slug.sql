-- `/api/public/version` is a fixed route (the machine-readable twin of the footer version
-- line), and fixed routes take precedence over user slugs. Any profile already holding the
-- slug `version` would become unreachable, so rename it first with the same deterministic
-- scheme migration 0032 used for `model-pricing`: pick the first free `version-legacy…`
-- candidate so the migration is safe to retry and stays within the 32-character slug limit.
WITH RECURSIVE
  legacy_profiles AS (
    SELECT
      user_id,
      row_number() OVER (ORDER BY user_id) AS sequence_number,
      count(*) OVER () AS profile_count
    FROM profiles
    WHERE lower(slug) = 'version'
  ),
  profile_totals AS (
    SELECT count(*) AS total_profile_count
    FROM profiles
  ),
  candidates (
    user_id,
    sequence_number,
    profile_count,
    total_profile_count,
    fallback_attempt,
    attempt,
    candidate_slug
  ) AS (
    SELECT
      user_id,
      sequence_number,
      profile_count,
      profile_totals.total_profile_count,
      CASE
        WHEN sequence_number = 1 THEN CAST((9998 / profile_count) AS INTEGER) + 2
        ELSE CAST((9999 - sequence_number) / profile_count AS INTEGER) + 1
      END,
      0,
      CASE
        WHEN sequence_number = 1 THEN 'version-legacy'
        WHEN sequence_number <= 9999 THEN
          'version-legacy-' || lower(substr(hex(user_id), 1, 7)) || printf('%04d', sequence_number)
        ELSE
          'version-legacy-x' || substr(printf('%08x', sequence_number), -8)
      END
    FROM legacy_profiles
    CROSS JOIN profile_totals
    UNION ALL
    SELECT
      user_id,
      sequence_number,
      profile_count,
      total_profile_count,
      fallback_attempt,
      attempt + 1,
      CASE
        WHEN sequence_number = 1 AND attempt = 0 THEN
          'version-legacy-' || lower(substr(hex(user_id), 1, 7)) || printf('%04d', 1)
        WHEN sequence_number = 1 AND 1 + attempt * profile_count <= 9999 THEN
          'version-legacy-' || lower(substr(hex(user_id), 1, 7)) || printf('%04d', 1 + attempt * profile_count)
        WHEN sequence_number > 1 AND sequence_number + (attempt + 1) * profile_count <= 9999 THEN
          'version-legacy-' || lower(substr(hex(user_id), 1, 7)) ||
            printf('%04d', sequence_number + (attempt + 1) * profile_count)
        WHEN attempt + 1 = fallback_attempt THEN
          'version-legacy-x' || substr(printf('%08x', sequence_number), -8)
        ELSE
          'version-legacy-x' ||
            substr(printf('%08x', sequence_number + (attempt + 1) * profile_count), -8)
      END
    FROM candidates
      WHERE attempt < total_profile_count
      AND EXISTS (
        SELECT 1
        FROM profiles AS existing
        WHERE existing.slug = candidates.candidate_slug
      )
  )
UPDATE profiles
SET
  slug = (
    SELECT candidate_slug
    FROM candidates
    WHERE candidates.user_id = profiles.user_id
      AND NOT EXISTS (
      SELECT 1
      FROM profiles AS existing
      WHERE existing.slug = candidates.candidate_slug
      )
    ORDER BY attempt
    LIMIT 1
  ),
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE lower(slug) = 'version';
