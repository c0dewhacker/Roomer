import fs from 'fs'
import path from 'path'
import type { FastifyInstance } from 'fastify'
import { prisma } from '../lib/prisma'
import { createFloorSchema, updateFloorSchema, GlobalRole } from '@roomer/shared'
import { requireAuth } from '../middleware/requireAuth'
import { requireGlobalRole, isFloorManagerForFloor } from '../middleware/requireRole'
import { saveFloorPlan, resolveStoragePath, deleteFile } from '../lib/storage'
import { env } from '../env'

export async function floorRoutes(fastify: FastifyInstance): Promise<void> {
  // GET /floors/:id — floor with zones, bookable assets, floorPlan
  fastify.get('/:id', { preHandler: [requireAuth] }, async (request, reply) => {
    const { id } = request.params as { id: string }

    const floor = await prisma.floor.findUnique({
      where: { id },
      include: {
        building: { select: { id: true, name: true } },
        floorPlan: true,
        zoneGroups: { orderBy: { name: 'asc' } },
        zones: {
          orderBy: { name: 'asc' },
          include: {
            assets: {
              where: { isBookable: true },
              orderBy: { name: 'asc' },
            },
          },
        },
      },
    })

    if (!floor) {
      return reply.status(404).send({ error: { message: 'Floor not found', code: 'NOT_FOUND' } })
    }

    return reply.status(200).send({ data: floor })
  })

  // GET /floors/:id/managers — list floor managers (SUPER_ADMIN only)
  fastify.get(
    '/:id/managers',
    { preHandler: [requireAuth, requireGlobalRole(GlobalRole.SUPER_ADMIN)] },
    async (request, reply) => {
      const { id } = request.params as { id: string }

      const roles = await prisma.userResourceRole.findMany({
        where: { scopeType: 'FLOOR', floorId: id, role: 'FLOOR_MANAGER' },
        include: {
          user: { select: { id: true, displayName: true, email: true } },
        },
        orderBy: { createdAt: 'asc' },
      })

      return reply.status(200).send({ data: roles.map((r) => ({ roleId: r.id, ...r.user })) })
    },
  )

  // GET /floors/:id/group-managers — list group floor managers (SUPER_ADMIN only)
  fastify.get(
    '/:id/group-managers',
    { preHandler: [requireAuth, requireGlobalRole(GlobalRole.SUPER_ADMIN)] },
    async (request, reply) => {
      const { id } = request.params as { id: string }

      const roles = await prisma.groupResourceRole.findMany({
        where: { scopeType: 'FLOOR', floorId: id, role: 'FLOOR_MANAGER' },
        include: {
          group: { select: { id: true, name: true, _count: { select: { members: true } } } },
        },
        orderBy: { createdAt: 'asc' },
      })

      return reply.status(200).send({
        data: roles.map((r) => ({
          roleId: r.id,
          id: r.group.id,
          name: r.group.name,
          memberCount: r.group._count.members,
        })),
      })
    },
  )

  // POST /floors/:id/group-managers — assign a group as floor manager (SUPER_ADMIN only)
  fastify.post(
    '/:id/group-managers',
    { preHandler: [requireAuth, requireGlobalRole(GlobalRole.SUPER_ADMIN)] },
    async (request, reply) => {
      const { id } = request.params as { id: string }
      const { groupId } = request.body as { groupId: string }

      if (!groupId) {
        return reply.status(400).send({ error: { message: 'groupId is required', code: 'VALIDATION_ERROR' } })
      }

      const group = await prisma.userGroup.findUnique({ where: { id: groupId } })
      if (!group) {
        return reply.status(404).send({ error: { message: 'Group not found', code: 'NOT_FOUND' } })
      }

      const existing = await prisma.groupResourceRole.findFirst({
        where: { groupId, scopeType: 'FLOOR', floorId: id },
      })
      if (existing) {
        return reply.status(409).send({ error: { message: 'Group is already a floor manager', code: 'ALREADY_EXISTS' } })
      }

      const role = await prisma.groupResourceRole.create({
        data: { groupId, role: 'FLOOR_MANAGER', scopeType: 'FLOOR', floorId: id },
      })

      return reply.status(201).send({ data: { roleId: role.id, id: group.id, name: group.name } })
    },
  )

  // DELETE /floors/:id/group-managers/:groupId — remove a group floor manager (SUPER_ADMIN only)
  fastify.delete(
    '/:id/group-managers/:groupId',
    { preHandler: [requireAuth, requireGlobalRole(GlobalRole.SUPER_ADMIN)] },
    async (request, reply) => {
      const { id, groupId } = request.params as { id: string; groupId: string }

      const role = await prisma.groupResourceRole.findFirst({
        where: { groupId, scopeType: 'FLOOR', floorId: id },
      })
      if (!role) {
        return reply.status(404).send({ error: { message: 'Group role not found', code: 'NOT_FOUND' } })
      }

      await prisma.groupResourceRole.delete({ where: { id: role.id } })
      return reply.status(200).send({ data: { ok: true } })
    },
  )

  // POST /floors — create floor
  fastify.post(
    '/',
    { preHandler: [requireAuth, requireGlobalRole(GlobalRole.SUPER_ADMIN)] },
    async (request, reply) => {
      const result = createFloorSchema.safeParse(request.body)
      if (!result.success) {
        return reply.status(400).send({
          error: { message: 'Validation failed', code: 'VALIDATION_ERROR', details: result.error.flatten() },
        })
      }

      const building = await prisma.building.findUnique({ where: { id: result.data.buildingId } })
      if (!building) {
        return reply.status(404).send({ error: { message: 'Building not found', code: 'NOT_FOUND' } })
      }

      const floor = await prisma.floor.create({
        data: {
          buildingId: result.data.buildingId,
          name: result.data.name,
          level: result.data.level ?? 0,
        },
      })

      return reply.status(201).send({ data: floor })
    },
  )

  // PUT /floors/:id — update floor (SUPER_ADMIN or floor manager for that floor)
  fastify.put(
    '/:id',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const { id } = request.params as { id: string }

      if (request.user.globalRole !== GlobalRole.SUPER_ADMIN) {
        const canManage = await isFloorManagerForFloor(request.user.id, id)
        if (!canManage) {
          return reply.status(403).send({ error: { message: 'Insufficient permissions', code: 'FORBIDDEN' } })
        }
      }

      const result = updateFloorSchema.safeParse(request.body)
      if (!result.success) {
        return reply.status(400).send({
          error: { message: 'Validation failed', code: 'VALIDATION_ERROR', details: result.error.flatten() },
        })
      }

      try {
        const floor = await prisma.floor.update({ where: { id }, data: result.data })
        return reply.status(200).send({ data: floor })
      } catch {
        return reply.status(404).send({ error: { message: 'Floor not found', code: 'NOT_FOUND' } })
      }
    },
  )

  // DELETE /floors/:id
  fastify.delete(
    '/:id',
    { preHandler: [requireAuth, requireGlobalRole(GlobalRole.SUPER_ADMIN)] },
    async (request, reply) => {
      const { id } = request.params as { id: string }
      try {
        await prisma.floor.delete({ where: { id } })
        return reply.status(200).send({ data: { ok: true } })
      } catch {
        return reply.status(404).send({ error: { message: 'Floor not found', code: 'NOT_FOUND' } })
      }
    },
  )

  // POST /floors/:id/floor-plan — upload floor plan (SUPER_ADMIN or floor manager for that floor)
  fastify.post(
    '/:id/floor-plan',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const { id } = request.params as { id: string }

      if (request.user.globalRole !== GlobalRole.SUPER_ADMIN) {
        const canManage = await isFloorManagerForFloor(request.user.id, id)
        if (!canManage) {
          return reply.status(403).send({ error: { message: 'Insufficient permissions', code: 'FORBIDDEN' } })
        }
      }

      const floor = await prisma.floor.findUnique({ where: { id } })
      if (!floor) {
        return reply.status(404).send({ error: { message: 'Floor not found', code: 'NOT_FOUND' } })
      }

      const data = await request.file()
      if (!data) {
        return reply.status(400).send({ error: { message: 'No file uploaded', code: 'NO_FILE' } })
      }

      // Validate MIME type
      const allowedMimes = [
        'image/png', 'image/jpeg', 'image/webp', 'image/gif',
        'application/pdf',
        'image/vnd.dxf', 'application/dxf', 'application/octet-stream',
      ]
      if (!allowedMimes.includes(data.mimetype) && !data.filename.endsWith('.dxf')) {
        return reply.status(400).send({
          error: { message: 'Unsupported file type', code: 'INVALID_FILE_TYPE' },
        })
      }

      // Delete old floor plan files if they exist
      const existing = await prisma.floorPlan.findUnique({ where: { floorId: id } })
      if (existing) {
        await deleteFile(existing.originalPath)
        if (existing.renderedPath !== existing.originalPath) {
          await deleteFile(existing.renderedPath)
        }
        if (existing.thumbnailPath) {
          await deleteFile(existing.thumbnailPath)
        }
      }

      const saved = await saveFloorPlan(data)

      const floorPlan = await prisma.floorPlan.upsert({
        where: { floorId: id },
        update: {
          fileType: saved.fileType,
          originalPath: saved.originalPath,
          renderedPath: saved.renderedPath,
          thumbnailPath: saved.thumbnailPath,
          width: saved.width,
          height: saved.height,
        },
        create: {
          floorId: id,
          fileType: saved.fileType,
          originalPath: saved.originalPath,
          renderedPath: saved.renderedPath,
          thumbnailPath: saved.thumbnailPath,
          width: saved.width,
          height: saved.height,
        },
      })

      return reply.status(200).send({ data: floorPlan })
    },
  )

  // GET /floors/:id/floor-plan/image — stream rendered floor plan
  fastify.get('/:id/floor-plan/image', { preHandler: [requireAuth] }, async (request, reply) => {
    const { id } = request.params as { id: string }

    const floorPlan = await prisma.floorPlan.findUnique({ where: { floorId: id } })
    if (!floorPlan) {
      return reply.status(404).send({ error: { message: 'Floor plan not found', code: 'NOT_FOUND' } })
    }

    const absPath = resolveStoragePath(floorPlan.renderedPath)

    try {
      await fs.promises.access(absPath, fs.constants.R_OK)
    } catch {
      return reply.status(404).send({ error: { message: 'Floor plan file not found', code: 'FILE_NOT_FOUND' } })
    }

    const ext = path.extname(floorPlan.renderedPath).toLowerCase()
    const mimeMap: Record<string, string> = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.webp': 'image/webp',
      '.pdf': 'application/pdf',
      '.svg': 'image/svg+xml',
    }
    const contentType = mimeMap[ext] ?? 'application/octet-stream'

    const stream = fs.createReadStream(absPath)
    reply.header('Content-Type', contentType)
    reply.header('Cache-Control', 'public, max-age=86400')
    return reply.send(stream)
  })

  // GET /floors/:id/availability?date=YYYY-MM-DD
  // Returns zones with nested bookable assets and computed bookingStatus for the requesting user.
  fastify.get('/:id/availability', { preHandler: [requireAuth] }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const { date } = request.query as { date?: string }

    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return reply.status(400).send({
        error: { message: 'date query param required (YYYY-MM-DD)', code: 'INVALID_DATE' },
      })
    }

    const currentUserId = request.user.id
    const dayStart = new Date(`${date}T00:00:00.000Z`)
    const dayEnd = new Date(`${date}T23:59:59.999Z`)

    const floor = await prisma.floor.findUnique({
      where: { id },
      include: {
        zones: {
          orderBy: { name: 'asc' },
          include: {
            assets: {
              where: { isBookable: true },
              orderBy: { name: 'asc' },
              include: {
                allowList: { select: { userId: true } },
                userAssignments: {
                  select: {
                    isPrimary: true,
                    user: { select: { id: true, displayName: true, email: true } },
                  },
                },
                bookings: {
                  where: {
                    status: 'CONFIRMED',
                    startsAt: { lt: dayEnd },
                    endsAt: { gt: dayStart },
                  },
                  select: {
                    id: true,
                    userId: true,
                    startsAt: true,
                    endsAt: true,
                    user: { select: { displayName: true } },
                  },
                },
                queueEntries: {
                  where: {
                    userId: currentUserId,
                    status: { in: ['WAITING', 'PROMOTED'] },
                    wantedStartsAt: { lt: dayEnd },
                    wantedEndsAt: { gt: dayStart },
                  },
                  select: { id: true, status: true, position: true, claimDeadline: true },
                },
                availabilityWindows: {
                  where: {
                    startsAt: { lte: dayEnd },
                    endsAt: { gte: dayStart },
                  },
                  select: { id: true, startsAt: true, endsAt: true, ownerId: true },
                },
              },
            },
          },
        },
      },
    })

    if (!floor) {
      return reply.status(404).send({ error: { message: 'Floor not found', code: 'NOT_FOUND' } })
    }

    type AvailabilityStatus = 'available' | 'mine' | 'booked' | 'restricted' | 'assigned' | 'disabled' | 'queued' | 'promoted' | 'zone_conflict'

    // Collect zone group IDs where the current user has a booking today
    const userBookedZoneGroupIds = new Set<string>()
    for (const zone of floor.zones) {
      if (!zone.zoneGroupId) continue
      for (const asset of zone.assets) {
        if (asset.bookings.some((b) => b.userId === currentUserId)) {
          userBookedZoneGroupIds.add(zone.zoneGroupId)
        }
      }
    }

    const zones = floor.zones.map((zone) => {
      const assets = zone.assets.map((asset) => {
        const myBooking = asset.bookings.find((b) => b.userId === currentUserId)
        const othersBookings = asset.bookings.filter((b) => b.userId !== currentUserId)
        const myQueueEntry = asset.queueEntries[0] ?? null
        const isOnAllowList = asset.allowList.some((a) => a.userId === currentUserId)
        const isAssignedUser = asset.userAssignments.some((ua) => ua.user.id === currentUserId)
        const hasAvailabilityWindow = (asset.availabilityWindows ?? []).length > 0

        let bookingStatus: AvailabilityStatus

        if (asset.bookingStatus === 'DISABLED') {
          bookingStatus = 'disabled'
        } else if (myBooking) {
          bookingStatus = 'mine'
        } else if (othersBookings.length > 0) {
          if (myQueueEntry?.status === 'PROMOTED') {
            bookingStatus = 'promoted'
          } else if (myQueueEntry?.status === 'WAITING') {
            bookingStatus = 'queued'
          } else {
            bookingStatus = 'booked'
          }
        } else if (
          (asset.bookingStatus === 'ASSIGNED' || asset.userAssignments.length > 0) &&
          !isAssignedUser &&
          !hasAvailabilityWindow
        ) {
          bookingStatus = 'assigned'
        } else if (
          asset.bookingStatus === 'RESTRICTED' &&
          !isOnAllowList &&
          !isAssignedUser
        ) {
          bookingStatus = 'restricted'
        } else {
          bookingStatus = 'available'
        }

        // Zone group conflict: asset is available but user already has a booking in the same zone group
        if (
          bookingStatus === 'available' &&
          zone.zoneGroupId &&
          userBookedZoneGroupIds.has(zone.zoneGroupId)
        ) {
          bookingStatus = 'zone_conflict'
        }

        return {
          id: asset.id,
          zoneId: zone.id,
          zoneName: zone.name,
          zoneColour: zone.colour,
          name: asset.name,
          bookingLabel: asset.bookingLabel,
          x: asset.x,
          y: asset.y,
          width: asset.width,
          height: asset.height,
          rotation: asset.rotation,
          bookingStatus: bookingStatus,
          rawBookingStatus: asset.bookingStatus,
          amenities: asset.amenities,
          availabilityStatus: bookingStatus,
          currentBooking: myBooking
            ? { id: myBooking.id, userId: myBooking.userId, startsAt: myBooking.startsAt, endsAt: myBooking.endsAt }
            : othersBookings[0]
            ? { id: othersBookings[0].id, userId: othersBookings[0].userId, startsAt: othersBookings[0].startsAt, endsAt: othersBookings[0].endsAt, bookerName: othersBookings[0].user?.displayName }
            : null,
          bookedBy: othersBookings.map((b) => ({ userId: b.userId, displayName: b.user?.displayName ?? 'Unknown' })),
          myQueueEntry,
          assignedUsers: asset.userAssignments.map((ua) => ({ ...ua.user, isPrimary: ua.isPrimary })),
        }
      })

      return {
        id: zone.id,
        name: zone.name,
        colour: zone.colour,
        assets,
      }
    })

    return reply.status(200).send({ data: { floorId: floor.id, date, zones } })
  })
}

// Re-export resolveStoragePath for use by other routes if needed
export { resolveStoragePath }
