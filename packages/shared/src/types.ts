// ─── Enums ────────────────────────────────────────────────────────────────────

export enum AuthProvider {
  LOCAL = 'LOCAL',
  OIDC = 'OIDC',
  SAML = 'SAML',
  LDAP = 'LDAP',
}

export enum GlobalRole {
  SUPER_ADMIN = 'SUPER_ADMIN',
  USER = 'USER',
}

export enum ResourceRoleType {
  BUILDING_ADMIN = 'BUILDING_ADMIN',
  FLOOR_MANAGER = 'FLOOR_MANAGER',
  USER = 'USER',
  VIEWER = 'VIEWER',
}

export enum ResourceScopeType {
  BUILDING = 'BUILDING',
  FLOOR = 'FLOOR',
}

export enum AccountStatus {
  ACTIVE = 'ACTIVE',
  BLOCKED = 'BLOCKED',
}

export enum DeskStatus {
  OPEN = 'OPEN',
  RESTRICTED = 'RESTRICTED',
  ASSIGNED = 'ASSIGNED',
  DISABLED = 'DISABLED',
}

export enum BookingStatus {
  CONFIRMED = 'CONFIRMED',
  CANCELLED = 'CANCELLED',
  COMPLETED = 'COMPLETED',
}

export enum QueueEntryStatus {
  WAITING = 'WAITING',
  PROMOTED = 'PROMOTED',
  CLAIMED = 'CLAIMED',
  EXPIRED = 'EXPIRED',
  CANCELLED = 'CANCELLED',
}

export enum AssetStatus {
  AVAILABLE = 'AVAILABLE',
  ASSIGNED = 'ASSIGNED',
  MAINTENANCE = 'MAINTENANCE',
  RETIRED = 'RETIRED',
  DISABLED = 'DISABLED',
}

export enum BookableStatus {
  OPEN = 'OPEN',
  RESTRICTED = 'RESTRICTED',
  ASSIGNED = 'ASSIGNED',
  DISABLED = 'DISABLED',
}

export enum AssetAssigneeType {
  USER = 'USER',
}

export enum NotificationType {
  BOOKING_CONFIRMED = 'BOOKING_CONFIRMED',
  BOOKING_CANCELLED = 'BOOKING_CANCELLED',
  BOOKING_CANCELLED_BY_ADMIN = 'BOOKING_CANCELLED_BY_ADMIN',
  BOOKING_REMINDER = 'BOOKING_REMINDER',
  QUEUE_JOINED = 'QUEUE_JOINED',
  QUEUE_PROMOTED = 'QUEUE_PROMOTED',
  QUEUE_EXPIRED = 'QUEUE_EXPIRED',
  QUEUE_CLAIM_EXPIRING = 'QUEUE_CLAIM_EXPIRING',
  ASSET_ASSIGNED = 'ASSET_ASSIGNED',
  ASSET_DUE_RETURN = 'ASSET_DUE_RETURN',
  WELCOME = 'WELCOME',
}

export enum FloorPlanFileType {
  IMAGE = 'IMAGE',
  PDF = 'PDF',
  DXF = 'DXF',
}

// ─── Entity Interfaces ────────────────────────────────────────────────────────

export interface Organisation {
  id: string
  name: string
  slug: string
  createdAt: Date
  updatedAt: Date
}

export interface Building {
  id: string
  organisationId: string
  name: string
  address: string | null
  createdAt: Date
  updatedAt: Date
}

export interface Floor {
  id: string
  buildingId: string
  name: string
  level: number
  createdAt: Date
  updatedAt: Date
}

export interface FloorPlan {
  id: string
  floorId: string
  fileType: FloorPlanFileType
  originalPath: string
  renderedPath: string
  thumbnailPath: string | null
  width: number
  height: number
  createdAt: Date
  updatedAt: Date
}

export interface ZoneGroup {
  id: string
  floorId: string
  name: string
  createdAt: Date
  updatedAt: Date
}

export interface Zone {
  id: string
  floorId: string
  zoneGroupId: string | null
  name: string
  colour: string
  createdAt: Date
  updatedAt: Date
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
  createdAt: Date
  updatedAt: Date
}

export interface DeskAllowList {
  deskId: string
  userId: string
  createdAt: Date
}

export interface User {
  id: string
  email: string
  displayName: string
  passwordHash: string | null
  provider: AuthProvider
  externalId: string | null
  accountStatus: AccountStatus
  globalRole: GlobalRole
  createdAt: Date
  updatedAt: Date
}

export interface UserResourceRole {
  id: string
  userId: string
  role: ResourceRoleType
  scopeType: ResourceScopeType
  buildingId: string | null
  floorId: string | null
  createdAt: Date
}

export interface Booking {
  id: string
  userId: string
  assetId: string
  startsAt: Date
  endsAt: Date
  status: BookingStatus
  notes: string | null
  createdAt: Date
  updatedAt: Date
}

export interface QueueEntry {
  id: string
  userId: string
  assetId: string
  wantedStartsAt: Date
  wantedEndsAt: Date
  position: number
  status: QueueEntryStatus
  expiresAt: Date
  claimDeadline: Date | null
  createdAt: Date
  updatedAt: Date
}

export interface AssetCategory {
  id: string
  name: string
  description: string | null
  defaultIsBookable: boolean | null
  defaultIcon: string | null
  colour: string
  createdAt: Date
}

export interface Asset {
  id: string
  categoryId: string
  name: string
  description: string | null
  serialNumber: string | null
  assetTag: string | null
  status: AssetStatus
  purchaseDate: Date | null
  warrantyExpiry: Date | null
  notes: string | null
  // Bookable-asset fields
  isBookable: boolean
  bookingLabel: string | null
  amenities: string[]
  bookingStatus: BookableStatus | null
  primaryZoneId: string | null
  floorId: string | null
  x: number | null
  y: number | null
  width: number | null
  height: number | null
  rotation: number | null
  createdAt: Date
  updatedAt: Date
}

export interface AssetAssignment {
  id: string
  assetId: string
  userId: string | null
  assignedById: string | null
  assignedAt: Date
  returnedAt: Date | null
  notes: string | null
}

export interface Notification {
  id: string
  userId: string
  type: NotificationType
  title: string
  body: string
  read: boolean
  metadata: Record<string, unknown>
  createdAt: Date
}

export interface AuditLog {
  id: string
  actorId: string
  action: string
  resourceType: string
  resourceId: string
  before: Record<string, unknown> | null
  after: Record<string, unknown> | null
  ipAddress: string | null
  createdAt: Date
}

// ─── Public user type (no passwordHash) ──────────────────────────────────────

export type PublicUser = Omit<User, 'passwordHash'>

export interface SessionUser {
  id: string
  email: string
  displayName: string
  globalRole: GlobalRole
  accountStatus: AccountStatus
}
