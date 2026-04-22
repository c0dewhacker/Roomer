import { prisma } from './prisma'
import { GlobalRole } from '@roomer/shared'

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
    // Remove user from mapped groups they no longer match
    const staleGroupIds = [...allMappedGroupIds].filter((gid) => !matchedGroupIds.includes(gid))
    if (staleGroupIds.length) {
      await prisma.userGroupMember.deleteMany({
        where: { userId, groupId: { in: staleGroupIds } },
      })
    }
  }

  // Add user to each matched Roomer group
  for (const groupId of matchedGroupIds) {
    try {
      await prisma.userGroupMember.upsert({
        where: { groupId_userId: { groupId, userId } },
        create: { groupId, userId },
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

  if (sync) {
    // Re-derive role; may downgrade from SUPER_ADMIN → USER if no matching grants remain
    await prisma.user.update({
      where: { id: userId },
      data: { globalRole: hasAdminRole ? GlobalRole.SUPER_ADMIN : GlobalRole.USER },
    })
  } else if (hasAdminRole) {
    // Legacy: only elevate, never downgrade
    await prisma.user.update({
      where: { id: userId },
      data: { globalRole: GlobalRole.SUPER_ADMIN },
    })
  }
}
