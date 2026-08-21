import { z } from 'zod'

export const createBallotSchema = z.object({
  name: z.string().min(1, 'Name is required').max(255),
  // Scope: at least one building or floor required (validated below) — the
  // asset pool is the union of assets on any listed floor, plus every floor
  // of any listed building.
  buildingIds: z.array(z.string().min(1)).default([]),
  floorIds: z.array(z.string().min(1)).default([]),
  // Empty = every bookable asset in scope, no category filter.
  assetCategoryIds: z.array(z.string().min(1)).default([]),
  frequency: z.enum(['ONCE', 'WEEKLY', 'MONTHLY']).default('WEEKLY'),
  dayOfWeek: z.number().int().min(0).max(6).optional(),
  // Capped at 28 to avoid "day 30" never landing in February etc. — a
  // monthly ballot always draws on the same day-of-month, clamped to the
  // shortest month if higher were allowed.
  dayOfMonth: z.number().int().min(1).max(28).optional(),
  registrationWindowHours: z.number().int().min(1).max(24 * 30).default(72),
  slotStartTime: z.string().regex(/^\d{2}:\d{2}$/, 'slotStartTime must be HH:MM').default('00:00'),
  slotEndTime: z.string().regex(/^\d{2}:\d{2}$/, 'slotEndTime must be HH:MM').default('23:59'),
  slotLeadDays: z.number().int().min(0).max(90).default(1),
  slotDurationDays: z.number().int().min(1).max(90).default(1),
}).refine(
  (d) => d.buildingIds.length > 0 || d.floorIds.length > 0,
  { message: 'Select at least one building or floor', path: ['buildingIds'] },
).refine(
  (d) => d.frequency !== 'WEEKLY' || d.dayOfWeek !== undefined,
  { message: 'dayOfWeek is required for weekly ballots', path: ['dayOfWeek'] },
).refine(
  (d) => d.frequency !== 'MONTHLY' || d.dayOfMonth !== undefined,
  { message: 'dayOfMonth is required for monthly ballots', path: ['dayOfMonth'] },
)

export const updateBallotSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  buildingIds: z.array(z.string().min(1)).optional(),
  floorIds: z.array(z.string().min(1)).optional(),
  assetCategoryIds: z.array(z.string().min(1)).optional(),
  dayOfWeek: z.number().int().min(0).max(6).nullable().optional(),
  dayOfMonth: z.number().int().min(1).max(28).nullable().optional(),
  registrationWindowHours: z.number().int().min(1).max(24 * 30).optional(),
  slotStartTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  slotEndTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  slotLeadDays: z.number().int().min(0).max(90).optional(),
  slotDurationDays: z.number().int().min(1).max(90).optional(),
  status: z.enum(['ACTIVE', 'PAUSED', 'CANCELLED']).optional(),
})

export type CreateBallotInput = z.infer<typeof createBallotSchema>
export type UpdateBallotInput = z.infer<typeof updateBallotSchema>
