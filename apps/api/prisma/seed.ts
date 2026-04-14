import { PrismaClient, DeskStatus } from '@prisma/client'
import bcryptjs from 'bcryptjs'

const prisma = new PrismaClient()

async function main() {
  console.log('Seeding database...')

  // 1. Organisation
  const org = await prisma.organisation.upsert({
    where: { slug: 'acme' },
    update: {},
    create: {
      name: 'Acme Corp',
      slug: 'acme',
    },
  })
  console.log(`Organisation: ${org.name} (${org.id})`)

  // 2. Super admin user
  const adminHash = bcryptjs.hashSync('admin123', 10)
  const admin = await prisma.user.upsert({
    where: { email: 'admin@roomer.local' },
    update: {},
    create: {
      email: 'admin@roomer.local',
      displayName: 'Admin',
      passwordHash: adminHash,
      globalRole: 'SUPER_ADMIN',
      accountStatus: 'ACTIVE',
    },
  })
  console.log(`Admin user: ${admin.email} (${admin.id})`)

  // 3. Regular user
  const userHash = bcryptjs.hashSync('user123', 10)
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
  console.log(`Regular user: ${regularUser.email} (${regularUser.id})`)

  // 4. Building
  const building = await prisma.building.upsert({
    where: { id: 'seed-building-001' },
    update: {},
    create: {
      id: 'seed-building-001',
      organisationId: org.id,
      name: 'Acme HQ',
      address: '1 Acme Street, London, EC1A 1BB',
    },
  })
  console.log(`Building: ${building.name} (${building.id})`)

  // 5. Floor
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
  console.log(`Floor: ${floor.name} (${floor.id})`)

  // Zone group for enforcing single booking per group
  const zoneGroup = await prisma.zoneGroup.upsert({
    where: { id: 'seed-zone-group-001' },
    update: {},
    create: {
      id: 'seed-zone-group-001',
      floorId: floor.id,
      name: 'Main Office',
    },
  })

  // 6. Two zones
  const zoneA = await prisma.zone.upsert({
    where: { id: 'seed-zone-001' },
    update: {},
    create: {
      id: 'seed-zone-001',
      floorId: floor.id,
      zoneGroupId: zoneGroup.id,
      name: 'Open Plan',
      colour: '#6366f1',
    },
  })

  const zoneB = await prisma.zone.upsert({
    where: { id: 'seed-zone-002' },
    update: {},
    create: {
      id: 'seed-zone-002',
      floorId: floor.id,
      name: 'Quiet Zone',
      colour: '#10b981',
    },
  })
  console.log(`Zones: ${zoneA.name}, ${zoneB.name}`)

  // 7. Six desks spread across the two zones (x/y as % of floor plan)
  const desksData = [
    {
      id: 'seed-desk-001',
      zoneId: zoneA.id,
      name: 'A1',
      x: 20,
      y: 30,
      width: 3,
      height: 2,
      rotation: 0,
      status: DeskStatus.OPEN,
      amenities: ['monitor', 'docking-station'],
    },
    {
      id: 'seed-desk-002',
      zoneId: zoneA.id,
      name: 'A2',
      x: 30,
      y: 30,
      width: 3,
      height: 2,
      rotation: 0,
      status: DeskStatus.OPEN,
      amenities: ['monitor'],
    },
    {
      id: 'seed-desk-003',
      zoneId: zoneA.id,
      name: 'A3',
      x: 40,
      y: 30,
      width: 3,
      height: 2,
      rotation: 0,
      status: DeskStatus.RESTRICTED,
      amenities: ['monitor', 'standing-desk'],
    },
    {
      id: 'seed-desk-004',
      zoneId: zoneB.id,
      name: 'B1',
      x: 60,
      y: 50,
      width: 3,
      height: 2,
      rotation: 0,
      status: DeskStatus.OPEN,
      amenities: ['monitor', 'keyboard', 'mouse'],
    },
    {
      id: 'seed-desk-005',
      zoneId: zoneB.id,
      name: 'B2',
      x: 70,
      y: 50,
      width: 3,
      height: 2,
      rotation: 0,
      status: DeskStatus.OPEN,
      amenities: ['monitor'],
    },
    {
      id: 'seed-desk-006',
      zoneId: zoneB.id,
      name: 'B3',
      x: 80,
      y: 50,
      width: 3,
      height: 2,
      rotation: 0,
      status: DeskStatus.DISABLED,
      amenities: [],
    },
  ]

  for (const desk of desksData) {
    await prisma.desk.upsert({
      where: { id: desk.id },
      update: {},
      create: desk,
    })
  }
  console.log(`Created ${desksData.length} desks`)

  // Asset category seed
  await prisma.assetCategory.upsert({
    where: { name: 'IT Equipment' },
    update: {},
    create: {
      name: 'IT Equipment',
      description: 'Laptops, monitors, keyboards, mice, docking stations',
    },
  })

  await prisma.assetCategory.upsert({
    where: { name: 'Furniture' },
    update: {},
    create: {
      name: 'Furniture',
      description: 'Chairs, desks, standing desk converters',
    },
  })

  console.log('Seed complete.')
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
