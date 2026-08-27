import { z } from 'zod'
import { QrCheckInMode } from '../types.js'

// .trim() before .min(1) — see schemas/department.ts for why.
export const createFloorSchema = z.object({
  buildingId: z.string().min(1, 'Invalid building ID'),
  name: z.string().trim().min(1, 'Floor name is required').max(255),
  level: z.number().int().optional(),
})

export const updateFloorSchema = z.object({
  name: z.string().trim().min(1).max(255).optional(),
  level: z.number().int().optional(),
  // Per-floor no-show release override. null = inherit (floor → building → org).
  noShowReleaseEnabled: z.boolean().nullable().optional(),
  // Per-floor QR check-in mode override. null = inherit (floor → building → org).
  qrCheckInMode: z.nativeEnum(QrCheckInMode).nullable().optional(),
})

export type CreateFloorInput = z.infer<typeof createFloorSchema>
export type UpdateFloorInput = z.infer<typeof updateFloorSchema>
