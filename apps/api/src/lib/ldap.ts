import ldap from 'ldapjs'
import { prisma, findAuthConfig } from './prisma.js'
import type { GroupMapping } from './group-mapping.js'
import { dispatchWebhook } from './webhook.js'

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
  /** Base DN for directory sync (defaults to searchBase if omitted) */
  syncBase?: string
  /** LDAP filter used during directory sync (default: (objectClass=person)) */
  syncFilter?: string
  /** Scope for sync search: sub (subtree) or one (one-level). Default: sub */
  syncScope?: 'sub' | 'one'
  /** When true, deactivate LDAP-provider users absent from the sync results */
  deactivateMissing?: boolean
  /** LDAP attribute containing the user's department name (e.g. 'department') */
  departmentAttribute?: string
  /** LDAP attribute containing the user's manager DN (e.g. 'manager') */
  managerAttribute?: string
}

export interface LdapSyncResult {
  created: number
  updated: number
  deactivated: number
  managersResolved?: number
  skipped: number
  errors: Array<{ dn: string; message: string }>
}

export async function getLdapConfig(): Promise<LdapConfig | null> {
  const row = await findAuthConfig('LDAP')
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
  /** Department attribute value, if departmentAttribute is configured */
  department?: string
}

export async function syncLdapUsers(cfg: LdapConfig): Promise<LdapSyncResult> {
  const result: LdapSyncResult = { created: 0, updated: 0, deactivated: 0, skipped: 0, errors: [] }

  const emailAttr = cfg.emailAttribute ?? 'mail'
  const nameAttr = cfg.displayNameAttribute ?? 'displayName'
  const groupAttr = cfg.groupAttribute ?? 'memberOf'
  const deptAttr = cfg.departmentAttribute
  const managerAttr = cfg.managerAttribute
  const syncBase = cfg.syncBase?.trim() || cfg.searchBase
  const syncFilter = cfg.syncFilter?.trim() || '(objectClass=person)'
  const syncScope = cfg.syncScope ?? 'sub'

  // Resolve org ID once upfront if we need to upsert departments
  let orgId: string | null = null
  if (deptAttr) {
    const org = await prisma.organisation.findFirst({ select: { id: true } })
    orgId = org?.id ?? null
  }

  const client = createLdapClient(cfg)
  try {
    await bindAsync(client, cfg.bindDN, cfg.bindCredentials)

    const attrs = ['dn', emailAttr, nameAttr, groupAttr]
    if (deptAttr) attrs.push(deptAttr)
    if (managerAttr) attrs.push(managerAttr)

    const entries = await searchAsync(client, syncBase, {
      filter: syncFilter,
      scope: syncScope,
      attributes: attrs,
    })

    const seenEmails = new Set<string>()

    for (const entry of entries) {
      const attrs = entry.attributes as Array<{ type: string; values: string[] }>
      const getAttr = (name: string) => attrs.find((a) => a.type.toLowerCase() === name.toLowerCase())

      const email = getAttr(emailAttr)?.values[0]?.trim().toLowerCase()
      if (!email) { result.skipped++; continue }

      const displayName = getAttr(nameAttr)?.values[0]?.trim() || email
      const groups = (getAttr(groupAttr)?.values ?? []).map((g) => g.trim().toLowerCase())
      const departmentName = deptAttr ? getAttr(deptAttr)?.values[0]?.trim() : undefined
      const managerRef = managerAttr ? (getAttr(managerAttr)?.values[0]?.trim() || null) : undefined
      const dn = entry.dn.toString()

      seenEmails.add(email)

      try {
        const existing = await prisma.user.findUnique({ where: { email } })
        if (existing) {
          await prisma.user.update({
            where: { email },
            data: {
              displayName, accountStatus: 'ACTIVE', provider: 'LDAP', externalId: dn,
              ...(managerAttr ? { managerExternalRef: managerRef } : {}),
            },
          })
          result.updated++
        } else {
          await prisma.user.create({
            data: {
              email, displayName, provider: 'LDAP', externalId: dn,
              ...(managerAttr ? { managerExternalRef: managerRef } : {}),
            },
          })
          result.created++
        }

        const userId = existing?.id ?? (await prisma.user.findUnique({ where: { email }, select: { id: true } }))!.id
        if (cfg.groupMappings?.length && groups.length) {
          const { applyGroupMappings } = await import('./group-mapping.js')
          await applyGroupMappings(userId, groups, cfg.groupMappings, true)
        }

        if (departmentName && orgId) {
          const dept = await prisma.department.upsert({
            where: { organisationId_name: { organisationId: orgId, name: departmentName } },
            create: { organisationId: orgId, name: departmentName },
            update: {},
          })
          await prisma.user.update({ where: { id: userId }, data: { departmentId: dept.id } })
        }
      } catch (err) {
        result.errors.push({ dn, message: err instanceof Error ? err.message : 'Unknown error' })
      }
    }

    if (cfg.deactivateMissing && seenEmails.size > 0) {
      const deactivated = await prisma.user.updateMany({
        where: { provider: 'LDAP', accountStatus: 'ACTIVE', email: { notIn: [...seenEmails] } },
        data: { accountStatus: 'BLOCKED' },
      })
      result.deactivated = deactivated.count
    }
  } finally {
    unbind(client)
  }

  // Resolve manager DNs → managerId now that all users are present.
  if (managerAttr) {
    const { reconcileAllManagers } = await import('./manager.js')
    const { resolved } = await reconcileAllManagers()
    result.managersResolved = resolved
  }

  if (result.created > 0 || result.updated > 0) {
    dispatchWebhook('user.imported', { created: result.created, updated: result.updated, deactivated: result.deactivated }).catch(() => {})
  }

  return result
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
    const deptAttr = cfg.departmentAttribute

    const searchAttrs = ['dn', emailAttr, nameAttr, groupAttr]
    if (deptAttr) searchAttrs.push(deptAttr)

    const entries = await searchAsync(adminClient, cfg.searchBase, {
      filter,
      scope: 'sub',
      attributes: searchAttrs,
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
    const groups = (getAttr(groupAttr)?.values ?? []).map((g) => g.trim().toLowerCase())
    const department = deptAttr ? getAttr(deptAttr)?.values[0]?.trim() : undefined

    // 3. Try binding as the user to verify password
    const userClient = createLdapClient(cfg)
    try {
      await bindAsync(userClient, userDn, password)
      unbind(userClient)
    } catch {
      // Wrong password
      return null
    }

    return { email: userEmail, displayName: userDisplayName, dn: userDn, groups, department }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? 'unknown'
    const message = err instanceof Error ? err.message : 'Unknown error'
    // Log at warn level — never include bind credentials or user passwords
    console.warn(`[ldap] authenticateWithLdap failed (${code}): ${message}`)
    return null
  } finally {
    unbind(adminClient)
  }
}
