import { SAML, ValidateInResponseTo, type CacheProvider } from '@node-saml/node-saml'
import { findAuthConfig } from './prisma.js'
import type { GroupMapping } from './group-mapping.js'

/**
 * AuthnRequest-ID cache backing validateInResponseTo below. buildSaml() is
 * called fresh on every /saml/authorize and /saml/callback request — without
 * a cache instance shared across both, each call would construct its own
 * cacheProvider default (or, without this module, none at all), so the ID
 * saved at /authorize would never be visible to /callback and
 * validateInResponseTo would reject every response. Single-process only
 * (matches the library's own default in-memory provider's documented
 * limitation) — a multi-replica deployment needs a shared store instead, but
 * this is still strictly better than the no-replay-protection state before.
 */
class InMemoryAuthnRequestCache implements CacheProvider {
  private readonly entries = new Map<string, { value: string; createdAt: number }>()
  private readonly ttlMs: number

  constructor(ttlMs: number) {
    this.ttlMs = ttlMs
  }

  private prune(): void {
    const cutoff = Date.now() - this.ttlMs
    for (const [key, item] of this.entries) {
      if (item.createdAt < cutoff) this.entries.delete(key)
    }
  }

  async saveAsync(key: string, value: string): Promise<{ value: string; createdAt: number } | null> {
    this.prune()
    const item = { value, createdAt: Date.now() }
    this.entries.set(key, item)
    return item
  }

  async getAsync(key: string): Promise<string | null> {
    this.prune()
    return this.entries.get(key)?.value ?? null
  }

  async removeAsync(key: string | null): Promise<string | null> {
    if (!key) return null
    const item = this.entries.get(key)
    this.entries.delete(key)
    return item?.value ?? null
  }
}

const samlAuthnRequestCache = new InMemoryAuthnRequestCache(10 * 60 * 1000)

export interface SamlConfig {
  entryPoint: string
  issuer: string
  cert: string
  callbackUrl: string
  label?: string
  signatureAlgorithm?: 'sha1' | 'sha256' | 'sha512'
  /** SAML attribute name containing group membership (default: groups) */
  groupAttribute?: string
  groupMappings?: GroupMapping[]
  /** Whether the outer SAML response envelope must be signed (default: true) */
  wantAuthnResponseSigned?: boolean
  /** Whether the SAML assertion element must be signed (default: true) */
  wantAssertionsSigned?: boolean
  /** Accepted clock skew in milliseconds for timestamp validation (default: 0) */
  allowClockSkewMs?: number
  /** SAML attribute containing department name (default: department) */
  departmentAttribute?: string
  /** SAML attribute containing the user's manager (email/UPN). Blank = disabled. */
  managerAttribute?: string
}

export async function getSamlConfig(): Promise<SamlConfig | null> {
  const row = await findAuthConfig('SAML')
  if (!row || !row.enabled) return null
  const cfg = row.config as unknown as SamlConfig
  if (!cfg.entryPoint || !cfg.cert || !cfg.callbackUrl) return null
  return cfg
}

export function buildSaml(cfg: SamlConfig): SAML {
  return new SAML({
    entryPoint: cfg.entryPoint,
    issuer: cfg.issuer || 'roomer',
    idpCert: cfg.cert,
    callbackUrl: cfg.callbackUrl,
    signatureAlgorithm: cfg.signatureAlgorithm ?? 'sha256',
    wantAuthnResponseSigned: cfg.wantAuthnResponseSigned ?? true,
    wantAssertionsSigned: cfg.wantAssertionsSigned ?? true,
    acceptedClockSkewMs: cfg.allowClockSkewMs ?? 0,
    // Without this the library defaults to ValidateInResponseTo.never — the
    // AuthnRequest ID sent at /saml/authorize is never recorded or checked
    // against the Response's InResponseTo, so signature/timestamp validation
    // alone still lets a captured, still-unexpired SAMLResponse be replayed
    // to mint a fresh session indefinitely. `always` + the shared cache below
    // tracks and consumes each AuthnRequest ID exactly once.
    validateInResponseTo: ValidateInResponseTo.always,
    cacheProvider: samlAuthnRequestCache,
  })
}

export interface SamlProfile {
  email?: string
  nameID?: string
  displayName?: string
  groups?: string | string[]
  // Common SAML attribute names
  'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress'?: string
  'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name'?: string
  'http://schemas.microsoft.com/identity/claims/displayname'?: string
  'http://schemas.microsoft.com/ws/2008/06/identity/claims/groups'?: string | string[]
  [key: string]: unknown
}

export function extractEmailFromProfile(profile: SamlProfile): string | null {
  return (
    profile.email ??
    profile['http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress'] ??
    profile.nameID ??
    null
  )
}

export function extractGroupsFromProfile(profile: SamlProfile, groupAttribute?: string): string[] {
  const attr = groupAttribute ?? 'groups'
  const raw = profile[attr] ?? profile['http://schemas.microsoft.com/ws/2008/06/identity/claims/groups']
  if (!raw) return []
  return Array.isArray(raw) ? raw.map(String) : [String(raw)]
}

export function extractDisplayNameFromProfile(profile: SamlProfile): string {
  return (
    profile.displayName ??
    profile['http://schemas.microsoft.com/identity/claims/displayname'] ??
    profile['http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name'] ??
    'SSO User'
  )
}

export function extractDepartmentFromProfile(profile: SamlProfile, attribute?: string): string | null {
  const attr = attribute ?? 'department'
  const val = profile[attr]
  if (typeof val === 'string' && val.trim()) return val.trim()
  const msVal = profile['http://schemas.microsoft.com/identity/claims/department']
  if (typeof msVal === 'string' && msVal.trim()) return msVal.trim()
  return null
}

export function extractManagerFromProfile(profile: SamlProfile, attribute?: string): string | null {
  if (attribute) {
    const val = profile[attribute]
    if (typeof val === 'string' && val.trim()) return val.trim()
  }
  // Common AD FS / Entra manager claim URI.
  const msVal = profile['http://schemas.microsoft.com/ws/2008/06/identity/claims/manager']
  if (typeof msVal === 'string' && msVal.trim()) return msVal.trim()
  return null
}
