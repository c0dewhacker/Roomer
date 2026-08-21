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
  AssetZone,
  UtilisationDataPoint,
  BookingDataPoint,
  TopUserDataPoint,
  Lease,
  LeaseDocument,
  UserGroup,
  FloorSubscription,
  RecurringBookingRule,
  BookingTransfer,
  BookingSwap,
  FloorManagerRequest,
  ManagerRequestStatus,
  QrCheckInMode,
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
  const isMutating = method !== 'GET' && method !== 'HEAD'
  const baseHeaders: Record<string, string> = isMutating
    ? { 'X-Requested-With': 'XMLHttpRequest' }
    : {}
  if (body !== undefined && !(body instanceof FormData)) {
    baseHeaders['Content-Type'] = 'application/json'
  }
  const res = await fetch(`${BASE}${path}`, {
    method,
    credentials: 'include',
    headers: Object.keys(baseHeaders).length > 0 ? baseHeaders : undefined,
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
  update: (id: string, body: Partial<{ name: string; address: string; noShowReleaseEnabled: boolean | null; qrCheckInMode: QrCheckInMode | null }>) =>
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
  accessSummary: (id: string) => api.get<{ data: AccessSummary }>(`/buildings/${id}/access-summary`),
}

// --- Floors ---
export const floorsApi = {
  get: (id: string) =>
    api.get<{ data: Floor & { zones: Array<{ id: string; name: string; colour: string; zoneGroupId: string | null; assets: Asset[] }>; zoneGroups: Array<{ id: string; name: string; floorId: string }>; floorPlan: { id: string; floorId: string; fileType: 'IMAGE' | 'PDF' | 'DXF'; renderedPath: string; thumbnailPath?: string; width: number; height: number; displayScale: number; updatedAt: string } | null } }>(
      `/floors/${id}`,
    ),
  create: (body: { buildingId: string; name: string; level?: number }) =>
    api.post<{ data: Floor }>('/floors', body),
  update: (id: string, body: Partial<{ name: string; level: number; noShowReleaseEnabled: boolean | null; qrCheckInMode: QrCheckInMode | null }>) =>
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
  accessSummary: (id: string) => api.get<{ data: AccessSummary }>(`/floors/${id}/access-summary`),
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
    // Present on the raw API response but not needed by every consumer
    // (e.g. the Bookings page's desk-focused card) — declared optional so
    // callers that do need this equipment-tracking detail (My Assets) can
    // read it without a second, near-duplicate endpoint.
    description?: string | null
    serialNumber?: string | null
    assetTag?: string | null
    status?: string
  }
}

// A favourited asset enriched with its location (from GET /assets/favourites).
export type FavouriteAsset = Asset & {
  floor?: { id: string; name: string; building?: { id: string; name: string } | null } | null
  primaryZone?: { id: string; name: string } | null
}

export const assetsApi = {
  list: (params?: { mine?: boolean; unplaced?: boolean }) => api.get<{ data: Asset[] }>(
    `/assets${params?.mine ? '?mine=true' : params?.unplaced ? '?unplaced=true' : ''}`,
  ),
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
  clearFloorAssignments: (floorId: string) =>
    api.delete<{ data: { cleared: number } }>(`/assets/user-assignments/by-floor/${floorId}`),
  bulkAssignments: (rows: Array<{ assetId: string; userEmail: string; isPrimary?: boolean }>) =>
    api.post<{ data: { assigned: number; errors: Array<{ row: number; assetId: string; userEmail: string; error: string }> } }>('/assets/user-assignments/bulk', { rows }),
  exportAssignments: (buildingId?: string) =>
    api.get<{ data: Array<{ assetId: string; assetName: string; userEmail: string; isPrimary: boolean }> }>(
      `/assets/user-assignments/export${buildingId ? `?buildingId=${encodeURIComponent(buildingId)}` : ''}`,
    ),
  makeAvailable: (assetId: string) =>
    api.post<{ data: { queued: number; action: 'none' | 'auto_confirmed' | 'promoted'; userId?: string; claimDeadline?: string } }>(`/assets/${assetId}/make-available`),
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
  updateCategory: (id: string, body: { name?: string; description?: string; defaultIsBookable?: boolean; defaultIcon?: string | null; colour?: string }) =>
    api.patch<{ data: AssetCategory }>(`/assets/categories/${id}`, body),
  deleteCategory: (id: string) =>
    api.delete<{ data: { ok: true } }>(`/assets/categories/${id}`),
  uploadCategoryIcon: (id: string, file: File) => {
    const form = new FormData()
    form.append('file', file)
    return api.post<{ data: AssetCategory }>(`/assets/categories/${id}/icon`, form)
  },
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
  // Favourites
  listFavourites: () => api.get<{ data: FavouriteAsset[] }>('/assets/favourites'),
  addFavourite: (id: string) =>
    api.post<{ data: { ok: true; favourited: boolean } }>(`/assets/${id}/favourite`),
  removeFavourite: (id: string) =>
    api.delete<{ data: { ok: true; favourited: boolean } }>(`/assets/${id}/favourite`),
  // "Suggested for you" — ranked available desks for a date, for the booking flow
  suggestions: (date: string) =>
    api.get<{ data: FavouriteAsset[] }>(`/assets/suggestions?date=${date}`),
  // Recurring weekday availability (assigned desks)
  getAvailabilityRules: (id: string) =>
    api.get<{ data: { weekdays: number[] } }>(`/assets/${id}/availability-rules`),
  setAvailabilityRules: (id: string, weekdays: number[]) =>
    api.put<{ data: { weekdays: number[] } }>(`/assets/${id}/availability-rules`, { weekdays }),
  // QR-scan landing data — see routes/assets.ts's GET /:id/qr-status
  qrStatus: (id: string) =>
    api.get<{
      data: {
        qrCheckInMode: QrCheckInMode
        asset: { id: string; name: string; bookingLabel: string | null; floorName: string | null; buildingName: string | null }
        canBookNow: boolean
        deniedReason?: string | null
        proposedStartsAt?: string
        proposedEndsAt?: string
        currentBooking: { id: string | null; isOwnBooking: boolean; startsAt: string; endsAt: string; checkedInAt: string | null } | null
      }
    }>(`/assets/${id}/qr-status`),
}

// --- Bookings ---
export const bookingsApi = {
  list: (status?: 'upcoming' | 'past' | 'all') =>
    api.get<{ data: Booking[]; meta: { total: number } }>(
      `/bookings${status ? `?status=${status}` : ''}`,
    ),
  get: (id: string) => api.get<{ data: Booking }>(`/bookings/${id}`),
  create: (body: { assetId: string; startsAt: string; endsAt: string; notes?: string; attendeeCount?: number }) =>
    api.post<{ data: Booking }>('/bookings', body),
  update: (id: string, body: Partial<{ startsAt: string; endsAt: string; notes: string; attendeeCount: number | null }>) =>
    api.patch<{ data: Booking }>(`/bookings/${id}`, body),
  cancel: (id: string) => api.delete<{ data: { ok: true } }>(`/bookings/${id}`),
  checkIn: (id: string) => api.post<{ data: { id: string; checkedInAt: string } }>(`/bookings/${id}/check-in`),
  report: (params: {
    from?: string
    to?: string
    userId?: string
    assetId?: string
    floorId?: string
    buildingId?: string
    status?: 'CONFIRMED' | 'CANCELLED' | 'COMPLETED'
    page?: number
    limit?: number
  }) => {
    const qs = new URLSearchParams()
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== '') qs.set(k, String(v))
    }
    return api.get<{ data: Booking[]; meta: { page: number; limit: number; total: number; totalPages: number } }>(
      `/bookings/report${qs.toString() ? `?${qs}` : ''}`,
    )
  },
  // Transfer — hand a booking to a colleague
  transfer: (id: string, toUserId: string) =>
    api.post<{ data: BookingTransfer }>(`/bookings/${id}/transfer`, { toUserId }),
  listTransfers: () =>
    api.get<{ data: { sent: BookingTransfer[]; received: BookingTransfer[] } }>('/bookings/transfers'),
  acceptTransfer: (id: string) =>
    api.post<{ data: { ok: true } }>(`/bookings/transfers/${id}/accept`),
  declineTransfer: (id: string) =>
    api.post<{ data: { ok: true } }>(`/bookings/transfers/${id}/decline`),
  cancelTransfer: (id: string) =>
    api.delete<{ data: { ok: true } }>(`/bookings/transfers/${id}`),
  // Swap — two users trade bookings at the same time
  swapCandidate: (bookingId: string, userId: string) =>
    api.get<{ data: BookingSummaryMatch | null }>(`/bookings/${bookingId}/swap-candidate?userId=${encodeURIComponent(userId)}`),
  swapRequest: (bookingId: string, withBookingId: string) =>
    api.post<{ data: BookingSwap }>(`/bookings/${bookingId}/swap-request`, { withBookingId }),
  listSwaps: () =>
    api.get<{ data: { sent: BookingSwap[]; received: BookingSwap[] } }>('/bookings/swaps'),
  acceptSwap: (id: string) =>
    api.post<{ data: { ok: true } }>(`/bookings/swaps/${id}/accept`),
  declineSwap: (id: string) =>
    api.post<{ data: { ok: true } }>(`/bookings/swaps/${id}/decline`),
  cancelSwap: (id: string) =>
    api.delete<{ data: { ok: true } }>(`/bookings/swaps/${id}`),
}

interface BookingSummaryMatch {
  id: string
  startsAt: string
  endsAt: string
  asset: { id: string; name: string }
}

// --- Queue ---
export const queueApi = {
  list: (includeHistory?: boolean) =>
    api.get<{ data: QueueEntry[] }>(`/queue${includeHistory ? '?include_history=true' : ''}`),
  join: (body: { assetId: string; wantedStartsAt: string; wantedEndsAt: string; expiresAt: string }) =>
    api.post<{ data: QueueEntry }>('/queue', body),
  leave: (id: string) => api.delete<{ data: { ok: true } }>(`/queue/${id}`),
  claim: (id: string) => api.post<{ data: Booking }>(`/queue/${id}/claim`),
  claimByToken: (token: string) =>
    api.post<{ data: { booking: Booking; queueEntry: { id: string; status: string } } }>('/queue/claim-by-token', { token }),
}

// --- Subscriptions ---
export const subscriptionsApi = {
  list: () => api.get<{ data: FloorSubscription[] }>('/subscriptions'),
  create: (body: { floorId: string; zoneIds?: string[] }) =>
    api.post<{ data: FloorSubscription }>('/subscriptions', body),
  update: (id: string, body: { zoneIds: string[] }) =>
    api.put<{ data: FloorSubscription }>(`/subscriptions/${id}`, body),
  remove: (id: string) => api.delete<{ data: { ok: true } }>(`/subscriptions/${id}`),
}

// --- Users (admin) ---
export const usersApi = {
  list: (params?: { page?: number; limit?: number; q?: string }) => {
    const qs = new URLSearchParams()
    if (params?.page) qs.set('page', String(params.page))
    if (params?.limit) qs.set('limit', String(params.limit))
    if (params?.q) qs.set('search', params.q) // backend uses 'search' param
    return api.get<{ data: User[]; meta: { total: number; page: number; limit: number; totalPages: number } }>(
      `/users${qs.toString() ? `?${qs}` : ''}`,
    )
  },
  get: (id: string) => api.get<{ data: User }>(`/users/${id}`),
  // Colleague picker for any authenticated user (transfer/swap/allow-list) —
  // unlike list() above, not SUPER_ADMIN-gated, and returns only id/displayName/email.
  search: (q: string) => api.get<{ data: Pick<User, 'id' | 'displayName' | 'email'>[] }>(`/users/search?q=${encodeURIComponent(q)}`),
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
  bulkImport: (rows: Array<Record<string, string>>) =>
    api.post<{ data: { created: number; updated: number; errors: Array<{ row: number; message: string }> } }>(
      '/users/bulk-import',
      { rows },
    ),
  getNotificationPreferences: () =>
    api.get<{ data: { preferences: Record<string, { email?: boolean; inApp?: boolean; push?: boolean }> } }>(
      '/users/me/notification-preferences',
    ),
  updateNotificationPreferences: (preferences: Record<string, { email?: boolean; inApp?: boolean; push?: boolean }>) =>
    api.patch<{ data: { ok: boolean } }>('/users/me/notification-preferences', { preferences }),
  changePassword: (body: { currentPassword: string; newPassword: string }) =>
    api.post<{ data: { ok: boolean } }>('/users/me/password', body),
  resetPassword: (id: string, body: { password: string }) =>
    api.post<{ data: { ok: boolean } }>(`/users/${id}/password/reset`, body),
  effectiveAccess: (id: string) =>
    api.get<{ data: EffectiveAccess }>(`/users/${id}/effective-access`),
}

// --- Web Push ---
export const pushApi = {
  vapidPublicKey: () => api.get<{ data: { publicKey: string | null } }>('/push/vapid-public-key'),
  subscribe: (subscription: { endpoint: string; keys: { p256dh: string; auth: string } }) =>
    api.post<{ data: { ok: true } }>('/push/subscribe', subscription),
  unsubscribe: (endpoint: string) =>
    api.post<{ data: { ok: true } }>('/push/unsubscribe', { endpoint }),
}

// --- RBAC inspection types ---
export type RoleSource = 'MANUAL' | 'IDP'

export interface EffectiveAccess {
  user: { id: string; email: string; displayName: string }
  globalRole: string
  globalRoleSource: RoleSource
  globalRoleVia: string | null
  groups: Array<{ id: string; name: string; source: RoleSource; confersAdmin: boolean }>
  grants: Array<{ scope: 'BUILDING' | 'FLOOR'; role: string; targetId: string; targetName: string; buildingName?: string; via: string; source: RoleSource }>
  idp: { lastSsoLoginAt: string | null; lastIdpGroups: string[] }
}

export interface AccessSummary {
  name: string
  building?: { id: string; name: string }
  access: { restricted: boolean; groups: Array<{ id: string; name: string }> }
  managers: {
    direct: Array<{ id: string; displayName: string; email: string; source: RoleSource }>
    viaGroups: Array<{ id: string; name: string; memberCount: number; source: RoleSource }>
    inheritedFromBuildingAdmins?: Array<{ id: string; displayName: string; email: string }>
  }
}

export interface MappingTestResult {
  evaluatedAgainst: 'provided' | 'user' | 'all-known'
  inputGroups: string[]
  mappings: Array<{ idpGroup: string; matched: boolean; roomerGroup: { id: string; name: string } | null; confersAdmin: boolean }>
  resolvedGroups: Array<{ id: string; name: string }>
  resolvedGlobalRole: string
  unmatchedMappings: string[]
}

// --- Settings ---

type OrgSettings = {
  id: string
  name: string
  defaultBookingDurationHours: number
  maxAdvanceBookingDays: number
  maxBookingsPerUser: number
  queueClaimWindowHours: number
  dateFormat: string
  noShowReleaseEnabled?: boolean
  checkInGraceMinutes?: number
  qrCheckInMode?: QrCheckInMode
  weeklyReportEnabled?: boolean
}

export interface BrandingBanner {
  enabled: boolean
  text: string
  bgColor: string
  textColor: string
}

export interface Branding {
  appName?: string | null
  sidebarTitle?: string | null
  sidebarSubtitle?: string | null
  primaryColor?: string
  primaryColorDark?: string
  logoPath?: string
  faviconPath?: string
  borderRadius?: 'sharp' | 'medium' | 'large'
  navStyle?: 'sidebar' | 'topbar' | 'floating' | 'rail'
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

export type EmailSettings = {
  host: string
  port: number | null
  secure: boolean
  user: string
  from: string
  hasPassword: boolean
  envOverrides: { host: boolean; port: boolean; secure: boolean; user: boolean; pass: boolean; from: boolean }
  effective: { host: string; port: number; secure: boolean; user?: string; from: string }
}

export const settingsApi = {
  testEmail: (to?: string) =>
    api.post<{ data: { ok: true; message: string } }>('/settings/test-email', to ? { to } : {}),
  getEmail: () => api.get<{ data: EmailSettings }>('/settings/email'),
  updateEmail: (body: Partial<{ host: string; port: number; secure: boolean; user: string; from: string; password: string }>) =>
    api.put<{ data: EmailSettings }>('/settings/email', body),
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
  getPublic: () => api.get<{ data: { dateFormat: string } }>('/settings/public'),
  getScim: () =>
    api.get<{ data: { enabled: boolean; hasToken: boolean; endpointUrl: string } }>('/settings/scim'),
  patchScim: (body: { enabled: boolean }) =>
    api.patch<{ data: { enabled: boolean } }>('/settings/scim', body),
  generateScimToken: () =>
    api.post<{ data: { token: string; endpointUrl: string } }>('/settings/scim/token', {}),
  revokeScimToken: () =>
    api.delete<{ data: { ok: boolean } }>('/settings/scim/token'),
  syncLdap: () =>
    api.post<{ data: { created: number; updated: number; deactivated: number; skipped: number; errors: Array<{ dn: string; message: string }> } }>('/settings/auth-config/ldap/sync', {}),
  updateLoginSettings: (body: { defaultProvider?: LoginProvider | null; showProviderSelector?: boolean }) =>
    api.patch<{ data: { ok: boolean } }>('/settings/login-settings', body),
}

// --- Email Templates ---
export interface EmailTemplate {
  subject: string
  html: string
  isCustom: boolean
}

export const emailTemplatesApi = {
  get: (type: string) =>
    api.get<{ data: EmailTemplate }>(`/settings/email-templates/${type}`),
  save: (type: string, body: { subject: string; html: string }) =>
    api.put<{ data: EmailTemplate & { type: string } }>(`/settings/email-templates/${type}`, body),
  reset: (type: string) =>
    api.delete<{ data: EmailTemplate & { type: string } }>(`/settings/email-templates/${type}`),
  sendTest: (type: string, body?: { subject?: string; html?: string }) =>
    api.post<{ data: { ok: boolean; sentTo: string } }>(`/settings/email-templates/${type}/test`, body ?? {}),
}

// --- Auth Providers (public) ---
export type LoginProvider = 'local' | 'ldap' | 'oidc' | 'saml'
export interface AuthProviders {
  oidc: { enabled: boolean; label: string }
  saml: { enabled: boolean; label: string }
  ldap: { enabled: boolean }
  local: { enabled: boolean }
  defaultProvider: LoginProvider | null
  showProviderSelector: boolean
}
export const authProvidersApi = {
  list: () => api.get<{ data: AuthProviders }>('/auth/providers'),
  testMapping: (provider: string, body: { groups?: string[]; userId?: string }) =>
    api.post<{ data: MappingTestResult }>(`/settings/auth-config/${provider}/test-mapping`, body),
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
  cancellationRate: number; noShowBookings: number; noShowRate: number
  uniqueBookers: number; avgDailyBookings: number
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
export type DepartmentAnalyticsPoint = {
  departmentId: string; departmentName: string
  bookingCount: number; deskDays: number; memberCount: number
}
export type CapacityPlanningPoint = {
  buildingId: string; buildingName: string
  currentDeskCount: number; peakDailyAttendance: number; averageDailyAttendance: number
  recommendedDeskCount: number; spareCapacity: number
}
export type UtilisationTrendPoint = { month: string; bookingCount: number; utilisationPct: number }
export type CostPerSeatPoint = {
  buildingId: string; buildingName: string
  monthlyRent: number; currency: string; deskCount: number; costPerSeatPerDay: number
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
  departments: (params?: AnalyticsParams) =>
    api.get<{ data: DepartmentAnalyticsPoint[] }>(`/analytics/departments${analyticsQs(params)}`),
  managerRollup: (userId: string, params?: AnalyticsParams) => {
    const qs = analyticsQs(params)
    const sep = qs ? '&' : '?'
    return api.get<{ data: ManagerRollup }>(`/analytics/manager-rollup${qs}${sep}userId=${encodeURIComponent(userId)}`)
  },
  capacityPlanning: (params?: AnalyticsParams) =>
    api.get<{ data: CapacityPlanningPoint[] }>(`/analytics/capacity-planning${analyticsQs(params)}`),
  utilisationTrend: (params?: AnalyticsParams) =>
    api.get<{ data: UtilisationTrendPoint[] }>(`/analytics/utilisation-trend${analyticsQs(params)}`),
  costPerSeat: (params?: AnalyticsParams) =>
    api.get<{ data: CostPerSeatPoint[] }>(`/analytics/cost-per-seat${analyticsQs(params)}`),
}

export type ManagerRollupBranch = { rootId: string; rootName: string; peopleCount: number; bookingCount: number; deskDays: number }
export type ManagerRollup = {
  manager: { id: string; displayName: string; email: string }
  peopleCount: number
  bookingCount: number
  deskDays: number
  directReports: ManagerRollupBranch[]
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
    return api.get<{ data: Notification[]; meta: { total: number; page: number; limit: number; totalPages: number } }>(
      `/notifications${qs.toString() ? `?${qs}` : ''}`,
    )
  },
  unreadCount: () => api.get<{ data: { count: number } }>('/notifications/unread-count'),
  markAllRead: () => api.patch<{ data: { ok: true } }>('/notifications/read-all'),
  markRead: (id: string) => api.patch<{ data: { ok: true } }>(`/notifications/${id}/read`),
}

// --- Recurring bookings ---
export const recurringBookingsApi = {
  list: () => api.get<{ data: RecurringBookingRule[] }>('/recurring-bookings'),
  get: (id: string) => api.get<{ data: RecurringBookingRule }>(`/recurring-bookings/${id}`),
  create: (body: {
    assetId: string
    frequency: 'DAILY' | 'WEEKLY' | 'MONTHLY'
    dayOfWeek?: number
    startTime: string
    endTime: string
    firstDate: string
    lastDate: string
    attendeeCount?: number
  }) => api.post<{ data: RecurringBookingRule }>('/recurring-bookings', body),
  update: (id: string, body: { lastDate: string }) =>
    api.patch<{ data: RecurringBookingRule }>(`/recurring-bookings/${id}`, body),
  cancel: (id: string) => api.delete<{ data: { ok: true } }>(`/recurring-bookings/${id}`),
}

// --- Webhooks ---
export interface WebhookEndpoint {
  id: string
  url: string
  events: string[]
  enabled: boolean
  createdAt: string
  updatedAt: string
}

export interface WebhookDelivery {
  id: string
  event: string
  statusCode: number | null
  success: boolean
  error: string | null
  attempt: number
  createdAt: string
}

export const webhooksApi = {
  listEvents: () => api.get<{ data: string[] }>('/webhooks/events'),
  list: () => api.get<{ data: WebhookEndpoint[] }>('/webhooks'),
  create: (body: { url: string; events: string[]; secret?: string; enabled?: boolean }) =>
    api.post<{ data: WebhookEndpoint & { secret: string } }>('/webhooks', body),
  update: (id: string, body: { url?: string; events?: string[]; secret?: string; enabled?: boolean }) =>
    api.patch<{ data: WebhookEndpoint }>(`/webhooks/${id}`, body),
  delete: (id: string) => api.delete<{ data: { ok: true } }>(`/webhooks/${id}`),
  ping: (id: string) => api.post<{ data: { ok: true } }>(`/webhooks/${id}/ping`),
  deliveries: (id: string, page = 1, limit = 50) =>
    api.get<{ data: WebhookDelivery[]; meta: { total: number; page: number; limit: number; totalPages: number } }>(
      `/webhooks/${id}/deliveries?page=${page}&limit=${limit}`,
    ),
}

// --- Departments (flat; hierarchy is inferred from manager links via orgApi) ---
export interface Department {
  id: string
  name: string
  _count?: { members: number }
}

export interface DepartmentMember {
  id: string
  email: string
  displayName: string
  globalRole: string
  accountStatus: string
}

// --- Org hierarchy (manager-derived) ---
export interface OrgPerson {
  id: string
  displayName: string
  email: string
  departmentId: string | null
  managerId: string | null
}
export interface OrgDepartment {
  id: string
  name: string
  memberCount: number
  inferredParentId: string | null
}
export interface OrgHierarchy {
  people: OrgPerson[]
  departments: OrgDepartment[]
  unresolvedManagers: number
}
export const orgApi = {
  hierarchy: () => api.get<{ data: OrgHierarchy }>('/org/hierarchy'),
}

export const departmentsApi = {
  list: () => api.get<{ data: Department[] }>('/departments'),
  get: (id: string) => api.get<{ data: Department }>(`/departments/${id}`),
  create: (body: { name: string }) =>
    api.post<{ data: Department }>('/departments', body),
  update: (id: string, body: { name?: string }) =>
    api.put<{ data: Department }>(`/departments/${id}`, body),
  delete: (id: string) => api.delete<{ data: { ok: true } }>(`/departments/${id}`),
  listMembers: (id: string, search?: string) =>
    api.get<{ data: DepartmentMember[] }>(
      `/departments/${id}/members${search ? `?search=${encodeURIComponent(search)}` : ''}`,
    ),
  addMember: (id: string, userId: string) =>
    api.post<{ data: { ok: true } }>(`/departments/${id}/members`, { userId }),
  removeMember: (id: string, userId: string) =>
    api.delete<{ data: { ok: true } }>(`/departments/${id}/members/${userId}`),
}

// --- Directory / colleague finder ---
export interface WhereaboutsLocation {
  assetId: string
  assetName: string
  zoneId: string | null
  zoneName: string | null
  floorId: string | null
  floorName: string | null
  buildingId: string | null
  buildingName: string | null
}
export interface WhereaboutsPerson {
  user: { id: string; displayName: string; email: string }
  today: (WhereaboutsLocation & { startsAt: string; endsAt: string })[]
  assignedDesks: (WhereaboutsLocation & { isPrimary: boolean })[]
}
export const directoryApi = {
  whereabouts: (params?: { search?: string; date?: string; buildingId?: string; floorId?: string }) => {
    const qs = new URLSearchParams()
    if (params?.search) qs.set('search', params.search)
    if (params?.date) qs.set('date', params.date)
    if (params?.buildingId) qs.set('buildingId', params.buildingId)
    if (params?.floorId) qs.set('floorId', params.floorId)
    return api.get<{ data: WhereaboutsPerson[]; meta: { total: number; date: string } }>(
      `/directory/whereabouts${qs.toString() ? `?${qs}` : ''}`,
    )
  },
}

// --- Self-service floor manager access requests ---
export const managerRequestsApi = {
  create: (floorId: string, note?: string) =>
    api.post<{ data: FloorManagerRequest }>('/manager-requests', { floorId, note }),
  mine: () => api.get<{ data: FloorManagerRequest[] }>('/manager-requests/mine'),
  // Admin dashboard — scoped server-side to what the caller can review (Super Admin: all, Building Admin: their buildings only).
  list: (status?: ManagerRequestStatus | 'all') =>
    api.get<{ data: FloorManagerRequest[] }>(`/manager-requests${status ? `?status=${status}` : ''}`),
  approve: (id: string) => api.post<{ data: { ok: true } }>(`/manager-requests/${id}/approve`, {}),
  reject: (id: string, reviewNote?: string) =>
    api.post<{ data: { ok: true } }>(`/manager-requests/${id}/reject`, { reviewNote }),
  withdraw: (id: string) => api.delete<{ data: { ok: true } }>(`/manager-requests/${id}`),
}
