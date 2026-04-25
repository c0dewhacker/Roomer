import { prisma } from './prisma'

// In-process negative-result cache: if a JTI is NOT in the blocklist, we cache that
// result for 30 seconds to avoid a DB round-trip on every authenticated request.
// Positive results (blocked tokens) are never cached — revocations must be immediate.
const NOT_BLOCKED_CACHE = new Map<string, number>()
const NOT_BLOCKED_TTL_MS = 30_000

function isCachedNotBlocked(jti: string): boolean {
  const expiresAt = NOT_BLOCKED_CACHE.get(jti)
  if (expiresAt === undefined) return false
  if (Date.now() > expiresAt) {
    NOT_BLOCKED_CACHE.delete(jti)
    return false
  }
  return true
}

/**
 * Add a token JTI to the revocation blocklist.
 *
 * Called on logout. The record expires at the same time as the JWT itself so
 * storage requirements are bounded — expired entries can be pruned freely.
 *
 * Requires the Prisma `RevokedToken` model:
 *   model RevokedToken {
 *     jti       String   @id
 *     expiresAt DateTime
 *   }
 */
export async function blockToken(jti: string, expUnix: number): Promise<void> {
  await prisma.revokedToken.upsert({
    where: { jti },
    update: { expiresAt: new Date(expUnix * 1000) },
    create: { jti, expiresAt: new Date(expUnix * 1000) },
  })
}

/**
 * Return true when the given JTI has been explicitly revoked.
 * A missing row means the token has not been revoked.
 */
export async function isTokenBlocked(jti: string): Promise<boolean> {
  if (isCachedNotBlocked(jti)) return false
  const row = await prisma.revokedToken.findUnique({ where: { jti } })
  if (row === null) {
    NOT_BLOCKED_CACHE.set(jti, Date.now() + NOT_BLOCKED_TTL_MS)
  }
  return row !== null
}

/**
 * Remove all blocklist entries whose JWT has already expired.
 * Call this periodically (e.g. via a pg-boss cron job) to keep the table small.
 */
export async function pruneExpiredBlocklistEntries(): Promise<void> {
  await prisma.revokedToken.deleteMany({ where: { expiresAt: { lt: new Date() } } })
}
