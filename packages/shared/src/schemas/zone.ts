import { z } from 'zod'

export const createZoneSchema = z.object({
  floorId: z.string().min(1, 'Invalid floor ID'),
  name: z.string().min(1, 'Zone name is required').max(255),
  colour: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Colour must be a valid hex colour')
    .optional(),
  zoneGroupId: z.string().min(1).nullable().optional(),
})

export const updateZoneSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  colour: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Colour must be a valid hex colour')
    .optional(),
  zoneGroupId: z.string().min(1).nullable().optional(),
})

export const createZoneGroupSchema = z.object({
  floorId: z.string().min(1, 'Invalid floor ID'),
  name: z.string().min(1, 'Zone group name is required').max(255),
})

export type CreateZoneInput = z.infer<typeof createZoneSchema>
export type UpdateZoneInput = z.infer<typeof updateZoneSchema>
export type CreateZoneGroupInput = z.infer<typeof createZoneGroupSchema>
