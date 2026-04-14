import { z } from 'zod'
import { AssetAssigneeType } from '../types'

export const createAssetSchema = z.object({
  name: z.string().min(1, 'Asset name is required').max(255),
  categoryId: z.string().min(1, 'Invalid category ID'),
  description: z.string().max(1000).optional(),
  serialNumber: z.string().max(255).optional(),
  assetTag: z.string().max(100).optional(),
  purchaseDate: z.string().datetime().nullable().optional(),
  warrantyExpiry: z.string().datetime().nullable().optional(),
  notes: z.string().max(2000).optional(),
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
})

export const assignAssetSchema = z
  .object({
    assigneeType: z.nativeEnum(AssetAssigneeType),
    userId: z.string().min(1).optional(),
    deskId: z.string().min(1).optional(),
    notes: z.string().max(1000).optional(),
  })
  .refine(
    (data) => {
      if (data.assigneeType === AssetAssigneeType.USER) return !!data.userId
      if (data.assigneeType === AssetAssigneeType.DESK) return !!data.deskId
      return false
    },
    {
      message:
        'userId is required when assigneeType is USER; deskId is required when assigneeType is DESK',
    },
  )

export const createAssetCategorySchema = z.object({
  name: z.string().min(1, 'Category name is required').max(255),
  description: z.string().max(1000).optional(),
})

export type CreateAssetInput = z.infer<typeof createAssetSchema>
export type UpdateAssetInput = z.infer<typeof updateAssetSchema>
export type AssignAssetInput = z.infer<typeof assignAssetSchema>
export type CreateAssetCategoryInput = z.infer<typeof createAssetCategorySchema>
