import type { FastifyInstance } from 'fastify'
import bcryptjs from 'bcryptjs'
import { prisma } from '../lib/prisma'
import { loginSchema } from '@roomer/shared'
import { requireAuth } from '../middleware/requireAuth'
import { authenticateWithLdap, getLdapConfig } from '../lib/ldap'
import { applyGroupMappings } from '../lib/group-mapping'
import { signAccessToken, verifyAccessToken, TOKEN_COOKIE, TOKEN_COOKIE_OPTS, TOKEN_MAX_AGE, MAX_SESSION_SECONDS } from '../lib/jwt'
import { blockToken } from '../lib/token-blocklist'

export async function authRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.addHook('onRoute', (route) => { route.schema = { tags: ['Auth'], ...route.schema } })

  // POST /auth/login
  fastify.post('/login', async (request, reply) => {
    const result = loginSchema.safeParse(request.body)
    if (!result.success) {
      return reply.status(400).send({
        error: { message: 'Validation failed', code: 'VALIDATION_ERROR', details: result.error.flatten() },
      })
    }

    const { email, password } = result.data

    let user = await prisma.user.findUnique({ where: { email } })

    // ─── LDAP fallback ────────────────────────────────────────────────────────
    if (!user?.passwordHash) {
      const ldapResult = await authenticateWithLdap(email, password)
      if (ldapResult) {
        user = await prisma.user.upsert({
          where: { email: ldapResult.email },
          update: { displayName: ldapResult.displayName, externalId: ldapResult.dn, provider: 'LDAP' },
          create: {
            email: ldapResult.email,
            displayName: ldapResult.displayName,
            externalId: ldapResult.dn,
            provider: 'LDAP',
            passwordHash: null,
          },
        })
        const ldapCfg = await getLdapConfig()
        const mappings = ldapCfg?.groupMappings ?? []
        if (ldapResult.groups.length && mappings.length) {
          await applyGroupMappings(user.id, ldapResult.groups, mappings, true)
        }
      } else if (!user || !user.passwordHash) {
        return reply.status(401).send({
          error: { message: 'Invalid email or password', code: 'INVALID_CREDENTIALS' },
        })
      }
    } else {
      // Local password auth
      const passwordValid = await bcryptjs.compare(password, user.passwordHash)
      if (!passwordValid) {
        return reply.status(401).send({
          error: { message: 'Invalid email or password', code: 'INVALID_CREDENTIALS' },
        })
      }
    }

    if (user.accountStatus === 'BLOCKED') {
      return reply.status(403).send({
        error: { message: 'Your account has been suspended', code: 'ACCOUNT_BLOCKED' },
      })
    }

    // Issue a signed JWT. The `role` claim is embedded and protected by HS256 —
    // any client-side modification of the payload invalidates the signature.
    // sessionStart records the original login time; it is preserved across refreshes
    // so that the MAX_SESSION_SECONDS ceiling cannot be bypassed by repeated refreshes.
    const token = signAccessToken({
      sub: user.id,
      role: user.globalRole,
      email: user.email,
      displayName: user.displayName,
      sessionStart: Math.floor(Date.now() / 1000),
    })

    reply.setCookie(TOKEN_COOKIE, token, {
      ...TOKEN_COOKIE_OPTS,
      maxAge: TOKEN_MAX_AGE,
    })

    return reply.status(200).send({
      data: {
        user: {
          id: user.id,
          email: user.email,
          displayName: user.displayName,
          globalRole: user.globalRole,
          accountStatus: user.accountStatus,
        },
      },
    })
  })

  // POST /auth/logout
  fastify.post('/logout', { preHandler: [requireAuth] }, async (request, reply) => {
    // Blocklist the current token JTI so it cannot be replayed even before expiry.
    // This is the critical step that makes logout actually invalidate the JWT.
    const rawToken = request.cookies?.[TOKEN_COOKIE] ??
      (request.headers.authorization?.startsWith('Bearer ')
        ? request.headers.authorization.slice(7)
        : undefined)
    if (rawToken) {
      try {
        const decoded = verifyAccessToken(rawToken)
        if (decoded.jti) await blockToken(decoded.jti, decoded.exp)
      } catch {
        // Token already invalid — no blocklist entry needed
      }
    }
    reply.clearCookie(TOKEN_COOKIE, TOKEN_COOKIE_OPTS)
    return reply.status(200).send({ data: { ok: true } })
  })

  // POST /auth/refresh — re-issue token if the current one is still valid.
  // Useful for extending the session without a full re-login.
  // Security constraints:
  //   - Enforces a MAX_SESSION_SECONDS absolute ceiling from original login.
  //     Repeated refreshes cannot extend a session beyond 24 hours — a stolen
  //     token cannot be kept alive indefinitely.
  //   - Blocklists the old JTI after issuing a new token so the old token cannot
  //     be replayed if intercepted.
  fastify.post('/refresh', async (request, reply) => {
    const token = request.cookies?.[TOKEN_COOKIE]
    if (!token) {
      return reply.status(401).send({ error: { message: 'No token to refresh', code: 'UNAUTHENTICATED' } })
    }

    let payload: ReturnType<typeof verifyAccessToken>
    try {
      payload = verifyAccessToken(token)
    } catch {
      reply.clearCookie(TOKEN_COOKIE, TOKEN_COOKIE_OPTS)
      return reply.status(401).send({ error: { message: 'Invalid or expired token', code: 'TOKEN_INVALID' } })
    }

    // Enforce absolute session ceiling — prevents indefinite session extension
    // through repeated refresh calls.
    const now = Math.floor(Date.now() / 1000)
    const sessionAge = now - (payload.sessionStart ?? payload.iat)
    if (sessionAge > MAX_SESSION_SECONDS) {
      reply.clearCookie(TOKEN_COOKIE, TOKEN_COOKIE_OPTS)
      return reply.status(401).send({
        error: { message: 'Session expired, please log in again', code: 'SESSION_EXPIRED' },
      })
    }

    // Re-fetch so the refreshed token reflects current role + status
    const user = await prisma.user.findUnique({ where: { id: payload.sub } })
    if (!user || user.accountStatus === 'BLOCKED') {
      reply.clearCookie(TOKEN_COOKIE, TOKEN_COOKIE_OPTS)
      return reply.status(401).send({ error: { message: 'Authentication required', code: 'UNAUTHENTICATED' } })
    }

    // Blocklist the old token JTI before issuing the new one so concurrent
    // requests using the old token are rejected after this point.
    if (payload.jti) await blockToken(payload.jti, payload.exp)

    // Preserve the original sessionStart so the 24-hour ceiling applies
    // to the whole session chain, not just each individual token.
    const newToken = signAccessToken({
      sub: user.id,
      role: user.globalRole,
      email: user.email,
      displayName: user.displayName,
      sessionStart: payload.sessionStart ?? payload.iat,
    })

    reply.setCookie(TOKEN_COOKIE, newToken, {
      ...TOKEN_COOKIE_OPTS,
      maxAge: TOKEN_MAX_AGE,
    })

    return reply.status(200).send({
      data: {
        user: {
          id: user.id,
          email: user.email,
          displayName: user.displayName,
          globalRole: user.globalRole,
          accountStatus: user.accountStatus,
        },
      },
    })
  })

  // GET /auth/me
  fastify.get('/me', { preHandler: [requireAuth] }, async (request, reply) => {
    const user = await prisma.user.findUnique({
      where: { id: request.user.id },
      include: {
        resourceRoles: {
          include: {
            building: { select: { id: true, name: true } },
            floor: { select: { id: true, name: true } },
          },
        },
        groupMemberships: {
          include: {
            group: {
              select: {
                id: true,
                name: true,
                globalRole: true,
                groupResourceRoles: {
                  select: {
                    id: true,
                    role: true,
                    scopeType: true,
                    floorId: true,
                    buildingId: true,
                    floor: { select: { id: true, name: true } },
                    building: { select: { id: true, name: true } },
                  },
                },
              },
            },
          },
        },
      },
    })

    if (!user) {
      return reply.status(404).send({
        error: { message: 'User not found', code: 'NOT_FOUND' },
      })
    }

    const { passwordHash: _, ...safeUser } = user
    return reply.status(200).send({ data: { user: safeUser } })
  })
}
