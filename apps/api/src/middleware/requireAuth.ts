import type { FastifyRequest, FastifyReply } from 'fastify'
import type { User } from '@prisma/client'
import { prisma } from '../lib/prisma'
import { verifyAccessToken, TOKEN_COOKIE, TOKEN_COOKIE_OPTS } from '../lib/jwt'
import { isTokenBlocked } from '../lib/token-blocklist'
import { env } from '../env'

declare module 'fastify' {
  interface FastifyRequest {
    user: User
  }
}

/**
 * Authentication middleware.
 *
 * 1. Reads the access token from the `access_token` httpOnly cookie (preferred)
 *    or from the `Authorization: Bearer <token>` header when ALLOW_BEARER_AUTH=true.
 * 2. Verifies the JWT signature + expiry using HS256 with the server-side secret.
 *    Any modification to the payload (e.g. elevating the embedded `role` claim)
 *    invalidates the signature and the request is rejected with 401.
 * 3. Checks the JTI blocklist — tokens invalidated by logout are rejected here
 *    even if their `exp` claim has not yet elapsed.
 * 4. Loads the live user record from the database so that account blocks and
 *    role changes take effect immediately, regardless of the token's remaining
 *    lifetime.
 */
export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  // Prefer cookie. Bearer header is only honoured when ALLOW_BEARER_AUTH is enabled
  // (typically for programmatic/machine-to-machine API clients).
  const cookieToken = request.cookies?.[TOKEN_COOKIE]
  const bearerToken = env.ALLOW_BEARER_AUTH && request.headers.authorization?.startsWith('Bearer ')
    ? request.headers.authorization.slice(7)
    : undefined
  const token = cookieToken ?? bearerToken

  if (!token) {
    return reply.status(401).send({
      error: { message: 'Authentication required', code: 'UNAUTHENTICATED' },
    })
  }

  let payload: ReturnType<typeof verifyAccessToken>
  try {
    payload = verifyAccessToken(token)
  } catch {
    // Clear a stale/tampered cookie so the browser doesn't loop
    reply.clearCookie(TOKEN_COOKIE, TOKEN_COOKIE_OPTS)
    return reply.status(401).send({
      error: { message: 'Invalid or expired token', code: 'TOKEN_INVALID' },
    })
  }

  // Check JTI blocklist — catches tokens that were explicitly revoked via logout
  // before their expiry elapsed.
  if (payload.jti && await isTokenBlocked(payload.jti)) {
    reply.clearCookie(TOKEN_COOKIE, TOKEN_COOKIE_OPTS)
    return reply.status(401).send({
      error: { message: 'Token has been revoked', code: 'TOKEN_REVOKED' },
    })
  }

  // Always load the live record — ensures blocked accounts and role changes
  // are enforced immediately without waiting for token expiry.
  const user = await prisma.user.findUnique({ where: { id: payload.sub } })

  if (!user) {
    reply.clearCookie(TOKEN_COOKIE, TOKEN_COOKIE_OPTS)
    return reply.status(401).send({
      error: { message: 'User not found', code: 'USER_NOT_FOUND' },
    })
  }

  if (user.accountStatus === 'BLOCKED') {
    reply.clearCookie(TOKEN_COOKIE, TOKEN_COOKIE_OPTS)
    return reply.status(403).send({
      error: { message: 'Your account has been suspended', code: 'ACCOUNT_BLOCKED' },
    })
  }

  request.user = user
}
