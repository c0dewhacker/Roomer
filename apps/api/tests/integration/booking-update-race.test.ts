import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { Pool } from 'pg'
import { BookingConflictError, updateUnchangedBooking } from '../../src/lib/booking-update.js'

const connectionString = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL
if (!connectionString) throw new Error('TEST_DATABASE_URL or DATABASE_URL is required')

const pool = new Pool({ connectionString })
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) })

test.after(async () => {
  await prisma.$disconnect()
  await pool.end()
})

test('a stale editor cannot modify a booking after ownership changes', async () => {
  const suffix = randomUUID()
  const [owner, recipient, category] = await Promise.all([
    prisma.user.create({ data: { email: `owner-${suffix}@example.test`, displayName: 'Owner' } }),
    prisma.user.create({ data: { email: `recipient-${suffix}@example.test`, displayName: 'Recipient' } }),
    prisma.assetCategory.create({ data: { name: `Category ${suffix}` } }),
  ])
  const asset = await prisma.asset.create({
    data: {
      categoryId: category.id,
      name: `Desk ${suffix}`,
      status: 'AVAILABLE',
      isBookable: true,
      bookingStatus: 'OPEN',
      amenities: [],
    },
  })
  const booking = await prisma.booking.create({
    data: {
      userId: owner.id,
      assetId: asset.id,
      startsAt: new Date('2035-01-01T09:00:00Z'),
      endsAt: new Date('2035-01-01T17:00:00Z'),
    },
  })

  try {
    await prisma.booking.update({ where: { id: booking.id }, data: { userId: recipient.id } })

    await assert.rejects(
      prisma.$transaction((tx) => updateUnchangedBooking(
        tx,
        booking,
        { data: { notes: 'stale edit' }, omit: { guestCheckInToken: true } },
      )),
      (error: unknown) => error instanceof BookingConflictError && error.code === 'BOOKING_CHANGED',
    )

    const current = await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } })
    assert.equal(current.userId, recipient.id)
    assert.equal(current.notes, null)
  } finally {
    await prisma.booking.deleteMany({ where: { id: booking.id } })
    await prisma.asset.deleteMany({ where: { id: asset.id } })
    await prisma.assetCategory.deleteMany({ where: { id: category.id } })
    await prisma.user.deleteMany({ where: { id: { in: [owner.id, recipient.id] } } })
  }
})
