export type GlobalRole = 'SUPER_ADMIN' | 'USER'
export type BookableStatus = 'OPEN' | 'RESTRICTED' | 'ASSIGNED' | 'DISABLED'
/** @deprecated Use BookableStatus instead */
export type DeskStatus = BookableStatus
export type BookingStatus = 'CONFIRMED' | 'CANCELLED' | 'COMPLETED'
export type QueueEntryStatus = 'WAITING' | 'PROMOTED' | 'CLAIMED' | 'EXPIRED' | 'CANCELLED'
export type AssetBookingStatus = 'available' | 'mine' | 'booked' | 'restricted' | 'assigned' | 'disabled' | 'queued' | 'promoted' | 'zone_conflict'
/** @deprecated Use AssetBookingStatus instead */
export type DeskBookingStatus = AssetBookingStatus
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
  assets: Asset[]
}

export interface AssetAssignedUser {
  id: string
  displayName: string
  email: string
  isPrimary: boolean
}
/** @deprecated Use AssetAssignedUser instead */
export type DeskAssignedUser = AssetAssignedUser

export interface Asset {
  id: string
  name: string
  description?: string
  categoryId: string
  category?: AssetCategory
  serialNumber?: string
  assetTag?: string
  status: AssetStatus
  // Bookable asset fields
  isBookable?: boolean
  bookingLabel?: string
  bookingStatus?: BookableStatus
  primaryZoneId?: string
  floorId?: string
  x?: number
  y?: number
  width?: number
  height?: number
  rotation?: number
  amenities?: string[]
  purchaseDate?: string
  warrantyExpiry?: string
  notes?: string
  createdAt?: string
  assignments?: AssetAssignment[]
  userAssignments?: Array<{ isPrimary: boolean; user: { id: string; displayName: string; email: string } }>
}

/** @deprecated Use Asset instead — desks are now Asset rows with isBookable: true */
export type Desk = Asset

export interface AssetWithStatus extends Omit<Asset, 'bookingStatus'> {
  bookingStatus: AssetBookingStatus
  rawBookingStatus?: BookableStatus
  currentBooking?: Booking & { bookerName?: string }
  bookedBy?: Array<{ userId: string; displayName: string }>
  zoneColour: string
  zoneName: string
  assignedUsers?: AssetAssignedUser[]
  queueDepth?: number
}
/** @deprecated Use AssetWithStatus instead */
export type DeskWithStatus = AssetWithStatus

export interface Booking {
  id: string
  userId: string
  assetId: string
  startsAt: string
  endsAt: string
  status: BookingStatus
  notes?: string
  user?: User
  asset?: Asset & {
    floor?: Floor & { building?: Building }
    primaryZone?: { id: string; name: string }
    zone?: Zone & {
      floor?: Floor & {
        building?: Building
      }
    }
  }
  /** @deprecated Use assetId */
  deskId?: string
  /** @deprecated Use asset */
  desk?: Asset & {
    floor?: Floor & { building?: Building }
    primaryZone?: { id: string; name: string }
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
  assetId: string
  wantedStartsAt: string
  wantedEndsAt: string
  position: number
  status: QueueEntryStatus
  expiresAt: string
  claimDeadline?: string
  asset?: Asset & { zone?: Zone }
  /** @deprecated Use assetId */
  deskId?: string
  /** @deprecated Use asset */
  desk?: Asset & { zone?: Zone }
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

export type AssetStatus = 'AVAILABLE' | 'ASSIGNED' | 'MAINTENANCE' | 'RETIRED' | 'DISABLED'

export interface AssetCategory {
  id: string
  name: string
  description?: string
  defaultIsBookable?: boolean
  defaultIcon?: string
  colour?: string
}

export interface AssetAssignment {
  id: string
  assetId: string
  asset?: Asset
  userId?: string
  user?: User
  assignedAt: string
  returnedAt?: string
}

export interface AssetZone {
  id: string
  name: string
  colour: string
  isPrimary: boolean
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

export interface FloorSubscriptionZone {
  subscriptionId: string
  zoneId: string
  zone: { id: string; name: string; colour: string }
}

export interface FloorSubscription {
  id: string
  userId: string
  floorId: string
  lastNotifiedAt?: string | null
  createdAt: string
  floor: { id: string; name: string; building: { id: string; name: string } }
  zones: FloorSubscriptionZone[]
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
