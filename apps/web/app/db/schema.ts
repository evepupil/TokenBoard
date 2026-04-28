import { integer, primaryKey, real, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  email: text('email').unique(),
  name: text('name'),
  image: text('image'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull()
})

export const profiles = sqliteTable('profiles', {
  userId: text('user_id')
    .notNull()
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  slug: text('slug').notNull().unique(),
  displayName: text('display_name').notNull(),
  timezone: text('timezone').notNull().default('UTC'),
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
    syncedAt: text('synced_at').notNull()
  },
  (table) => [
    primaryKey({
      columns: [table.userId, table.source, table.usageDate, table.model]
    })
  ]
)

export const schema = {
  users,
  profiles,
  uploadTokens,
  pairingCodes,
  devices,
  dailyUsage
}
