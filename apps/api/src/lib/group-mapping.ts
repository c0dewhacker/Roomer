import { Prisma } from '@prisma/client'
import { prisma } from './prisma.js'
import { GlobalRole, RoleSource } from '@roomer/shared'

// Distinct from booking.ts's advisory lock classes (4242-4245) and queue.ts's
// FLOOR_NOTIFICATION_LOCK_CLASS (4244) — next unused integer.
const SUPER_ADMIN_GUARD_LOCK_CLASS = 4246

/**
 * Serialises every check-then-mutate sequence anywhere in the app that could
 * demote, block, or delete a SUPER_ADMIN, against every other such sequence —
 * not just against other actions on the same user row. Without this, two
 * concurrent requests demoting two *different* admins (the only two active
 * ones) can each read "at least one other active admin exists" before either
 * commits, and both proceed, leaving zero active super admins with no way
 * back into the org's own admin UI short of direct DB access.
 *
 * Must be called inside a transaction, before wouldRemoveLastActiveSuperAdmin
 * and the mutation that acts on its result — any gap re-opens the race.
 */
export async function lockSuperAdminGuard(tx: Prisma.TransactionClient): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${SUPER_ADMIN_GUARD_LOCK_CLASS})`
}

/**
 * True if demoting/blocking/deleting `userId` right now would leave the org
 * with zero active SUPER_ADMINs. Call after lockSuperAdminGuard, in the same
 * transaction as the eventual mutation.
 */
export async function wouldRemoveLastActiveSuperAdmin(
  tx: Prisma.TransactionClient,
  userId: string,
): Promise<boolean> {
  const target = await tx.user.findUnique({ where: { id: userId }, select: { globalRole: true, accountStatus: true } })
  if (target?.globalRole !== GlobalRole.SUPER_ADMIN || target.accountStatus !== 'ACTIVE') return false
  const otherActiveAdmins = await tx.user.count({
    where: { id: { not: userId }, globalRole: GlobalRole.SUPER_ADMIN, accountStatus: 'ACTIVE' },
  })
  return otherActiveAdmins === 0
}

/**
 * Record the raw IdP group values seen on this login so admins can copy exact
 * identifiers when configuring mappings, and the mapping dry-run can use them.
 * Safe to call on every SSO/LDAP login regardless of whether mappings exist.
 */
export async function recordLastIdpGroups(userId: string, idpGroups: string[]): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: { lastIdpGroups: idpGroups, lastSsoLoginAt: new Date() },
  })
}

export interface GroupMapping {
  /** The group name or identifier as it comes from the IdP (e.g. "Admins" or full LDAP DN) */
  idpGroup: string
  /** The Roomer UserGroup ID to add the user to on login (optional) */
  roomerGroupId?: string
  /**
   * Directly grant this Roomer global role when the group matches.
   * Takes effect in addition to (or instead of) roomerGroupId.
   * Accepted values: 'SUPER_ADMIN' | 'USER'
   */
  targetGlobalRole?: string
}

/**
 * Normalise a DN/group string for comparison:
 *  - Lowercase everything
 *  - Remove spaces around commas (CN=Foo, DC=bar → cn=foo,dc=bar)
 *  - Trim surrounding whitespace
 */
function normaliseDn(s: string): string {
  return s.toLowerCase().replace(/\s*,\s*/g, ',').trim()
}

/**
 * Return true when the IdP group value `g` matches the configured `idpGroup`.
 *
 * Only exact DN match (after normalisation) is accepted. Substring matching
 * was removed because it is a privilege escalation vector: an attacker who
 * controls a group named e.g. "Admins" could match a configured pattern of
 * "cn=Admins,dc=example,dc=com" via substring containment.
 */
function groupMatches(g: string, idpGroup: string): boolean {
  const ng = normaliseDn(g)
  const ni = normaliseDn(idpGroup)
  return ng === ni
}

/** True when any of the supplied IdP group values matches the configured idpGroup. */
export function idpGroupMatchesAny(idpGroups: string[], idpGroup: string): boolean {
  return idpGroups.some((g) => groupMatches(g, idpGroup))
}

/**
 * Apply IdP group → Roomer access group mappings for a newly authenticated user.
 *
 * For each mapping whose idpGroup matches one of the user's IdP groups, the user is:
 *   1. Added to the corresponding Roomer UserGroup (if roomerGroupId is set)
 *   2. Granted the targetGlobalRole (if set) OR granted via the group's globalRole
 *
 * When `sync` is true (recommended on every login):
 *   - The user is removed from any Roomer groups referenced by mappings that no longer match.
 *   - The user's globalRole is re-derived from current matches and may be downgraded to USER.
 *
 * When `sync` is false (legacy default):
 *   - Roles are only elevated, never downgraded — existing higher roles are preserved.
 */
export async function applyGroupMappings(
  userId: string,
  idpGroups: string[],
  mappings: GroupMapping[],
  sync = false,
): Promise<void> {
  if (!mappings.length) return

  // Collect all Roomer group IDs referenced by any mapping (for sync eviction)
  const allMappedGroupIds = new Set<string>()
  for (const m of mappings) {
    if (m.roomerGroupId) allMappedGroupIds.add(m.roomerGroupId)
  }

  const matchedGroupIds: string[] = []
  let directAdminGrant = false

  for (const mapping of mappings) {
    if (!mapping.idpGroup) continue

    const matched = idpGroups.some((g) => groupMatches(g, mapping.idpGroup))
    if (!matched) continue

    if (mapping.roomerGroupId) {
      matchedGroupIds.push(mapping.roomerGroupId)
    }

    if (mapping.targetGlobalRole === GlobalRole.SUPER_ADMIN) {
      directAdminGrant = true
    }
  }

  if (sync) {
    // Remove user from mapped groups they no longer match — but ONLY IDP-sourced
    // memberships, so a membership an admin added manually is never evicted.
    const staleGroupIds = [...allMappedGroupIds].filter((gid) => !matchedGroupIds.includes(gid))
    if (staleGroupIds.length) {
      await prisma.userGroupMember.deleteMany({
        where: { userId, groupId: { in: staleGroupIds }, source: RoleSource.IDP },
      })
    }
  }

  // Add user to each matched Roomer group, tagging the membership as IDP-sourced.
  // If the membership already exists as a manual grant we leave its source alone.
  for (const groupId of matchedGroupIds) {
    try {
      await prisma.userGroupMember.upsert({
        where: { groupId_userId: { groupId, userId } },
        create: { groupId, userId, source: RoleSource.IDP },
        update: {},
      })
    } catch {
      // Group may have been deleted — skip
    }
  }

  // Derive the effective globalRole from matched groups + direct grants
  const effectiveGroups = matchedGroupIds.length
    ? await prisma.userGroup.findMany({
        where: { id: { in: matchedGroupIds } },
        select: { globalRole: true },
      })
    : []

  const hasAdminRole = directAdminGrant || effectiveGroups.some((g) => g.globalRole === GlobalRole.SUPER_ADMIN)

  if (hasAdminRole) {
    // IdP grants admin — record IDP provenance so a later sync can revoke it.
    await prisma.user.update({
      where: { id: userId },
      data: { globalRole: GlobalRole.SUPER_ADMIN, globalRoleSource: RoleSource.IDP },
    })
  } else if (sync) {
    // No IdP admin grant. Only downgrade if the current admin role was itself
    // IDP-derived — never strip an admin role an operator set manually.
    //
    // This path is the most dangerous of the four places this guard applies:
    // it fires silently on an ordinary SSO login (e.g. after a routine AD
    // group rename or someone briefly dropped from an "Admins" group), with
    // no admin reviewing the change. lockSuperAdminGuard serialises this
    // against the other three (PATCH /users/:id, bulk import, SCIM) so two
    // concurrent demotions of the org's last two admins can't both slip past
    // the check before either commits.
    await prisma.$transaction(async (tx) => {
      await lockSuperAdminGuard(tx)
      const current = await tx.user.findUnique({
        where: { id: userId },
        select: { globalRole: true, globalRoleSource: true },
      })
      if (current?.globalRole !== GlobalRole.SUPER_ADMIN || current.globalRoleSource !== RoleSource.IDP) return
      if (await wouldRemoveLastActiveSuperAdmin(tx, userId)) {
        process.stderr.write(JSON.stringify({
          level: 'warn',
          msg: '[group-mapping] Skipped IdP-driven admin demotion — user is the last active super admin',
          userId,
        }) + '\n')
        return
      }
      await tx.user.update({
        where: { id: userId },
        data: { globalRole: GlobalRole.USER, globalRoleSource: RoleSource.MANUAL },
      })
    })
  }
}
