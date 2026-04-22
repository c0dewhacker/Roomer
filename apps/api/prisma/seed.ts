import { PrismaClient, BookableStatus, AssetStatus } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { Pool } from 'pg'
import bcryptjs from 'bcryptjs'

const pool = new Pool({ connectionString: process.env['DATABASE_URL'] })
const adapter = new PrismaPg(pool)
const prisma = new PrismaClient({ adapter })

// ─── Core seed (always runs) ──────────────────────────────────────────────────
// Creates the default organisation and super-admin account. Both are idempotent
// (upsert by stable slug/email) so re-running on an existing database is safe.

async function seedCore() {
  // Default organisation — needed for buildings/floors, also creates a sensible
  // default for single-tenant deployments.
  const org = await prisma.organisation.upsert({
    where: { slug: 'default' },
    update: {},
    create: {
      name: 'My Organisation',
      slug: 'default',
    },
  })
  console.log(`[seed] Organisation: ${org.name} (${org.id})`)

  // Super-admin — use SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD env vars.
  // If SEED_ADMIN_PASSWORD is unset a secure random password is generated and
  // printed once to stdout — there is no hardcoded default credential.
  const adminEmail = process.env['SEED_ADMIN_EMAIL'] ?? 'admin@roomer.local'
  const rawAdminPassword = process.env['SEED_ADMIN_PASSWORD'] ?? (() => {
    const generated = require('crypto').randomBytes(16).toString('hex')
    console.log(`[seed] SEED_ADMIN_PASSWORD not set — generated password: ${generated}`)
    return generated
  })()
  const adminHash = bcryptjs.hashSync(rawAdminPassword, 12)
  const admin = await prisma.user.upsert({
    where: { email: adminEmail },
    update: {},
    create: {
      email: adminEmail,
      displayName: 'Admin',
      passwordHash: adminHash,
      globalRole: 'SUPER_ADMIN',
      accountStatus: 'ACTIVE',
    },
  })
  console.log(`[seed] Admin: ${admin.email}`)

  return { org }
}

// ─── Demo seed (runs when SEED_DEMO_DATA=true) ────────────────────────────────
// Populates a realistic-looking workspace with one building, one floor, two
// zones, six desks and a regular test user. Useful for demos and development.

async function seedDemoData(orgId: string) {
  // Regular test user
  const rawUserPassword = process.env['SEED_USER_PASSWORD'] ?? (() => {
    const generated = require('crypto').randomBytes(16).toString('hex')
    console.log(`[seed] SEED_USER_PASSWORD not set — generated password: ${generated}`)
    return generated
  })()
  const userHash = bcryptjs.hashSync(rawUserPassword, 12)
  const regularUser = await prisma.user.upsert({
    where: { email: 'user@roomer.local' },
    update: {},
    create: {
      email: 'user@roomer.local',
      displayName: 'Test User',
      passwordHash: userHash,
      globalRole: 'USER',
      accountStatus: 'ACTIVE',
    },
  })
  console.log(`[seed] Test user: ${regularUser.email}`)

  // Update org to demo name
  await prisma.organisation.update({
    where: { id: orgId },
    data: { name: 'Acme Corp', slug: 'acme' },
  })

  const building = await prisma.building.upsert({
    where: { id: 'seed-building-001' },
    update: {},
    create: {
      id: 'seed-building-001',
      organisationId: orgId,
      name: 'Acme HQ',
      address: '1 Acme Street, London, EC1A 1BB',
    },
  })
  console.log(`[seed] Building: ${building.name}`)

  const floor = await prisma.floor.upsert({
    where: { id: 'seed-floor-001' },
    update: {},
    create: {
      id: 'seed-floor-001',
      buildingId: building.id,
      name: 'Ground Floor',
      level: 0,
    },
  })

  const zoneGroup = await prisma.zoneGroup.upsert({
    where: { id: 'seed-zone-group-001' },
    update: {},
    create: { id: 'seed-zone-group-001', floorId: floor.id, name: 'Main Office' },
  })

  const zoneA = await prisma.zone.upsert({
    where: { id: 'seed-zone-001' },
    update: {},
    create: { id: 'seed-zone-001', floorId: floor.id, zoneGroupId: zoneGroup.id, name: 'Open Plan', colour: '#6366f1' },
  })

  const zoneB = await prisma.zone.upsert({
    where: { id: 'seed-zone-002' },
    update: {},
    create: { id: 'seed-zone-002', floorId: floor.id, name: 'Quiet Zone', colour: '#10b981' },
  })
  console.log(`[seed] Zones: ${zoneA.name}, ${zoneB.name}`)

  const deskCategory = await prisma.assetCategory.upsert({
    where: { name: 'Desk' },
    update: {},
    create: { name: 'Desk', description: 'Bookable desk space on the floor plan', defaultIsBookable: true, defaultIcon: 'monitor' },
  })

  await prisma.assetCategory.upsert({
    where: { name: 'IT Equipment' },
    update: {},
    create: { name: 'IT Equipment', description: 'Laptops, monitors, keyboards, mice, docking stations' },
  })

  await prisma.assetCategory.upsert({
    where: { name: 'Furniture' },
    update: {},
    create: { name: 'Furniture', description: 'Chairs, desks, standing desk converters' },
  })

  const desksData = [
    { id: 'seed-desk-001', primaryZoneId: zoneA.id, name: 'A1', x: 20, y: 30, bookingStatus: BookableStatus.OPEN,       status: AssetStatus.AVAILABLE, amenities: ['monitor', 'docking-station'] },
    { id: 'seed-desk-002', primaryZoneId: zoneA.id, name: 'A2', x: 30, y: 30, bookingStatus: BookableStatus.OPEN,       status: AssetStatus.AVAILABLE, amenities: ['monitor'] },
    { id: 'seed-desk-003', primaryZoneId: zoneA.id, name: 'A3', x: 40, y: 30, bookingStatus: BookableStatus.RESTRICTED, status: AssetStatus.AVAILABLE, amenities: ['monitor', 'standing-desk'] },
    { id: 'seed-desk-004', primaryZoneId: zoneB.id, name: 'B1', x: 60, y: 50, bookingStatus: BookableStatus.OPEN,       status: AssetStatus.AVAILABLE, amenities: ['monitor', 'keyboard', 'mouse'] },
    { id: 'seed-desk-005', primaryZoneId: zoneB.id, name: 'B2', x: 70, y: 50, bookingStatus: BookableStatus.OPEN,       status: AssetStatus.AVAILABLE, amenities: ['monitor'] },
    { id: 'seed-desk-006', primaryZoneId: zoneB.id, name: 'B3', x: 80, y: 50, bookingStatus: BookableStatus.DISABLED,   status: AssetStatus.DISABLED,  amenities: [] },
  ]

  for (const desk of desksData) {
    await prisma.asset.upsert({
      where: { id: desk.id },
      update: {},
      create: {
        ...desk,
        floorId: floor.id,
        categoryId: deskCategory.id,
        isBookable: true,
        bookingLabel: 'Desk',
        width: 3,
        height: 2,
        rotation: 0,
      },
    })
  }
  console.log(`[seed] Created ${desksData.length} desks`)
}

// ─── Entry point ──────────────────────────────────────────────────────────────

async function main() {
  const seedDemo = process.env['SEED_DEMO_DATA'] === 'true'
  console.log(`[seed] Starting (demo data: ${seedDemo})`)

  const { org } = await seedCore()

  if (seedDemo) {
    await seedDemoData(org.id)
  }

  console.log('[seed] Done.')
}

main()
  .catch((e) => {
    console.error('[seed] Error:', e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
    await pool.end()
  })
