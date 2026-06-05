import { Prisma } from '@prisma/client'
import type { User } from '@prisma/client'
import { GlobalRole } from '@roomer/shared'
import { checkGroupAccess } from '../routes/groups.js'

/**
 * Single advisory-lock class shared by EVERY code path that creates a CONFIRMED
 * booking (direct booking, queue claim, recurring series, queue auto-confirm).
 *
 * Previously each path picked its own class (bookings used 1, queue used 2,
 * recurring/auto-confirm used none) which meant concurrent transactions on the
 * same asset did NOT serialise against each other and could both pass their
 * overlap check — producing a double booking. All booking-creating transactions
 * must take this one lock so they are mutually exclusive per asset.
 */
export const ASSET_BOOKING_LOCK_CLASS = 4242

/**
 * Separate lock class for queue-position bookkeeping (counting WAITING entries
 * to assign the next position). This is intentionally distinct from the booking
 * lock: joining a queue does not create a booking, so it need not contend with
 * booking creation.
 */
export const ASSET_QUEUE_LOCK_CLASS = 4243

/** Acquire the per-asset advisory lock that serialises booking creation. */
export async function lockAssetForBooking(tx: Prisma.TransactionClient, assetId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ASSET_BOOKING_LOCK_CLASS}, hashtext(${assetId}))`
}

/** Acquire the per-asset advisory lock that serialises queue-position assignment. */
export async function lockAssetForQueue(tx: Prisma.TransactionClient, assetId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ASSET_QUEUE_LOCK_CLASS}, hashtext(${assetId}))`
}

/** True when a CONFIRMED booking already overlaps [startsAt, endsAt) for the asset. */
export async function hasConfirmedOverlap(
  client: Prisma.TransactionClient,
  assetId: string,
  startsAt: Date,
  endsAt: Date,
  excludeBookingId?: string,
): Promise<boolean> {
  const conflict = await client.booking.findFirst({
    where: {
      assetId,
      status: 'CONFIRMED',
      id: excludeBookingId ? { not: excludeBookingId } : undefined,
      startsAt: { lt: endsAt },
      endsAt: { gt: startsAt },
    },
    select: { id: true },
  })
  return conflict !== null
}

/**
 * Detect the Postgres exclusion-constraint violation raised by the
 * `booking_no_overlap` constraint (error code 23P01). This is the durable
 * backstop against double bookings: even if a code path forgets the advisory
 * lock, the database itself refuses overlapping CONFIRMED rows.
 */
export function isOverlapConstraintViolation(err: unknown): boolean {
  const e = err as { code?: string; meta?: { code?: string; message?: string }; message?: string }
  if (e?.code === '23P01' || e?.meta?.code === '23P01') return true
  const msg = e?.message ?? e?.meta?.message
  return typeof msg === 'string' && msg.includes('booking_no_overlap')
}

export type BookabilityResult =
  | { ok: true }
  | { ok: false; status: number; code: string; message: string }

function deny(status: number, code: string, message: string): BookabilityResult {
  return { ok: false, status, code, message }
}

/**
 * Central authorization gate for booking an asset. Every booking-creating path
 * (direct, queue join, queue claim, recurring) must funnel through this so the
 * bookable / disabled / restricted-allow-list / assigned / group-access rules
 * are enforced consistently. Previously these checks were copy-pasted per route
 * and had drifted — notably the queue path skipped the restricted/assigned gates
 * entirely, letting users obtain bookings they were not permitted to make.
 *
 * Note: this does NOT check time-slot overlap (use hasConfirmedOverlap for that)
 * because the queue-join path intentionally targets currently-booked slots.
 */
export async function assertBookable(
  client: Prisma.TransactionClient,
  user: Pick<User, 'id' | 'globalRole'>,
  assetId: string,
  startsAt: Date,
  endsAt: Date,
): Promise<BookabilityResult> {
  const asset = await client.asset.findUnique({
    where: { id: assetId },
    include: {
      allowList: { select: { userId: true } },
      userAssignments: { select: { userId: true } },
      floor: { select: { id: true, buildingId: true } },
    },
  })

  if (!asset) return deny(404, 'NOT_FOUND', 'Asset not found')
  if (!asset.isBookable) return deny(409, 'ASSET_NOT_BOOKABLE', 'Asset is not bookable')
  if (asset.bookingStatus === 'DISABLED') return deny(409, 'ASSET_DISABLED', 'Asset is disabled')

  const isSuperAdmin = user.globalRole === GlobalRole.SUPER_ADMIN

  if (asset.bookingStatus === 'RESTRICTED' && !isSuperAdmin) {
    const onList = asset.allowList.some((e) => e.userId === user.id)
    const isAssigned = asset.userAssignments.some((ua) => ua.userId === user.id)
    if (!onList && !isAssigned) {
      return deny(403, 'NOT_ON_ALLOW_LIST', 'You are not on the allow list for this asset')
    }
  }

  if (asset.bookingStatus === 'ASSIGNED' && !isSuperAdmin) {
    const isAssignedUser = asset.userAssignments.some((ua) => ua.userId === user.id)
    if (!isAssignedUser) {
      const window = await client.assetAvailabilityWindow.findFirst({
        where: { assetId, startsAt: { lte: startsAt }, endsAt: { gte: endsAt } },
      })
      if (!window) {
        return deny(403, 'ASSET_ASSIGNED', 'This asset is permanently assigned to another user')
      }
    }
  }

  if (!isSuperAdmin && asset.floor) {
    const allowed = await checkGroupAccess(user.id, asset.floor.buildingId, asset.floor.id)
    if (!allowed) {
      return deny(403, 'GROUP_ACCESS_DENIED', 'Your group does not have access to this building or floor')
    }
  }

  return { ok: true }
}
