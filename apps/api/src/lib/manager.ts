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

  // First pass: each user's candidate target, self-reference already excluded.
  const candidateTarget = new Map<string, string | null>()
  for (const u of users) {
    if (!u.managerExternalRef) { candidateTarget.set(u.id, null); continue }
    const found = byKey.get(normRef(u.managerExternalRef))
    candidateTarget.set(u.id, found && found !== u.id ? found : null)
  }

  // Second pass: only self-reference was ever excluded above — nothing
  // stopped a transitive cycle (A's manager is B, B's is C, C's is A) from
  // being wired through managerId, e.g. from a half-applied re-org or two
  // directory entries whose manager attributes point at each other. This is
  // the only write path for managerId (no admin-facing PATCH field for it),
  // so any cycle here is one the app itself created, not just bad upstream
  // data to tolerate defensively. Walk each user's candidate chain; if it
  // ever leads back to that same user, every edge in the cycle is treated as
  // unresolved rather than picking one arbitrary edge to sacrifice.
  function chainLeadsBackTo(startId: string, selfId: string): boolean {
    let current: string | null = startId
    const seen = new Set<string>()
    while (current) {
      if (current === selfId) return true
      if (seen.has(current)) return false // a different cycle, not involving selfId — not this user's problem
      seen.add(current)
      current = candidateTarget.get(current) ?? null
    }
    return false
  }

  let resolved = 0
  let unresolved = 0
  const updates: Array<{ id: string; managerId: string | null }> = []
  for (const u of users) {
    let target = candidateTarget.get(u.id) ?? null
    if (target && chainLeadsBackTo(target, u.id)) target = null
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
 * True when walking up the already-persisted managerId chain from `startId`
 * ever reaches `selfId` — i.e. selfId is already (transitively) startId's
 * manager. Used to refuse an assignment that would close a cycle. Bounded by
 * `seen` rather than a fixed depth, so it terminates even against a
 * pre-existing unrelated cycle in the data.
 */
async function managerChainContains(startId: string, selfId: string): Promise<boolean> {
  let current: string | null = startId
  const seen = new Set<string>()
  while (current) {
    if (current === selfId) return true
    if (seen.has(current)) return false
    seen.add(current)
    const id: string = current
    const row = await prisma.user.findUnique({ where: { id }, select: { managerId: true } })
    current = row?.managerId ?? null
  }
  return false
}

/** Every id reachable by walking up managerId from `startId` (startId itself excluded). */
async function managerChainIds(startId: string): Promise<string[]> {
  const chain: string[] = []
  let current: string | null = startId
  const seen = new Set<string>([startId])
  while (current) {
    const id: string = current
    const row = await prisma.user.findUnique({ where: { id }, select: { managerId: true } })
    current = row?.managerId ?? null
    if (!current || seen.has(current)) break
    seen.add(current)
    chain.push(current)
  }
  return chain
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
    // Only self-reference (id != u.id above) was ever excluded — nothing
    // stopped a transitive cycle (this user's manager is already, a few
    // links up, one of this user's own reports) from being wired through on
    // login. This is the only write path for managerId (no admin-facing
    // PATCH field for it), so refuse rather than create one.
    const candidateId = candidates[0]?.id ?? null
    const managerId = candidateId && !(await managerChainContains(candidateId, u.id)) ? candidateId : null
    await prisma.user.update({ where: { id: u.id }, data: { managerId } })
  }

  // Forward references: reports whose stored ref points at this user's id/DN/email.
  // Same case + comma-whitespace normalisation as above, applied to the
  // report's stored managerExternalRef instead, plus the same raw-id branch
  // for spec-correct SCIM manager.value refs.
  //
  // Excludes this user's own manager chain (computed after the block above,
  // so it reflects u's just-resolved, cycle-safe managerId): if one of u's
  // own ancestors also has a managerExternalRef pointing back at u (a mutual
  // reference, or a longer loop closed from the other end), making that
  // ancestor into u's report here would wire the exact cycle the block above
  // just refused to create for u's own assignment.
  const ancestorIds = await managerChainIds(u.id)
  const normalizedExternalId = u.externalId ? normRef(u.externalId) : null
  const normalizedEmail = normRef(u.email)
  await prisma.$executeRaw`
    UPDATE "User" SET "managerId" = ${u.id}
    WHERE id != ${u.id} AND "managerId" IS NULL AND "managerExternalRef" IS NOT NULL
      AND NOT (id = ANY(${ancestorIds}::text[]))
      AND (
        "managerExternalRef" = ${u.id}
        OR (${normalizedExternalId}::text IS NOT NULL AND regexp_replace(lower("managerExternalRef"), '\\s*,\\s*', ',', 'g') = ${normalizedExternalId})
        OR regexp_replace(lower("managerExternalRef"), '\\s*,\\s*', ',', 'g') = ${normalizedEmail}
      )
  `
}
