import { prisma } from './prisma.js'
import { NotificationType } from '@roomer/shared'
import { lockAssetForBooking, hasBlockingOverlap } from './booking.js'
import { resolveBuildingTimezone, zonedWallClockToUtc } from './timezone.js'
import { checkGroupAccess } from '../routes/groups.js'
import { enqueueNotification, promoteNextQueueEntry, fanOutFloorAvailable, getBoss } from './queue.js'
import { dispatchWebhook } from './webhook.js'
import { recordAuditLog } from './audit.js'

/**
 * The asset pool a Ballot draws from: every bookable, currently-open asset
 * on any of its scoped floors, plus every floor of any of its scoped
 * buildings, optionally narrowed by assetCategoryIds. Deliberately scoped to
 * bookingStatus 'OPEN' only — RESTRICTED (allow-list gated) and ASSIGNED
 * assets are excluded outright rather than trying to respect their
 * per-user rules in a blind random draw, and DISABLED is never bookable
 * anyway. This is exactly the "assets that can't be assigned in the ballot"
 * exclusion the feature was asked for.
 */
export async function resolveBallotAssetPool(ballot: {
  buildingIds: string[]
  floorIds: string[]
  assetCategoryIds: string[]
}): Promise<Array<{ id: string; floorId: string; buildingId: string }>> {
  if (ballot.buildingIds.length === 0 && ballot.floorIds.length === 0) return []

  const assets = await prisma.asset.findMany({
    where: {
      isBookable: true,
      bookingStatus: 'OPEN',
      ...(ballot.assetCategoryIds.length > 0 ? { categoryId: { in: ballot.assetCategoryIds } } : {}),
      floor: {
        OR: [
          ...(ballot.floorIds.length > 0 ? [{ id: { in: ballot.floorIds } }] : []),
          ...(ballot.buildingIds.length > 0 ? [{ buildingId: { in: ballot.buildingIds } }] : []),
        ],
      },
    },
    select: { id: true, floorId: true, floor: { select: { buildingId: true } } },
  })

  return assets
    .filter((a): a is typeof a & { floorId: string } => !!a.floorId)
    .map((a) => ({ id: a.id, floorId: a.floorId!, buildingId: a.floor!.buildingId }))
}

/** Fisher-Yates shuffle — not cryptographically secure, which a fairness lottery doesn't need. */
function shuffle<T>(items: T[]): T[] {
  const arr = [...items]
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return arr
}

/** Extracts the UTC calendar-date components stored in a "date-only" DateTime column (see BallotRun.slotStartsAt/EndsAt). */
function dateParts(d: Date): { year: number; month: number; day: number } {
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() }
}

/** Resolves a BallotRun's slot into the real UTC instant for one specific asset, timezone-aware (see #72). */
async function resolveSlotInstants(
  run: { slotStartsAt: Date; slotEndsAt: Date },
  ballot: { slotStartTime: string; slotEndTime: string },
  buildingId: string,
): Promise<{ startsAt: Date; endsAt: Date }> {
  const timeZone = await resolveBuildingTimezone(prisma, buildingId)
  const [startH, startM] = ballot.slotStartTime.split(':').map(Number)
  const [endH, endM] = ballot.slotEndTime.split(':').map(Number)
  const startParts = dateParts(run.slotStartsAt)
  const endParts = dateParts(run.slotEndsAt)
  return {
    startsAt: zonedWallClockToUtc(startParts.year, startParts.month, startParts.day, startH, startM, timeZone),
    endsAt: zonedWallClockToUtc(endParts.year, endParts.month, endParts.day, endH, endM, timeZone),
  }
}

/**
 * Attempts to assign `userId` the given asset for the run's slot, creating a
 * real CONFIRMED booking through the same advisory-locked, overlap-checked
 * path every other booking-creating flow uses — a ballot can never
 * double-book. Bypasses the approval workflow (#74), booking quota, and
 * working-hours enforcement entirely: the draw itself is the decision, not
 * a request subject to further gating (see #159's confirmed design).
 * Returns the created booking id, or null if the asset turned out to
 * already be taken (a real race against ordinary booking activity — the
 * caller should try the next asset in the pool for this user).
 */
async function tryAssign(
  userId: string,
  asset: { id: string; floorId: string; buildingId: string },
  run: { slotStartsAt: Date; slotEndsAt: Date },
  ballot: { slotStartTime: string; slotEndTime: string },
): Promise<{ bookingId: string; startsAt: Date; endsAt: Date } | null> {
  const { startsAt, endsAt } = await resolveSlotInstants(run, ballot, asset.buildingId)

  try {
    const booking = await prisma.$transaction(async (tx) => {
      await lockAssetForBooking(tx, asset.id)
      if (await hasBlockingOverlap(tx, asset.id, startsAt, endsAt)) return null
      return tx.booking.create({
        data: { userId, assetId: asset.id, startsAt, endsAt, status: 'CONFIRMED' },
      })
    })
    if (!booking) return null
    return { bookingId: booking.id, startsAt, endsAt }
  } catch {
    // Database-level backstop (booking_no_overlap) — same as any other
    // booking-creating path, treat as "this asset just became unavailable".
    return null
  }
}

/**
 * Runs the draw for one BallotRun: every ENTERED entry is matched, in
 * random order, against the ballot's asset pool (also access-rechecked —
 * time may have passed since the user entered). Winners get a real
 * CONFIRMED booking + BALLOT_WON notification; everyone left over is marked
 * LOST and notified so they know to fall back to normal booking/queueing.
 * Safe to call more than once for the same run (only OPEN runs are drawn;
 * calling it again on an already-DRAWN run is a no-op).
 */
export async function runDrawForRun(runId: string, actorId: string | null = null): Promise<void> {
  const run = await prisma.ballotRun.findUnique({
    where: { id: runId },
    include: { ballot: true, entries: { where: { status: 'ENTERED' } } },
  })
  if (!run || run.status !== 'OPEN') return

  // Mark DRAWN up front (not at the end) so a slow draw with many entrants
  // can't be picked up by a second concurrent cron tick — findMany-then-
  // updateMany would leave a window where both ticks see status: 'OPEN'.
  const claimed = await prisma.ballotRun.updateMany({
    where: { id: runId, status: 'OPEN' },
    data: { status: 'DRAWN', drawnAt: new Date() },
  })
  if (claimed.count === 0) return

  const pool = await resolveBallotAssetPool(run.ballot)
  // Mutable — assets are only ever spliced out when genuinely gone (won by
  // someone, or raced away by ordinary booking activity), never just because
  // one entrant lacked access to them. A shared read cursor that only ever
  // advanced would permanently discard an asset the moment any entrant
  // skipped it for lacking access, denying it to every later entrant even
  // though it was never actually assigned to anyone.
  const availableAssets = shuffle(pool)
  const shuffledEntries = shuffle(run.entries)

  let wonCount = 0
  let lostCount = 0
  for (const entry of shuffledEntries) {
    // Re-check access — the user's group/role access may have changed
    // between entering and the draw closing.
    let assigned: { bookingId: string; startsAt: Date; endsAt: Date } | null = null
    for (let i = 0; i < availableAssets.length; i++) {
      const candidate = availableAssets[i]
      const hasAccess = await checkGroupAccess(entry.userId, candidate.buildingId, candidate.floorId)
      if (!hasAccess) continue
      const result = await tryAssign(entry.userId, candidate, run, run.ballot)
      if (result) {
        assigned = result
        availableAssets.splice(i, 1)
        await prisma.ballotEntry.update({
          where: { id: entry.id },
          data: { status: 'WON', assetId: candidate.id, bookingId: result.bookingId },
        })
        dispatchWebhook('booking.created', { id: result.bookingId, userId: entry.userId, assetId: candidate.id, startsAt: result.startsAt, endsAt: result.endsAt }).catch(() => {})
        await enqueueNotification({ type: NotificationType.BALLOT_WON, userId: entry.userId, ballotEntryId: entry.id })
        wonCount++
        break
      }
      // Asset was taken by something else in the meantime — remove it for
      // everyone (it's genuinely gone), then re-check this same index (now
      // the next candidate) before moving on.
      availableAssets.splice(i, 1)
      i--
    }
    if (!assigned) {
      await prisma.ballotEntry.update({ where: { id: entry.id }, data: { status: 'LOST' } })
      await enqueueNotification({ type: NotificationType.BALLOT_LOST, userId: entry.userId, ballotEntryId: entry.id })
      lostCount++
    }
  }

  // One summary row for the whole draw, not one per entrant — actorId is
  // null when the hourly cron (handleBallotDraw) triggers this, or the
  // admin's own id when a manual force-draw (POST /runs/:runId/draw) does.
  await recordAuditLog(prisma, {
    actorId,
    action: 'ballot_run.drawn',
    resourceType: 'BallotRun',
    resourceId: runId,
    before: { status: 'OPEN' },
    after: { status: 'DRAWN', entrants: shuffledEntries.length, wonCount, lostCount },
  })

  process.stdout.write(JSON.stringify({ level: 'info', msg: '[ballot] Drew run', runId, entrants: shuffledEntries.length }) + '\n')
}

/**
 * Declines a WON entry: releases its booking (same cancel + queue-promote +
 * floor-fanout steps as any other booking cancellation) and, per #159's
 * confirmed design, re-draws the freed asset among that run's LOST entries
 * rather than just releasing it — a mini re-draw scoped to the existing
 * entrant pool, not a fresh registration window. If no LOST entries remain
 * (or none can actually take it), the asset is simply released to normal
 * booking/queueing, same as any other cancellation.
 */
export async function declineBallotEntry(entryId: string, userId: string): Promise<
  | { ok: true }
  | { ok: false; status: number; code: string; message: string }
> {
  const entry = await prisma.ballotEntry.findUnique({
    where: { id: entryId },
    include: { booking: true, run: { include: { ballot: true } } },
  })
  if (!entry) return { ok: false, status: 404, code: 'NOT_FOUND', message: 'Entry not found' }
  if (entry.userId !== userId) return { ok: false, status: 403, code: 'FORBIDDEN', message: 'Not your entry' }
  if (entry.status !== 'WON' || !entry.booking || !entry.assetId) {
    return { ok: false, status: 409, code: 'NOT_WON', message: 'This entry has no active assignment to decline' }
  }

  const booking = entry.booking
  const assetId = entry.assetId

  await prisma.$transaction([
    prisma.booking.update({ where: { id: booking.id }, data: { status: 'CANCELLED' } }),
    prisma.ballotEntry.update({ where: { id: entry.id }, data: { status: 'DECLINED' } }),
  ])
  dispatchWebhook('booking.cancelled', { id: booking.id, userId: entry.userId, assetId }).catch(() => {})
  await recordAuditLog(prisma, {
    actorId: userId,
    action: 'ballot_entry.declined',
    resourceType: 'BallotEntry',
    resourceId: entryId,
    before: { status: 'WON', assetId, bookingId: booking.id },
    after: { status: 'DECLINED' },
  })

  // Re-draw among this run's LOST entries for the freed asset.
  const losers = shuffle(
    await prisma.ballotEntry.findMany({ where: { runId: entry.runId, status: 'LOST' } }),
  )
  const asset = await prisma.asset.findUnique({ where: { id: assetId }, select: { id: true, floorId: true, floor: { select: { buildingId: true } } } })

  let redrawn = false
  if (asset?.floorId && asset.floor) {
    for (const loser of losers) {
      const hasAccess = await checkGroupAccess(loser.userId, asset.floor.buildingId, asset.floorId)
      if (!hasAccess) continue
      const result = await tryAssign(
        loser.userId,
        { id: asset.id, floorId: asset.floorId, buildingId: asset.floor.buildingId },
        entry.run,
        entry.run.ballot,
      )
      if (result) {
        // Atomically claim this loser's entry (LOST -> WON) rather than an
        // unconditional update — two declines on the same run racing to
        // re-draw could otherwise both pick the same LOST user for their
        // own (different) freed asset, since ballotEntry is unique per
        // (runId, userId): the second update would silently overwrite the
        // first, leaving that user with two real overlapping bookings but
        // only one of them reflected in their ballot entry. The `count`
        // check below means only the decline that gets here first for this
        // specific loser actually wins the claim; the other continues to
        // its next candidate.
        const claimed = await prisma.ballotEntry.updateMany({
          where: { id: loser.id, status: 'LOST' },
          data: { status: 'WON', assetId: asset.id, bookingId: result.bookingId },
        })
        if (claimed.count === 0) {
          // Lost the race for this candidate — the booking we just created
          // for them is now orphaned from ballot bookkeeping; cancel it
          // and fall through to try the next loser instead of leaving a
          // stray confirmed booking nobody's entry points to.
          await prisma.booking.update({ where: { id: result.bookingId }, data: { status: 'CANCELLED' } })
          continue
        }
        dispatchWebhook('booking.created', { id: result.bookingId, userId: loser.userId, assetId: asset.id, startsAt: result.startsAt, endsAt: result.endsAt }).catch(() => {})
        await enqueueNotification({ type: NotificationType.BALLOT_WON, userId: loser.userId, ballotEntryId: loser.id })
        redrawn = true
        break
      }
    }
  }

  if (!redrawn) {
    // Nobody left to re-draw to (or the asset genuinely can't be
    // reassigned) — release it the same way any other cancellation does.
    const nextQueued = await promoteNextQueueEntry(assetId, booking.startsAt, booking.endsAt)
    if (nextQueued) {
      await enqueueNotification({
        type: NotificationType.QUEUE_PROMOTED,
        userId: nextQueued.userId,
        queueEntryId: nextQueued.id,
        claimDeadline: nextQueued.claimDeadline.toISOString(),
      })
      dispatchWebhook('queue.promoted', { id: nextQueued.id, userId: nextQueued.userId, assetId: nextQueued.assetId, claimDeadline: nextQueued.claimDeadline.toISOString() }).catch(() => {})
    }
    if (asset?.floorId) {
      const slotDate = booking.startsAt.toISOString().slice(0, 10)
      await fanOutFloorAvailable(assetId, asset.floorId, null, slotDate, entry.userId).catch(() => {})
    }
  }

  return { ok: true }
}

/**
 * Computes the next scheduled draw date (UTC midnight, calendar-only — see
 * BallotRun.slotStartsAt's convention) for a recurring ballot, strictly
 * after `after`. Interpreted in the org's default timezone (see #72) —
 * a ballot can span multiple buildings with different timezones, so there
 * is no single "the" building to anchor the schedule itself to; only each
 * winner's actual booking instant is building-timezone-specific.
 */
function computeNextRunDate(
  frequency: 'WEEKLY' | 'MONTHLY',
  dayOfWeek: number | null,
  dayOfMonth: number | null,
  after: Date,
): Date {
  const cursor = new Date(Date.UTC(after.getUTCFullYear(), after.getUTCMonth(), after.getUTCDate()))
  cursor.setUTCDate(cursor.getUTCDate() + 1)
  if (frequency === 'WEEKLY') {
    while (cursor.getUTCDay() !== dayOfWeek) cursor.setUTCDate(cursor.getUTCDate() + 1)
    return cursor
  }
  // MONTHLY — dayOfMonth is capped at 28 (see createBallotSchema) so it
  // always exists in every month, no clamping needed.
  if (cursor.getUTCDate() > (dayOfMonth ?? 1)) {
    cursor.setUTCMonth(cursor.getUTCMonth() + 1)
  }
  cursor.setUTCDate(dayOfMonth ?? 1)
  return cursor
}

/** Builds the slotStartsAt/slotEndsAt (date-only) pair for a run whose draw lands on `drawDate`. */
function computeSlotDates(ballot: { slotLeadDays: number; slotDurationDays: number }, drawDate: Date): { slotStartsAt: Date; slotEndsAt: Date } {
  const slotStartsAt = new Date(drawDate)
  slotStartsAt.setUTCDate(slotStartsAt.getUTCDate() + ballot.slotLeadDays)
  const slotEndsAt = new Date(slotStartsAt)
  slotEndsAt.setUTCDate(slotEndsAt.getUTCDate() + ballot.slotDurationDays - 1)
  return { slotStartsAt, slotEndsAt }
}

/**
 * Creates the immediate single run for a ONCE ballot, or (called from the
 * ballot-open-registration cron) the next run for a recurring one, if it's
 * time to open registration and no run for that cycle exists yet. Returns
 * whether a run was actually created, so callers that need to distinguish
 * "created" from "nothing to do" (the manual admin trigger — see
 * routes/ballots.ts) don't have to re-derive it themselves.
 *
 * `force` (only ever passed true by the manual admin trigger, never by the
 * cron) bypasses the registration-open-time gate for a recurring ballot,
 * opening registration immediately regardless of the configured schedule —
 * without it, the gate meant the admin "open run now" action silently
 * no-op'd whenever it wasn't yet the scheduled time, while still reporting
 * success back to the caller.
 */
export async function ensureNextBallotRun(ballotId: string, options: { force?: boolean; actorId?: string | null } = {}): Promise<boolean> {
  // Lock the parent Ballot row for the whole check-then-create sequence
  // below. Without this, two concurrent calls for the same ballot (the
  // hourly cron racing a manual admin "open run now" trigger, or two
  // overlapping cron ticks) can both pass the "no existing run for this
  // cycle" check and each create their own BallotRun — BallotRun has no
  // unique constraint on ballotId/registrationClosesAt to catch that at the
  // DB level, and BallotEntry is only unique per (runId, userId), so the
  // same user could then enter and win a desk in both duplicate runs.
  return prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Ballot" WHERE id = ${ballotId} FOR UPDATE`
    if (locked.length === 0) return false

    const ballot = await tx.ballot.findUnique({ where: { id: ballotId } })
    if (!ballot || ballot.status !== 'ACTIVE') return false

    const now = new Date()

    if (ballot.frequency === 'ONCE') {
      const existing = await tx.ballotRun.findFirst({ where: { ballotId } })
      if (existing) return false
      // ONCE ballots draw as soon as their registration window elapses from
      // creation — no weekday/day-of-month schedule involved.
      const registrationClosesAt = new Date(now.getTime() + ballot.registrationWindowHours * 60 * 60 * 1000)
      const drawDateOnly = new Date(Date.UTC(registrationClosesAt.getUTCFullYear(), registrationClosesAt.getUTCMonth(), registrationClosesAt.getUTCDate()))
      const { slotStartsAt, slotEndsAt } = computeSlotDates(ballot, drawDateOnly)
      const run = await tx.ballotRun.create({
        data: {
          ballotId,
          registrationOpensAt: now,
          registrationClosesAt,
          slotStartsAt,
          slotEndsAt,
        },
      })
      await recordAuditLog(tx, {
        actorId: options.actorId ?? null,
        action: 'ballot_run.opened',
        resourceType: 'BallotRun',
        resourceId: run.id,
        after: { ballotId, registrationOpensAt: run.registrationOpensAt, registrationClosesAt: run.registrationClosesAt },
      })
      return true
    }

    const nextDrawDate = computeNextRunDate(ballot.frequency, ballot.dayOfWeek, ballot.dayOfMonth, now)
    const registrationOpensAt = new Date(nextDrawDate.getTime() - ballot.registrationWindowHours * 60 * 60 * 1000)
    if (!options.force && registrationOpensAt > now) return false // not yet time to open this cycle's registration

    const alreadyExists = await tx.ballotRun.findFirst({
      where: { ballotId, registrationClosesAt: nextDrawDate, status: { not: 'CANCELLED' } },
    })
    if (alreadyExists) return false

    const { slotStartsAt, slotEndsAt } = computeSlotDates(ballot, nextDrawDate)
    const run = await tx.ballotRun.create({
      data: {
        ballotId,
        // The computed value, not `now` — when registrationWindowHours is
        // longer than the gap between recurrence cycles (e.g. a 10-day
        // window on a weekly ballot), this cron (hourly) may not notice the
        // cycle is due until sometime after the window was actually meant to
        // open. Recording the intended open time here keeps the run's stated
        // window honest even though the hourly cron granularity means
        // entrants might see it announced a bit later than that. When forced
        // open early by an admin, `now` IS the actual open time — there's no
        // "intended" time to honour instead, the admin's action is the intent.
        registrationOpensAt: options.force && registrationOpensAt > now ? now : registrationOpensAt,
        registrationClosesAt: nextDrawDate,
        slotStartsAt,
        slotEndsAt,
      },
    })
    await recordAuditLog(tx, {
      actorId: options.actorId ?? null,
      action: 'ballot_run.opened',
      resourceType: 'BallotRun',
      resourceId: run.id,
      after: { ballotId, registrationOpensAt: run.registrationOpensAt, registrationClosesAt: run.registrationClosesAt, forced: options.force ?? false },
    })
    return true
  })
}

/** Cron: for every ACTIVE ballot, spawn its next run if one isn't already open/pending. */
export async function handleBallotOpenRegistration(): Promise<void> {
  const ballots = await prisma.ballot.findMany({ where: { status: 'ACTIVE' }, select: { id: true } })
  for (const b of ballots) {
    await ensureNextBallotRun(b.id).catch((err) => {
      process.stderr.write(JSON.stringify({ level: 'error', msg: '[ballot] Failed to ensure next run', ballotId: b.id, err: String(err) }) + '\n')
    })
  }
}

/** Cron: draw every run whose registration has closed. */
export async function handleBallotDraw(): Promise<void> {
  const dueRuns = await prisma.ballotRun.findMany({
    where: { status: 'OPEN', registrationClosesAt: { lte: new Date() } },
    select: { id: true },
  })
  for (const run of dueRuns) {
    await runDrawForRun(run.id).catch((err) => {
      process.stderr.write(JSON.stringify({ level: 'error', msg: '[ballot] Failed to draw run', runId: run.id, err: String(err) }) + '\n')
    })
  }
}

// Re-exported so routes/ballots.ts doesn't need its own pg-boss handle for the manual-trigger endpoints.
export { getBoss }
