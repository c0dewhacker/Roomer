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
    // Case-insensitive *and* comma-whitespace-collapsed, matching normRef —
    // a plain Prisma `equals`/`mode: insensitive` (as this used to be) only
    // covers the case half. reconcileAllManagers' bulk path already collapses
    // comma whitespace (LDAP servers/clients aren't always consistent about
    // "CN=X,OU=Y" vs "CN=X, OU=Y"); this incremental path — run on every
    // SSO login — needs the exact same transform, expressed in SQL since it
    // queries the DB directly rather than comparing in memory. Without it, a
    // correctly-resolved managerId could flap back to null on a later login
    // if the directory's manager attribute and the target's own DN happen to
    // differ only in comma spacing.
    const normalizedRef = normRef(u.managerExternalRef)
    // Also match on raw id — SCIM's manager.value is, per RFC 7643 §4.1.2,
    // the SCIM id of the manager's User resource, which for this app's SCIM
    // implementation *is* the Roomer user id (see userToScim: `id: user.id`)
    // rather than a DN or email, so a spec-correct SCIM-provisioned manager
    // ref needs this extra branch the LDAP/OIDC/SAML-oriented DN/email match
    // alone wouldn't catch.
    const candidates = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM "User"
      WHERE id != ${u.id}
        AND (
          id = ${u.managerExternalRef}
          OR regexp_replace(lower("externalId"), '\\s*,\\s*', ',', 'g') = ${normalizedRef}
          OR regexp_replace(lower(email), '\\s*,\\s*', ',', 'g') = ${normalizedRef}
        )
      LIMIT 1
    `
    await prisma.user.update({ where: { id: u.id }, data: { managerId: candidates[0]?.id ?? null } })
  }

  // Forward references: reports whose stored ref points at this user's id/DN/email.
  // Same case + comma-whitespace normalisation as above, applied to the
  // report's stored managerExternalRef instead, plus the same raw-id branch
  // for spec-correct SCIM manager.value refs.
  const normalizedExternalId = u.externalId ? normRef(u.externalId) : null
  const normalizedEmail = normRef(u.email)
  await prisma.$executeRaw`
    UPDATE "User" SET "managerId" = ${u.id}
    WHERE id != ${u.id} AND "managerId" IS NULL AND "managerExternalRef" IS NOT NULL
      AND (
        "managerExternalRef" = ${u.id}
        OR (${normalizedExternalId}::text IS NOT NULL AND regexp_replace(lower("managerExternalRef"), '\\s*,\\s*', ',', 'g') = ${normalizedExternalId})
        OR regexp_replace(lower("managerExternalRef"), '\\s*,\\s*', ',', 'g') = ${normalizedEmail}
      )
  `
}
