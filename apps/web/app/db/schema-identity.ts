import { sql } from 'drizzle-orm'
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  email: text('email').unique(),
  emailVerified: integer('email_verified', { mode: 'boolean' }).notNull().default(false),
  name: text('name'),
  image: text('image'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull()
})

export const sessions = sqliteTable(
  'sessions',
  {
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
  },
  (table) => [index('sessions_user_id_idx').on(table.userId)]
)

export const accounts = sqliteTable(
  'accounts',
  {
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
  },
  (table) => [index('accounts_user_id_idx').on(table.userId)]
)

export const verifications = sqliteTable(
  'verifications',
  {
    id: text('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: integer('expires_at').notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull()
  },
  (table) => [index('verifications_identifier_idx').on(table.identifier)]
)

export const profiles = sqliteTable(
  'profiles',
  {
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
    participatesInLeaderboards: integer('participates_in_leaderboards', { mode: 'boolean' }).notNull().default(false),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull()
  },
  (table) => [index('profiles_public_leaderboard_idx').on(table.isPublic, table.participatesInLeaderboards)]
)

export const uploadTokens = sqliteTable(
  'upload_tokens',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    deviceId: text('device_id'),
    installationId: text('installation_id'),
    supersedesTokenId: text('supersedes_token_id'),
    lastUsedAt: text('last_used_at'),
    createdAt: text('created_at').notNull(),
    revokedAt: text('revoked_at')
  },
  (table) => [
    index('upload_tokens_user_id_idx').on(table.userId),
    index('upload_tokens_device_id_idx').on(table.deviceId),
    index('upload_tokens_installation_id_idx').on(table.installationId),
    uniqueIndex('upload_tokens_active_successor_idx')
      .on(table.supersedesTokenId)
      .where(sql`${table.supersedesTokenId} IS NOT NULL AND ${table.revokedAt} IS NULL`)
  ]
)

export const pairingCodes = sqliteTable(
  'pairing_codes',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    codeHash: text('code_hash').notNull().unique(),
    pairingType: text('pairing_type').notNull().default('new_device'),
    targetDeviceId: text('target_device_id'),
    metadata: text('metadata'),
    expiresAt: text('expires_at').notNull(),
    consumedAt: text('consumed_at'),
    createdAt: text('created_at').notNull()
  },
  (table) => [index('pairing_codes_target_device_idx').on(table.userId, table.targetDeviceId)]
)

export const devices = sqliteTable(
  'devices',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    platform: text('platform').notNull(),
    lastSyncedAt: text('last_synced_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull()
  },
  (table) => [index('devices_user_id_idx').on(table.userId)]
)

export const deviceInstallations = sqliteTable(
  'device_installations',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    deviceId: text('device_id')
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    platform: text('platform').notNull(),
    hostname: text('hostname'),
    clientVersion: text('client_version'),
    installClaimHash: text('install_claim_hash'),
    firstSeenAt: text('first_seen_at').notNull(),
    lastSeenAt: text('last_seen_at'),
    revokedAt: text('revoked_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull()
  },
  (table) => [
    index('device_installations_user_id_idx').on(table.userId),
    index('device_installations_device_id_idx').on(table.deviceId)
  ]
)

export const auditLogs = sqliteTable(
  'audit_logs',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    actorType: text('actor_type').notNull(),
    action: text('action').notNull(),
    targetType: text('target_type').notNull(),
    targetId: text('target_id'),
    metadata: text('metadata'),
    createdAt: text('created_at').notNull()
  },
  (table) => [index('audit_logs_user_created_idx').on(table.userId, table.createdAt)]
)
