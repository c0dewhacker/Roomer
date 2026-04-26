import { discovery, randomState, randomNonce, type Configuration, ClientSecretPost } from 'openid-client'
import { prisma } from './prisma'
import type { GroupMapping } from './group-mapping'

export interface OidcConfig {
  issuerUrl: string
  clientId: string
  clientSecret: string
  redirectUri: string
  scope?: string
  label?: string
  /** JWT/userinfo claim name containing the user's groups (default: groups) */
  groupsClaimName?: string
  groupMappings?: GroupMapping[]
}

const CACHE_TTL_MS = 60 * 60 * 1000 // 1 hour — forces re-discovery if IdP rotates keys

let cachedConfig: Configuration | null = null
let cachedIssuerUrl: string | null = null
let cachedAt: number = 0

export async function getOidcClientConfig(): Promise<Configuration | null> {
  const row = await prisma.authConfig.findUnique({ where: { provider: 'OIDC' } })
  if (!row || !row.enabled) return null

  const cfg = row.config as unknown as OidcConfig
  if (!cfg.issuerUrl || !cfg.clientId || !cfg.clientSecret || !cfg.redirectUri) return null

  const cacheExpired = Date.now() - cachedAt > CACHE_TTL_MS

  if (!cachedConfig || cachedIssuerUrl !== cfg.issuerUrl || cacheExpired) {
    cachedConfig = await discovery(
      new URL(cfg.issuerUrl),
      cfg.clientId,
      { client_secret: cfg.clientSecret },
      ClientSecretPost(cfg.clientSecret),
    )
    cachedIssuerUrl = cfg.issuerUrl
    cachedAt = Date.now()
  }

  return cachedConfig
}

export function invalidateOidcCache(): void {
  cachedConfig = null
  cachedIssuerUrl = null
  cachedAt = 0
}

export function generateState(): string {
  return randomState()
}

export function generateNonce(): string {
  return randomNonce()
}

export async function getOidcConfig(): Promise<OidcConfig | null> {
  const row = await prisma.authConfig.findUnique({ where: { provider: 'OIDC' } })
  if (!row || !row.enabled) return null
  return row.config as unknown as OidcConfig
}
