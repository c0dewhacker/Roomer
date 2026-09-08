import type { Booking, Prisma } from '@prisma/client'

export class BookingConflictError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message)
    this.name = 'BookingConflictError'
  }
}

/** Compare-and-set at the write boundary also covers writers without advisory locks. */
export async function updateUnchangedBooking(
  tx: Prisma.TransactionClient,
  snapshot: Booking,
  args: { data: Prisma.BookingUpdateManyMutationInput; omit: { guestCheckInToken: true } },
) {
  const claimed = await tx.booking.updateMany({
    where: {
      id: snapshot.id, userId: snapshot.userId, assetId: snapshot.assetId,
      status: 'CONFIRMED', updatedAt: snapshot.updatedAt,
      startsAt: snapshot.startsAt, endsAt: snapshot.endsAt,
      notes: snapshot.notes, attendeeCount: snapshot.attendeeCount,
      icsSequence: snapshot.icsSequence,
    },
    data: args.data,
  })
  if (claimed.count !== 1) {
    throw new BookingConflictError('BOOKING_CHANGED', 'This booking changed while you were editing. Reload and try again.')
  }
  return tx.booking.findUniqueOrThrow({ where: { id: snapshot.id }, omit: args.omit })
}
