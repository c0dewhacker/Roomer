import { z } from 'zod'

export const createBookingSchema = z.object({
  assetId: z.string().min(1, 'Invalid asset ID'),
  startsAt: z.string().datetime('startsAt must be a valid ISO 8601 datetime'),
  endsAt: z.string().datetime('endsAt must be a valid ISO 8601 datetime'),
  notes: z.string().max(1000).optional(),
  // Declared group size for a room/shared-space booking. Purely informational
  // — never validated against the asset's capacity server-side, since an
  // oversized group is a client-side warning, not a rejection reason.
  attendeeCount: z.number().int().positive().max(1000).optional(),
  // Visitor/guest booking (#79) — the host is still `userId` (request.user.id),
  // guestName/guestEmail just record who they're hosting. guestEmail is
  // optional even for a guest booking (a host may not have it yet) but when
  // present a check-in link is emailed to it.
  guestName: z.string().min(1).max(255).optional(),
  guestEmail: z.string().email().max(255).optional(),
}).refine(
  (data) => new Date(data.startsAt) < new Date(data.endsAt),
  { message: 'startsAt must be before endsAt', path: ['startsAt'] },
).refine(
  (data) => !data.guestEmail || !!data.guestName,
  { message: 'guestName is required when guestEmail is provided', path: ['guestName'] },
)

export const updateBookingSchema = z.object({
  startsAt: z.string().datetime().optional(),
  endsAt: z.string().datetime().optional(),
  notes: z.string().max(1000).nullable().optional(),
  attendeeCount: z.number().int().positive().max(1000).nullable().optional(),
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
