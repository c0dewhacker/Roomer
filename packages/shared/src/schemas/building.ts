import { z } from 'zod'
import { QrCheckInMode } from '../types.js'

// .trim() before .min(1): zod runs string checks in chain order, so min(1)
// against the raw value would let a whitespace-only name (" ") through
// un-normalized — see the identical fix in schemas/department.ts.
export const createBuildingSchema = z.object({
  name: z.string().trim().min(1, 'Building name is required').max(255),
  address: z.string().max(500).optional(),
})

export const updateBuildingSchema = z.object({
  name: z.string().trim().min(1).max(255).optional(),
  address: z.string().max(500).nullable().optional(),
  // Per-building no-show release override. null = inherit the org default.
  noShowReleaseEnabled: z.boolean().nullable().optional(),
  // Per-building QR check-in mode override. null = inherit the org default.
  qrCheckInMode: z.nativeEnum(QrCheckInMode).nullable().optional(),
  // Per-building booking-approval override. null = inherit the org default.
  requiresApproval: z.boolean().nullable().optional(),
  // Per-building timezone/working-hours overrides. null = inherit the org
  // default (see #72). enforceWorkingHours itself is an org-only switch,
  // not overridable per building.
  timezone: z.string().refine((v) => Intl.supportedValuesOf('timeZone').includes(v), 'Not a recognised IANA timezone').nullable().optional(),
  workingHoursStart: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
  workingHoursEnd: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
})

export type CreateBuildingInput = z.infer<typeof createBuildingSchema>
export type UpdateBuildingInput = z.infer<typeof updateBuildingSchema>
