import { sql } from 'drizzle-orm'
import { index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  email: text('email').unique(),
  emailVerified: integer('email_verified', { mode: 'boolean' }).notNull().default(false),
  name: text('name'),
  image: text('image'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull()
})

export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  token: text('token').notNull().unique(),
  expiresAt: integer('expires_at').notNull(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull()
})

export const accounts = sqliteTable('accounts', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  accessTokenExpiresAt: integer('access_token_expires_at'),
  refreshTokenExpiresAt: integer('refresh_token_expires_at'),
  scope: text('scope'),
  password: text('password'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull()
})

export const verifications = sqliteTable('verifications', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: integer('expires_at').notNull(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull()
})

export const profiles = sqliteTable('profiles', {
  userId: text('user_id')
    .notNull()
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  slug: text('slug').notNull().unique(),
  displayName: text('display_name').notNull(),
  timezone: text('timezone').notNull().default('UTC'),
  timezoneSource: text('timezone_source').notNull().default('default'),
  publicCardConfig: text('public_card_config'),
  dailyReportShareEnabled: integer('daily_report_share_enabled', { mode: 'boolean' }).notNull().default(false),
  isPublic: integer('is_public', { mode: 'boolean' }).notNull().default(false),
  participatesInLeaderboards: integer('participates_in_leaderboards', {
    mode: 'boolean'
  })
    .notNull()
    .default(false),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull()
})

export const uploadTokens = sqliteTable('upload_tokens', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  deviceId: text('device_id'),
  lastUsedAt: text('last_used_at'),
  createdAt: text('created_at').notNull(),
  revokedAt: text('revoked_at')
})

export const pairingCodes = sqliteTable('pairing_codes', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  codeHash: text('code_hash').notNull().unique(),
  expiresAt: text('expires_at').notNull(),
  consumedAt: text('consumed_at'),
  createdAt: text('created_at').notNull()
})

export const devices = sqliteTable('devices', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  platform: text('platform').notNull(),
  lastSyncedAt: text('last_synced_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull()
})

export const dailyUsage = sqliteTable(
  'daily_usage',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    deviceId: text('device_id').notNull().default('legacy'),
    source: text('source').notNull(),
    usageDate: text('usage_date').notNull(),
    timezone: text('timezone').notNull(),
    model: text('model').notNull(),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    cacheCreationTokens: integer('cache_creation_tokens').notNull().default(0),
    cacheReadTokens: integer('cache_read_tokens').notNull().default(0),
    totalTokens: integer('total_tokens').notNull().default(0),
    costUsd: real('cost_usd').notNull().default(0),
    sessionCount: integer('session_count').notNull().default(0),
    snapshotHash: text('snapshot_hash'),
    syncedAt: text('synced_at').notNull()
  },
  (table) => [
    primaryKey({
      columns: [table.userId, table.deviceId, table.source, table.usageDate, table.model]
    }),
    index('daily_usage_logical_key_device_idx').on(
      table.userId,
      table.usageDate,
      table.source,
      table.model,
      table.deviceId
    )
  ]
)

export const dailyUsageSummary = sqliteTable(
  'daily_usage_summary',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    usageDate: text('usage_date').notNull(),
    source: text('source').notNull(),
    model: text('model').notNull(),
    timezone: text('timezone').notNull(),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    cacheCreationTokens: integer('cache_creation_tokens').notNull().default(0),
    cacheReadTokens: integer('cache_read_tokens').notNull().default(0),
    totalTokens: integer('total_tokens').notNull().default(0),
    totalTokensWithoutCacheRead: integer('total_tokens_without_cache_read').notNull().default(0),
    costUsd: real('cost_usd').notNull().default(0),
    sessionCount: integer('session_count').notNull().default(0),
    updatedAt: text('updated_at').notNull()
  },
  (table) => [
    primaryKey({
      columns: [table.userId, table.usageDate, table.source, table.model]
    }),
    index('daily_usage_summary_date_user_idx').on(table.usageDate, table.userId)
  ]
)

export const userUsageTotals = sqliteTable('user_usage_totals', {
  userId: text('user_id')
    .notNull()
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  totalTokens: integer('total_tokens').notNull().default(0),
  totalTokensWithoutCacheRead: integer('total_tokens_without_cache_read').notNull().default(0),
  costUsd: real('cost_usd').notNull().default(0),
  sessionCount: integer('session_count').notNull().default(0),
  updatedAt: text('updated_at').notNull()
})

export const usageSummaryBackfillState = sqliteTable('usage_summary_backfill_state', {
  id: text('id').primaryKey(),
  phase: text('phase').notNull().default('summaries'),
  cursorUserId: text('cursor_user_id'),
  cursorUsageDate: text('cursor_usage_date'),
  cursorSource: text('cursor_source'),
  cursorModel: text('cursor_model'),
  completedAt: text('completed_at'),
  updatedAt: text('updated_at').notNull()
})

export const webhookSubscriptions = sqliteTable(
  'webhook_subscriptions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    provider: text('provider').notNull(),
    webhookUrlEncrypted: text('webhook_url_encrypted').notNull(),
    webhookUrlHost: text('webhook_url_host').notNull(),
    webhookUrlMasked: text('webhook_url_masked').notNull(),
    signingSecretEncrypted: text('signing_secret_encrypted'),
    timezone: text('timezone').notNull().default('UTC'),
    scheduleTimeLocal: text('schedule_time_local').notNull().default('18:00'),
    scheduleTimesLocal: text('schedule_times_local').notNull().default('18:00'),
    scheduleWeekdays: text('schedule_weekdays').notNull().default('0,1,2,3,4,5,6'),
    sendEmptyReport: integer('send_empty_report', { mode: 'boolean' }).notNull().default(false),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    nextRunAt: text('next_run_at').notNull(),
    pendingReportDate: text('pending_report_date'),
    pendingScheduleSlot: text('pending_schedule_slot'),
    lockedUntil: text('locked_until'),
    lockedAt: text('locked_at'),
    failureCount: integer('failure_count').notNull().default(0),
    lastSuccessAt: text('last_success_at'),
    lastFailureAt: text('last_failure_at'),
    lastError: text('last_error'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull()
  },
  (table) => [
    index('webhook_subscriptions_user_idx').on(table.userId, table.createdAt),
    index('webhook_subscriptions_due_idx').on(table.enabled, table.nextRunAt, table.lockedUntil)
  ]
)

export const webhookDeliveryLogs = sqliteTable(
  'webhook_delivery_logs',
  {
    id: text('id').primaryKey(),
    subscriptionId: text('subscription_id')
      .notNull()
      .references(() => webhookSubscriptions.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    reportDate: text('report_date').notNull(),
    scheduleSlot: text('schedule_slot'),
    kind: text('kind').notNull().default('daily'),
    status: text('status').notNull(),
    httpStatus: integer('http_status'),
    attempt: integer('attempt').notNull().default(1),
    error: text('error'),
    durationMs: integer('duration_ms').notNull().default(0),
    createdAt: text('created_at').notNull()
  },
  (table) => [
    index('webhook_delivery_logs_subscription_idx').on(table.subscriptionId, table.createdAt),
    index('webhook_delivery_logs_created_idx').on(table.createdAt),
    uniqueIndex('webhook_delivery_logs_daily_success_idx')
      .on(table.subscriptionId, table.reportDate, table.kind, table.scheduleSlot)
      .where(sql`${table.status} = 'success' AND ${table.kind} = 'daily' AND ${table.scheduleSlot} IS NOT NULL`)
  ]
)

export const dailyReportHistory = sqliteTable(
  'daily_report_history',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    reportDate: text('report_date').notNull(),
    scheduleSlot: text('schedule_slot').notNull(),
    displayName: text('display_name').notNull(),
    timezone: text('timezone').notNull(),
    dashboardUrl: text('dashboard_url').notNull(),
    totalTokens: integer('total_tokens').notNull().default(0),
    totalTokensWithoutCacheRead: integer('total_tokens_without_cache_read').notNull().default(0),
    cacheReadRate: real('cache_read_rate').notNull().default(0),
    costUsd: real('cost_usd').notNull().default(0),
    sessionCount: integer('session_count').notNull().default(0),
    sourceSplit: text('source_split').notNull(),
    topModels: text('top_models').notNull(),
    shareRevokedAt: text('share_revoked_at'),
    generatedAt: text('generated_at').notNull(),
    updatedAt: text('updated_at').notNull()
  },
  (table) => [
    uniqueIndex('daily_report_history_user_date_slot_idx').on(table.userId, table.reportDate, table.scheduleSlot),
    index('daily_report_history_user_generated_idx').on(table.userId, table.generatedAt),
    index('daily_report_history_report_date_idx').on(table.reportDate)
  ]
)

export const schema = {
  users, sessions, accounts, verifications, profiles,
  uploadTokens, pairingCodes, devices,
  dailyUsage, dailyUsageSummary, userUsageTotals,
  usageSummaryBackfillState,
  webhookSubscriptions, webhookDeliveryLogs, dailyReportHistory
}
