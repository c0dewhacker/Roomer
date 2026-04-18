import type {
  User,
  Building,
  Floor,
  AssetWithStatus,
  AssetAssignedUser,
  Booking,
  QueueEntry,
  Notification,
  Asset,
  AssetCategory,
  AssetAssignment,
  AssetZone,
  UtilisationDataPoint,
  BookingDataPoint,
  TopUserDataPoint,
  Lease,
  LeaseDocument,
  UserGroup,
} from '../types'

const BASE = '/api/v1'

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public body?: unknown,
  ) {
    super(message)
    this.name = 'ApiError'
  }

  /** Returns a human-readable string of field-level validation errors, or null if none. */
  get fieldErrors(): string | null {
    const details = (this.body as { error?: { details?: { fieldErrors?: Record<string, string[]> } } })
      ?.error?.details?.fieldErrors
    if (!details) return null
    const lines = Object.entries(details)
      .filter(([, msgs]) => msgs.length > 0)
      .map(([field, msgs]) => `${field}: ${msgs.join(', ')}`)
    return lines.length > 0 ? lines.join('; ') : null
  }
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    credentials: 'include',
    headers: body instanceof FormData || body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body instanceof FormData ? body : body !== undefined ? JSON.stringify(body) : undefined,
  })

  if (!res.ok) {
    let errorBody: unknown
    try {
      errorBody = await res.json()
    } catch {
      errorBody = null
    }
    const msg =
      (errorBody as { error?: { message?: string } })?.error?.message ??
      (errorBody as { message?: string })?.message ??
      `Request failed with status ${res.status}`
    throw new ApiError(res.status, msg, errorBody)
  }

  return res.json() as Promise<T>
}

const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body),
  delete: <T>(path: string) => request<T>('DELETE', path),
  upload: <T>(path: string, formData: FormData) => request<T>('POST', path, formData),
}

// --- Auth ---
export const authApi = {
  login: (email: string, password: string) =>
    api.post<{ data: { user: { id: string; email: string; displayName: string; globalRole: string; accountStatus: string } } }>(
      '/auth/login',
      { email, password },
    ),
  logout: () => api.post<{ data: { ok: true } }>('/auth/logout'),
  refresh: () => api.post<{ data: { user: { id: string; email: string; displayName: string; globalRole: string; accountStatus: string } } }>('/auth/refresh'),
  me: () => api.get<{ data: { user: User } }>('/auth/me'),
}

// --- Buildings ---
export const buildingsApi = {
  list: () => api.get<{ data: Building[] }>('/buildings'),
  get: (id: string) => api.get<{ data: Building & { floors: Floor[] } }>(`/buildings/${id}`),
  create: (body: { name: string; address?: string }) =>
    api.post<{ data: Building }>('/buildings', body),
  update: (id: string, body: Partial<{ name: string; address: string }>) =>
    api.put<{ data: Building }>(`/buildings/${id}`, body),
  delete: (id: string) => api.delete<{ data: { ok: true } }>(`/buildings/${id}`),
  getAccessGroups: (id: string) =>
    api.get<{ data: Array<{ id: string; name: string; description?: string; _count: { members: number } }> }>(
      `/buildings/${id}/access-groups`,
    ),
  addAccessGroup: (id: string, groupId: string) =>
    api.post<{ data: { groupId: string; buildingId: string } }>(`/buildings/${id}/access-groups`, { groupId }),
  removeAccessGroup: (id: string, groupId: string) =>
    api.delete<{ data: { ok: true } }>(`/buildings/${id}/access-groups/${groupId}`),
  getManagers: (id: string) =>
    api.get<{ data: Array<{ roleId: string; id: string; displayName: string; email: string }> }>(
      `/buildings/${id}/managers`,
    ),
  addManager: (id: string, userId: string) =>
    api.post<{ data: { roleId: string; id: string; displayName: string; email: string } }>(
      `/buildings/${id}/managers`,
      { userId },
    ),
  removeManager: (id: string, userId: string) =>
    api.delete<{ data: { ok: true } }>(`/buildings/${id}/managers/${userId}`),
  getGroupManagers: (id: string) =>
    api.get<{ data: Array<{ roleId: string; id: string; name: string; memberCount: number }> }>(
      `/buildings/${id}/group-managers`,
    ),
  addGroupManager: (id: string, groupId: string) =>
    api.post<{ data: { roleId: string; id: string; name: string; memberCount: number } }>(
      `/buildings/${id}/group-managers`,
      { groupId },
    ),
  removeGroupManager: (id: string, groupId: string) =>
    api.delete<{ data: { ok: true } }>(`/buildings/${id}/group-managers/${groupId}`),
}

// --- Floors ---
export const floorsApi = {
  get: (id: string) =>
    api.get<{ data: Floor & { zones: Array<{ id: string; name: string; colour: string; zoneGroupId: string | null; assets: Asset[] }>; zoneGroups: Array<{ id: string; name: string; floorId: string }>; floorPlan: { id: string; floorId: string; fileType: 'IMAGE' | 'PDF' | 'DXF'; renderedPath: string; thumbnailPath?: string; width: number; height: number; displayScale: number; updatedAt: string } | null } }>(
      `/floors/${id}`,
    ),
  create: (body: { buildingId: string; name: string; level?: number }) =>
    api.post<{ data: Floor }>('/floors', body),
  update: (id: string, body: Partial<{ name: string; level: number }>) =>
    api.put<{ data: Floor }>(`/floors/${id}`, body),
  delete: (id: string) => api.delete<{ data: { ok: true } }>(`/floors/${id}`),
  uploadFloorPlan: (id: string, file: File) => {
    const form = new FormData()
    form.append('file', file)
    return api.upload<{ data: { id: string; floorId: string; renderedPath: string; width: number; height: number } }>(
      `/floors/${id}/floor-plan`,
      form,
    )
  },
  getAvailability: (id: string, date: string) =>
    api.get<{ data: { floorId: string; date: string; zones: Array<{ id: string; name: string; colour: string; assets: AssetWithStatus[] }> } }>(`/floors/${id}/availability?date=${date}`),
  getManagers: (id: string) =>
    api.get<{ data: Array<{ roleId: string; id: string; displayName: string; email: string }> }>(
      `/floors/${id}/managers`,
    ),
  getGroupManagers: (id: string) =>
    api.get<{ data: Array<{ roleId: string; id: string; name: string; memberCount: number }> }>(
      `/floors/${id}/group-managers`,
    ),
  assignGroupManager: (id: string, groupId: string) =>
    api.post<{ data: { roleId: string; id: string; name: string } }>(
      `/floors/${id}/group-managers`,
      { groupId },
    ),
  removeGroupManager: (id: string, groupId: string) =>
    api.delete<{ data: { ok: true } }>(`/floors/${id}/group-managers/${groupId}`),
  updateFloorPlanTransform: (id: string, displayScale: number) =>
    api.patch<{ data: { displayScale: number } }>(`/floors/${id}/floor-plan/transform`, { displayScale }),
}

// --- Zones ---
export const zonesApi = {
  create: (body: { floorId: string; name: string; colour: string; zoneGroupId?: string }) =>
    api.post<{ data: { id: string; floorId: string; name: string; colour: string } }>('/zones', body),
  update: (id: string, body: Partial<{ name: string; colour: string; zoneGroupId: string | null }>) =>
    api.put<{ data: { id: string; floorId: string; name: string; colour: string } }>(`/zones/${id}`, body),
  delete: (id: string) => api.delete<{ data: { ok: true } }>(`/zones/${id}`),
}

// --- Zone Groups ---
export const zoneGroupsApi = {
  create: (body: { floorId: string; name: string }) =>
    api.post<{ data: { id: string; floorId: string; name: string } }>('/zone-groups', body),
  delete: (id: string) => api.delete<{ data: { ok: true } }>(`/zone-groups/${id}`),
}

// --- Assets (bookable) ---
export type PositionUpdate = { id: string; x: number; y: number; width: number; height: number; rotation: number }

export interface AvailabilityWindow {
  id: string
  assetId: string
  ownerId: string
  startsAt: string
  endsAt: string
  note?: string | null
  createdAt: string
}

export interface MyAssignment {
  assetId: string
  userId: string
  isPrimary: boolean
  createdAt: string
  asset: {
    id: string
    name: string
    bookingLabel?: string | null
    floorId?: string | null
    floor?: { id: string; name: string; building: { id: string; name: string } } | null
    primaryZone?: { id: string; name: string } | null
    category: { id: string; name: string }
    availabilityWindows: AvailabilityWindow[]
  }
}

export const assetsApi = {
  list: () => api.get<{ data: Asset[] }>('/assets'),
  listCategories: () => api.get<{ data: AssetCategory[] }>('/assets/categories'),
  get: (id: string) => api.get<{ data: Asset }>(`/assets/${id}`),
  create: (body: Partial<Asset> & {
    isBookable?: boolean
    bookingLabel?: string
    amenities?: string[]
    bookingStatus?: string
    primaryZoneId?: string
    floorId?: string
    x?: number
    y?: number
    width?: number
    height?: number
    rotation?: number
  }) => api.post<{ data: Asset }>('/assets', body),
  update: (id: string, body: Partial<Asset> & {
    isBookable?: boolean
    bookingLabel?: string | null
    amenities?: string[]
    bookingStatus?: string
    primaryZoneId?: string | null
    floorId?: string | null
    x?: number | null
    y?: number | null
    width?: number | null
    height?: number | null
    rotation?: number | null
  }) => api.patch<{ data: Asset }>(`/assets/${id}`, body),
  delete: (id: string) => api.delete<{ data: { ok: true } }>(`/assets/${id}`),
  assign: (id: string, body: { userId: string; notes?: string }) =>
    api.post<{ data: AssetAssignment }>(`/assets/${id}/assign`, body),
  unassign: (id: string) => api.post<{ data: AssetAssignment }>(`/assets/${id}/unassign`, {}),
  history: (id: string) => api.get<{ data: AssetAssignment[] }>(`/assets/${id}/history`),
  // Floor plan position updates
  updatePositions: (updates: PositionUpdate[]) =>
    api.patch<{ data: { ok: true } }>('/assets/positions', { assets: updates }),
  // Allow-list
  getAllowList: (id: string) =>
    api.get<{ data: Array<{ id: string; displayName: string; email: string }> }>(`/assets/${id}/allow-list`),
  addAllowList: (id: string, userId: string) =>
    api.post<{ data: { assetId: string; userId: string } }>(`/assets/${id}/allow-list`, { userId }),
  removeAllowList: (id: string, userId: string) =>
    api.delete<{ data: { ok: true } }>(`/assets/${id}/allow-list/${userId}`),
  // Permanent user assignments
  getAssignments: (id: string) =>
    api.get<{ data: AssetAssignedUser[] }>(`/assets/${id}/user-assignments`),
  addAssignment: (id: string, data: { userId: string; isPrimary?: boolean }) =>
    api.post<{ data: AssetAssignedUser }>(`/assets/${id}/user-assignments`, data),
  removeAssignment: (id: string, userId: string) =>
    api.delete<{ data: { ok: true } }>(`/assets/${id}/user-assignments/${userId}`),
  setPrimaryAssignment: (id: string, userId: string) =>
    api.patch<{ data: { ok: true } }>(`/assets/${id}/user-assignments/${userId}/primary`),
  // Additional zones
  getZones: (id: string) =>
    api.get<{ data: AssetZone[] }>(`/assets/${id}/zones`),
  addZone: (id: string, zoneId: string) =>
    api.post<{ data: { ok: true } }>(`/assets/${id}/zones`, { zoneId }),
  removeZone: (id: string, zoneId: string) =>
    api.delete<{ data: { ok: true } }>(`/assets/${id}/zones/${zoneId}`),
  // Bulk import — create multiple assets from CSV rows and place them on a floor
  bulkImport: (floorId: string, assets: Array<{
    name: string
    categoryName: string
    bookingStatus?: string
    bookingLabel?: string
    amenities?: string[]
    serialNumber?: string
    assetTag?: string
    notes?: string
    zoneName?: string
  }>) => api.post<{ data: { created: number; errors: Array<{ row: number; name: string; error: string }> } }>(
    '/assets/bulk-import',
    { floorId, assets },
  ),
  // Bookings for an asset
  getBookings: (id: string, params?: { status?: string; date?: string }) => {
    const qs = new URLSearchParams()
    if (params?.status) qs.set('status', params.status)
    if (params?.date) qs.set('date', params.date)
    return api.get<{ data: Booking[] }>(`/assets/${id}/bookings${qs.toString() ? `?${qs}` : ''}`)
  },
  createCategory: (body: { name: string; description?: string; defaultIsBookable?: boolean; defaultIcon?: string; colour?: string }) =>
    api.post<{ data: AssetCategory }>('/assets/categories', body),
  // Permanent assignments for current user
  getMyAssignments: () =>
    api.get<{ data: MyAssignment[] }>('/assets/my-assignments'),
  // Availability windows
  listAvailabilityWindows: (id: string) =>
    api.get<{ data: AvailabilityWindow[] }>(`/assets/${id}/availability-windows`),
  createAvailabilityWindow: (id: string, body: { startsAt: string; endsAt: string; note?: string }) =>
    api.post<{ data: AvailabilityWindow }>(`/assets/${id}/availability-windows`, body),
  deleteAvailabilityWindow: (id: string, windowId: string) =>
    api.delete<{ data: { ok: true } }>(`/assets/${id}/availability-windows/${windowId}`),
}

// --- Bookings ---
export const bookingsApi = {
  list: (status?: 'upcoming' | 'past' | 'all') =>
    api.get<{ data: Booking[]; meta: { total: number } }>(
      `/bookings${status ? `?status=${status}` : ''}`,
    ),
  get: (id: string) => api.get<{ data: Booking }>(`/bookings/${id}`),
  create: (body: { assetId: string; startsAt: string; endsAt: string; notes?: string }) =>
    api.post<{ data: Booking }>('/bookings', body),
  update: (id: string, body: Partial<{ startsAt: string; endsAt: string; notes: string }>) =>
    api.patch<{ data: Booking }>(`/bookings/${id}`, body),
  cancel: (id: string) => api.delete<{ data: { ok: true } }>(`/bookings/${id}`),
}

// --- Queue ---
export const queueApi = {
  list: () => api.get<{ data: QueueEntry[] }>('/queue'),
  join: (body: { assetId: string; wantedStartsAt: string; wantedEndsAt: string; expiresAt: string }) =>
    api.post<{ data: QueueEntry }>('/queue', body),
  leave: (id: string) => api.delete<{ data: { ok: true } }>(`/queue/${id}`),
  claim: (id: string) => api.post<{ data: Booking }>(`/queue/${id}/claim`),
}

// --- Users (admin) ---
export const usersApi = {
  list: (params?: { page?: number; limit?: number; q?: string }) => {
    const qs = new URLSearchParams()
    if (params?.page) qs.set('page', String(params.page))
    if (params?.limit) qs.set('limit', String(params.limit))
    if (params?.q) qs.set('search', params.q) // backend uses 'search' param
    return api.get<{ data: User[]; meta: { total: number; page: number; limit: number } }>(
      `/users${qs.toString() ? `?${qs}` : ''}`,
    )
  },
  get: (id: string) => api.get<{ data: User }>(`/users/${id}`),
  create: (body: { email: string; displayName: string; password: string; globalRole?: string }) =>
    api.post<{ data: User }>('/users', body),
  update: (id: string, body: Partial<User>) =>
    api.patch<{ data: User }>(`/users/${id}`, body),
  assignResourceRole: (
    userId: string,
    body: { role: string; scopeType: string; floorId?: string; buildingId?: string },
  ) => api.post<{ data: { id: string } }>(`/users/${userId}/resource-roles`, body),
  removeResourceRole: (userId: string, roleId: string) =>
    api.delete<{ data: { ok: true } }>(`/users/${userId}/resource-roles/${roleId}`),
}

// --- Settings ---

type OrgSettings = {
  id: string
  name: string
  defaultBookingDurationHours: number
  maxAdvanceBookingDays: number
  maxBookingsPerUser: number
}

export interface BrandingBanner {
  enabled: boolean
  text: string
  bgColor: string
  textColor: string
}

export interface Branding {
  appName?: string
  sidebarTitle?: string
  sidebarSubtitle?: string
  primaryColor?: string
  primaryColorDark?: string
  logoPath?: string
  faviconPath?: string
  borderRadius?: 'sharp' | 'medium' | 'large'
  headerBanner?: BrandingBanner
  footerBanner?: BrandingBanner
}

export const brandingApi = {
  get: () => api.get<{ data: Branding }>('/settings/branding'),
  update: (body: Partial<Branding>) => api.patch<{ data: Branding }>('/settings/branding', body),
  uploadLogo: (file: File) => {
    const form = new FormData()
    form.append('file', file)
    return request<{ data: { logoPath: string } }>('POST', '/settings/branding/logo', form)
  },
  uploadFavicon: (file: File) => {
    const form = new FormData()
    form.append('file', file)
    return request<{ data: { faviconPath: string } }>('POST', '/settings/branding/favicon', form)
  },
  getLogoUrl: () => `${BASE}/settings/branding/logo/image`,
  getFaviconUrl: () => `${BASE}/settings/branding/favicon/image`,
}

export const settingsApi = {
  testEmail: (to?: string) =>
    api.post<{ data: { ok: true; message: string } }>('/settings/test-email', to ? { to } : {}),
  getAuthConfig: () =>
    api.get<{ data: Record<string, { enabled: boolean; config: Record<string, unknown> }> }>('/settings/auth-config'),
  updateAuthConfig: (
    provider: 'oidc' | 'saml' | 'ldap',
    body: { enabled?: boolean; config?: Record<string, unknown> },
  ) => api.put<{ data: { provider: string; enabled: boolean; config: Record<string, unknown> } }>(
    `/settings/auth-config/${provider}`,
    body,
  ),
  getOrg: () => api.get<{ data: OrgSettings }>('/settings/organisation'),
  updateOrg: (body: Partial<Omit<OrgSettings, 'id'>>) =>
    api.patch<{ data: OrgSettings }>('/settings/organisation', body),
}

// --- Auth Providers (public) ---
export const authProvidersApi = {
  list: () =>
    api.get<{ data: { oidc: { enabled: boolean; label: string }; saml: { enabled: boolean; label: string }; ldap: { enabled: boolean } } }>(
      '/auth/providers',
    ),
}


// --- Leases ---
export const leasesApi = {
  list: (buildingId?: string) =>
    api.get<{ data: Lease[] }>(`/leases${buildingId ? `?buildingId=${buildingId}` : ''}`),
  get: (id: string) => api.get<{ data: Lease }>(`/leases/${id}`),
  create: (body: {
    buildingId: string
    name: string
    startDate: string
    endDate?: string
    landlord?: string
    rentAmount?: number
    currency?: string
    notes?: string
  }) => api.post<{ data: Lease }>('/leases', body),
  update: (id: string, body: Partial<{
    name: string
    startDate: string
    endDate: string | null
    landlord: string
    rentAmount: number
    currency: string
    notes: string
  }>) => api.put<{ data: Lease }>(`/leases/${id}`, body),
  delete: (id: string) => api.delete<{ data: { ok: true } }>(`/leases/${id}`),
  uploadDocument: (id: string, file: File) => {
    const form = new FormData()
    form.append('file', file)
    return api.upload<{ data: LeaseDocument }>(`/leases/${id}/documents`, form)
  },
  downloadDocumentUrl: (leaseId: string, docId: string) =>
    `${BASE}/leases/${leaseId}/documents/${docId}`,
  deleteDocument: (leaseId: string, docId: string) =>
    api.delete<{ data: { ok: true } }>(`/leases/${leaseId}/documents/${docId}`),
}

// --- Groups ---
export const groupsApi = {
  list: () => api.get<{ data: UserGroup[] }>('/groups'),
  get: (id: string) => api.get<{ data: UserGroup }>(`/groups/${id}`),
  create: (body: { name: string; description?: string; globalRole?: 'USER' | 'SUPER_ADMIN' }) =>
    api.post<{ data: UserGroup }>('/groups', body),
  update: (id: string, body: Partial<{ name: string; description: string; globalRole: 'USER' | 'SUPER_ADMIN' }>) =>
    api.put<{ data: UserGroup }>(`/groups/${id}`, body),
  delete: (id: string) => api.delete<{ data: { ok: true } }>(`/groups/${id}`),
  addMember: (id: string, userId: string) =>
    api.post<{ data: { groupId: string; userId: string } }>(`/groups/${id}/members`, { userId }),
  removeMember: (id: string, userId: string) =>
    api.delete<{ data: { ok: true } }>(`/groups/${id}/members/${userId}`),
  addBuildingAccess: (id: string, buildingId: string) =>
    api.post<{ data: { groupId: string; buildingId: string } }>(`/groups/${id}/building-access`, { buildingId }),
  removeBuildingAccess: (id: string, buildingId: string) =>
    api.delete<{ data: { ok: true } }>(`/groups/${id}/building-access/${buildingId}`),
  addFloorAccess: (id: string, floorId: string) =>
    api.post<{ data: { groupId: string; floorId: string } }>(`/groups/${id}/floor-access`, { floorId }),
  removeFloorAccess: (id: string, floorId: string) =>
    api.delete<{ data: { ok: true } }>(`/groups/${id}/floor-access/${floorId}`),
}

// --- Analytics ---
function analyticsQs(params?: { startDate?: string; endDate?: string; buildingId?: string; floorId?: string }) {
  const qs = new URLSearchParams()
  if (params?.startDate) qs.set('startDate', params.startDate)
  if (params?.endDate) qs.set('endDate', params.endDate)
  if (params?.buildingId) qs.set('buildingId', params.buildingId)
  if (params?.floorId) qs.set('floorId', params.floorId)
  return qs.toString() ? `?${qs}` : ''
}

export type AnalyticsParams = { startDate?: string; endDate?: string; buildingId?: string; floorId?: string }

export type SummaryStats = {
  totalBookings: number; cancelledBookings: number; completedBookings: number
  cancellationRate: number; uniqueBookers: number; avgDailyBookings: number
  totalDesks: number; bookableDesks: number; assignedDesks: number; disabledDesks: number
  overallUtilisationPct: number; queueDepth: number; workingDays: number
}
export type StatusBreakdownPoint = { status: string; label: string; count: number }
export type PeakDayPoint = { dayOfWeek: number; dayName: string; count: number }
export type FloorUtilisationPoint = {
  floorId: string; floorName: string; buildingId: string; buildingName: string
  totalDesks: number; bookableDesks: number; assignedDesks: number; disabledDesks: number
  bookingCount: number; utilisationPct: number
}

export const analyticsApi = {
  summary: (params?: AnalyticsParams) =>
    api.get<{ data: SummaryStats }>(`/analytics/summary${analyticsQs(params)}`),
  utilisation: (params?: AnalyticsParams) =>
    api.get<{ data: UtilisationDataPoint[] }>(`/analytics/utilisation${analyticsQs(params)}`),
  bookings: (params?: AnalyticsParams) =>
    api.get<{ data: BookingDataPoint[] }>(`/analytics/bookings${analyticsQs(params)}`),
  topUsers: (params?: AnalyticsParams) =>
    api.get<{ data: TopUserDataPoint[] }>(`/analytics/top-users${analyticsQs(params)}`),
  statusBreakdown: (params?: AnalyticsParams) =>
    api.get<{ data: StatusBreakdownPoint[] }>(`/analytics/status-breakdown${analyticsQs(params)}`),
  peakDays: (params?: AnalyticsParams) =>
    api.get<{ data: PeakDayPoint[] }>(`/analytics/peak-days${analyticsQs(params)}`),
  floorUtilisation: (params?: AnalyticsParams) =>
    api.get<{ data: FloorUtilisationPoint[] }>(`/analytics/floor-utilisation${analyticsQs(params)}`),
}

// --- Notifications ---
export type ImportRow = {
  building_name: string
  building_address?: string
  floor_name: string
  floor_level?: string
  zone_name: string
  zone_colour?: string
  asset_name: string
  asset_category?: string
  is_bookable?: string
  asset_status?: string
  asset_amenities?: string
}

export type ImportResult = {
  created: { buildings: number; floors: number; zones: number; assets: number }
  errors: Array<{ row: number; message: string }>
}

export const importApi = {
  bulk: (rows: ImportRow[]) =>
    api.post<{ data: ImportResult }>('/import/bulk', { rows }),
}

export const notificationsApi = {
  list: (params?: { page?: number; limit?: number }) => {
    const qs = new URLSearchParams()
    if (params?.page) qs.set('page', String(params.page))
    if (params?.limit) qs.set('limit', String(params.limit))
    return api.get<{ data: Notification[]; meta: { total: number } }>(
      `/notifications${qs.toString() ? `?${qs}` : ''}`,
    )
  },
  unreadCount: () => api.get<{ data: { count: number } }>('/notifications/unread-count'),
  markAllRead: () => api.patch<{ data: { ok: true } }>('/notifications/read-all'),
  markRead: (id: string) => api.patch<{ data: { ok: true } }>(`/notifications/${id}/read`),
}
