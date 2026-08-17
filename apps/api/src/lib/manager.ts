import { prisma } from './prisma.js'

/** Normalise a manager reference (DN / email / UPN) for comparison. */
function normRef(s: string): string {
  return s.trim().toLowerCase().replace(/\s*,\s*/g, ',')
}

function userKeys(u: { externalId: string | null; email: string }): string[] {
  const keys: string[] = []
  if (u.externalId) keys.push(normRef(u.externalId))
  if (u.email) keys.push(normRef(u.email))
  return keys
}

/** Store the raw manager identifier from the IdP (DN/email/UPN). */
export async function recordManagerRef(userId: string, ref: string | null | undefined): Promise<void> {
  const value = ref && ref.trim() ? ref.trim() : null
  await prisma.user.update({ where: { id: userId }, data: { managerExternalRef: value } })
}

/**
 * Resolve every user's managerExternalRef → managerId in one pass.
 * Used after a bulk LDAP sync. Handles DN whitespace normalisation in memory
 * (which a SQL query can't), and self-references are ignored.
 * Returns counts for logging.
 */
export async function reconcileAllManagers(): Promise<{ resolved: number; unresolved: number }> {
  const users = await prisma.user.findMany({
    select: { id: true, email: true, externalId: true, managerExternalRef: true, managerId: true },
  })
  const byKey = new Map<string, string>()
  for (const u of users) for (const k of userKeys(u)) byKey.set(k, u.id)

  let resolved = 0
  let unresolved = 0
  const updates: Array<{ id: string; managerId: string | null }> = []
  for (const u of users) {
    if (!u.managerExternalRef) {
      if (u.managerId !== null) updates.push({ id: u.id, managerId: null })
      continue
    }
    const found = byKey.get(normRef(u.managerExternalRef))
    const target = found && found !== u.id ? found : null
    if (target) resolved++
    else unresolved++
    if (u.managerId !== target) updates.push({ id: u.id, managerId: target })
  }

  // Chunk the updates to keep transactions reasonable.
  for (let i = 0; i < updates.length; i += 100) {
    const chunk = updates.slice(i, i + 100)
    await prisma.$transaction(chunk.map((up) => prisma.user.update({ where: { id: up.id }, data: { managerId: up.managerId } })))
  }
  return { resolved, unresolved }
}

/**
 * Incrementally resolve one user (used on SSO login):
 *   1. Link this user to their manager (by externalId / email, case-insensitive).
 *   2. Link any existing reports that referenced this user (forward references).
 */
export async function resolveManagerForUser(userId: string): Promise<void> {
  const u = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, externalId: true, managerExternalRef: true },
  })
  if (!u) return

  if (u.managerExternalRef) {
    const mgr = await prisma.user.findFirst({
      where: {
        id: { not: u.id },
        OR: [
          { externalId: { equals: u.managerExternalRef, mode: 'insensitive' } },
          { email: { equals: u.managerExternalRef, mode: 'insensitive' } },
        ],
      },
      select: { id: true },
    })
    await prisma.user.update({ where: { id: u.id }, data: { managerId: mgr?.id ?? null } })
  }

  // Forward references: reports whose stored ref points at this user's DN/email.
  // Case-insensitive to match the "resolve my manager" lookup above — without
  // this, a managerExternalRef that differs only in case from the manager's
  // actual externalId/email (common with LDAP DNs and email addresses, both
  // conventionally case-insensitive) would silently never link, even though
  // reconcileAllManagers' bulk path already normalises case for exactly this.
  const refs = [u.externalId, u.email].filter((x): x is string => !!x)
  if (refs.length) {
    await prisma.user.updateMany({
      where: { id: { not: u.id }, managerId: null, managerExternalRef: { in: refs, mode: 'insensitive' } },
      data: { managerId: u.id },
    })
  }
}
