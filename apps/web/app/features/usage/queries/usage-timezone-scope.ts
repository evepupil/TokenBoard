import { normalizeTimezone } from '../../../lib/timezone'

/**
 * The zones the user's collectors are currently stamping dates in.
 *
 * Read from `daily_usage.timezone`, which each collector writes per row from its own
 * `TOKENBOARD_TIMEZONE`. Only the most recent usage date is inspected: the question is whether
 * the pipeline is stamping the right zone *now*, not whether it ever stamped another one — a
 * user who moved and then reinstalled should stop seeing a warning, and scanning all history
 * would keep one from years ago alive forever.
 */
export async function listActiveUsageTimezones(db: D1Database, userId: string): Promise<string[]> {
  const rows = await db
    .prepare(
      `
        SELECT DISTINCT timezone
        FROM daily_usage
        WHERE user_id = ?
          AND usage_date = (
            SELECT MAX(usage_date) FROM daily_usage WHERE user_id = ?
          )
        ORDER BY timezone ASC
      `
    )
    .bind(userId, userId)
    .all<{ timezone: string }>()

  return [...new Set((rows.results ?? []).map((row) => normalizeTimezone(row.timezone)))].sort()
}

/**
 * The zones that disagree with the profile, or `[]` when they all agree.
 *
 * The dashboard attributes "today" by the profile zone while `usage_date` is stamped by each
 * collector's own zone, frozen into its config at install time. Nothing propagates a profile
 * change back to an installed collector, so after a user moves and edits the setting the two
 * calendars diverge: the dashboard asks for the profile's today and the collector has written
 * the other zone's today, so the figure reads zero while the month total still counts the row.
 */
export function findMismatchedUsageTimezones(profileTimezone: string, usageTimezones: string[]): string[] {
  const profile = canonicalTimezone(normalizeTimezone(profileTimezone))
  return usageTimezones.filter((timezone) => canonicalTimezone(timezone) !== profile)
}

/**
 * Resolves a zone to the single name the host's time-zone database uses for it.
 *
 * `normalizeTimezone` only validates the spelling; it keeps the user's own name. Two spellings
 * of the same zone ("UTC" and "Etc/UTC", "Asia/Kolkata" and the older "Asia/Calcutta") would
 * otherwise be reported as a mismatch, telling the user to reinstall a collector that is
 * already stamping the right calendar. An unknown name keeps its spelling; there is nothing to
 * canonicalize it to.
 */
function canonicalTimezone(timezone: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: timezone }).resolvedOptions().timeZone
  } catch {
    return timezone
  }
}
