import { prisma } from './prisma.js'
import { GlobalRole, RoleSource } from '@roomer/shared'

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
    const current = await prisma.user.findUnique({
      where: { id: userId },
      select: { globalRole: true, globalRoleSource: true },
    })
    if (current?.globalRole === GlobalRole.SUPER_ADMIN && current.globalRoleSource === RoleSource.IDP) {
      // Same guard as PATCH /users/:id and the bulk user import — but this path
      // is the most dangerous of the three: it fires silently on an ordinary
      // SSO login (e.g. after a routine AD group rename or someone briefly
      // dropped from an "Admins" group), with no admin reviewing the change.
      // Demoting the org's last active super admin here would lock the org
      // out of its own admin UI with no way back except direct DB access.
      const otherActiveAdmins = await prisma.user.count({
        where: { id: { not: userId }, globalRole: GlobalRole.SUPER_ADMIN, accountStatus: 'ACTIVE' },
      })
      if (otherActiveAdmins > 0) {
        await prisma.user.update({
          where: { id: userId },
          data: { globalRole: GlobalRole.USER, globalRoleSource: RoleSource.MANUAL },
        })
      } else {
        process.stderr.write(JSON.stringify({
          level: 'warn',
          msg: '[group-mapping] Skipped IdP-driven admin demotion — user is the last active super admin',
          userId,
        }) + '\n')
      }
    }
  }
}
