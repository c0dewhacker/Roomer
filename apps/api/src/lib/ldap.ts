import ldap from 'ldapjs'
import { prisma, findAuthConfig } from './prisma.js'
import type { GroupMapping } from './group-mapping.js'
import { lockSuperAdminGuard } from './group-mapping.js'
import { GlobalRole } from '@roomer/shared'
import { dispatchWebhook } from './webhook.js'
import { decryptStringMaybe } from './encryption.js'
import { cancelFutureBookingsForUser, cancelQueueEntriesForUser, releaseAssetAssignmentsForUser } from './queue.js'

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
  // bindCredentials is encrypted at rest (enc:v1:…); decryptStringMaybe also
  // transparently passes through legacy plaintext rows saved before this fix.
  if (cfg.bindCredentials) cfg.bindCredentials = decryptStringMaybe(cfg.bindCredentials)
  return cfg
}

function createLdapClient(cfg: LdapConfig): ldap.Client {
  const client = ldap.createClient({
    url: cfg.url,
    tlsOptions: cfg.tlsEnabled
      ? { rejectUnauthorized: cfg.tlsRejectUnauthorized ?? true }
      : undefined,
    timeout: 5000,
    connectTimeout: 5000,
  })
  // ldapjs emits 'error' directly on the client for connection-level failures
  // (unreachable host, connect timeout) — these fire independently of any
  // bind/search callback. With zero listeners, Node's EventEmitter rethrows
  // synchronously and crashes the whole process, taking down every user's
  // session over one bad LDAP config or a transient network blip. bindAsync/
  // searchAsync attach their own listener while a call is in flight to reject
  // their promise instead of hanging; this is the permanent fallback so an
  // error firing at any other time (e.g. between calls, or after the request
  // that triggered it has already finished) still can't crash the process.
  client.on('error', () => {})
  return client
}

function bindAsync(client: ldap.Client, dn: string, password: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => reject(err)
    client.once('error', onError)
    client.bind(dn, password, (err) => {
      client.removeListener('error', onError)
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
    const onError = (err: Error) => reject(err)
    client.once('error', onError)
    client.search(base, options, (err, res) => {
      if (err) { client.removeListener('error', onError); reject(err); return }
      const entries: ldap.SearchEntry[] = []
      res.on('searchEntry', (entry) => entries.push(entry))
      res.on('error', (searchErr) => { client.removeListener('error', onError); reject(searchErr) })
      res.on('end', () => { client.removeListener('error', onError); resolve(entries) })
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
  /** Raw manager attribute value (a DN, email, or UPN), if managerAttribute is configured */
  manager?: string
}

// Guards against a second admin (or a second tab) triggering an overlapping
// full-directory sync — the client only disables its own button while its
// own request is pending, which doesn't stop a concurrent one from
// elsewhere, and two syncs racing over the same users wastes a full LDAP
// traversal and produces error counts that are hard to attribute to either run.
let ldapSyncInProgress = false

export async function syncLdapUsers(cfg: LdapConfig): Promise<LdapSyncResult> {
  if (ldapSyncInProgress) {
    throw new Error('LDAP_SYNC_IN_PROGRESS')
  }
  ldapSyncInProgress = true
  try {
    return await runLdapSync(cfg)
  } finally {
    ldapSyncInProgress = false
  }
}

async function runLdapSync(cfg: LdapConfig): Promise<LdapSyncResult> {
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
        // Same two guards findOrCreateSsoUser (OIDC/SAML, auth-enterprise.ts)
        // and the interactive LDAP login path (auth.ts) already apply before
        // linking — this batch sync was the one caller still skipping them.
        // A local-password account must never be silently taken over by a
        // directory sync, and an account already linked to a DIFFERENT
        // directory entry must never be silently re-pointed — otherwise a
        // recycled email address reassigned to a new employee after the
        // previous one left would quietly inherit the previous person's
        // entire account, role, group memberships, and booking history the
        // next time this sync runs.
        if (existing?.passwordHash) {
          throw new Error(`Skipped: ${email} is a local-password account, not linked to LDAP`)
        }
        if (existing?.externalId && existing.externalId !== dn) {
          throw new Error(`Skipped: ${email} is already linked to a different directory identity (${existing.externalId})`)
        }
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
        // Deliberately does NOT also require groups.length: an empty array is
        // exactly the "user was removed from every mapped group" signal that
        // must reach applyGroupMappings so its sync=true eviction/demotion
        // logic can run — gating this on a non-empty group list silently
        // skipped revocation for a fully-deprovisioned directory entry.
        if (cfg.groupMappings?.length) {
          const { applyGroupMappings } = await import('./group-mapping.js')
          await applyGroupMappings(userId, groups, cfg.groupMappings, true)
        }

        if (departmentName && orgId) {
          const { findOrCreateDepartment } = await import('./department.js')
          const dept = await findOrCreateDepartment(orgId, departmentName)
          await prisma.user.update({ where: { id: userId }, data: { departmentId: dept.id } })
        }
      } catch (err) {
        result.errors.push({ dn, message: err instanceof Error ? err.message : 'Unknown error' })
      }
    }

    if (cfg.deactivateMissing && seenEmails.size > 0) {
      // Select the affected users before the bulk update — same reasoning as
      // every other "must run before" cascade in this codebase: updateMany's
      // count alone doesn't tell us WHICH users to release bookings/desks for.
      const toDeactivate = await prisma.user.findMany({
        where: { provider: 'LDAP', accountStatus: 'ACTIVE', email: { notIn: [...seenEmails] } },
        select: { id: true, email: true, globalRole: true },
      })
      if (toDeactivate.length > 0) {
        // Blocking a user is functionally identical to demoting them for
        // last-active-super-admin purposes (requireAuth rejects a BLOCKED
        // user's every request, same as a non-SUPER_ADMIN's) — every other
        // path that can flip accountStatus to BLOCKED (PATCH /users/:id, CSV
        // bulk import, SCIM PUT/PATCH/DELETE, the IdP group-mapping globalRole
        // demotion) serialises against SUPER_ADMIN_GUARD_LOCK_CLASS and
        // refuses to zero out active admins. This directory-driven mass
        // deactivation is reachable the exact same way (an admin's LDAP entry
        // ages out of the sync filter, or is deleted upstream) and previously
        // had no such guard — silently locking an org out of its own admin UI
        // with no recovery path short of direct DB access.
        const safeToDeactivate = await prisma.$transaction(async (tx) => {
          await lockSuperAdminGuard(tx)
          const candidateIds = toDeactivate.map((u) => u.id)
          const activeSuperAdminIds = new Set(
            (await tx.user.findMany({
              where: { globalRole: GlobalRole.SUPER_ADMIN, accountStatus: 'ACTIVE' },
              select: { id: true },
            })).map((u) => u.id),
          )
          const superAdminsInBatch = candidateIds.filter((id) => activeSuperAdminIds.has(id))
          // Deactivating this whole batch would leave zero active super
          // admins — protect ALL of them rather than arbitrarily sparing one;
          // an automated directory sync shouldn't be the thing deciding which
          // admin account survives.
          const wouldZeroOutAdmins = superAdminsInBatch.length > 0 && superAdminsInBatch.length === activeSuperAdminIds.size
          const safe = wouldZeroOutAdmins
            ? toDeactivate.filter((u) => !superAdminsInBatch.includes(u.id))
            : toDeactivate

          if (safe.length > 0) {
            await tx.user.updateMany({
              where: { id: { in: safe.map((u) => u.id) } },
              data: { accountStatus: 'BLOCKED' },
            })
          }
          return safe
        })

        for (const u of toDeactivate) {
          if (!safeToDeactivate.some((s) => s.id === u.id)) {
            result.errors.push({ dn: u.email, message: 'Skipped deactivation — would leave the organisation with no active Super Admin' })
          }
        }

        for (const { id: userId } of safeToDeactivate) {
          await cancelFutureBookingsForUser(userId)
          await cancelQueueEntriesForUser(userId)
          await releaseAssetAssignmentsForUser(userId)
        }
        result.deactivated = safeToDeactivate.length
      }
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
    const managerAttr = cfg.managerAttribute

    const searchAttrs = ['dn', emailAttr, nameAttr, groupAttr]
    if (deptAttr) searchAttrs.push(deptAttr)
    if (managerAttr) searchAttrs.push(managerAttr)

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
    const manager = managerAttr ? getAttr(managerAttr)?.values[0]?.trim() : undefined

    // 3. Try binding as the user to verify password
    const userClient = createLdapClient(cfg)
    try {
      await bindAsync(userClient, userDn, password)
      unbind(userClient)
    } catch {
      // Wrong password
      return null
    }

    return { email: userEmail, displayName: userDisplayName, dn: userDn, groups, department, manager }
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
