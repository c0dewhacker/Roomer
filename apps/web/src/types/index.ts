export type GlobalRole = 'SUPER_ADMIN' | 'USER'
export type DeskStatus = 'OPEN' | 'RESTRICTED' | 'ASSIGNED' | 'DISABLED'
export type BookingStatus = 'CONFIRMED' | 'CANCELLED' | 'COMPLETED'
export type QueueEntryStatus = 'WAITING' | 'PROMOTED' | 'CLAIMED' | 'EXPIRED' | 'CANCELLED'
export type DeskBookingStatus = 'available' | 'mine' | 'booked' | 'restricted' | 'assigned' | 'disabled' | 'queued' | 'promoted' | 'zone_conflict'
export type ResourceRoleType = 'FLOOR_MANAGER' | 'BUILDING_ADMIN' | 'VIEWER' | 'USER'
export type ResourceScopeType = 'FLOOR' | 'BUILDING'

export interface ResourceRole {
  id: string
  role: ResourceRoleType
  scopeType: ResourceScopeType
  floorId?: string
  buildingId?: string
  floor?: { id: string; name: string }
  building?: { id: string; name: string }
}

export interface GroupResourceRole {
  id: string
  role: ResourceRoleType
  scopeType: ResourceScopeType
  floorId?: string
  buildingId?: string
  floor?: { id: string; name: string }
  building?: { id: string; name: string }
}

export interface UserGroupMembership {
  groupId: string
  group: {
    id: string
    name: string
    globalRole: GlobalRole
    groupResourceRoles?: GroupResourceRole[]
  }
}

export interface User {
  id: string
  email: string
  displayName: string
  globalRole: GlobalRole
  accountStatus: 'ACTIVE' | 'BLOCKED'
  provider: 'LOCAL' | 'LDAP' | 'OIDC' | 'SAML'
  externalId?: string
  createdAt: string
  resourceRoles?: ResourceRole[]
  groupMemberships?: UserGroupMembership[]
}

export interface Building {
  id: string
  name: string
  address?: string
  organisationId: string
}

export interface Floor {
  id: string
  buildingId: string
  name: string
  level: number
  floorPlan?: FloorPlan
  building?: Building
  zones?: Zone[]
}

export interface FloorPlan {
  id: string
  floorId: string
  fileType: 'IMAGE' | 'PDF' | 'DXF'
  renderedPath: string
  thumbnailPath?: string
  width: number
  height: number
}

export interface Zone {
  id: string
  floorId: string
  name: string
  colour: string
  desks: Desk[]
}

export interface Desk {
  id: string
  zoneId: string
  name: string
  x: number
  y: number
  width: number
  height: number
  rotation: number
  status: DeskStatus
  amenities: string[]
}

export interface DeskAsset {
  assignmentId: string
  assetId: string
  assetName: string
  categoryName: string
}

export interface DeskAssignedUser {
  id: string
  displayName: string
  email: string
  isPrimary: boolean
}

export interface DeskWithStatus extends Desk {
  bookingStatus: DeskBookingStatus
  currentBooking?: Booking & { bookerName?: string }
  bookedBy?: Array<{ userId: string; displayName: string }>
  zoneColour: string
  zoneName: string
  assets?: DeskAsset[]
  assignedUsers?: DeskAssignedUser[]
}

export interface Booking {
  id: string
  userId: string
  deskId: string
  startsAt: string
  endsAt: string
  status: BookingStatus
  notes?: string
  user?: User
  desk?: Desk & {
    zone?: Zone & {
      floor?: Floor & {
        building?: Building
      }
    }
  }
}

export interface QueueEntry {
  id: string
  userId: string
  deskId: string
  wantedStartsAt: string
  wantedEndsAt: string
  position: number
  status: QueueEntryStatus
  expiresAt: string
  claimDeadline?: string
  desk?: Desk & { zone?: Zone }
}

export interface Notification {
  id: string
  type: string
  title: string
  body: string
  read: boolean
  createdAt: string
  metadata: Record<string, unknown>
}

export type AssetStatus = 'AVAILABLE' | 'ASSIGNED' | 'MAINTENANCE' | 'RETIRED'
export type AssetAssigneeType = 'USER' | 'DESK'

export interface AssetCategory {
  id: string
  name: string
  description?: string
}

export interface Asset {
  id: string
  name: string
  description?: string
  categoryId: string
  category?: AssetCategory
  serialNumber?: string
  assetTag?: string
  status: AssetStatus
  purchaseDate?: string
  warrantyExpiry?: string
  notes?: string
  createdAt: string
  assignments?: AssetAssignment[]
}

export interface AssetAssignment {
  id: string
  assetId: string
  asset?: Asset
  assigneeType: AssetAssigneeType
  userId?: string
  deskId?: string
  user?: User
  assignedAt: string
  returnedAt?: string
}

export interface LeaseDocument {
  id: string
  leaseId: string
  filename: string
  mimeType: string
  sizeBytes: number
  uploadedAt: string
  storagePath?: string
}

export interface Lease {
  id: string
  buildingId: string
  building?: { id: string; name: string }
  name: string
  startDate: string
  endDate?: string
  landlord?: string
  rentAmount?: number
  currency: string
  notes?: string
  createdAt: string
  updatedAt: string
  documents?: LeaseDocument[]
}

export interface UserGroupMember {
  groupId: string
  userId: string
  createdAt: string
  user?: { id: string; displayName: string; email: string }
}

export interface GroupBuildingAccess {
  groupId: string
  buildingId: string
  building?: { id: string; name: string }
}

export interface GroupFloorAccess {
  groupId: string
  floorId: string
  floor?: { id: string; name: string; buildingId: string }
}

export interface UserGroup {
  id: string
  name: string
  description?: string
  globalRole: 'USER' | 'SUPER_ADMIN'
  organisationId: string
  createdAt: string
  updatedAt: string
  members?: UserGroupMember[]
  buildingAccess?: GroupBuildingAccess[]
  floorAccess?: GroupFloorAccess[]
  _count?: { members: number }
}

export interface UtilisationDataPoint {
  floorId: string
  floorName: string
  zoneId: string
  zoneName: string
  totalDesks: number
  bookableDesks: number
  assignedDesks: number
  disabledDesks: number
  bookingCount: number
  utilisationPct: number
}

export interface BookingDataPoint {
  date: string
  count: number
}

export interface TopUserDataPoint {
  userId: string
  displayName: string
  email: string
  bookingCount: number
}
