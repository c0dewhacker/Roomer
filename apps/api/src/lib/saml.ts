import { SAML } from '@node-saml/node-saml'
import { findAuthConfig } from './prisma.js'
import type { GroupMapping } from './group-mapping.js'

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
