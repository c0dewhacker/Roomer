import { z } from 'zod'

export const createBookingSchema = z.object({
  deskId: z.string().min(1, 'Invalid desk ID'),
  startsAt: z.string().datetime('startsAt must be a valid ISO 8601 datetime'),
  endsAt: z.string().datetime('endsAt must be a valid ISO 8601 datetime'),
  notes: z.string().max(1000).optional(),
}).refine(
  (data) => new Date(data.startsAt) < new Date(data.endsAt),
  { message: 'startsAt must be before endsAt', path: ['startsAt'] },
)

export const updateBookingSchema = z.object({
  startsAt: z.string().datetime().optional(),
  endsAt: z.string().datetime().optional(),
  notes: z.string().max(1000).nullable().optional(),
}).refine(
  (data) => {
    if (data.startsAt && data.endsAt) {
      return new Date(data.startsAt) < new Date(data.endsAt)
    }
    return true
  },
  { message: 'startsAt must be before endsAt', path: ['startsAt'] },
)

export type CreateBookingInput = z.infer<typeof createBookingSchema>
export type UpdateBookingInput = z.infer<typeof updateBookingSchema>
