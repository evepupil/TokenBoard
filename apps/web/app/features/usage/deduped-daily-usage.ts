import { billableCostSql, costUnavailableSourcesSql as sharedCostUnavailableSourcesSql } from '../../lib/usage-cost'

const usageSqlValueBrand = Symbol('usage-sql-value')
const dailyUsageScopeBrand = Symbol('daily-usage-scope-filter')
const usageSummaryScopeBrand = Symbol('usage-summary-scope-filter')

/**
 * SQL list literal of every source that cannot report a cost, for use inside an
 * `IN (...)` clause. Built from the `usage-core` constant so a new source only
 * has to be declared once. Values are compile-time constants from a const
 * tuple, never user input.
 */
export const costUnavailableSourcesSql = sharedCostUnavailableSourcesSql

type UsageSqlValue = {
  readonly [usageSqlValueBrand]: true
  readonly sql: string
}

type DailyUsageScopeFilter = {
  readonly [dailyUsageScopeBrand]: true
  readonly dailyUsageSql: string
}

type UsageSummaryScopeFilter = DailyUsageScopeFilter & {
  readonly [usageSummaryScopeBrand]: true
  readonly summarySql: string
}

const paramsSql = {
  userId: '(SELECT user_id FROM params)',
  today: '(SELECT today FROM params)',
  monthStart: '(SELECT month_start FROM params)'
} as const

export const usageSummaryValue = {
  bind(): UsageSqlValue {
    return { [usageSqlValueBrand]: true, sql: '?' }
  }
}

export function usageSummaryParam(name: keyof typeof paramsSql): UsageSqlValue {
  return { [usageSqlValueBrand]: true, sql: paramsSql[name] }
}

export function usageSummaryScopeSql(input: {
  userId?: UsageSqlValue
  usageDate?: UsageSqlValue
  usageDateGte?: UsageSqlValue
  usageDateLte?: UsageSqlValue
  usageDateLt?: UsageSqlValue
}): UsageSummaryScopeFilter {
  const predicates = [
    simpleUsagePredicate('user_id', '=', input.userId),
    simpleUsagePredicate('usage_date', '=', input.usageDate),
    simpleUsagePredicate('usage_date', '>=', input.usageDateGte),
    simpleUsagePredicate('usage_date', '<=', input.usageDateLte),
    simpleUsagePredicate('usage_date', '<', input.usageDateLt)
  ].filter((predicate): predicate is NonNullable<typeof predicate> => Boolean(predicate))

  return {
    [dailyUsageScopeBrand]: true,
    [usageSummaryScopeBrand]: true,
    dailyUsageSql: scopedSql(predicates, 'daily_usage'),
    summarySql: scopedSql(predicates, 'daily_usage_summary')
  }
}

export function dailyUsageScopeSql(input: {
  userId?: UsageSqlValue
  usageDateGte?: UsageSqlValue
  usageDateLte?: UsageSqlValue
  optionalSource?: { selector: UsageSqlValue; value: UsageSqlValue }
  modelQuery?: { selector: UsageSqlValue; value: UsageSqlValue }
}): DailyUsageScopeFilter {
  const predicates = [
    simpleUsagePredicate('user_id', '=', input.userId),
    simpleUsagePredicate('usage_date', '>=', input.usageDateGte),
    simpleUsagePredicate('usage_date', '<=', input.usageDateLte),
    input.optionalSource
      ? optionalEqualsPredicate('source', input.optionalSource.selector, input.optionalSource.value, 'all')
      : null,
    input.modelQuery ? modelContainsPredicate(input.modelQuery.selector, input.modelQuery.value) : null
  ].filter((predicate): predicate is NonNullable<typeof predicate> => Boolean(predicate))

  return {
    [dailyUsageScopeBrand]: true,
    dailyUsageSql: scopedSql(predicates, 'daily_usage')
  }
}

function dedupedDailyUsageCteWithFilter(filterInput?: DailyUsageScopeFilter) {
  const filter = filterInput?.dailyUsageSql ? `AND (${filterInput.dailyUsageSql})` : ''
  return `
deduped_daily_usage AS (
  SELECT daily_usage.*
  FROM daily_usage
  WHERE (
      daily_usage.device_id <> 'legacy'
      OR NOT EXISTS (
        SELECT 1
        FROM daily_usage AS current_usage
        WHERE current_usage.user_id = daily_usage.user_id
          AND current_usage.usage_date = daily_usage.usage_date
          AND current_usage.source = daily_usage.source
          AND current_usage.model = daily_usage.model
          AND current_usage.device_id <> 'legacy'
      )
    )
    ${filter}
)`
}

const summaryColumns = [
  'user_id',
  'usage_date',
  'source',
  'model',
  'timezone',
  'input_tokens',
  'output_tokens',
  'cache_creation_tokens',
  'cache_read_tokens',
  'total_tokens',
  'total_tokens_without_cache_read',
  `${billableCostSql()} as cost_usd`,
  'session_count',
  'updated_at'
]

export function effectiveDailyUsageSummaryWith(input?: { filter?: UsageSummaryScopeFilter; summaryStrict?: boolean }) {
  assertUsageSummaryInput(input)
  const summaryFilter = input?.filter?.summarySql ? `WHERE ${input.filter.summarySql}` : ''
  if (input?.summaryStrict) {
    return `
effective_daily_usage_summary AS (
  SELECT ${summaryColumns.join(', ')}
  FROM daily_usage_summary
  ${summaryFilter}
)`
  }
  return `
${dedupedDailyUsageCteWithFilter(input?.filter)},
fallback_daily_usage_summary AS (
  SELECT
    user_id,
    usage_date,
    source,
    model,
    COALESCE(MAX(timezone), 'UTC') as timezone,
    COALESCE(SUM(input_tokens), 0) as input_tokens,
    COALESCE(SUM(output_tokens), 0) as output_tokens,
    COALESCE(SUM(cache_creation_tokens), 0) as cache_creation_tokens,
    COALESCE(SUM(cache_read_tokens), 0) as cache_read_tokens,
    COALESCE(SUM(total_tokens), 0) as total_tokens,
    COALESCE(SUM(total_tokens - cache_read_tokens), 0) as total_tokens_without_cache_read,
    COALESCE(SUM(${billableCostSql()}), 0) as cost_usd,
    COALESCE(SUM(session_count), 0) as session_count,
    MAX(synced_at) as updated_at
  FROM deduped_daily_usage
  WHERE NOT EXISTS (
    SELECT 1
    FROM daily_usage_summary
    WHERE daily_usage_summary.user_id = deduped_daily_usage.user_id
      AND daily_usage_summary.usage_date = deduped_daily_usage.usage_date
      AND daily_usage_summary.source = deduped_daily_usage.source
      AND daily_usage_summary.model = deduped_daily_usage.model
  )
  GROUP BY user_id, usage_date, source, model
),
effective_daily_usage_summary AS (
  SELECT ${summaryColumns.join(', ')}
  FROM daily_usage_summary
  ${summaryFilter}
  UNION ALL
  SELECT ${summaryColumns.join(', ')}
  FROM fallback_daily_usage_summary
)`
}

export function usageTableForDeviceFilter(deviceId?: string) {
  return isSpecificDeviceFilter(deviceId) ? 'daily_usage' : 'deduped_daily_usage'
}

export function optionalDedupedDailyUsageWith(deviceId?: string, filter?: DailyUsageScopeFilter) {
  assertDailyUsageFilter(filter)
  return isSpecificDeviceFilter(deviceId) ? '' : `WITH ${dedupedDailyUsageCteWithFilter(filter)}`
}

export function tokensWithoutCacheReadSql(tableAlias?: string) {
  const prefix = tableAlias ? `${tableAlias}.` : ''
  return `${prefix}total_tokens - ${prefix}cache_read_tokens`
}

export function normalizeDeviceFilter(deviceId?: string) {
  const normalized = String(deviceId ?? '').trim()
  if (!normalized || normalized.toLowerCase() === 'all') return 'all'
  return /^[A-Za-z0-9_-]{1,128}$/.test(normalized) ? normalized : 'all'
}

export function usageSummaryStrictMode(env: { TOKENBOARD_USAGE_SUMMARY_STRICT?: string }) {
  const raw = env.TOKENBOARD_USAGE_SUMMARY_STRICT
  if (raw === undefined) return false
  const value = raw.trim().toLowerCase()
  if (!value) return false
  if (value === '1' || value === 'true') return true
  if (value === '0' || value === 'false') return false
  throw new Error('TOKENBOARD_USAGE_SUMMARY_STRICT must be true, false, 1, or 0')
}

function isSpecificDeviceFilter(deviceId?: string) {
  return normalizeDeviceFilter(deviceId) !== 'all'
}

type UsagePredicate = {
  readonly column?: 'user_id' | 'usage_date' | 'source' | 'model'
  readonly op?: '=' | '>=' | '<=' | '<'
  readonly value?: UsageSqlValue
  readonly render?: (table: 'daily_usage' | 'daily_usage_summary') => string
}

function simpleUsagePredicate(
  column: UsagePredicate['column'],
  op: NonNullable<UsagePredicate['op']>,
  value?: UsageSqlValue
): UsagePredicate | null {
  if (!value) return null
  assertUsageSqlValue(value)
  return { column, op, value }
}

function optionalEqualsPredicate(
  column: NonNullable<UsagePredicate['column']>,
  selector: UsageSqlValue,
  value: UsageSqlValue,
  allValue: string
): UsagePredicate {
  assertUsageSqlValue(selector)
  assertUsageSqlValue(value)
  return {
    render: (table) => `(${selector.sql} = '${allValue}' OR ${table}.${column} = ${value.sql})`
  }
}

function modelContainsPredicate(selector: UsageSqlValue, value: UsageSqlValue): UsagePredicate {
  assertUsageSqlValue(selector)
  assertUsageSqlValue(value)
  return {
    render: (table) => `(${selector.sql} = '' OR lower(${table}.model) LIKE '%' || lower(${value.sql}) || '%')`
  }
}

function scopedSql(predicates: UsagePredicate[], table: 'daily_usage' | 'daily_usage_summary') {
  return predicates
    .map((predicate) => {
      if (predicate.render) return predicate.render(table)
      return `${table}.${predicate.column} ${predicate.op} ${predicate.value?.sql}`
    })
    .join(' AND ')
}

function assertUsageSqlValue(value: UsageSqlValue) {
  if (value?.[usageSqlValueBrand] !== true) {
    throw new Error('Usage SQL values must be built with usageSummaryValue')
  }
}

function assertDailyUsageFilter(filter?: DailyUsageScopeFilter) {
  if (filter !== undefined && filter[dailyUsageScopeBrand] !== true) {
    throw new Error('Daily usage filters must be built with dailyUsageScopeSql')
  }
}

function assertUsageSummaryInput(input?: { filter?: UsageSummaryScopeFilter; summaryStrict?: boolean }) {
  const legacyInput = input as { dailyUsageFilter?: unknown; summaryFilter?: unknown } | undefined
  if (legacyInput?.dailyUsageFilter !== undefined || legacyInput?.summaryFilter !== undefined) {
    throw new Error('Usage summary filters must be built with usageSummaryScopeSql')
  }
  if (input?.filter !== undefined && input.filter[usageSummaryScopeBrand] !== true) {
    throw new Error('Usage summary filters must be built with usageSummaryScopeSql')
  }
}
