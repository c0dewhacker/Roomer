import { prisma } from './prisma.js'

/**
 * Find-or-create a Department by name within an org, matching
 * case-insensitively after trimming surrounding whitespace. Every IdP sync
 * path (OIDC/SAML/LDAP/SCIM) calls this with a raw department claim value,
 * and Department.name has no case-insensitive collation — it's a plain
 * Postgres TEXT with an exact-match unique constraint
 * (@@unique([organisationId, name])). Without normalising first, a rename or
 * casing difference upstream (or simply "Sales" vs "Sales " from a
 * differently-configured IdP attribute) silently created a second,
 * logically-duplicate Department row instead of matching the existing one —
 * fragmenting headcounts across GET /departments, /org/hierarchy, and the
 * manager-rollup analytics.
 */
export async function findOrCreateDepartment(organisationId: string, rawName: string): Promise<{ id: string; name: string }> {
  const name = rawName.trim()
  const existing = await prisma.department.findFirst({
    where: { organisationId, name: { equals: name, mode: 'insensitive' } },
    select: { id: true, name: true },
  })
  if (existing) return existing

  try {
    return await prisma.department.create({
      data: { organisationId, name },
      select: { id: true, name: true },
    })
  } catch (err) {
    // Race: a concurrent sync created the same name between our lookup and
    // this create. The unique constraint is exact-match only, so re-run the
    // same case-insensitive lookup rather than assuming the race was an
    // exact-string collision.
    if ((err as { code?: string }).code === 'P2002') {
      const raced = await prisma.department.findFirst({
        where: { organisationId, name: { equals: name, mode: 'insensitive' } },
        select: { id: true, name: true },
      })
      if (raced) return raced
    }
    throw err
  }
}
