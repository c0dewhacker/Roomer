import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../lib/prisma'
import { requireAuth } from '../middleware/requireAuth'
import { requireGlobalRole } from '../middleware/requireRole'
import { GlobalRole } from '@roomer/shared'

// ─── Palette used when zone_colour is omitted ─────────────────────────────────

const ZONE_COLOUR_PALETTE = [
  '#6366f1', '#10b981', '#f59e0b', '#ef4444',
  '#8b5cf6', '#06b6d4', '#f97316', '#84cc16',
  '#ec4899', '#14b8a6',
]

function paletteColour(index: number): string {
  return ZONE_COLOUR_PALETTE[index % ZONE_COLOUR_PALETTE.length]
}

// ─── Validation ───────────────────────────────────────────────────────────────

const rowSchema = z.object({
  building_name: z.string().min(1, 'building_name is required'),
  building_address: z.string().optional(),
  floor_name: z.string().min(1, 'floor_name is required'),
  floor_level: z.union([z.coerce.number().int(), z.literal('')]).transform((v) => (v === '' ? 0 : Number(v))),
  zone_name: z.string().min(1, 'zone_name is required'),
  zone_colour: z
    .string()
    .regex(/^(#[0-9a-fA-F]{6})?$/, 'zone_colour must be a hex colour or empty')
    .optional(),
  asset_name: z.string().min(1, 'asset_name is required'),
  asset_category: z.string().min(1, 'asset_category is required'),
  asset_status: z
    .enum(['OPEN', 'RESTRICTED', 'ASSIGNED', 'DISABLED'])
    .default('OPEN'),
  asset_amenities: z.string().optional(),
  is_bookable: z
    .string()
    .optional()
    .transform((v) => {
      if (v === 'false' || v === '0') return false
      return true // default true for backwards compat
    }),
  serial_number: z.string().optional(),
  asset_tag: z.string().optional(),
})

const importBodySchema = z.object({
  rows: z.array(z.record(z.string())).min(1).max(2000),
})

// ─── Route ────────────────────────────────────────────────────────────────────

export async function importRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.addHook('onRoute', (route) => { route.schema = { tags: ['Import'], ...route.schema } })

  fastify.post(
    '/bulk',
    { preHandler: [requireAuth, requireGlobalRole(GlobalRole.SUPER_ADMIN)] },
    async (request, reply) => {
      const body = importBodySchema.safeParse(request.body)
      if (!body.success) {
        return reply.status(400).send({
          error: { message: 'Invalid request body', code: 'VALIDATION_ERROR' },
        })
      }

      // Validate every row and collect errors
      type ValidatedRow = z.infer<typeof rowSchema>
      const validRows: Array<{ index: number; row: ValidatedRow }> = []
      const errors: Array<{ row: number; message: string }> = []

      for (let i = 0; i < body.data.rows.length; i++) {
        const result = rowSchema.safeParse(body.data.rows[i])
        if (!result.success) {
          const msg = result.error.issues.map((e) => e.message).join('; ')
          errors.push({ row: i + 2, message: msg }) // +2 = 1-indexed + header row
        } else {
          validRows.push({ index: i, row: result.data })
        }
      }

      if (validRows.length === 0) {
        return reply.status(422).send({
          error: { message: 'No valid rows to import', code: 'NO_VALID_ROWS' },
          data: { errors },
        })
      }

      // ─── Perform import ────────────────────────────────────────────────────
      const org = await prisma.organisation.findFirst()
      if (!org) {
        return reply.status(500).send({
          error: { message: 'No organisation found', code: 'INTERNAL_ERROR' },
        })
      }

      let buildingsCreated = 0
      let floorsCreated = 0
      let zonesCreated = 0
      let assetsCreated = 0

      // Cache maps to avoid repeated DB lookups within this import
      const buildingCache = new Map<string, string>()       // name → id
      const floorCache    = new Map<string, string>()       // `${buildingId}::${floorName}` → id
      const zoneCache     = new Map<string, string>()       // `${floorId}::${zoneName}` → id
      const categoryCache = new Map<string, { id: string; defaultIsBookable: boolean | null }>()
      let zoneIndexCounter = 0

      await prisma.$transaction(async (tx) => {
        for (const { row } of validRows) {
          // ── Building ───────────────────────────────────────────────────────
          const buildingKey = row.building_name.trim()
          let buildingId = buildingCache.get(buildingKey)
          if (!buildingId) {
            const existing = await tx.building.findFirst({
              where: { name: buildingKey },
              select: { id: true },
            })
            if (existing) {
              buildingId = existing.id
            } else {
              const created = await tx.building.create({
                data: {
                  organisationId: org.id,
                  name: buildingKey,
                  address: row.building_address?.trim() ?? null,
                },
                select: { id: true },
              })
              buildingId = created.id
              buildingsCreated++
            }
            buildingCache.set(buildingKey, buildingId)
          }

          // ── Floor ──────────────────────────────────────────────────────────
          const floorKey = `${buildingId}::${row.floor_name.trim()}`
          let floorId = floorCache.get(floorKey)
          if (!floorId) {
            const existing = await tx.floor.findFirst({
              where: { buildingId, name: row.floor_name.trim() },
              select: { id: true },
            })
            if (existing) {
              floorId = existing.id
            } else {
              const created = await tx.floor.create({
                data: { buildingId, name: row.floor_name.trim(), level: row.floor_level },
                select: { id: true },
              })
              floorId = created.id
              floorsCreated++
            }
            floorCache.set(floorKey, floorId)
          }

          // ── Zone ───────────────────────────────────────────────────────────
          const zoneKey = `${floorId}::${row.zone_name.trim()}`
          let zoneId = zoneCache.get(zoneKey)
          if (!zoneId) {
            const colour = row.zone_colour?.trim() || paletteColour(zoneIndexCounter++)
            const existing = await tx.zone.findFirst({
              where: { floorId, name: row.zone_name.trim() },
              select: { id: true },
            })
            if (existing) {
              zoneId = existing.id
            } else {
              const created = await tx.zone.create({
                data: { floorId, name: row.zone_name.trim(), colour },
                select: { id: true },
              })
              zoneId = created.id
              zonesCreated++
            }
            zoneCache.set(zoneKey, zoneId)
          }

          // ── AssetCategory ──────────────────────────────────────────────────
          const categoryKey = row.asset_category.trim()
          let categoryEntry = categoryCache.get(categoryKey)
          if (!categoryEntry) {
            const existing = await tx.assetCategory.findFirst({
              where: { name: categoryKey },
              select: { id: true, defaultIsBookable: true },
            })
            if (existing) {
              categoryEntry = { id: existing.id, defaultIsBookable: existing.defaultIsBookable }
            } else {
              // Auto-create category; infer defaultIsBookable from first occurrence of is_bookable
              const created = await tx.assetCategory.create({
                data: {
                  name: categoryKey,
                  defaultIsBookable: row.is_bookable,
                  colour: '#6366f1',
                },
                select: { id: true, defaultIsBookable: true },
              })
              categoryEntry = { id: created.id, defaultIsBookable: created.defaultIsBookable }
            }
            categoryCache.set(categoryKey, categoryEntry)
          }

          // ── Asset ──────────────────────────────────────────────────────────
          const amenities = row.asset_amenities
            ? row.asset_amenities.split(';').map((a) => a.trim()).filter(Boolean)
            : []

          await tx.asset.create({
            data: {
              categoryId: categoryEntry.id,
              name: row.asset_name.trim(),
              isBookable: row.is_bookable,
              bookingStatus: row.is_bookable ? (row.asset_status as import('@prisma/client').BookableStatus) : null,
              primaryZoneId: zoneId,
              floorId,
              amenities,
              serialNumber: row.serial_number?.trim() || null,
              assetTag: row.asset_tag?.trim() || null,
              x: 50,
              y: 50,
              width: 3,
              height: 2,
              rotation: 0,
            },
          })
          assetsCreated++
        }
      })

      return reply.status(200).send({
        data: {
          created: { buildings: buildingsCreated, floors: floorsCreated, zones: zonesCreated, assets: assetsCreated },
          errors,
        },
      })
    },
  )
}
