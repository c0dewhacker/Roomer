import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { env } from '../env'

/** Cookie name used for the access token throughout the application. */
export const TOKEN_COOKIE = 'access_token'

/**
 * Cookie options applied consistently on every set/clear.
 * secure is controlled by the COOKIE_SECURE env var so that staging environments
 * running with NODE_ENV=development can still require HTTPS cookies.
 */
export const TOKEN_COOKIE_OPTS = {
  httpOnly: true,
  secure: env.COOKIE_SECURE,
  sameSite: 'strict' as const,
  path: '/',
} as const

/** Lifetime of an access token: 8 hours (one working day). */
const EXPIRES_IN = '8h'
const MAX_AGE_SECONDS = 8 * 60 * 60

export const TOKEN_MAX_AGE = MAX_AGE_SECONDS

/**
 * Maximum lifetime of a session chain regardless of how many times the token
 * is refreshed. After this many seconds from the original login the user must
 * re-authenticate. Prevents a stolen token from being kept alive indefinitely
 * via the /auth/refresh endpoint.
 */
export const MAX_SESSION_SECONDS = 24 * 60 * 60 // 24 hours

export interface TokenPayload {
  sub: string           // userId
  role: string          // GlobalRole — embedded and signed, cannot be tampered
  email: string
  displayName: string
  /**
   * Unix epoch of the original login that started this session chain.
   * Preserved across refreshes so the 24-hour ceiling is enforced end-to-end.
   */
  sessionStart: number
}

/**
 * Sign an access token with HS256.
 * - The `role` claim is embedded inside the signature so any modification of the
 *   payload after issuance causes verifyAccessToken to throw.
 * - A `jti` (JWT ID) is added to every token so that logout can blocklist it.
 * - `sessionStart` records the original login time so refresh cannot extend a
 *   session beyond MAX_SESSION_SECONDS.
 */
export function signAccessToken(payload: TokenPayload): string {
  return jwt.sign(payload, env.SESSION_SECRET, {
    algorithm: 'HS256',
    expiresIn: EXPIRES_IN,
    issuer: 'roomer',
    audience: 'roomer',
    jwtid: randomUUID(),
  })
}

/**
 * Verify and decode an access token.
 * Throws `JsonWebTokenError` / `TokenExpiredError` / `NotBeforeError` on failure.
 * Verifies algorithm, issuer, audience and expiry — nothing needs trusting from
 * the caller side.
 */
export function verifyAccessToken(token: string): TokenPayload & { iat: number; exp: number; jti: string } {
  return jwt.verify(token, env.SESSION_SECRET, {
    algorithms: ['HS256'],
    issuer: 'roomer',
    audience: 'roomer',
  }) as TokenPayload & { iat: number; exp: number; jti: string }
}
