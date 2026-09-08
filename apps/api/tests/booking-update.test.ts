import assert from 'node:assert/strict'
import test from 'node:test'
import type { Booking, Prisma } from '@prisma/client'
import { BookingConflictError, updateUnchangedBooking } from '../src/lib/booking-update.js'

const snapshot = {
  id: 'booking-1',
  userId: 'user-1',
  assetId: 'asset-1',
  status: 'CONFIRMED',
  startsAt: new Date('2030-01-01T09:00:00Z'),
  endsAt: new Date('2030-01-01T17:00:00Z'),
  notes: null,
  attendeeCount: null,
  reminderSentAt: null,
  checkedInAt: null,
  noShow: false,
  icsSequence: 0,
  recurringRuleId: null,
  approvalExpiresAt: null,
  approvedAt: null,
  approvedByUserId: null,
  rejectionNote: null,
  guestName: null,
  guestEmail: null,
  guestCheckInToken: null,
  createdAt: new Date('2029-01-01T00:00:00Z'),
  updatedAt: new Date('2029-01-01T00:00:00Z'),
} satisfies Booking

test('rejects an edit when the booking changed after it was read', async () => {
  const tx = {
    booking: {
      updateMany: async () => ({ count: 0 }),
      findUniqueOrThrow: async () => assert.fail('must not read after losing the compare-and-set'),
    },
  } as unknown as Prisma.TransactionClient

  await assert.rejects(
    updateUnchangedBooking(tx, snapshot, { data: { notes: 'new note' }, omit: { guestCheckInToken: true } }),
    (error: unknown) => error instanceof BookingConflictError && error.code === 'BOOKING_CHANGED',
  )
})

test('returns the updated row after winning the compare-and-set', async () => {
  const updated = { ...snapshot, notes: 'new note' }
  const tx = {
    booking: {
      updateMany: async () => ({ count: 1 }),
      findUniqueOrThrow: async () => updated,
    },
  } as unknown as Prisma.TransactionClient

  assert.equal(
    (await updateUnchangedBooking(tx, snapshot, { data: { notes: 'new note' }, omit: { guestCheckInToken: true } })).notes,
    'new note',
  )
})
