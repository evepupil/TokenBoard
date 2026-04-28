import { betterAuth } from 'better-auth'
import type { Bindings } from '../../lib/db'

export const authBasePath = '/api/auth'

export function createAuth(
  env: Pick<Bindings, 'DB' | 'BETTER_AUTH_SECRET' | 'BETTER_AUTH_URL' | 'GITHUB_CLIENT_ID' | 'GITHUB_CLIENT_SECRET'>,
  request?: Request
) {
  const origin = request ? new URL(request.url).origin : undefined
  const secret = env.BETTER_AUTH_SECRET || (origin?.startsWith('http://localhost') ? 'dev-tokenboard-local-secret' : undefined)

  return betterAuth({
    appName: 'TokenBoard',
    basePath: authBasePath,
    baseURL: env.BETTER_AUTH_URL || origin,
    secret,
    database: env.DB,
    socialProviders: {
      github: {
        clientId: env.GITHUB_CLIENT_ID || '',
        clientSecret: env.GITHUB_CLIENT_SECRET || ''
      }
    },
    trustedOrigins: origin ? [origin] : undefined,
    user: {
      modelName: 'users',
      fields: {
        emailVerified: 'email_verified',
        createdAt: 'created_at',
        updatedAt: 'updated_at'
      }
    },
    session: {
      modelName: 'sessions',
      fields: {
        userId: 'user_id',
        expiresAt: 'expires_at',
        ipAddress: 'ip_address',
        userAgent: 'user_agent',
        createdAt: 'created_at',
        updatedAt: 'updated_at'
      }
    },
    account: {
      modelName: 'accounts',
      fields: {
        accountId: 'account_id',
        providerId: 'provider_id',
        userId: 'user_id',
        accessToken: 'access_token',
        refreshToken: 'refresh_token',
        idToken: 'id_token',
        accessTokenExpiresAt: 'access_token_expires_at',
        refreshTokenExpiresAt: 'refresh_token_expires_at',
        createdAt: 'created_at',
        updatedAt: 'updated_at'
      }
    },
    verification: {
      modelName: 'verifications',
      fields: {
        expiresAt: 'expires_at',
        createdAt: 'created_at',
        updatedAt: 'updated_at'
      }
    }
  })
}
