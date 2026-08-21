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

/**
 * Separate lock class for per-user booking-quota enforcement. ASSET_BOOKING_LOCK_CLASS
 * only serialises requests for the SAME asset — two concurrent bookings by the
 * same user on two DIFFERENT assets don't contend on it at all, so both could
 * pass assertUnderBookingQuota's pre-transaction count before either commits
 * and exceed maxBookingsPerUser. This lock is keyed on userId instead of
 * assetId so any two booking-creating transactions for the same user
 * serialise against each other regardless of which asset each targets.
 *
 * pg_advisory_xact_lock's classid is a single global namespace (not scoped
 * per-file/module), so every advisory lock class in the codebase must be a
 * distinct integer — 4244 is FLOOR_NOTIFICATION_LOCK_CLASS in lib/queue.ts;
 * check there before adding another one here.
 */
export const USER_BOOKING_QUOTA_LOCK_CLASS = 4245

/** Acquire the per-asset advisory lock that serialises booking creation. */
export async function lockAssetForBooking(tx: Prisma.TransactionClient, assetId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ASSET_BOOKING_LOCK_CLASS}, hashtext(${assetId}))`
}

/** Acquire the per-asset advisory lock that serialises queue-position assignment. */
export async function lockAssetForQueue(tx: Prisma.TransactionClient, assetId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ASSET_QUEUE_LOCK_CLASS}, hashtext(${assetId}))`
}

/** Acquire the per-user advisory lock that serialises booking-quota enforcement. */
export async function lockUserForBookingQuota(tx: Prisma.TransactionClient, userId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${USER_BOOKING_QUOTA_LOCK_CLASS}, hashtext(${userId}))`
}

/**
 * True when a CONFIRMED or PENDING_APPROVAL booking already overlaps
 * [startsAt, endsAt) for the asset. PENDING_APPROVAL reserves the slot the
 * same as CONFIRMED (approval workflow, #74) — an approver may still reject
 * it, but until they do, it blocks the same as a confirmed booking so a
 * second person can't book over a request that's simply awaiting sign-off.
 */
export async function hasBlockingOverlap(
  client: Prisma.TransactionClient,
  assetId: string,
  startsAt: Date,
  endsAt: Date,
  excludeBookingId?: string,
): Promise<boolean> {
  const conflict = await client.booking.findFirst({
    where: {
      assetId,
      status: { in: ['CONFIRMED', 'PENDING_APPROVAL'] },
      id: excludeBookingId ? { not: excludeBookingId } : undefined,
      startsAt: { lt: endsAt },
      endsAt: { gt: startsAt },
    },
    select: { id: true },
  })
  return conflict !== null
}

/**
 * True when this user already holds a CONFIRMED booking overlapping
 * [startsAt, endsAt) somewhere else in the same ZoneGroup as `assetId`.
 * Scoped to this one user, not a cross-user "booking Zone A blocks Zone B for
 * everyone" rule — a ZoneGroup exists to stop one person double-booking
 * across zones meant to be mutually exclusive for them (e.g. a hot-desk zone
 * and its adjacent phone-booth zone), not to reserve zone capacity globally.
 *
 * Must be called under lockUserForBookingQuota (or an equivalent per-user
 * lock) for the check to actually serialise against a concurrent request —
 * see callers.
 */
export async function checkZoneGroupOverlap(
  tx: Prisma.TransactionClient,
  userId: string,
  assetId: string,
  startsAt: Date,
  endsAt: Date,
  excludeBookingId?: string,
): Promise<boolean> {
  const asset = await tx.asset.findUnique({
    where: { id: assetId },
    select: {
      primaryZoneId: true,
      primaryZone: { select: { zoneGroupId: true } },
    },
  })

  const zoneGroupId = asset?.primaryZone?.zoneGroupId
  if (!zoneGroupId) return false

  const conflict = await tx.booking.findFirst({
    where: {
      userId,
      status: { in: ['CONFIRMED', 'PENDING_APPROVAL'] },
      id: excludeBookingId ? { not: excludeBookingId } : undefined,
      startsAt: { lt: endsAt },
      endsAt: { gt: startsAt },
      asset: {
        primaryZone: { zoneGroupId },
      },
    },
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

/**
 * Resolve whether a new booking on this asset requires approval before it's
 * confirmed: zone override → building override → org default. Zone is the
 * most granular level here (unlike QR check-in mode or no-show release,
 * which stop at floor) since approval is naturally a per-team/per-room
 * policy rather than a per-floor one — see #74's feasibility assessment.
 */
export async function resolveRequiresApproval(client: Prisma.TransactionClient, assetId: string): Promise<boolean> {
  const asset = await client.asset.findUnique({
    where: { id: assetId },
    select: {
      primaryZone: { select: { requiresApproval: true } },
      floor: {
        select: {
          building: {
            select: {
              requiresApproval: true,
              organisation: { select: { requiresApproval: true } },
            },
          },
        },
      },
    },
  })
  if (!asset) return false
  return (
    asset.primaryZone?.requiresApproval ??
    asset.floor?.building?.requiresApproval ??
    asset.floor?.building?.organisation?.requiresApproval ??
    false
  )
}

export type BookabilityResult =
  | { ok: true }
  | { ok: false; status: number; code: string; message: string }

function deny(status: number, code: string, message: string): BookabilityResult {
  return { ok: false, status, code, message }
}

/**
 * True when `startsAt` falls within the org's configured maxAdvanceBookingDays
 * window (or the org has no such cap). Applied to the moment a new booking
 * commitment is created — a direct booking, a reschedule, or the *start* of a
 * recurring series — not to every individual queue-claim, since a claimed slot
 * is bounded by a booking that already passed this check, and not to every
 * occurrence within an already-approved recurring series, which is governed by
 * its own maxRecurringBookingWeeks span instead.
 */
export function isWithinAdvanceBookingWindow(startsAt: Date, maxAdvanceBookingDays: number | null | undefined): boolean {
  if (!maxAdvanceBookingDays) return true
  const maxDate = new Date()
  maxDate.setUTCDate(maxDate.getUTCDate() + maxAdvanceBookingDays)
  return startsAt <= maxDate
}

/**
 * Rejects a booking whose end has already elapsed — checked on `endsAt`
 * rather than `startsAt` so the everyday "book today, full day" flow (whose
 * default start is today's midnight, already in the past by the time the
 * request lands) keeps working; only a slot that's entirely over by the time
 * it would be created is nonsensical. Recurring series creation has its own
 * equivalent firstDate-in-the-future check in recurring.ts.
 */
export function isNotAlreadyElapsed(endsAt: Date): boolean {
  return endsAt > new Date()
}

/**
 * Rejects a new ad-hoc booking once the user already holds
 * maxBookingsPerUser confirmed, not-yet-ended bookings. Checked at the moment
 * a single Booking row is about to be created (direct booking, queue claim) —
 * deliberately NOT applied to recurring series creation, which would make the
 * default 12-week/5-booking combination reject nearly every series outright;
 * recurring commitments are governed by maxRecurringBookingWeeks instead.
 */
export async function assertUnderBookingQuota(
  client: Prisma.TransactionClient,
  userId: string,
  isSuperAdmin: boolean,
): Promise<BookabilityResult> {
  if (isSuperAdmin) return { ok: true }
  const org = await client.organisation.findFirst({ select: { maxBookingsPerUser: true } })
  if (!org?.maxBookingsPerUser) return { ok: true }
  const activeCount = await client.booking.count({
    where: { userId, status: { in: ['CONFIRMED', 'PENDING_APPROVAL'] }, endsAt: { gt: new Date() } },
  })
  if (activeCount >= org.maxBookingsPerUser) {
    return deny(409, 'MAX_BOOKINGS_EXCEEDED', `You already have ${org.maxBookingsPerUser} active bookings, the maximum allowed`)
  }
  return { ok: true }
}

/**
 * Central authorization gate for booking an asset. Every booking-creating path
 * (direct, queue join, queue claim, recurring) must funnel through this so the
 * bookable / disabled / restricted-allow-list / assigned / group-access rules
 * are enforced consistently. Previously these checks were copy-pasted per route
 * and had drifted — notably the queue path skipped the restricted/assigned gates
 * entirely, letting users obtain bookings they were not permitted to make.
 *
 * Note: this does NOT check time-slot overlap (use hasBlockingOverlap for that)
 * because the queue-join path intentionally targets currently-booked slots.
 */
/**
 * True when every UTC calendar day the [startsAt, endsAt] booking spans falls on
 * a weekday the assigned owner has marked as recurringly available. Returns false
 * when there are no rules. (Single-timezone; per-building tz is tracked in #72.)
 */
async function isCoveredByAvailabilityRules(
  client: Prisma.TransactionClient,
  assetId: string,
  startsAt: Date,
  endsAt: Date,
): Promise<boolean> {
  const rules = await client.assetAvailabilityRule.findMany({ where: { assetId }, select: { weekday: true } })
  if (rules.length === 0) return false
  const allowed = new Set(rules.map((r) => r.weekday))

  // Walk each calendar day from the start day up to (but not past) the end instant.
  // Strict `<` matches the half-open [startsAt, endsAt) semantics used everywhere
  // else in this file (see hasBlockingOverlap) — a booking whose endsAt lands
  // exactly on a day's UTC midnight boundary uses none of that day's time, so it
  // must not require that day to be in the owner's allowed-weekday set too.
  const cursor = new Date(Date.UTC(startsAt.getUTCFullYear(), startsAt.getUTCMonth(), startsAt.getUTCDate()))
  while (cursor < endsAt) {
    if (!allowed.has(cursor.getUTCDay())) return false
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  return true
}

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
      // A non-assigned user may book if the owner has offered the desk for this
      // exact time via a one-off window, OR every calendar day the booking spans
      // falls on a weekday the owner has marked as recurringly available.
      const window = await client.assetAvailabilityWindow.findFirst({
        where: { assetId, startsAt: { lte: startsAt }, endsAt: { gte: endsAt } },
      })
      if (!window && !(await isCoveredByAvailabilityRules(client, assetId, startsAt, endsAt))) {
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
