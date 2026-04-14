import ldap from 'ldapjs'
import { prisma } from './prisma'
import type { GroupMapping } from './group-mapping'

export interface LdapConfig {
  url: string
  bindDN: string
  bindCredentials: string
  searchBase: string
  searchFilter: string
  displayNameAttribute?: string
  emailAttribute?: string
  tlsEnabled?: boolean
  tlsRejectUnauthorized?: boolean
  /** LDAP attribute to read group membership from (default: memberOf) */
  groupAttribute?: string
  groupMappings?: GroupMapping[]
}

export async function getLdapConfig(): Promise<LdapConfig | null> {
  const row = await prisma.authConfig.findUnique({ where: { provider: 'LDAP' } })
  if (!row || !row.enabled) return null
  const cfg = row.config as unknown as LdapConfig
  if (!cfg.url || !cfg.searchBase) return null
  return cfg
}

function createLdapClient(cfg: LdapConfig): ldap.Client {
  return ldap.createClient({
    url: cfg.url,
    tlsOptions: cfg.tlsEnabled
      ? { rejectUnauthorized: cfg.tlsRejectUnauthorized ?? true }
      : undefined,
    timeout: 5000,
    connectTimeout: 5000,
  })
}

function bindAsync(client: ldap.Client, dn: string, password: string): Promise<void> {
  return new Promise((resolve, reject) => {
    client.bind(dn, password, (err) => {
      if (err) reject(err)
      else resolve()
    })
  })
}

function searchAsync(
  client: ldap.Client,
  base: string,
  options: ldap.SearchOptions,
): Promise<ldap.SearchEntry[]> {
  return new Promise((resolve, reject) => {
    client.search(base, options, (err, res) => {
      if (err) { reject(err); return }
      const entries: ldap.SearchEntry[] = []
      res.on('searchEntry', (entry) => entries.push(entry))
      res.on('error', reject)
      res.on('end', () => resolve(entries))
    })
  })
}

function unbind(client: ldap.Client): void {
  try { client.unbind() } catch { /* ignore */ }
}

export interface LdapAuthResult {
  email: string
  displayName: string
  dn: string
  /** Raw group values (e.g. memberOf DNs) for group mapping */
  groups: string[]
}

export async function authenticateWithLdap(
  email: string,
  password: string,
): Promise<LdapAuthResult | null> {
  const cfg = await getLdapConfig()
  if (!cfg) return null

  const adminClient = createLdapClient(cfg)

  try {
    // 1. Bind as admin/service account to search
    await bindAsync(adminClient, cfg.bindDN, cfg.bindCredentials)

    // 2. Search for user by email
    // Escape special LDAP filter characters per RFC 4515
    const escapedEmail = email.replace(/[\\*()\[\]\0/]/g, (c) => `\\${c.charCodeAt(0).toString(16).padStart(2, '0')}`)
    // Use replaceAll so that every occurrence of {{email}} is substituted.
    // A single .replace() would leave a second occurrence unescaped which could
    // act as an LDAP injection vector if the filter template were ever authored
    // with the placeholder appearing twice.
    const filter = (cfg.searchFilter ?? '(mail={{email}})').replaceAll('{{email}}', escapedEmail)
    const emailAttr = cfg.emailAttribute ?? 'mail'
    const nameAttr = cfg.displayNameAttribute ?? 'displayName'
    const groupAttr = cfg.groupAttribute ?? 'memberOf'

    const entries = await searchAsync(adminClient, cfg.searchBase, {
      filter,
      scope: 'sub',
      attributes: ['dn', emailAttr, nameAttr, groupAttr],
    })

    if (entries.length === 0) return null

    const entry = entries[0]
    const userDn = entry.dn.toString()

    // Use entry.attributes (raw Attribute objects) — more reliable than entry.pojo
    // which can vary with ldapjs versions. Each attribute has .type and .values.
    const attrs = entry.attributes as Array<{ type: string; values: string[] }>
    const getAttr = (name: string) => attrs.find((a) => a.type.toLowerCase() === name.toLowerCase())

    const userEmail = getAttr(emailAttr)?.values[0] ?? email
    const userDisplayName = getAttr(nameAttr)?.values[0] ?? email
    // Group values are trimmed to avoid whitespace issues in DN comparisons
    const groups = (getAttr(groupAttr)?.values ?? []).map((g) => g.trim())

    // 3. Try binding as the user to verify password
    const userClient = createLdapClient(cfg)
    try {
      await bindAsync(userClient, userDn, password)
      unbind(userClient)
    } catch {
      // Wrong password
      return null
    }

    return { email: userEmail, displayName: userDisplayName, dn: userDn, groups }
  } catch {
    return null
  } finally {
    unbind(adminClient)
  }
}
