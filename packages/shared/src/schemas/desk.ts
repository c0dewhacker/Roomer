import { z } from 'zod'
import { DeskStatus } from '../types'

export const createDeskSchema = z.object({
  zoneId: z.string().min(1, 'Invalid zone ID'),
  name: z.string().min(1, 'Desk name is required').max(255),
  x: z.number().min(0).max(100),
  y: z.number().min(0).max(100),
  width: z.number().positive().optional(),
  height: z.number().positive().optional(),
  rotation: z.number().min(-360).max(360).optional(),
  status: z.nativeEnum(DeskStatus).optional(),
  amenities: z.array(z.string()).optional(),
})

export const updateDeskSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  x: z.number().min(0).max(100).optional(),
  y: z.number().min(0).max(100).optional(),
  width: z.number().positive().optional(),
  height: z.number().positive().optional(),
  rotation: z.number().min(-360).max(360).optional(),
  status: z.nativeEnum(DeskStatus).optional(),
  amenities: z.array(z.string()).optional(),
})

export const deskPositionSchema = z.object({
  id: z.string().min(1),
  x: z.number().min(0).max(100),
  y: z.number().min(0).max(100),
  width: z.number().positive().optional(),
  height: z.number().positive().optional(),
  rotation: z.number().min(-360).max(360).optional(),
})

export const bulkUpdatePositionsSchema = z.object({
  desks: z.array(deskPositionSchema).min(1),
})

export type CreateDeskInput = z.infer<typeof createDeskSchema>
export type UpdateDeskInput = z.infer<typeof updateDeskSchema>
export type DeskPositionInput = z.infer<typeof deskPositionSchema>
export type BulkUpdatePositionsInput = z.infer<typeof bulkUpdatePositionsSchema>
