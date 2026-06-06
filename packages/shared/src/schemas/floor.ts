import { z } from 'zod'

export const createFloorSchema = z.object({
  buildingId: z.string().min(1, 'Invalid building ID'),
  name: z.string().min(1, 'Floor name is required').max(255),
  level: z.number().int().optional(),
})

export const updateFloorSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  level: z.number().int().optional(),
  // Per-floor no-show release override. null = inherit (floor → building → org).
  noShowReleaseEnabled: z.boolean().nullable().optional(),
})

export type CreateFloorInput = z.infer<typeof createFloorSchema>
export type UpdateFloorInput = z.infer<typeof updateFloorSchema>
