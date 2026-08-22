import type { FastifyInstance } from 'fastify'
import bcryptjs from 'bcryptjs'
import { prisma } from '../lib/prisma.js'
import { loginSchema } from '@roomer/shared'
import { requireAuth } from '../middleware/requireAuth.js'
import { authenticateWithLdap, getLdapConfig } from '../lib/ldap.js'
import { applyGroupMappings, recordLastIdpGroups } from '../lib/group-mapping.js'
import { recordManagerRef, resolveManagerForUser } from '../lib/manager.js'
import { signAccessToken, verifyAccessToken, TOKEN_COOKIE, TOKEN_COOKIE_OPTS, TOKEN_MAX_AGE, MAX_SESSION_SECONDS } from '../lib/jwt.js'
import { blockToken, isTokenBlocked } from '../lib/token-blocklist.js'
import { recordAuditLog } from '../lib/audit.js'

// A valid bcrypt hash (cost 12) of a random string, used to equalise response
// timing when an account has no local password (non-existent user or SSO-only).
// Without this, the local-auth path runs bcrypt.compare while the "no password"
// path returns immediately, leaking account existence via a timing side channel.
const DUMMY_PASSWORD_HASH = bcryptjs.hashSync('roomer-timing-equaliser', 12)

export async function authRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.addHook('onRoute', (route) => { route.schema = { tags: ['Auth'], ...route.schema } })

  // POST /auth/login
  fastify.post('/login', { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } }, async (request, reply) => {
    const result = loginSchema.safeParse(request.body)
    if (!result.success) {
      return reply.status(400).send({
        error: { message: 'Validation failed', code: 'VALIDATION_ERROR', details: result.error.flatten() },
      })
    }

    const { email, password } = result.data

    // Case-insensitive: email creation is not normalised to lowercase
    // everywhere (LDAP sync lowercases; an admin manually creating a local
    // account, or an OIDC/SAML claim, may not), so a findUnique on the exact
    // string here would reject a correct password just because the user
    // typed different case than however their account happened to be stored.
    let user = await prisma.user.findFirst({ where: { email: { equals: email, mode: 'insensitive' } } })

    // ─── LDAP fallback ────────────────────────────────────────────────────────
    if (!user?.passwordHash) {
      const ldapResult = await authenticateWithLdap(email, password)
      if (ldapResult) {
        // upsert() requires an exact-match unique where, which can't be made
        // case-insensitive — find first (matching the same relaxed rule as
        // above), then update or create explicitly, so this doesn't create a
        // duplicate account for someone who already exists with different
        // email casing.
        const existingLdapUser = await prisma.user.findFirst({
          where: { email: { equals: ldapResult.email, mode: 'insensitive' } },
        })
        user = existingLdapUser
          ? await prisma.user.update({
              where: { id: existingLdapUser.id },
              data: { displayName: ldapResult.displayName, externalId: ldapResult.dn, provider: 'LDAP' },
            })
          : await prisma.user.create({
              data: {
                email: ldapResult.email,
                displayName: ldapResult.displayName,
                externalId: ldapResult.dn,
                provider: 'LDAP',
                passwordHash: null,
              },
            })
        // actorId: null — this is IdP-driven JIT provisioning triggered by the
        // user's own login, not a human admin action, same reasoning as SCIM's
        // actorId: null (users.ts/scim.ts, Batch A). A distinguishing
        // ldap_-prefixed action name lets a reviewer tell provenance apart.
        await recordAuditLog(prisma, {
          actorId: null,
          action: existingLdapUser ? 'user.ldap_updated' : 'user.ldap_created',
          resourceType: 'User',
          resourceId: user.id,
          after: { email: user.email, displayName: user.displayName, externalId: user.externalId },
          ipAddress: request.ip,
        }, request.log)
        await recordLastIdpGroups(user.id, ldapResult.groups)
        const ldapCfg = await getLdapConfig()
        const mappings = ldapCfg?.groupMappings ?? []
        // Deliberately does NOT also require ldapResult.groups.length: an
        // empty array is exactly the "user was removed from every mapped
        // group" signal that must reach applyGroupMappings so its sync=true
        // eviction/demotion logic can run — gating this on a non-empty group
        // list silently skipped revocation for a fully-deprovisioned
        // directory entry. Mirrors lib/ldap.ts's full sync and
        // auth-enterprise.ts's OIDC/SAML JIT paths, which already avoid this
        // exact gate for this exact reason — this interactive-login path was
        // the one caller still doing it wrong.
        if (mappings.length) {
          await applyGroupMappings(user.id, ldapResult.groups, mappings, true)
        }
        if (ldapResult.department) {
          const org = await prisma.organisation.findFirst({ select: { id: true } })
          if (org) {
            const dept = await prisma.department.upsert({
              where: { organisationId_name: { organisationId: org.id, name: ldapResult.department } },
              create: { organisationId: org.id, name: ldapResult.department },
              update: {},
            })
            await prisma.user.update({ where: { id: user.id }, data: { departmentId: dept.id } })
          }
        }
        // Same manager-attribute handling the admin-triggered LDAP directory
        // sync already does (see runLdapSync/reconcileAllManagers) — an org
        // that authenticates via interactive LDAP bind rather than routinely
        // running that separate, manual sync would otherwise never populate
        // manager data at all, no matter how many times a user logs in.
        if (ldapCfg?.managerAttribute) {
          await recordManagerRef(user.id, ldapResult.manager)
        }
        await resolveManagerForUser(user.id)
      } else if (!user || !user.passwordHash) {
        // Run a dummy bcrypt comparison so this path takes a similar amount of
        // time to the local-password path — avoids account-enumeration via timing.
        await bcryptjs.compare(password, DUMMY_PASSWORD_HASH)
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
  fastify.post('/logout', { preHandler: [requireAuth], config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request, reply) => {
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
  fastify.post('/refresh', { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } }, async (request, reply) => {
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

    // Reject revoked tokens — otherwise a token blocklisted at logout could be
    // exchanged here for a fresh one, defeating logout/refresh revocation.
    if (payload.jti && await isTokenBlocked(payload.jti)) {
      reply.clearCookie(TOKEN_COOKIE, TOKEN_COOKIE_OPTS)
      return reply.status(401).send({ error: { message: 'Token has been revoked', code: 'TOKEN_REVOKED' } })
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

    // Refuse to mint a fresh (post-change) token from a pre-change one — this
    // endpoint verifies the incoming JWT itself rather than going through
    // requireAuth, so without this check a token stolen before a password
    // change could be exchanged here for a new token whose iat is now *after*
    // passwordChangedAt, sailing straight through requireAuth's own check.
    if (user.passwordChangedAt && payload.iat < Math.floor(user.passwordChangedAt.getTime() / 1000)) {
      reply.clearCookie(TOKEN_COOKIE, TOKEN_COOKIE_OPTS)
      return reply.status(401).send({
        error: { message: 'Session invalidated by a password change — please log in again', code: 'PASSWORD_CHANGED' },
      })
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
