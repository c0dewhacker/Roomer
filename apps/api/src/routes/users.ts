import type { FastifyInstance } from 'fastify'
import bcryptjs from 'bcryptjs'
import crypto from 'crypto'
import { prisma } from '../lib/prisma.js'
import { GlobalRole, ResourceRoleType, ResourceScopeType, RoleSource } from '@roomer/shared'
import { requireAuth } from '../middleware/requireAuth.js'
import { requireGlobalRole, isFloorManagerForFloor, RESOURCE_ROLE_GRANT_LOCK_CLASS } from '../middleware/requireRole.js'
import { enqueueNotification, cancelFutureBookingsForUser, cancelQueueEntriesForUser, releaseAssetAssignmentsForUser } from '../lib/queue.js'
import { lockSuperAdminGuard, wouldRemoveLastActiveSuperAdmin } from '../lib/group-mapping.js'
import { dispatchWebhook } from '../lib/webhook.js'
import { NotificationType } from '@roomer/shared'
import { signAccessToken, verifyAccessToken, TOKEN_COOKIE, TOKEN_COOKIE_OPTS, TOKEN_MAX_AGE } from '../lib/jwt.js'
import { blockToken } from '../lib/token-blocklist.js'
import { recordAuditLog } from '../lib/audit.js'
import { z } from 'zod'

// .trim() before .min(1) on displayName — see schemas/department.ts for why.
const createUserSchema = z.object({
  email: z.string().email(),
  displayName: z.string().trim().min(1).max(255),
  password: z.string().min(12),
  globalRole: z.nativeEnum(GlobalRole).optional(),
})

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(12),
})

const adminSetPasswordSchema = z.object({
  password: z.string().min(12),
})

const updateUserSchema = z.object({
  displayName: z.string().trim().min(1).max(255).optional(),
  accountStatus: z.enum(['ACTIVE', 'BLOCKED']).optional(),
  globalRole: z.nativeEnum(GlobalRole).optional(),
  // Self-serviceable privacy flag — controls visibility in the colleague finder.
  visibleInColleagueSearch: z.boolean().optional(),
})

const notificationPrefValueSchema = z.object({
  email: z.boolean().optional(),
  inApp: z.boolean().optional(),
  // Added for Web Push (#76 phase 2) — queue.ts's processSendNotification
  // and ProfilePage.tsx's toggle UI both already read/write this field;
  // this schema (the actual PATCH validation) was never updated to match,
  // so a push preference change was silently stripped by Zod's default
  // strip-unknown-keys behaviour before it ever reached the DB — the UI
  // showed "saved" but the toggle reverted to on-by-default on next load.
  push: z.boolean().optional(),
})

const updateNotificationPreferencesSchema = z.object({
  preferences: z.record(z.string(), notificationPrefValueSchema),
})

const assignRoleSchema = z.object({
  role: z.nativeEnum(ResourceRoleType),
  scopeType: z.nativeEnum(ResourceScopeType),
  buildingId: z.string().cuid().optional(),
  floorId: z.string().cuid().optional(),
})

const listUsersQuerySchema = z.object({
  search: z.string().optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
})

const userImportRowSchema = z.object({
  email: z.string().email('Invalid email'),
  // .trim() before .min(1) — see schemas/department.ts for why.
  display_name: z.string().trim().min(1, 'display_name is required').max(255),
  password: z.string().min(12).optional(),
  global_role: z.enum(['USER', 'SUPER_ADMIN']).default('USER'),
  access_groups: z.string().optional(),
  send_welcome_email: z.string().optional().transform((v) => v !== 'false' && v !== '0'),
})

const userImportBodySchema = z.object({
  rows: z.array(z.record(z.string(), z.string())).min(1).max(1000),
})

export async function userRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.addHook('onRoute', (route) => { route.schema = { tags: ['Users'], ...route.schema } })

  // POST /users — create user (admin)
  // Every other endpoint that can trigger an outbound email to an
  // attacker-influenced address (login, refresh, password-change/reset) has
  // its own per-route limit bounding a compromised-session blast radius —
  // this one only had the blanket 300/min global default, letting a
  // hijacked SUPER_ADMIN session email-bomb arbitrary third-party inboxes
  // via the WELCOME notification. Same 30/15min precedent as
  // /:id/password/reset below.
  fastify.post(
    '/',
    { preHandler: [requireAuth, requireGlobalRole(GlobalRole.SUPER_ADMIN)], config: { rateLimit: { max: 30, timeWindow: '15 minutes' } } },
    async (request, reply) => {
      const result = createUserSchema.safeParse(request.body)
      if (!result.success) {
        return reply.status(400).send({
          error: { message: 'Validation failed', code: 'VALIDATION_ERROR', details: result.error.flatten() },
        })
      }

      const { email, displayName, password, globalRole } = result.data

      const existing = await prisma.user.findUnique({ where: { email } })
      if (existing) {
        return reply.status(409).send({
          error: { message: 'A user with this email already exists', code: 'ALREADY_EXISTS' },
        })
      }

      const org = await prisma.organisation.findFirst()
      if (!org) {
        return reply.status(500).send({
          error: { message: 'No organisation found', code: 'INTERNAL_ERROR' },
        })
      }

      const passwordHash = await bcryptjs.hash(password, 12)
      const user = await prisma.user.create({
        data: {
          email,
          displayName,
          passwordHash,
          globalRole: globalRole ?? GlobalRole.USER,
        },
        select: {
          id: true, email: true, displayName: true,
          provider: true, accountStatus: true, globalRole: true,
          createdAt: true, updatedAt: true,
        },
      })

      // Send welcome email (non-blocking)
      enqueueNotification({ type: NotificationType.WELCOME, userId: user.id }).catch((err) =>
        fastify.log.warn({ err }, 'Failed to enqueue welcome notification'),
      )

      dispatchWebhook('user.created', { id: user.id, email: user.email, displayName: user.displayName, globalRole: user.globalRole }).catch(() => {})
      await recordAuditLog(prisma, {
        actorId: request.user.id,
        action: 'user.created',
        resourceType: 'User',
        resourceId: user.id,
        after: { email: user.email, displayName: user.displayName, globalRole: user.globalRole },
        ipAddress: request.ip,
      }, request.log)

      return reply.status(201).send({ data: user })
    },
  )

  // GET /users — list users (admin), paginated, filterable
  fastify.get(
    '/',
    { preHandler: [requireAuth, requireGlobalRole(GlobalRole.SUPER_ADMIN)] },
    async (request, reply) => {
      const result = listUsersQuerySchema.safeParse(request.query)
      if (!result.success) {
        return reply.status(400).send({
          error: { message: 'Invalid query parameters', code: 'VALIDATION_ERROR' },
        })
      }

      const { search, page, limit } = result.data
      const skip = (page - 1) * limit

      const where = search
        ? {
            OR: [
              { email: { contains: search, mode: 'insensitive' as const } },
              { displayName: { contains: search, mode: 'insensitive' as const } },
            ],
          }
        : {}

      const [users, total] = await Promise.all([
        prisma.user.findMany({
          where,
          skip,
          take: limit,
          select: {
            id: true,
            email: true,
            displayName: true,
            provider: true,
            accountStatus: true,
            globalRole: true,
            createdAt: true,
            updatedAt: true,
            _count: { select: { bookings: true } },
          },
          // Secondary sort on id — displayName is not unique (two users can
          // easily share a name), and Postgres gives no ordering guarantee
          // among tied rows across separate queries without a unique
          // tiebreaker. Same class of bug as GET /bookings/report.
          orderBy: [{ displayName: 'asc' }, { id: 'asc' }],
        }),
        prisma.user.count({ where }),
      ])

      return reply.status(200).send({
        data: users,
        meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
      })
    },
  )

  // GET /users/search — colleague picker for any authenticated user (transfer
  // a booking, propose a swap, add someone to an asset's allow list). Deliberately
  // separate from GET / above (which stays SUPER_ADMIN-only, admin-only fields,
  // paginated) rather than loosening that route's auth — this returns just
  // enough to render a name+email picker row and nothing else (no globalRole,
  // accountStatus, provider, etc.), the same minimal shape GET /directory/whereabouts
  // already uses for the colleague-finder feature. Registered before /:id so
  // "search" is never captured as a user id.
  fastify.get('/search', { preHandler: [requireAuth] }, async (request, reply) => {
    const result = z.object({ q: z.string().min(2).max(255) }).safeParse(request.query)
    if (!result.success) {
      return reply.status(200).send({ data: [] })
    }
    // A user who opted out of "Show me in Who's In" was promised (ProfilePage)
    // they "won't appear in Who's In or colleague search" — this endpoint's
    // own name is "colleague picker," so it's exactly the surface that
    // promise covers, same visibility rule GET /directory/whereabouts already
    // applies. Unlike the floor plan (a deliberate, separately-documented
    // exception — see #219, whose fix updated this exact copy to carve it
    // out explicitly), nothing carves this endpoint out of the promise, so
    // it must honour it too.
    const visibility = { OR: [{ visibleInColleagueSearch: true }, { id: request.user.id }] }
    const users = await prisma.user.findMany({
      where: {
        accountStatus: 'ACTIVE',
        AND: [visibility, { OR: [
          { email: { contains: result.data.q, mode: 'insensitive' as const } },
          { displayName: { contains: result.data.q, mode: 'insensitive' as const } },
        ] }],
      },
      select: { id: true, email: true, displayName: true },
      orderBy: { displayName: 'asc' },
      take: 20,
    })
    return reply.status(200).send({ data: users })
  })

  // GET /users/:id — get user
  fastify.get('/:id', { preHandler: [requireAuth] }, async (request, reply) => {
    const { id } = request.params as { id: string }

    const isSelf = request.user.id === id
    const isAdmin = request.user.globalRole === GlobalRole.SUPER_ADMIN

    if (!isSelf && !isAdmin) {
      return reply.status(403).send({ error: { message: 'Forbidden', code: 'FORBIDDEN' } })
    }

    const user = await prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        email: true,
        displayName: true,
        provider: true,
        accountStatus: true,
        globalRole: true,
        createdAt: true,
        updatedAt: true,
        resourceRoles: {
          include: {
            building: { select: { id: true, name: true } },
            floor: { select: { id: true, name: true } },
          },
        },
        groupMemberships: {
          include: { group: { select: { id: true, name: true, globalRole: true } } },
        },
      },
    })

    if (!user) {
      return reply.status(404).send({ error: { message: 'User not found', code: 'NOT_FOUND' } })
    }

    return reply.status(200).send({ data: user })
  })

  // PATCH /users/:id — update user
  fastify.patch('/:id', { preHandler: [requireAuth] }, async (request, reply) => {
    const { id } = request.params as { id: string }

    const isSelf = request.user.id === id
    const isAdmin = request.user.globalRole === GlobalRole.SUPER_ADMIN

    if (!isSelf && !isAdmin) {
      return reply.status(403).send({ error: { message: 'Forbidden', code: 'FORBIDDEN' } })
    }

    const result = updateUserSchema.safeParse(request.body)
    if (!result.success) {
      return reply.status(400).send({
        error: { message: 'Validation failed', code: 'VALIDATION_ERROR', details: result.error.flatten() },
      })
    }

    // Only admins can change accountStatus or globalRole
    if ((result.data.accountStatus || result.data.globalRole) && !isAdmin) {
      return reply.status(403).send({
        error: { message: 'Only admins can change account status or role', code: 'FORBIDDEN' },
      })
    }

    // Guard against removing the last active super admin (would lock the org
    // out). lockSuperAdminGuard + wouldRemoveLastActiveSuperAdmin run inside
    // the same transaction as the update itself so two concurrent requests
    // demoting two *different* admins (the only two active ones) can't both
    // pass the check before either commits and leave zero.
    const demotesAdmin = result.data.globalRole !== undefined && result.data.globalRole !== GlobalRole.SUPER_ADMIN
    const blocksAccount = result.data.accountStatus === 'BLOCKED'

    try {
      const updated = await prisma.$transaction(async (tx) => {
        if (demotesAdmin || blocksAccount) {
          await lockSuperAdminGuard(tx)
          if (await wouldRemoveLastActiveSuperAdmin(tx, id)) {
            throw Object.assign(new Error('LAST_SUPER_ADMIN'), { code: 'LAST_SUPER_ADMIN' })
          }
        }
        const before = await tx.user.findUnique({
          where: { id },
          select: { displayName: true, accountStatus: true, globalRole: true, visibleInColleagueSearch: true },
        })
        const updated = await tx.user.update({
          where: { id },
          data: {
            ...result.data,
            // An admin explicitly setting the role marks it MANUAL so directory
            // sync will not later downgrade it.
            ...(result.data.globalRole !== undefined ? { globalRoleSource: RoleSource.MANUAL } : {}),
          },
          select: {
            id: true,
            email: true,
            displayName: true,
            provider: true,
            accountStatus: true,
            globalRole: true,
            visibleInColleagueSearch: true,
            createdAt: true,
            updatedAt: true,
          },
        })
        await recordAuditLog(tx, {
          actorId: request.user.id,
          action: result.data.accountStatus === 'BLOCKED' ? 'user.suspended' : 'user.updated',
          resourceType: 'User',
          resourceId: id,
          before,
          after: { displayName: updated.displayName, accountStatus: updated.accountStatus, globalRole: updated.globalRole, visibleInColleagueSearch: updated.visibleInColleagueSearch },
          ipAddress: request.ip,
        }, request.log)
        return updated
      })

      if (result.data.accountStatus === 'BLOCKED') {
        // A blocked user can no longer log in to cancel their own bookings or
        // release their desk, so do it for them — otherwise a desk sits
        // silently CONFIRMED/ASSIGNED under an account nobody can manage.
        await cancelFutureBookingsForUser(updated.id)
        await cancelQueueEntriesForUser(updated.id)
        await releaseAssetAssignmentsForUser(updated.id)
        dispatchWebhook('user.suspended', { id: updated.id, email: updated.email }).catch(() => {})
      } else {
        dispatchWebhook('user.updated', { id: updated.id, email: updated.email, displayName: updated.displayName }).catch(() => {})
      }

      return reply.status(200).send({ data: updated })
    } catch (err: unknown) {
      const e = err as { code?: string }
      if (e?.code === 'LAST_SUPER_ADMIN') {
        return reply.status(409).send({
          error: { message: 'Cannot remove the last active super admin', code: 'LAST_SUPER_ADMIN' },
        })
      }
      return reply.status(404).send({ error: { message: 'User not found', code: 'NOT_FOUND' } })
    }
  })

  // GET /users/me/notification-preferences — get current user's notification preferences
  fastify.get('/me/notification-preferences', { preHandler: [requireAuth] }, async (request, reply) => {
    const user = await prisma.user.findUnique({
      where: { id: request.user.id },
      select: { notificationPreferences: true },
    })
    const preferences = (user?.notificationPreferences ?? {}) as Record<string, { email?: boolean; inApp?: boolean; push?: boolean }>
    return reply.status(200).send({ data: { preferences } })
  })

  // PATCH /users/me/notification-preferences — update current user's notification preferences
  fastify.patch('/me/notification-preferences', { preHandler: [requireAuth] }, async (request, reply) => {
    const result = updateNotificationPreferencesSchema.safeParse(request.body)
    if (!result.success) {
      return reply.status(400).send({
        error: { message: 'Validation failed', code: 'VALIDATION_ERROR', details: result.error.flatten() },
      })
    }

    const before = await prisma.user.findUnique({ where: { id: request.user.id }, select: { notificationPreferences: true } })
    await prisma.user.update({
      where: { id: request.user.id },
      data: { notificationPreferences: result.data.preferences },
    })
    await recordAuditLog(prisma, {
      actorId: request.user.id,
      action: 'user.notification_preferences_updated',
      resourceType: 'User',
      resourceId: request.user.id,
      before: before?.notificationPreferences ?? null,
      after: result.data.preferences,
      ipAddress: request.ip,
    }, request.log)

    return reply.status(200).send({ data: { ok: true } })
  })

  // POST /users/me/password — self-service password change (local auth users only)
  // Rate-limited like /auth/login: this endpoint bcrypt-compares currentPassword,
  // so without a strict limit it's an online password-guessing oracle available
  // to anyone holding a valid session token (e.g. a stolen cookie) — worse than
  // login's exposure, since it needs no username/email guesswork at all. Global
  // default is 300 req/min; that's 20x looser than /auth/login's brute-force tier.
  fastify.post('/me/password', { preHandler: [requireAuth], config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } }, async (request, reply) => {
    const result = changePasswordSchema.safeParse(request.body)
    if (!result.success) {
      return reply.status(400).send({
        error: { message: 'Validation failed', code: 'VALIDATION_ERROR', details: result.error.flatten() },
      })
    }

    const user = await prisma.user.findUnique({ where: { id: request.user.id }, select: { id: true, passwordHash: true } })
    if (!user?.passwordHash) {
      return reply.status(409).send({
        error: { message: 'Password change is not available for SSO accounts', code: 'SSO_ACCOUNT' },
      })
    }

    const valid = await bcryptjs.compare(result.data.currentPassword, user.passwordHash)
    if (!valid) {
      return reply.status(401).send({ error: { message: 'Current password is incorrect', code: 'INVALID_CREDENTIALS' } })
    }

    const newHash = await bcryptjs.hash(result.data.newPassword, 12)
    await prisma.user.update({
      where: { id: request.user.id },
      data: { passwordHash: newHash, passwordChangedAt: new Date() },
    })
    // Never log password hashes — only the fact that a change happened.
    await recordAuditLog(prisma, {
      actorId: request.user.id,
      action: 'user.password_changed',
      resourceType: 'User',
      resourceId: request.user.id,
      ipAddress: request.ip,
    }, request.log)

    // requireAuth now rejects any token issued before passwordChangedAt, which
    // would otherwise also log the caller out of the session they just used to
    // change their own password. Reissue a fresh token here — same pattern as
    // /auth/refresh — so this session continues seamlessly while every other
    // still-live token (other devices, or a stolen cookie) is invalidated.
    const currentToken = request.cookies?.[TOKEN_COOKIE]
    if (currentToken) {
      try {
        const payload = verifyAccessToken(currentToken)
        if (payload.jti) await blockToken(payload.jti, payload.exp)
        const newToken = signAccessToken({
          sub: request.user.id,
          role: request.user.globalRole,
          email: request.user.email,
          displayName: request.user.displayName,
          sessionStart: payload.sessionStart ?? payload.iat,
        })
        reply.setCookie(TOKEN_COOKIE, newToken, { ...TOKEN_COOKIE_OPTS, maxAge: TOKEN_MAX_AGE })
      } catch {
        // Current token was already invalid/expired — nothing to reissue.
      }
    }

    return reply.status(200).send({ data: { ok: true } })
  })

  // POST /users/:id/password/reset — admin sets a new password for any user
  // Rate-limited for a different reason than /me/password: not a guessing
  // oracle (no secret comparison here), but a compromised admin token would
  // otherwise be able to mass-reset every user's password at up to the
  // 300 req/min global default. 30/15min still bounds that blast radius while
  // leaving headroom for a legitimate admin resetting several accounts by hand.
  fastify.post(
    '/:id/password/reset',
    { preHandler: [requireAuth, requireGlobalRole(GlobalRole.SUPER_ADMIN)], config: { rateLimit: { max: 30, timeWindow: '15 minutes' } } },
    async (request, reply) => {
      const { id } = request.params as { id: string }
      const result = adminSetPasswordSchema.safeParse(request.body)
      if (!result.success) {
        return reply.status(400).send({
          error: { message: 'Validation failed', code: 'VALIDATION_ERROR', details: result.error.flatten() },
        })
      }

      const user = await prisma.user.findUnique({ where: { id } })
      if (!user) {
        return reply.status(404).send({ error: { message: 'User not found', code: 'NOT_FOUND' } })
      }
      // A federated (OIDC/SAML/LDAP) account has no Roomer-owned credential
      // to "reset" — the IdP is the sole source of truth for it. Setting a
      // passwordHash here would silently open a second, parallel local-login
      // path for that account: /auth/login only branches into the LDAP
      // fallback when passwordHash is null (see the `!user?.passwordHash`
      // check there), so once set, this account could be logged into with a
      // plain email+password from then on — bypassing the IdP entirely,
      // including its MFA and any deprovisioning done IdP-side, until
      // someone notices and manually clears it. Same class of risk as the
      // SCIM identity-hijack this session already fixed (#283), via a
      // different vector.
      if (user.provider !== 'LOCAL') {
        return reply.status(409).send({
          error: {
            message: `This account signs in via ${user.provider} — it has no local password to reset. Manage its access through that identity provider instead.`,
            code: 'NOT_A_LOCAL_ACCOUNT',
          },
        })
      }

      const newHash = await bcryptjs.hash(result.data.password, 12)
      await prisma.user.update({
        where: { id },
        data: { passwordHash: newHash, passwordChangedAt: new Date() },
      })
      // Never log password hashes — only that an admin reset this user's password.
      await recordAuditLog(prisma, {
        actorId: request.user.id,
        action: 'user.password_reset_by_admin',
        resourceType: 'User',
        resourceId: id,
        ipAddress: request.ip,
      }, request.log)
      return reply.status(200).send({ data: { ok: true } })
    },
  )

  // GET /users/:id/effective-access — explain WHAT a user can do and WHERE each
  // permission comes from (provenance). Visible to the user themselves or admins.
  fastify.get('/:id/effective-access', { preHandler: [requireAuth] }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const isSelf = request.user.id === id
    const isAdmin = request.user.globalRole === GlobalRole.SUPER_ADMIN
    if (!isSelf && !isAdmin) {
      return reply.status(403).send({ error: { message: 'Forbidden', code: 'FORBIDDEN' } })
    }

    const user = await prisma.user.findUnique({
      where: { id },
      select: {
        id: true, email: true, displayName: true, globalRole: true, globalRoleSource: true,
        lastIdpGroups: true, lastSsoLoginAt: true,
        resourceRoles: {
          select: {
            role: true, scopeType: true, source: true,
            building: { select: { id: true, name: true } },
            floor: { select: { id: true, name: true, building: { select: { id: true, name: true } } } },
          },
        },
        groupMemberships: {
          select: {
            source: true,
            group: {
              select: {
                id: true, name: true, globalRole: true,
                groupResourceRoles: {
                  select: {
                    role: true, scopeType: true,
                    building: { select: { id: true, name: true } },
                    floor: { select: { id: true, name: true, building: { select: { id: true, name: true } } } },
                  },
                },
              },
            },
          },
        },
      },
    })
    if (!user) {
      return reply.status(404).send({ error: { message: 'User not found', code: 'NOT_FOUND' } })
    }

    type Grant = { scope: 'BUILDING' | 'FLOOR'; role: string; targetId: string; targetName: string; buildingName?: string; via: string; source: string }
    const grants: Grant[] = []

    for (const r of user.resourceRoles) {
      if (r.scopeType === 'BUILDING' && r.building) {
        grants.push({ scope: 'BUILDING', role: r.role, targetId: r.building.id, targetName: r.building.name, via: 'Direct grant', source: r.source })
      } else if (r.scopeType === 'FLOOR' && r.floor) {
        grants.push({ scope: 'FLOOR', role: r.role, targetId: r.floor.id, targetName: r.floor.name, buildingName: r.floor.building?.name, via: 'Direct grant', source: r.source })
      }
    }

    const groups = user.groupMemberships.map((m) => ({
      id: m.group.id,
      name: m.group.name,
      source: m.source,
      confersAdmin: m.group.globalRole === GlobalRole.SUPER_ADMIN,
    }))

    for (const m of user.groupMemberships) {
      for (const r of m.group.groupResourceRoles) {
        if (r.scopeType === 'BUILDING' && r.building) {
          grants.push({ scope: 'BUILDING', role: r.role, targetId: r.building.id, targetName: r.building.name, via: `Group "${m.group.name}"`, source: m.source })
        } else if (r.scopeType === 'FLOOR' && r.floor) {
          grants.push({ scope: 'FLOOR', role: r.role, targetId: r.floor.id, targetName: r.floor.name, buildingName: r.floor.building?.name, via: `Group "${m.group.name}"`, source: m.source })
        }
      }
    }

    const adminViaGroup = groups.find((g) => g.confersAdmin)

    return reply.status(200).send({
      data: {
        user: { id: user.id, email: user.email, displayName: user.displayName },
        globalRole: user.globalRole,
        globalRoleSource: user.globalRoleSource,
        globalRoleVia: user.globalRole === GlobalRole.SUPER_ADMIN
          ? (user.globalRoleSource === RoleSource.IDP ? 'Granted via IdP group mapping' : (adminViaGroup ? `Group "${adminViaGroup.name}"` : 'Set manually'))
          : null,
        groups,
        grants,
        idp: {
          lastSsoLoginAt: user.lastSsoLoginAt,
          lastIdpGroups: user.lastIdpGroups,
        },
      },
    })
  })

  // GET /users/:id/bookings — get user's bookings
  fastify.get('/:id/bookings', { preHandler: [requireAuth] }, async (request, reply) => {
    const { id } = request.params as { id: string }

    const isSelf = request.user.id === id
    const isAdmin = request.user.globalRole === GlobalRole.SUPER_ADMIN

    if (!isSelf && !isAdmin) {
      return reply.status(403).send({ error: { message: 'Forbidden', code: 'FORBIDDEN' } })
    }

    const pageResult = z.object({
      page: z.coerce.number().int().positive().default(1),
      limit: z.coerce.number().int().positive().max(100).default(20),
    }).safeParse(request.query)
    const { page, limit } = pageResult.success ? pageResult.data : { page: 1, limit: 20 }
    const skip = (page - 1) * limit

    const [bookings, total] = await Promise.all([
      prisma.booking.findMany({
        where: { userId: id },
        // guestCheckInToken is a bare, unauthenticated credential — never
        // surfaced outside the invite email actually sent to the guest,
        // not even to an admin looking up this user's own booking history.
        omit: { guestCheckInToken: true },
        include: {
          asset: {
            include: {
              floor: { include: { building: { select: { id: true, name: true } } } },
              primaryZone: { select: { id: true, name: true } },
            },
          },
        },
        orderBy: { startsAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.booking.count({ where: { userId: id } }),
    ])

    return reply.status(200).send({ data: bookings, meta: { total, page, limit } })
  })

  // POST /users/:id/resource-roles — assign resource role (SUPER_ADMIN, or a
  // floor manager/building admin assigning FLOOR_MANAGER on a floor they
  // already manage — the only grant FloorAdminPage's FloorManagersPanel
  // actually makes through this endpoint. Any other scope/role combination
  // (granting BUILDING_ADMIN, or FLOOR_MANAGER on a floor the actor doesn't
  // manage) stays SUPER_ADMIN-only.)
  fastify.post(
    '/:id/resource-roles',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const { id } = request.params as { id: string }

      const result = assignRoleSchema.safeParse(request.body)
      if (!result.success) {
        return reply.status(400).send({
          error: { message: 'Validation failed', code: 'VALIDATION_ERROR', details: result.error.flatten() },
        })
      }

      if (request.user.globalRole !== GlobalRole.SUPER_ADMIN) {
        const canManage =
          result.data.scopeType === 'FLOOR' &&
          result.data.role === 'FLOOR_MANAGER' &&
          result.data.floorId &&
          (await isFloorManagerForFloor(request.user.id, result.data.floorId))
        if (!canManage) {
          return reply.status(403).send({ error: { message: 'Insufficient permissions', code: 'FORBIDDEN' } })
        }
      }

      const user = await prisma.user.findUnique({ where: { id } })
      if (!user) {
        return reply.status(404).send({ error: { message: 'User not found', code: 'NOT_FOUND' } })
      }

      if (result.data.scopeType === 'BUILDING' && !result.data.buildingId) {
        return reply.status(400).send({
          error: { message: 'buildingId is required for BUILDING scope', code: 'VALIDATION_ERROR' },
        })
      }

      if (result.data.scopeType === 'FLOOR' && !result.data.floorId) {
        return reply.status(400).send({
          error: { message: 'floorId is required for FLOOR scope', code: 'VALIDATION_ERROR' },
        })
      }

      // The unique index on UserResourceRole is (userId, scopeType, buildingId,
      // floorId), but a BUILDING-scope row always has floorId NULL and a
      // FLOOR-scope row always has buildingId NULL — Postgres treats NULL <>
      // NULL for uniqueness, so that constraint never actually fires for
      // either scope and the same user could be assigned the same role twice.
      // The findFirst pre-check alone only closes the sequential-request
      // case — two concurrent grants for the same user+scope both pass it
      // before either commits, same as GroupResourceRole's equivalent (now
      // fixed the same way in buildings.ts/floors.ts's group-manager grant
      // routes). Without the lock, revoking one of the resulting duplicate
      // grants via DELETE below left the other grant — and therefore the
      // access — silently in place, looking to the admin like a successful,
      // complete revocation.
      const lockKey = `${id}:${result.data.scopeType}:${result.data.buildingId ?? result.data.floorId ?? ''}:${result.data.role}`
      const role = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${RESOURCE_ROLE_GRANT_LOCK_CLASS}, hashtext(${lockKey}))`
        const existing = await tx.userResourceRole.findFirst({
          where: {
            userId: id,
            role: result.data.role,
            scopeType: result.data.scopeType,
            buildingId: result.data.buildingId ?? null,
            floorId: result.data.floorId ?? null,
          },
        })
        if (existing) {
          throw Object.assign(new Error('ALREADY_EXISTS'), { code: 'ALREADY_EXISTS' })
        }
        return tx.userResourceRole.create({
          data: {
            userId: id,
            role: result.data.role,
            scopeType: result.data.scopeType,
            buildingId: result.data.buildingId ?? null,
            floorId: result.data.floorId ?? null,
          },
        })
      }).catch((err) => {
        if ((err as { code?: string })?.code === 'ALREADY_EXISTS') return null
        throw err
      })
      if (!role) {
        return reply.status(409).send({
          error: { message: 'Role already assigned', code: 'ALREADY_EXISTS' },
        })
      }
      await recordAuditLog(prisma, {
        actorId: request.user.id,
        action: 'user_resource_role.granted',
        resourceType: 'UserResourceRole',
        resourceId: role.id,
        after: { userId: id, role: role.role, scopeType: role.scopeType, buildingId: role.buildingId, floorId: role.floorId },
        ipAddress: request.ip,
      }, request.log)
      return reply.status(201).send({ data: role })
    },
  )

  // DELETE /users/:id/resource-roles/:roleId — remove resource role
  // (SUPER_ADMIN, or the same scoped FLOOR_MANAGER carve-out as the POST above)
  fastify.delete(
    '/:id/resource-roles/:roleId',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const { id, roleId } = request.params as { id: string; roleId: string }

      const target = await prisma.userResourceRole.findUnique({ where: { id: roleId, userId: id } })
      if (!target) {
        return reply.status(404).send({ error: { message: 'Role not found', code: 'NOT_FOUND' } })
      }

      if (request.user.globalRole !== GlobalRole.SUPER_ADMIN) {
        const canManage =
          target.scopeType === 'FLOOR' &&
          target.role === 'FLOOR_MANAGER' &&
          target.floorId &&
          (await isFloorManagerForFloor(request.user.id, target.floorId))
        if (!canManage) {
          return reply.status(403).send({ error: { message: 'Insufficient permissions', code: 'FORBIDDEN' } })
        }
      }

      // deleteMany on the full scope filter, not delete-by-id — the grant
      // side's unique constraint never actually fires (see
      // RESOURCE_ROLE_GRANT_LOCK_CLASS), so a race could have left more than
      // one row for this exact user+scope+role. Deleting only the given
      // roleId left any duplicate siblings (and therefore the access)
      // silently in place despite an apparently successful revoke.
      await prisma.userResourceRole.deleteMany({
        where: { userId: id, role: target.role, scopeType: target.scopeType, buildingId: target.buildingId, floorId: target.floorId },
      })
      await recordAuditLog(prisma, {
        actorId: request.user.id,
        action: 'user_resource_role.revoked',
        resourceType: 'UserResourceRole',
        resourceId: roleId,
        before: { userId: target.userId, role: target.role, scopeType: target.scopeType, buildingId: target.buildingId, floorId: target.floorId },
        ipAddress: request.ip,
      }, request.log)
      return reply.status(200).send({ data: { ok: true } })
    },
  )

  // POST /users/bulk-import — CSV user import with optional group assignments (SUPER_ADMIN)
  // Body: { rows: Array<{ email, display_name, password?, global_role?, access_groups?, send_welcome_email? }> }
  // access_groups: semicolon-separated group names (looked up by name, case-insensitive)
  // Tighter than the single-create limit above: one call here can already
  // create hundreds of users (and WELCOME emails) at once, so the
  // legitimate use case needs far fewer repeated calls than 30/15min.
  fastify.post(
    '/bulk-import',
    { preHandler: [requireAuth, requireGlobalRole(GlobalRole.SUPER_ADMIN)], config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } },
    async (request, reply) => {
      const body = userImportBodySchema.safeParse(request.body)
      if (!body.success) {
        return reply.status(400).send({ error: { message: 'Invalid request body', code: 'VALIDATION_ERROR' } })
      }

      const org = await prisma.organisation.findFirst({ select: { id: true } })
      if (!org) return reply.status(500).send({ error: { message: 'No organisation found', code: 'INTERNAL_ERROR' } })

      let created = 0
      let updated = 0
      const errors: Array<{ row: number; message: string }> = []

      // Validate all rows first. A CSV blank cell parses to '' (not absent), but
      // password/global_role are meant to be optional-with-a-default (see the
      // CSV column help text and downloadable template, which both show blank
      // password/global_role cells) — z.optional()/z.default() only apply to
      // undefined, not ''. Without stripping empty strings here, an ordinary
      // blank cell rejects the whole row instead of falling back to a random
      // password / USER role as documented.
      type ValidRow = z.infer<typeof userImportRowSchema>
      const validRows: Array<{ index: number; row: ValidRow }> = []
      for (let i = 0; i < body.data.rows.length; i++) {
        const rawRow = { ...body.data.rows[i] }
        if (rawRow.password === '') delete rawRow.password
        if (rawRow.global_role === '') delete rawRow.global_role
        const result = userImportRowSchema.safeParse(rawRow)
        if (!result.success) {
          errors.push({ row: i + 2, message: result.error.issues.map((e) => e.message).join('; ') })
        } else {
          validRows.push({ index: i, row: result.data })
        }
      }

      if (validRows.length === 0) {
        return reply.status(422).send({ error: { message: 'No valid rows', code: 'NO_VALID_ROWS' }, data: { errors } })
      }

      // Pre-resolve group names → IDs (case-insensitive)
      const allGroupNames = new Set<string>()
      for (const { row } of validRows) {
        if (row.access_groups) {
          row.access_groups.split(';').map((g) => g.trim()).filter(Boolean).forEach((g) => allGroupNames.add(g.toLowerCase()))
        }
      }
      const groupsByName = new Map<string, string>() // lowercase name → id
      if (allGroupNames.size > 0) {
        const groups = await prisma.userGroup.findMany({
          where: { organisationId: org.id },
          select: { id: true, name: true },
        })
        for (const g of groups) groupsByName.set(g.name.toLowerCase(), g.id)
      }

      for (const { index, row } of validRows) {
        try {
          const existing = await prisma.user.findUnique({ where: { email: row.email } })
          let userId: string

          if (existing) {
            // Same guard as PATCH /users/:id — a roster CSV with no global_role
            // column defaults every row to 'USER' (see userImportRowSchema), so
            // an "all employees" import that happens to include the org's sole
            // super admin would otherwise silently demote them and lock the org
            // out with no path back except direct DB access. lockSuperAdminGuard
            // serialises this against the other three guarded paths (PATCH
            // /users/:id, IdP group-mapping sync, SCIM) so a concurrent request
            // demoting a different admin can't race this row past the check.
            const couldDemote = existing.globalRole === GlobalRole.SUPER_ADMIN
              && existing.accountStatus === 'ACTIVE'
              && (row.global_role as typeof existing.globalRole) !== GlobalRole.SUPER_ADMIN

            await prisma.$transaction(async (tx) => {
              let nextGlobalRole: typeof existing.globalRole = row.global_role as typeof existing.globalRole
              if (couldDemote) {
                await lockSuperAdminGuard(tx)
                if (await wouldRemoveLastActiveSuperAdmin(tx, existing.id)) {
                  nextGlobalRole = existing.globalRole
                  errors.push({ row: index + 2, message: `Cannot demote ${row.email} — they are the last active super admin; role left unchanged` })
                }
              }
              await tx.user.update({
                where: { email: row.email },
                data: { displayName: row.display_name, globalRole: nextGlobalRole },
              })
            })
            userId = existing.id
            updated++
          } else {
            const password = row.password?.trim() || crypto.randomBytes(12).toString('base64url')
            const passwordHash = await bcryptjs.hash(password, 12)
            const user = await prisma.user.create({
              data: { email: row.email, displayName: row.display_name, passwordHash, globalRole: row.global_role as GlobalRole },
              select: { id: true },
            })
            userId = user.id
            created++
            dispatchWebhook('user.created', { id: userId, email: row.email, displayName: row.display_name, globalRole: row.global_role as GlobalRole }).catch(() => {})
            if (row.send_welcome_email) {
              enqueueNotification({ type: NotificationType.WELCOME, userId }).catch(() => {})
            }
          }

          // Assign to access groups
          if (row.access_groups) {
            const names = row.access_groups.split(';').map((g) => g.trim()).filter(Boolean)
            for (const name of names) {
              const groupId = groupsByName.get(name.toLowerCase())
              if (!groupId) { errors.push({ row: index + 2, message: `Group "${name}" not found` }); continue }
              await prisma.userGroupMember.upsert({
                where: { groupId_userId: { groupId, userId } },
                create: { groupId, userId },
                update: {},
              })
            }
          }
        } catch (err) {
          errors.push({ row: index + 2, message: err instanceof Error ? err.message : 'Unknown error' })
        }
      }

      // One summary row for the whole batch, not one per imported user — this
      // can create/update hundreds of rows in a single call.
      await recordAuditLog(prisma, {
        actorId: request.user.id,
        action: 'user.bulk_imported',
        resourceType: 'User',
        resourceId: crypto.randomUUID(),
        after: { createdCount: created, updatedCount: updated, errorCount: errors.length, totalRows: validRows.length },
        ipAddress: request.ip,
      }, request.log)

      return reply.status(200).send({ data: { created, updated, errors } })
    },
  )
}
