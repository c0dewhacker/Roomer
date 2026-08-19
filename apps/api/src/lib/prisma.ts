import { PrismaClient, Prisma } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { Pool } from 'pg'
import { encryptJson, decryptJson } from './encryption.js'

const dbUrl = process.env['ROOMER_DATABASE_URL'] ?? process.env['DATABASE_URL']
const nodeEnv = process.env['ROOMER_NODE_ENV'] ?? process.env['NODE_ENV']

declare global {
  // Allow global prisma in development to survive hot reloads
  var __prisma: PrismaClient | undefined
}

function createPrismaClient(): PrismaClient {
  const pool = new Pool({ connectionString: dbUrl })
  const adapter = new PrismaPg(pool)
  return new PrismaClient({
    adapter,
    log: nodeEnv === 'development' ? ['query', 'info', 'warn', 'error'] : ['warn', 'error'],
  })
}

export const prisma: PrismaClient =
  nodeEnv === 'production'
    ? createPrismaClient()
    : (global.__prisma ?? (global.__prisma = createPrismaClient()))

// ── AuthConfig encrypted accessors ───────────────────────────────────────────
// AuthConfig.config stores sensitive credentials (OIDC clientSecret, LDAP
// bindCredentials). These functions transparently encrypt on write and decrypt
// on read so all callsites get plain objects without handling encryption directly.

type AuthConfigProvider = 'OIDC' | 'SAML' | 'LDAP'

function decryptConfig<T extends { config: Prisma.JsonValue }>(row: T): T {
  return { ...row, config: decryptJson(row.config) }
}

// `client` defaults to the module-level prisma singleton for the many
// read-only callers (login-time lookups in saml.ts/ldap.ts/oidc.ts, where
// wrapping every login in a transaction would be pure overhead). The one
// caller that mutates config (settings.ts PUT /auth-config/:provider) passes
// its own Prisma.TransactionClient so the read-merge-write it does around
// this can be lock-protected against a concurrent edit of the same provider.
export async function findAuthConfig(
  provider: AuthConfigProvider,
  client: Prisma.TransactionClient | PrismaClient = prisma,
) {
  const row = await client.authConfig.findUnique({ where: { provider } })
  return row ? decryptConfig(row) : null
}

export async function listAuthConfigs() {
  const rows = await prisma.authConfig.findMany()
  return rows.map(decryptConfig)
}

export async function upsertAuthConfig(
  provider: AuthConfigProvider,
  data: { enabled?: boolean; config?: Record<string, unknown> },
  client: Prisma.TransactionClient | PrismaClient = prisma,
) {
  const encryptedConfig = data.config !== undefined ? encryptJson(data.config) : undefined
  const row = await client.authConfig.upsert({
    where: { provider },
    update: {
      ...(typeof data.enabled === 'boolean' ? { enabled: data.enabled } : {}),
      ...(encryptedConfig !== undefined ? { config: encryptedConfig } : {}),
    },
    create: {
      provider,
      enabled: data.enabled ?? false,
      config: encryptedConfig ?? '{}',
    },
  })
  return decryptConfig(row)
}
