import { z } from 'zod'
import { BookableStatus } from '../types'

export const createAssetSchema = z.object({
  name: z.string().min(1, 'Asset name is required').max(255),
  categoryId: z.string().min(1, 'Invalid category ID'),
  description: z.string().max(1000).optional(),
  serialNumber: z.string().max(255).optional(),
  assetTag: z.string().max(100).optional(),
  purchaseDate: z.string().datetime().nullable().optional(),
  warrantyExpiry: z.string().datetime().nullable().optional(),
  notes: z.string().max(2000).optional(),
  // Bookable-asset fields
  isBookable: z.boolean().optional(),
  bookingLabel: z.string().max(255).optional(),
  amenities: z.array(z.string()).optional(),
  bookingStatus: z.nativeEnum(BookableStatus).optional(),
  primaryZoneId: z.string().optional(),
  floorId: z.string().optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  width: z.number().positive().optional(),
  height: z.number().positive().optional(),
  rotation: z.number().min(-360).max(360).optional(),
})

export const updateAssetSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  categoryId: z.string().min(1).optional(),
  description: z.string().max(1000).nullable().optional(),
  serialNumber: z.string().max(255).nullable().optional(),
  assetTag: z.string().max(100).nullable().optional(),
  purchaseDate: z.string().datetime().nullable().optional(),
  warrantyExpiry: z.string().datetime().nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  // Bookable-asset fields
  isBookable: z.boolean().optional(),
  bookingLabel: z.string().max(255).nullable().optional(),
  amenities: z.array(z.string()).optional(),
  bookingStatus: z.nativeEnum(BookableStatus).optional(),
  primaryZoneId: z.string().nullable().optional(),
  floorId: z.string().nullable().optional(),
  x: z.number().nullable().optional(),
  y: z.number().nullable().optional(),
  width: z.number().positive().nullable().optional(),
  height: z.number().positive().nullable().optional(),
  rotation: z.number().min(-360).max(360).nullable().optional(),
})

export const assignAssetSchema = z.object({
  userId: z.string().min(1),
  notes: z.string().max(1000).optional(),
})

export const createAssetCategorySchema = z.object({
  name: z.string().min(1, 'Category name is required').max(255),
  description: z.string().max(1000).optional(),
  defaultIsBookable: z.boolean().optional(),
  defaultIcon: z.string().max(255).optional(),
  colour: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'colour must be a 6-digit hex colour'),
})

export const assetPositionSchema = z.object({
  id: z.string().min(1),
  x: z.number(),
  y: z.number(),
  width: z.number().positive().optional(),
  height: z.number().positive().optional(),
  rotation: z.number().min(-360).max(360).optional(),
})

export const bulkUpdateAssetPositionsSchema = z.object({
  assets: z.array(assetPositionSchema).min(1),
})

export type CreateAssetInput = z.infer<typeof createAssetSchema>
export type UpdateAssetInput = z.infer<typeof updateAssetSchema>
export type AssignAssetInput = z.infer<typeof assignAssetSchema>
export type CreateAssetCategoryInput = z.infer<typeof createAssetCategorySchema>
export type AssetPositionInput = z.infer<typeof assetPositionSchema>
export type BulkUpdateAssetPositionsInput = z.infer<typeof bulkUpdateAssetPositionsSchema>
