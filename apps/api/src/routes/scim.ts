import { timingSafeEqual } from 'crypto'
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { prisma } from '../lib/prisma'
import {
  userToScim, groupToScim, scimError, listResponse, parseScimFilter,
  applyUserPatchOps, applyGroupPatchOps, hashScimToken,
  SCIM_SCHEMAS, scimUserLocation, scimGroupLocation,
} from '../lib/scim-helpers'
import { env } from '../env'

const SCIM_CONTENT_TYPE = 'application/scim+json'

async function scimAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const auth = request.headers.authorization
  if (!auth?.startsWith('Bearer ')) {
    reply.status(401).header('Content-Type', SCIM_CONTENT_TYPE)
      .send(scimError(401, 'Bearer token required'))
    return
  }
  const cfg = await prisma.scimConfig.findFirst()
  if (!cfg?.enabled || !cfg.tokenHash) {
    reply.status(401).header('Content-Type', SCIM_CONTENT_TYPE)
      .send(scimError(401, 'SCIM provisioning is not enabled'))
    return
  }
  const provided = Buffer.from(hashScimToken(auth.slice(7)))
  const expected = Buffer.from(cfg.tokenHash)
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    reply.status(401).header('Content-Type', SCIM_CONTENT_TYPE)
      .send(scimError(401, 'Invalid bearer token'))
    return
  }
}

const userSelect = {
  id: true, email: true, displayName: true,
  accountStatus: true, externalId: true, createdAt: true, updatedAt: true,
}

// ─── Discovery ────────────────────────────────────────────────────────────────

function registerDiscovery(fastify: FastifyInstance): void {
  fastify.get('/ServiceProviderConfig', { preHandler: [scimAuth] }, async (_req, reply) => {
    reply.header('Content-Type', SCIM_CONTENT_TYPE).send({
      schemas: [SCIM_SCHEMAS.SPC],
      patch: { supported: true },
      bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
      filter: { supported: true, maxResults: 200 },
      changePassword: { supported: false },
      sort: { supported: false },
      etag: { supported: false },
      authenticationSchemes: [{
        type: 'oauthbearertoken',
        name: 'OAuth Bearer Token',
        description: 'Authentication via bearer token configured in Admin → Settings → SCIM',
      }],
      meta: {
        resourceType: 'ServiceProviderConfig',
        location: `${env.API_PUBLIC_URL}/scim/v2/ServiceProviderConfig`,
      },
    })
  })

  fastify.get('/ResourceTypes', { preHandler: [scimAuth] }, async (_req, reply) => {
    reply.header('Content-Type', SCIM_CONTENT_TYPE).send(listResponse([
      {
        schemas: [SCIM_SCHEMAS.RESOURCE_TYPE],
        id: 'User', name: 'User', endpoint: '/Users',
        description: 'User accounts',
        schema: SCIM_SCHEMAS.USER,
        meta: { resourceType: 'ResourceType', location: `${env.API_PUBLIC_URL}/scim/v2/ResourceTypes/User` },
      },
      {
        schemas: [SCIM_SCHEMAS.RESOURCE_TYPE],
        id: 'Group', name: 'Group', endpoint: '/Groups',
        description: 'User groups',
        schema: SCIM_SCHEMAS.GROUP,
        meta: { resourceType: 'ResourceType', location: `${env.API_PUBLIC_URL}/scim/v2/ResourceTypes/Group` },
      },
    ], 2, 1))
  })

  fastify.get('/Schemas', { preHandler: [scimAuth] }, async (_req, reply) => {
    reply.header('Content-Type', SCIM_CONTENT_TYPE).send(listResponse([
      { schemas: [SCIM_SCHEMAS.SCHEMA], id: SCIM_SCHEMAS.USER, name: 'User', description: 'User Account', attributes: [] },
      { schemas: [SCIM_SCHEMAS.SCHEMA], id: SCIM_SCHEMAS.GROUP, name: 'Group', description: 'Group', attributes: [] },
      { schemas: [SCIM_SCHEMAS.SCHEMA], id: SCIM_SCHEMAS.ENTERPRISE_USER, name: 'EnterpriseUser', description: 'Enterprise User', attributes: [] },
    ], 3, 1))
  })
}

// ─── Users ────────────────────────────────────────────────────────────────────

function registerUsers(fastify: FastifyInstance): void {
  // GET /Users — list or filter
  fastify.get('/Users', { preHandler: [scimAuth] }, async (request, reply) => {
    const q = request.query as { filter?: string; startIndex?: string; count?: string }
    const startIndex = Math.max(1, parseInt(q.startIndex ?? '1', 10))
    const count = Math.min(200, Math.max(1, parseInt(q.count ?? '20', 10)))
    const skip = startIndex - 1

    const parsed = parseScimFilter(q.filter)
    let where: Record<string, unknown> = {}
    if (parsed) {
      if (parsed.attr === 'userName' || parsed.attr === 'email') where = { email: parsed.value }
      else if (parsed.attr === 'externalId') where = { externalId: parsed.value }
      else if (parsed.attr === 'displayName') where = { displayName: { contains: parsed.value, mode: 'insensitive' } }
    }

    const [users, total] = await Promise.all([
      prisma.user.findMany({ where, skip, take: count, select: userSelect, orderBy: { createdAt: 'asc' } }),
      prisma.user.count({ where }),
    ])

    reply.header('Content-Type', SCIM_CONTENT_TYPE)
      .send(listResponse(users.map(userToScim), total, startIndex))
  })

  // POST /Users — create user
  fastify.post('/Users', { preHandler: [scimAuth] }, async (request, reply) => {
    const body = request.body as Record<string, unknown>
    const email = (body.userName as string) ?? ((body.emails as Array<{ value: string }>)?.[0]?.value)
    const displayName = (body.displayName as string) ?? email
    const externalId = body.externalId as string | undefined
    const active = body.active !== false

    if (!email) {
      return reply.status(400).header('Content-Type', SCIM_CONTENT_TYPE)
        .send(scimError(400, 'userName is required'))
    }

    // Validate email format — SCIM userName must be a valid email address
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    if (!emailRegex.test(email)) {
      return reply.status(400).header('Content-Type', SCIM_CONTENT_TYPE)
        .send(scimError(400, 'userName must be a valid email address'))
    }

    const existing = await prisma.user.findUnique({ where: { email }, select: userSelect })
    if (existing) {
      return reply.status(409).header('Content-Type', SCIM_CONTENT_TYPE)
        .send(scimError(409, `User ${email} already exists`))
    }

    const user = await prisma.user.create({
      data: {
        email,
        displayName,
        externalId: externalId ?? null,
        accountStatus: active ? 'ACTIVE' : 'BLOCKED',
        provider: 'OIDC',
      },
      select: userSelect,
    })

    reply.status(201).header('Content-Type', SCIM_CONTENT_TYPE).send(userToScim(user))
  })

  // GET /Users/:id
  fastify.get('/Users/:id', { preHandler: [scimAuth] }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const user = await prisma.user.findUnique({ where: { id }, select: userSelect })
    if (!user) {
      return reply.status(404).header('Content-Type', SCIM_CONTENT_TYPE)
        .send(scimError(404, `User ${id} not found`))
    }
    reply.header('Content-Type', SCIM_CONTENT_TYPE).send(userToScim(user))
  })

  // PUT /Users/:id — full replace (Entra uses PATCH but some clients send PUT)
  fastify.put('/Users/:id', { preHandler: [scimAuth] }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const body = request.body as Record<string, unknown>
    const email = (body.userName as string) ?? ((body.emails as Array<{ value: string }>)?.[0]?.value)
    const displayName = body.displayName as string | undefined
    const externalId = body.externalId as string | undefined
    const active = body.active as boolean | undefined

    try {
      const user = await prisma.user.update({
        where: { id },
        data: {
          ...(email ? { email } : {}),
          ...(displayName ? { displayName } : {}),
          ...(externalId !== undefined ? { externalId } : {}),
          ...(active !== undefined ? { accountStatus: active ? 'ACTIVE' : 'BLOCKED' } : {}),
        },
        select: userSelect,
      })
      reply.header('Content-Type', SCIM_CONTENT_TYPE).send(userToScim(user))
    } catch {
      reply.status(404).header('Content-Type', SCIM_CONTENT_TYPE).send(scimError(404, `User ${id} not found`))
    }
  })

  // PATCH /Users/:id — partial update
  fastify.patch('/Users/:id', { preHandler: [scimAuth] }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const body = request.body as { Operations?: Array<{ op: string; path?: string; value?: unknown }> }
    const ops = body.Operations ?? []

    const patch = applyUserPatchOps(ops)
    if (Object.keys(patch).length === 0) {
      const user = await prisma.user.findUnique({ where: { id }, select: userSelect })
      if (!user) return reply.status(404).header('Content-Type', SCIM_CONTENT_TYPE).send(scimError(404, `User ${id} not found`))
      return reply.header('Content-Type', SCIM_CONTENT_TYPE).send(userToScim(user))
    }

    try {
      const user = await prisma.user.update({ where: { id }, data: patch, select: userSelect })
      reply.header('Content-Type', SCIM_CONTENT_TYPE).send(userToScim(user))
    } catch {
      reply.status(404).header('Content-Type', SCIM_CONTENT_TYPE).send(scimError(404, `User ${id} not found`))
    }
  })

  // DELETE /Users/:id — deprovision
  fastify.delete('/Users/:id', { preHandler: [scimAuth] }, async (request, reply) => {
    const { id } = request.params as { id: string }
    try {
      await prisma.user.update({ where: { id }, data: { accountStatus: 'BLOCKED' } })
      reply.status(204).send()
    } catch {
      reply.status(404).header('Content-Type', SCIM_CONTENT_TYPE).send(scimError(404, `User ${id} not found`))
    }
  })
}

// ─── Groups ───────────────────────────────────────────────────────────────────

function registerGroups(fastify: FastifyInstance): void {
  const groupSelect = { id: true, name: true, createdAt: true, updatedAt: true }

  // GET /Groups — list or filter
  fastify.get('/Groups', { preHandler: [scimAuth] }, async (request, reply) => {
    const q = request.query as { filter?: string; startIndex?: string; count?: string; excludedAttributes?: string }
    const startIndex = Math.max(1, parseInt(q.startIndex ?? '1', 10))
    const count = Math.min(200, Math.max(1, parseInt(q.count ?? '20', 10)))
    const excludeMembers = q.excludedAttributes?.includes('members') ?? false

    const parsed = parseScimFilter(q.filter)
    let where: Record<string, unknown> = {}
    if (parsed) {
      if (parsed.attr === 'displayName') where = { name: parsed.value }
      else if (parsed.attr === 'externalId') where = { id: parsed.value }
    }

    const org = await prisma.organisation.findFirst({ select: { id: true } })
    if (org) where = { ...where, organisationId: org.id }

    const [groups, total] = await Promise.all([
      prisma.userGroup.findMany({
        where,
        skip: startIndex - 1,
        take: count,
        select: {
          ...groupSelect,
          members: excludeMembers ? false : { select: { user: { select: { id: true, email: true } } } },
        },
        orderBy: { createdAt: 'asc' },
      }),
      prisma.userGroup.count({ where }),
    ])

    const resources = groups.map((g) => {
      const membersRaw = (g as Record<string, unknown>).members as Array<{ user: { id: string; email: string } }> | undefined
      const members = excludeMembers ? null : membersRaw?.map((m) => ({ id: m.user.id, email: m.user.email })) ?? []
      return groupToScim(g, members)
    })

    reply.header('Content-Type', SCIM_CONTENT_TYPE)
      .send(listResponse(resources, total, startIndex))
  })

  // POST /Groups — create group
  fastify.post('/Groups', { preHandler: [scimAuth] }, async (request, reply) => {
    const body = request.body as { displayName?: string }
    if (!body.displayName) {
      return reply.status(400).header('Content-Type', SCIM_CONTENT_TYPE)
        .send(scimError(400, 'displayName is required'))
    }

    const org = await prisma.organisation.findFirst({ select: { id: true } })
    if (!org) return reply.status(500).header('Content-Type', SCIM_CONTENT_TYPE).send(scimError(500, 'No organisation'))

    try {
      const group = await prisma.userGroup.create({
        data: { name: body.displayName, organisationId: org.id },
        select: groupSelect,
      })
      reply.status(201).header('Content-Type', SCIM_CONTENT_TYPE).send(groupToScim(group, []))
    } catch {
      reply.status(409).header('Content-Type', SCIM_CONTENT_TYPE).send(scimError(409, `Group ${body.displayName} already exists`))
    }
  })

  // GET /Groups/:id
  fastify.get('/Groups/:id', { preHandler: [scimAuth] }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const q = request.query as { excludedAttributes?: string }
    const excludeMembers = q.excludedAttributes?.includes('members') ?? false

    const group = await prisma.userGroup.findUnique({
      where: { id },
      select: {
        ...groupSelect,
        members: excludeMembers ? false : { select: { user: { select: { id: true, email: true } } } },
      },
    })
    if (!group) {
      return reply.status(404).header('Content-Type', SCIM_CONTENT_TYPE).send(scimError(404, `Group ${id} not found`))
    }

    const membersRaw = (group as Record<string, unknown>).members as Array<{ user: { id: string; email: string } }> | undefined
    const members = excludeMembers ? null : membersRaw?.map((m) => ({ id: m.user.id, email: m.user.email })) ?? []
    reply.header('Content-Type', SCIM_CONTENT_TYPE).send(groupToScim(group, members))
  })

  // PATCH /Groups/:id — add/remove members, rename
  fastify.patch('/Groups/:id', { preHandler: [scimAuth] }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const body = request.body as { Operations?: Array<{ op: string; path?: string; value?: unknown }> }
    const patch = applyGroupPatchOps(body.Operations ?? [])

    const group = await prisma.userGroup.findUnique({ where: { id }, select: groupSelect })
    if (!group) {
      return reply.status(404).header('Content-Type', SCIM_CONTENT_TYPE).send(scimError(404, `Group ${id} not found`))
    }

    if (patch.displayName) {
      await prisma.userGroup.update({ where: { id }, data: { name: patch.displayName } })
    }
    for (const userId of patch.addMemberIds) {
      await prisma.userGroupMember.upsert({
        where: { groupId_userId: { groupId: id, userId } },
        create: { groupId: id, userId },
        update: {},
      }).catch(() => { /* user may not exist */ })
    }
    for (const userId of patch.removeMemberIds) {
      await prisma.userGroupMember.deleteMany({ where: { groupId: id, userId } })
    }

    reply.status(204).send()
  })

  // DELETE /Groups/:id
  fastify.delete('/Groups/:id', { preHandler: [scimAuth] }, async (request, reply) => {
    const { id } = request.params as { id: string }
    try {
      await prisma.userGroup.delete({ where: { id } })
      reply.status(204).send()
    } catch {
      reply.status(404).header('Content-Type', SCIM_CONTENT_TYPE).send(scimError(404, `Group ${id} not found`))
    }
  })
}

// ─── Register ─────────────────────────────────────────────────────────────────

export async function scimRoutes(fastify: FastifyInstance): Promise<void> {
  // Entra ID sends Content-Type: application/scim+json — treat it like JSON
  fastify.addContentTypeParser('application/scim+json', { parseAs: 'string' }, (_req, body, done) => {
    try { done(null, JSON.parse(body as string)) } catch (err) { done(err as Error) }
  })

  registerDiscovery(fastify)
  registerUsers(fastify)
  registerGroups(fastify)
}
