/**
 * Per-account failed-login throttle — closes a real gap the existing
 * rate limiting doesn't cover. Every rate limit on /auth/login (both the
 * auth-scoped context in app.ts and the route's own tighter override) is
 * keyed by source IP only. An attacker distributing login attempts against
 * ONE target account across many source IPs (a proxy pool, IPv6 rotation,
 * or just retrying from different carrier-grade-NAT egress points) gets a
 * completely fresh 10-attempts/15-minutes budget from every new IP, facing
 * no throttling at all from the account's own perspective — bcrypt slows
 * each individual guess but doesn't bound total distributed throughput.
 *
 * In-memory, not DB-backed — same trade-off already accepted for the JWT
 * revocation blocklist's not-blocked cache (lib/token-blocklist.ts): correct
 * and immediate for a single API instance, and in a horizontally-scaled
 * deployment an attacker could in principle spread guesses across
 * instances to get a fresh budget per instance. That's a materially
 * smaller/harder attack than the one this closes (which needed no more
 * than rotating a header), and matches this codebase's existing risk
 * posture for this class of protection rather than introducing new
 * infrastructure (a shared cache/DB table) for a single-tenant app that
 * isn't otherwise designed to run horizontally scaled.
 */

const FAILED_LOGIN_WINDOW_MS = 15 * 60 * 1000
const FAILED_LOGIN_MAX = 10

const failedAttempts = new Map<string, number[]>()

function pruneOld(timestamps: number[], now: number): number[] {
  return timestamps.filter((t) => now - t < FAILED_LOGIN_WINDOW_MS)
}

/** True when this account has already hit the failed-attempt cap within the window — check before doing any credential verification work. */
export function isLoginThrottled(email: string): boolean {
  const key = email.trim().toLowerCase()
  const recent = pruneOld(failedAttempts.get(key) ?? [], Date.now())
  if (recent.length === 0) failedAttempts.delete(key)
  else failedAttempts.set(key, recent)
  return recent.length >= FAILED_LOGIN_MAX
}

/** Record one failed login attempt (wrong password, or a nonexistent/SSO-only account — same as the response already returns identically for both, so this must too, to avoid a throttle-timing side channel leaking account existence). */
export function recordFailedLogin(email: string): void {
  const key = email.trim().toLowerCase()
  const recent = pruneOld(failedAttempts.get(key) ?? [], Date.now())
  recent.push(Date.now())
  failedAttempts.set(key, recent)
}

/** Clear an account's failed-attempt history on a genuinely successful login. */
export function clearFailedLogins(email: string): void {
  failedAttempts.delete(email.trim().toLowerCase())
}
