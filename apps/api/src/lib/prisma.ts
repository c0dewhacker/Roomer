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

export async function findAuthConfig(provider: AuthConfigProvider) {
  const row = await prisma.authConfig.findUnique({ where: { provider } })
  return row ? decryptConfig(row) : null
}

export async function listAuthConfigs() {
  const rows = await prisma.authConfig.findMany()
  return rows.map(decryptConfig)
}

export async function upsertAuthConfig(
  provider: AuthConfigProvider,
  data: { enabled?: boolean; config?: Record<string, unknown> },
) {
  const encryptedConfig = data.config !== undefined ? encryptJson(data.config) : undefined
  const row = await prisma.authConfig.upsert({
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
