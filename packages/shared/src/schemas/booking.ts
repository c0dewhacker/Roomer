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
  // guestName/guestEmail just record who they're hosting. The two are now
  // all-or-nothing: see the paired refines below.
  // .trim() before .min(1) — see schemas/department.ts for why. Also matters
  // for those refines: an untrimmed whitespace-only guestName is still truthy,
  // so a presence check alone wouldn't catch it.
  guestName: z.string().trim().min(1).max(255).optional(),
  guestEmail: z.string().email().max(255).optional(),
}).refine(
  (data) => new Date(data.startsAt) < new Date(data.endsAt),
  { message: 'startsAt must be before endsAt', path: ['startsAt'] },
).refine(
  (data) => !data.guestEmail || !!data.guestName,
  { message: 'guestName is required when guestEmail is provided', path: ['guestName'] },
).refine(
  // The other direction (#264). A guest booking is exempt from
  // maxBookingsPerUser — the host books "for a visitor" and it doesn't count
  // against their own quota — so with guestEmail optional, `guestName: "x"`
  // was an unlimited, unattributable way around that cap. Rather than give
  // guest bookings a separate numeric cap, require that the visitor is a real,
  // contactable person: it raises the cost of abuse and leaves an audit trail,
  // without inventing a second quota to keep in sync with the first.
  // It also removes an inconsistency of its own — the guest check-in link is
  // only ever sent when guestEmail is present, so a guest booking without one
  // silently produced a check-in token nobody could receive.
  (data) => !data.guestName || !!data.guestEmail,
  { message: 'guestEmail is required when guestName is provided', path: ['guestEmail'] },
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
