import { z } from 'zod'
import { QrCheckInMode } from '../types.js'

export const createBuildingSchema = z.object({
  name: z.string().min(1, 'Building name is required').max(255),
  address: z.string().max(500).optional(),
})

export const updateBuildingSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  address: z.string().max(500).nullable().optional(),
  // Per-building no-show release override. null = inherit the org default.
  noShowReleaseEnabled: z.boolean().nullable().optional(),
  // Per-building QR check-in mode override. null = inherit the org default.
  qrCheckInMode: z.nativeEnum(QrCheckInMode).nullable().optional(),
})

export type CreateBuildingInput = z.infer<typeof createBuildingSchema>
export type UpdateBuildingInput = z.infer<typeof updateBuildingSchema>
