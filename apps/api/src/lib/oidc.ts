import { Issuer, type Client, generators } from 'openid-client'
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

// Cache the discovered client so we don't rediscover on every request
let cachedClient: Client | null = null
let cachedIssuerUrl: string | null = null

export async function getOidcClient(): Promise<Client | null> {
  const row = await prisma.authConfig.findUnique({ where: { provider: 'OIDC' } })
  if (!row || !row.enabled) return null

  const cfg = row.config as unknown as OidcConfig
  if (!cfg.issuerUrl || !cfg.clientId || !cfg.clientSecret || !cfg.redirectUri) return null

  // Re-discover if issuerUrl changed
  if (!cachedClient || cachedIssuerUrl !== cfg.issuerUrl) {
    const issuer = await Issuer.discover(cfg.issuerUrl)
    cachedClient = new issuer.Client({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      redirect_uris: [cfg.redirectUri],
      response_types: ['code'],
    })
    cachedIssuerUrl = cfg.issuerUrl
  }

  return cachedClient
}

export function invalidateOidcCache(): void {
  cachedClient = null
  cachedIssuerUrl = null
}

export function generateState(): string {
  return generators.state()
}

export function generateNonce(): string {
  return generators.nonce()
}

export async function getOidcConfig(): Promise<OidcConfig | null> {
  const row = await prisma.authConfig.findUnique({ where: { provider: 'OIDC' } })
  if (!row || !row.enabled) return null
  return row.config as unknown as OidcConfig
}
