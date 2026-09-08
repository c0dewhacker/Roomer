import { BookableStatus } from '@roomer/shared'
import { z } from 'zod'

// Asset request validation is kept separate from route handlers so changes to
// the import/edit contract do not get buried among booking and assignment
// endpoints.
export const createCategorySchema = z.object({
  name: z.string().trim().min(1).max(255),
  description: z.string().optional(),
  defaultIsBookable: z.boolean().optional(),
  defaultIcon: z.string().max(255).optional(),
  colour: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'colour must be a 6-digit hex colour').default('#6366f1'),
})

export const createAssetSchema = z.object({
  categoryId: z.string().min(1), name: z.string().trim().min(1).max(255),
  description: z.string().optional(),
  serialNumber: z.string().optional().transform((v) => v === '' ? undefined : v),
  assetTag: z.string().optional().transform((v) => v === '' ? undefined : v),
  purchaseDate: z.string().datetime().optional(), warrantyExpiry: z.string().datetime().optional(),
  notes: z.string().optional(), isBookable: z.boolean().optional(),
  bookingLabel: z.string().max(255).optional(), amenities: z.array(z.string()).optional(),
  bookingStatus: z.nativeEnum(BookableStatus).optional(), primaryZoneId: z.string().optional(),
  floorId: z.string().optional(), x: z.number().optional(), y: z.number().optional(),
  width: z.number().positive().optional(), height: z.number().positive().optional(),
  rotation: z.number().min(-360).max(360).optional(), capacity: z.number().int().positive().max(1000).optional(),
})

export const updateAssetSchema = z.object({
  categoryId: z.string().min(1).optional(), name: z.string().trim().min(1).max(255).optional(),
  description: z.string().optional(),
  serialNumber: z.string().optional().transform((v) => v === '' ? undefined : v),
  assetTag: z.string().optional().transform((v) => v === '' ? undefined : v),
  status: z.enum(['AVAILABLE', 'ASSIGNED', 'MAINTENANCE', 'RETIRED', 'DISABLED']).optional(),
  purchaseDate: z.string().datetime().optional(), warrantyExpiry: z.string().datetime().optional(),
  notes: z.string().optional(), isBookable: z.boolean().optional(),
  bookingLabel: z.string().max(255).nullable().optional(), amenities: z.array(z.string()).optional(),
  bookingStatus: z.nativeEnum(BookableStatus).optional(), primaryZoneId: z.string().nullable().optional(),
  floorId: z.string().nullable().optional(), x: z.number().nullable().optional(), y: z.number().nullable().optional(),
  width: z.number().positive().nullable().optional(), height: z.number().positive().nullable().optional(),
  rotation: z.number().min(-360).max(360).nullable().optional(), capacity: z.number().int().positive().max(1000).nullable().optional(),
})

export const addToAllowListSchema = z.object({ userId: z.string().min(1, 'Invalid user ID') })
export const addZoneSchema = z.object({ zoneId: z.string().min(1, 'Invalid zone ID') })

const bulkImportRowSchema = z.object({
  name: z.string().trim().min(1).max(255), categoryName: z.string().trim().min(1).max(255),
  bookingStatus: z.nativeEnum(BookableStatus).optional().default(BookableStatus.OPEN),
  bookingLabel: z.string().max(255).optional().default('Desk'), amenities: z.array(z.string()).optional().default([]),
  serialNumber: z.string().optional(), assetTag: z.string().optional(), notes: z.string().optional(), zoneName: z.string().optional(),
})

export const bulkImportSchema = z.object({ floorId: z.string().min(1), assets: z.array(bulkImportRowSchema).min(1).max(500) })
