import { useState, useEffect } from 'react'
import { format, addHours, startOfDay, addDays } from 'date-fns'
import { MapPin, Clock, Users, CheckCircle, XCircle, AlertCircle, Shield, UserPlus, UserMinus, ChevronDown, ChevronUp, Pencil, X } from 'lucide-react'
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { useCreateBooking, useJoinQueue, useLeaveQueue, useClaimDesk, useCancelBooking, useMakeAvailable, useQueueEntries } from '@/hooks/useBookings'
import { formatDateRange } from '@/lib/utils'
import { useAuthStore } from '@/stores/auth'
import { assetsApi, usersApi, settingsApi } from '@/lib/api'
import type { AssetWithStatus } from '@/types'

interface DeskPanelProps {
  desk: AssetWithStatus | null
  date: Date
  floorId?: string
  floorZones?: Array<{ id: string; name: string; colour: string }>
  onClose: () => void
  onBookingCreated: () => void
}

type TimePreset = 'full' | 'am' | 'pm' | 'custom'

// ─── Add to Allow-List Dialog ─────────────────────────────────────────────────

function AddAllowListDialog({
  open,
  deskId,
  onClose,
}: {
  open: boolean
  deskId: string
  onClose: () => void
}) {
  const qc = useQueryClient()
  const [search, setSearch] = useState('')
  const [selectedUserId, setSelectedUserId] = useState('')

  const { data: users } = useQuery({
    queryKey: ['users', 'search', search],
    queryFn: () => usersApi.list({ q: search, limit: 20 }),
    select: (r) => r.data,
    enabled: search.length >= 2,
  })

  const add = useMutation({
    mutationFn: () => assetsApi.addAllowList(deskId, selectedUserId),
    onSuccess: () => {
      toast.success('User added to allow list')
      qc.invalidateQueries({ queryKey: ['assets', deskId, 'allow-list'] })
      onClose()
      setSearch('')
      setSelectedUserId('')
    },
    onError: () => toast.error('Failed to add user'),
  })

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add User to Allow List</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div>
            <Label>Search user</Label>
            <Input
              className="mt-1.5"
              placeholder="Name or email…"
              value={search}
              onChange={(e) => { setSearch(e.target.value); setSelectedUserId('') }}
            />
          </div>
          {users && users.length > 0 && (
            <div className="rounded-md border divide-y max-h-48 overflow-y-auto">
              {users.map((u) => (
                <button
                  key={u.id}
                  type="button"
                  className={`w-full text-left px-3 py-2 hover:bg-muted transition-colors ${selectedUserId === u.id ? 'bg-muted' : ''}`}
                  onClick={() => setSelectedUserId(u.id)}
                >
                  <p className="text-sm font-medium">{u.displayName}</p>
                  <p className="text-xs text-muted-foreground">{u.email}</p>
                </button>
              ))}
            </div>
          )}
          {search.length >= 2 && (!users || users.length === 0) && (
            <p className="text-sm text-muted-foreground">No users found</p>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            onClick={() => add.mutate()}
            disabled={!selectedUserId || add.isPending}
          >
            {add.isPending ? 'Adding…' : 'Add to allow list'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ─── Add Permanent User Dialog ───────────────────────────────────────────────

function AddAssignmentDialog({
  open,
  deskId,
  onClose,
}: {
  open: boolean
  deskId: string
  onClose: () => void
}) {
  const qc = useQueryClient()
  const [search, setSearch] = useState('')
  const [selectedUserId, setSelectedUserId] = useState('')
  const [makePrimary, setMakePrimary] = useState(false)

  const { data: users } = useQuery({
    queryKey: ['users', 'search', search],
    queryFn: () => usersApi.list({ q: search, limit: 20 }),
    select: (r) => r.data,
    enabled: search.length >= 2,
  })

  const assign = useMutation({
    mutationFn: () => assetsApi.addAssignment(deskId, { userId: selectedUserId, isPrimary: makePrimary }),
    onSuccess: () => {
      toast.success('User assigned to desk')
      qc.invalidateQueries({ queryKey: ['floors'] })
      onClose()
      setSearch('')
      setSelectedUserId('')
      setMakePrimary(false)
    },
    onError: () => toast.error('Failed to assign user'),
  })

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add Permanent User</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div>
            <Label>Search user</Label>
            <Input
              className="mt-1.5"
              placeholder="Name or email…"
              value={search}
              onChange={(e) => { setSearch(e.target.value); setSelectedUserId('') }}
            />
          </div>
          {users && users.length > 0 && (
            <div className="rounded-md border divide-y max-h-48 overflow-y-auto">
              {users.map((u) => (
                <button
                  key={u.id}
                  type="button"
                  className={`w-full text-left px-3 py-2 hover:bg-muted transition-colors ${selectedUserId === u.id ? 'bg-muted' : ''}`}
                  onClick={() => setSelectedUserId(u.id)}
                >
                  <p className="text-sm font-medium">{u.displayName}</p>
                  <p className="text-xs text-muted-foreground">{u.email}</p>
                </button>
              ))}
            </div>
          )}
          {search.length >= 2 && (!users || users.length === 0) && (
            <p className="text-sm text-muted-foreground">No users found</p>
          )}
          <div className="flex items-center gap-2">
            <input
              id="make-primary"
              type="checkbox"
              checked={makePrimary}
              onChange={(e) => setMakePrimary(e.target.checked)}
              className="h-4 w-4 rounded border-border"
            />
            <Label htmlFor="make-primary" className="cursor-pointer text-sm">Set as primary user</Label>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            onClick={() => assign.mutate()}
            disabled={!selectedUserId || assign.isPending}
          >
            {assign.isPending ? 'Assigning…' : 'Add user'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ─── Add Zone Dialog ──────────────────────────────────────────────────────────

function AddZoneDialog({
  open,
  deskId,
  primaryZoneId,
  floorZones,
  existingZoneIds,
  onClose,
}: {
  open: boolean
  deskId: string
  primaryZoneId: string
  floorZones: Array<{ id: string; name: string; colour: string }>
  existingZoneIds: string[]
  onClose: () => void
}) {
  const qc = useQueryClient()
  const [selectedZoneId, setSelectedZoneId] = useState('')

  const available = floorZones.filter(
    (z) => z.id !== primaryZoneId && !existingZoneIds.includes(z.id),
  )

  const add = useMutation({
    mutationFn: () => assetsApi.addZone(deskId, selectedZoneId),
    onSuccess: () => {
      toast.success('Zone added')
      qc.invalidateQueries({ queryKey: ['assets', deskId, 'zones'] })
      onClose()
      setSelectedZoneId('')
    },
    onError: (e: unknown) => {
      const msg = e instanceof Error ? e.message : 'Failed to add zone'
      toast.error(msg)
    },
  })

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add to Additional Zone</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          {available.length === 0 ? (
            <p className="text-sm text-muted-foreground">No other zones available on this floor.</p>
          ) : (
            <div className="rounded-md border divide-y max-h-48 overflow-y-auto">
              {available.map((z) => (
                <button
                  key={z.id}
                  type="button"
                  className={`w-full flex items-center gap-2 text-left px-3 py-2 hover:bg-muted transition-colors ${selectedZoneId === z.id ? 'bg-muted' : ''}`}
                  onClick={() => setSelectedZoneId(z.id)}
                >
                  <span className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: z.colour }} />
                  <span className="text-sm font-medium">{z.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            onClick={() => add.mutate()}
            disabled={!selectedZoneId || add.isPending || available.length === 0}
          >
            {add.isPending ? 'Adding…' : 'Add zone'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ─── Edit Asset Dialog ────────────────────────────────────────────────────────

function EditAssetDialog({
  open,
  desk,
  onClose,
}: {
  open: boolean
  desk: AssetWithStatus
  onClose: () => void
}) {
  const qc = useQueryClient()
  const [name, setName] = useState(desk.name)
  const [description, setDescription] = useState(desk.description ?? '')
  const [bookingLabel, setBookingLabel] = useState(desk.bookingLabel ?? '')
  const [amenityInput, setAmenityInput] = useState('')
  const [amenities, setAmenities] = useState<string[]>(desk.amenities ?? [])
  const [bookingStatus, setBookingStatus] = useState<'OPEN' | 'RESTRICTED' | 'ASSIGNED' | 'DISABLED'>(
    desk.rawBookingStatus ?? 'OPEN',
  )

  // Reset form when dialog opens with new desk data
  useEffect(() => {
    if (open) {
      setName(desk.name)
      setDescription(desk.description ?? '')
      setBookingLabel(desk.bookingLabel ?? '')
      setAmenities(desk.amenities ?? [])
      setBookingStatus(desk.rawBookingStatus ?? 'OPEN')
    }
  }, [open, desk])

  const update = useMutation({
    mutationFn: () =>
      assetsApi.update(desk.id, {
        name: name.trim(),
        description: description.trim() || undefined,
        bookingLabel: bookingLabel.trim() || undefined,
        amenities,
        bookingStatus,
      }),
    onSuccess: () => {
      toast.success('Asset updated')
      qc.invalidateQueries({ queryKey: ['floors'] })
      onClose()
    },
    onError: () => toast.error('Failed to update asset'),
  })

  const addAmenity = () => {
    const val = amenityInput.trim()
    if (val && !amenities.includes(val)) {
      setAmenities((prev) => [...prev, val])
    }
    setAmenityInput('')
  }

  const removeAmenity = (a: string) => setAmenities((prev) => prev.filter((x) => x !== a))

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Edit Asset</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-1">
          <div>
            <Label>Name</Label>
            <Input className="mt-1.5" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div>
            <Label>Description</Label>
            <Textarea
              className="mt-1.5 resize-none"
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional description…"
            />
          </div>
          <div>
            <Label>Booking label</Label>
            <Input
              className="mt-1.5"
              value={bookingLabel}
              onChange={(e) => setBookingLabel(e.target.value)}
              placeholder="e.g. Hot desk, Standing desk…"
            />
          </div>
          <div>
            <Label>Booking status</Label>
            <Select value={bookingStatus} onValueChange={(v) => setBookingStatus(v as 'OPEN' | 'RESTRICTED' | 'ASSIGNED' | 'DISABLED')}>
              <SelectTrigger className="mt-1.5">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="OPEN">Open (anyone can book)</SelectItem>
                <SelectItem value="RESTRICTED">Restricted (allow list only)</SelectItem>
                <SelectItem value="ASSIGNED">Assigned (permanent user only)</SelectItem>
                <SelectItem value="DISABLED">Disabled (not bookable)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Amenities</Label>
            <div className="flex gap-2 mt-1.5">
              <Input
                value={amenityInput}
                onChange={(e) => setAmenityInput(e.target.value)}
                placeholder="e.g. Monitor, Sit-stand…"
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addAmenity() } }}
              />
              <Button type="button" variant="outline" size="sm" onClick={addAmenity} className="shrink-0">
                Add
              </Button>
            </div>
            {amenities.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mt-2">
                {amenities.map((a) => (
                  <Badge key={a} variant="secondary" className="gap-1 pr-1.5">
                    {a}
                    <button
                      type="button"
                      onClick={() => removeAmenity(a)}
                      className="ml-0.5 rounded-full hover:text-destructive"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </Badge>
                ))}
              </div>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={() => update.mutate()} disabled={!name.trim() || update.isPending}>
            {update.isPending ? 'Saving…' : 'Save changes'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ─── Main DeskPanel ───────────────────────────────────────────────────────────

export function DeskPanel({ desk, date, floorId: _floorId, floorZones = [], onClose, onBookingCreated }: DeskPanelProps) {
  const [timePreset, setTimePreset] = useState<TimePreset>('full')
  const [customStart, setCustomStart] = useState('09:00')
  const [customEnd, setCustomEnd] = useState('17:00')
  const [endDate, setEndDate] = useState<Date>(date)
  const [queueExpiry, setQueueExpiry] = useState('')

  // Keep endDate in sync when the floor page navigates to a different day
  useEffect(() => { setEndDate(date) }, [date])
  const [showAdmin, setShowAdmin] = useState(false)
  const [editAssetOpen, setEditAssetOpen] = useState(false)
  const [addAllowListOpen, setAddAllowListOpen] = useState(false)
  const [addAssignmentOpen, setAddAssignmentOpen] = useState(false)
  const [addZoneOpen, setAddZoneOpen] = useState(false)

  const { user } = useAuthStore()
  const isAdmin = user?.globalRole === 'SUPER_ADMIN'
  const isFloorManager = !isAdmin && (
    (user?.resourceRoles ?? []).some(
      (r) => r.scopeType === 'FLOOR' && r.floorId === _floorId && r.role === 'FLOOR_MANAGER',
    ) ||
    (user?.groupMemberships ?? []).some((m) =>
      (m.group.groupResourceRoles ?? []).some(
        (r) => r.scopeType === 'FLOOR' && r.floorId === _floorId && r.role === 'FLOOR_MANAGER',
      )
    )
  )
  const canManageDesk = isAdmin || isFloorManager

  const { data: orgSettings } = useQuery({
    queryKey: ['settings', 'organisation'],
    queryFn: () => settingsApi.getOrg(),
    select: (r) => r.data,
  })
  const maxAdvanceDays = orgSettings?.maxAdvanceBookingDays ?? 14
  const maxEndDateStr = format(addDays(date, maxAdvanceDays), 'yyyy-MM-dd')
  const isMultiDay = format(endDate, 'yyyy-MM-dd') !== format(date, 'yyyy-MM-dd')

  // Reset AM/PM preset when multi-day selection is made
  useEffect(() => {
    if (isMultiDay && (timePreset === 'am' || timePreset === 'pm')) {
      setTimePreset('full')
    }
  }, [isMultiDay, timePreset])

  const qc = useQueryClient()
  const createBooking = useCreateBooking()
  const joinQueue = useJoinQueue()
  const leaveQueue = useLeaveQueue()
  const claimDesk = useClaimDesk()
  const cancelBooking = useCancelBooking()
  const makeAvailable = useMakeAvailable()
  const { data: queueEntries } = useQueueEntries()

  const { data: allowList } = useQuery({
    queryKey: ['assets', desk?.id, 'allow-list'],
    queryFn: () => assetsApi.getAllowList(desk!.id),
    select: (r) => r.data,
    enabled: canManageDesk && !!desk && showAdmin,
  })

  const removeAllowList = useMutation({
    mutationFn: (userId: string) => assetsApi.removeAllowList(desk!.id, userId),
    onSuccess: () => {
      toast.success('User removed from allow list')
      qc.invalidateQueries({ queryKey: ['assets', desk?.id, 'allow-list'] })
    },
    onError: () => toast.error('Failed to remove user'),
  })

  const removeAssignment = useMutation({
    mutationFn: (userId: string) => assetsApi.removeAssignment(desk!.id, userId),
    onSuccess: () => {
      toast.success('User removed from desk')
      qc.invalidateQueries({ queryKey: ['floors'] })
    },
    onError: () => toast.error('Failed to remove user'),
  })

  const setPrimaryAssignment = useMutation({
    mutationFn: (userId: string) => assetsApi.setPrimaryAssignment(desk!.id, userId),
    onSuccess: () => {
      toast.success('Primary user updated')
      qc.invalidateQueries({ queryKey: ['floors'] })
    },
    onError: () => toast.error('Failed to update primary user'),
  })

  const { data: additionalZones } = useQuery({
    queryKey: ['assets', desk?.id, 'zones'],
    queryFn: () => assetsApi.getZones(desk!.id),
    select: (r) => r.data,
    enabled: canManageDesk && !!desk && showAdmin,
  })

  const removeZone = useMutation({
    mutationFn: (zoneId: string) => assetsApi.removeZone(desk!.id, zoneId),
    onSuccess: () => {
      toast.success('Zone removed')
      qc.invalidateQueries({ queryKey: ['assets', desk?.id, 'zones'] })
    },
    onError: () => toast.error('Failed to remove zone'),
  })

  if (!desk) return null

  const getBookingTimes = () => {
    const base = startOfDay(date)
    const endBase = startOfDay(endDate)
    if (timePreset === 'full') {
      return { start: base, end: new Date(endBase.getTime() + 23 * 3600000 + 59 * 60000) }
    }
    if (timePreset === 'am') {
      return { start: addHours(base, 8), end: addHours(base, 13) }
    }
    if (timePreset === 'pm') {
      return { start: addHours(base, 13), end: addHours(base, 18) }
    }
    const [sh, sm] = customStart.split(':').map(Number)
    const [eh, em] = customEnd.split(':').map(Number)
    const s = new Date(base)
    s.setHours(sh, sm, 0, 0)
    const e = new Date(endBase)
    e.setHours(eh, em, 0, 0)
    return { start: s, end: e }
  }

  const handleBook = async () => {
    const { start, end } = getBookingTimes()
    if (start >= end) {
      toast.error('Start time must be before end time')
      return
    }
    try {
      await createBooking.mutateAsync({
        assetId: desk.id,
        startsAt: start.toISOString(),
        endsAt: end.toISOString(),
      })
      onBookingCreated()
    } catch {
      // onError in useCreateBooking handles the toast
    }
  }

  const handleJoinQueue = async () => {
    const { start, end } = getBookingTimes()
    if (start >= end) {
      toast.error('Start time must be before end time')
      return
    }
    const minExpiry = Date.now() + 30 * 60000 // at least 30 min from now
    const expires = queueExpiry
      ? new Date(queueExpiry).toISOString()
      : new Date(Math.max(start.getTime() - 2 * 3600000, minExpiry)).toISOString()
    try {
      await joinQueue.mutateAsync({
        assetId: desk.id,
        wantedStartsAt: start.toISOString(),
        wantedEndsAt: end.toISOString(),
        expiresAt: expires,
      })
      onBookingCreated()
    } catch {
      // onError in useJoinQueue handles the toast
    }
  }

  const myQueueEntry = queueEntries?.find(
    (q) => q.assetId === desk.id && (q.status === 'WAITING' || q.status === 'PROMOTED'),
  )

  const isMyAssignedDesk = !!(
    desk.assignedUsers?.some((u) => u.id === user?.id) &&
    desk.rawBookingStatus === 'ASSIGNED'
  )

  const statusLabel: Record<string, string> = {
    available: 'Available',
    mine: 'Your booking',
    booked: 'Booked',
    assigned: 'Assigned',
    restricted: 'Restricted',
    disabled: 'Disabled',
    queued: 'You are queued',
    promoted: 'Claim available!',
    zone_conflict: 'Zone conflict',
  }

  const statusVariant: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
    available: 'default',
    mine: 'secondary',
    booked: 'destructive',
    assigned: 'secondary',
    restricted: 'outline',
    disabled: 'outline',
    queued: 'secondary',
    promoted: 'default',
    zone_conflict: 'outline',
  }

  const needsAllowList = desk.rawBookingStatus === 'RESTRICTED' || desk.rawBookingStatus === 'ASSIGNED'

  return (
    <>
      <Sheet open={!!desk} onOpenChange={(o) => !o && onClose()}>
        <SheetContent side="right" className="w-full max-w-md overflow-y-auto">
          <SheetHeader>
            <div className="flex items-start justify-between">
              <div>
                <SheetTitle className="text-xl">{desk.name}</SheetTitle>
                <SheetDescription className="flex items-center gap-1 mt-1">
                  <MapPin className="h-3 w-3" />
                  <span>{desk.zoneName}</span>
                </SheetDescription>
              </div>
              <Badge variant={statusVariant[desk.bookingStatus]}>
                {statusLabel[desk.bookingStatus]}
              </Badge>
            </div>
          </SheetHeader>

          <div className="mt-6 space-y-6">
            {/* Amenities */}
            {(desk.amenities ?? []).length > 0 && (
              <div>
                <p className="text-sm font-medium mb-2">Amenities</p>
                <div className="flex flex-wrap gap-1.5">
                  {(desk.amenities ?? []).map((a) => (
                    <Badge key={a} variant="secondary" className="text-xs">
                      {a}
                    </Badge>
                  ))}
                </div>
              </div>
            )}

            {/* Asset details */}
            {(desk.category?.name || desk.bookingLabel) && (
              <div className="rounded-md bg-muted/40 px-3 py-2.5 space-y-1">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1.5">Details</p>
                {desk.category?.name && (
                  <p className="text-sm">
                    <span className="text-muted-foreground">Category: </span>
                    <span className="font-medium">{desk.category.name}</span>
                  </p>
                )}
                {desk.bookingLabel && (
                  <p className="text-sm">
                    <span className="text-muted-foreground">Label: </span>
                    <span className="font-medium">{desk.bookingLabel}</span>
                  </p>
                )}
              </div>
            )}

            <Separator />

            {/* Permanent assignment indicator */}
            {desk.assignedUsers && desk.assignedUsers.length > 0 && (
              <div className="flex items-center gap-2 rounded-md bg-blue-50 border border-blue-200 px-3 py-2">
                <UserPlus className="h-3.5 w-3.5 text-blue-500 shrink-0" />
                <div className="min-w-0">
                  <p className="text-xs font-medium text-blue-800">Permanently assigned</p>
                  <p className="text-xs text-blue-600 truncate">
                    {desk.assignedUsers.find((u) => u.isPrimary)?.displayName ?? desk.assignedUsers[0].displayName}
                    {desk.assignedUsers.length > 1 && ` + ${desk.assignedUsers.length - 1} more`}
                  </p>
                </div>
              </div>
            )}

            {/* Date */}
            <div className="flex items-center gap-2 text-sm">
              <Clock className="h-4 w-4 text-muted-foreground" />
              <span>
                {isMultiDay
                  ? `${format(date, 'd MMM')} – ${format(endDate, 'd MMM yyyy')}`
                  : format(date, 'EEEE, d MMMM yyyy')
                }
              </span>
            </div>

            {/* Available: booking form */}
            {/* Assigned user: offer desk to the queue */}
            {isMyAssignedDesk && (
              <div className="rounded-md bg-blue-50 border border-blue-200 p-3 space-y-2">
                <p className="text-sm font-medium text-blue-800">This is your assigned desk</p>
                {(desk.queueDepth ?? 0) > 0 ? (
                  <p className="text-xs text-blue-600">
                    {desk.queueDepth} {desk.queueDepth === 1 ? 'person is' : 'people are'} waiting for this desk.
                  </p>
                ) : (
                  <p className="text-xs text-blue-600">No one is currently queued for this desk.</p>
                )}
                <Button
                  size="sm"
                  variant="outline"
                  className="w-full border-blue-300 text-blue-800 hover:bg-blue-100"
                  onClick={() => makeAvailable.mutate(desk.id)}
                  disabled={makeAvailable.isPending || (desk.queueDepth ?? 0) === 0}
                >
                  {makeAvailable.isPending ? 'Processing…' : 'Make available to queue'}
                </Button>
              </div>
            )}

            {desk.bookingStatus === 'available' && (
              <div className="space-y-4">
                <div>
                  <Label className="text-sm font-medium">End date</Label>
                  <Input
                    type="date"
                    value={format(endDate, 'yyyy-MM-dd')}
                    min={format(date, 'yyyy-MM-dd')}
                    max={maxEndDateStr}
                    onChange={(e) => {
                      if (e.target.value) setEndDate(new Date(e.target.value + 'T00:00:00'))
                    }}
                    className="mt-1.5"
                  />
                  {isMultiDay && (
                    <p className="text-xs text-muted-foreground mt-1">
                      {Math.round((startOfDay(endDate).getTime() - startOfDay(date).getTime()) / 86400000) + 1} day booking
                    </p>
                  )}
                </div>

                <div>
                  <Label className="text-sm font-medium">Time</Label>
                  <Select
                    value={timePreset}
                    onValueChange={(v) => setTimePreset(v as TimePreset)}
                  >
                    <SelectTrigger className="mt-1.5">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="full">Full Day (all day)</SelectItem>
                      <SelectItem value="am" disabled={isMultiDay}>Morning (08:00 – 13:00)</SelectItem>
                      <SelectItem value="pm" disabled={isMultiDay}>Afternoon (13:00 – 18:00)</SelectItem>
                      <SelectItem value="custom">Custom time</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {timePreset === 'custom' && (
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <Label className="text-xs">{isMultiDay ? 'Start time (day 1)' : 'Start time'}</Label>
                      <Input
                        type="time"
                        value={customStart}
                        onChange={(e) => setCustomStart(e.target.value)}
                        className="mt-1"
                      />
                    </div>
                    <div>
                      <Label className="text-xs">{isMultiDay ? 'End time (last day)' : 'End time'}</Label>
                      <Input
                        type="time"
                        value={customEnd}
                        onChange={(e) => setCustomEnd(e.target.value)}
                        className="mt-1"
                      />
                    </div>
                  </div>
                )}

                <Button
                  onClick={handleBook}
                  disabled={createBooking.isPending}
                  className="w-full"
                >
                  <CheckCircle className="mr-2 h-4 w-4" />
                  {createBooking.isPending ? 'Booking…' : 'Book Desk'}
                </Button>
              </div>
            )}

            {/* Mine: show booking details + cancel */}
            {desk.bookingStatus === 'mine' && desk.currentBooking && (
              <div className="space-y-3">
                <div className="rounded-md bg-blue-50 p-3">
                  <p className="text-sm font-medium text-blue-800">Your booking</p>
                  <p className="text-xs text-blue-600 mt-1">
                    {formatDateRange(desk.currentBooking.startsAt, desk.currentBooking.endsAt)}
                  </p>
                  {desk.currentBooking.notes && (
                    <p className="text-xs text-blue-600 mt-1">{desk.currentBooking.notes}</p>
                  )}
                </div>
                <Button
                  variant="destructive"
                  onClick={() => cancelBooking.mutate(desk.currentBooking!.id)}
                  disabled={cancelBooking.isPending}
                  className="w-full"
                >
                  <XCircle className="mr-2 h-4 w-4" />
                  {cancelBooking.isPending ? 'Cancelling…' : 'Cancel Booking'}
                </Button>
              </div>
            )}

            {/* Booked: join queue */}
            {desk.bookingStatus === 'booked' && (
              <div className="space-y-4">
                <div className="rounded-md bg-red-50 p-3">
                  <p className="text-sm font-medium text-red-800">This desk is already booked</p>
                  {desk.currentBooking?.bookerName && (
                    <p className="text-xs text-red-700 mt-1 font-medium">
                      Booked by {desk.currentBooking.bookerName}
                    </p>
                  )}
                  <p className="text-xs text-red-600 mt-1">
                    Join the queue to be notified if it becomes available.
                  </p>
                </div>

                {canManageDesk && desk.currentBooking && (
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => cancelBooking.mutate(desk.currentBooking!.id)}
                    disabled={cancelBooking.isPending}
                    className="w-full"
                  >
                    <XCircle className="mr-2 h-4 w-4" />
                    {cancelBooking.isPending ? 'Cancelling…' : 'Cancel this booking'}
                  </Button>
                )}

                <div>
                  <Label className="text-sm font-medium">Time preference</Label>
                  <Select
                    value={timePreset}
                    onValueChange={(v) => setTimePreset(v as TimePreset)}
                  >
                    <SelectTrigger className="mt-1.5">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="full">Full Day</SelectItem>
                      <SelectItem value="am">Morning</SelectItem>
                      <SelectItem value="pm">Afternoon</SelectItem>
                      <SelectItem value="custom">Custom</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div>
                  <Label className="text-xs text-muted-foreground">
                    Queue expiry (optional — defaults to 2h before start)
                  </Label>
                  <Input
                    type="datetime-local"
                    value={queueExpiry}
                    onChange={(e) => setQueueExpiry(e.target.value)}
                    className="mt-1"
                  />
                </div>

                <Button
                  onClick={handleJoinQueue}
                  disabled={joinQueue.isPending}
                  className="w-full"
                >
                  <Users className="mr-2 h-4 w-4" />
                  {joinQueue.isPending ? 'Joining…' : 'Join Queue'}
                </Button>
              </div>
            )}

            {/* Queued: show position + leave */}
            {desk.bookingStatus === 'queued' && myQueueEntry && myQueueEntry.status === 'WAITING' && (
              <div className="space-y-3">
                <div className="rounded-md bg-yellow-50 p-3">
                  <p className="text-sm font-medium text-yellow-800">
                    You are #{myQueueEntry.position} in the queue
                  </p>
                  <p className="text-xs text-yellow-600 mt-1">
                    You'll be notified when this desk becomes available.
                  </p>
                  <p className="text-xs text-yellow-600 mt-1">
                    Queue expires: {format(new Date(myQueueEntry.expiresAt), 'PPp')}
                  </p>
                </div>
                <Button
                  variant="outline"
                  onClick={() => leaveQueue.mutate(myQueueEntry.id)}
                  disabled={leaveQueue.isPending}
                  className="w-full"
                >
                  {leaveQueue.isPending ? 'Leaving…' : 'Leave Queue'}
                </Button>
              </div>
            )}

            {/* Promoted: claim desk */}
            {myQueueEntry?.status === 'PROMOTED' && (
              <div className="space-y-3">
                <div className="rounded-md bg-green-50 p-3 border border-green-200">
                  <p className="text-sm font-semibold text-green-800">Desk available for you!</p>
                  {myQueueEntry.claimDeadline && (
                    <p className="text-xs text-green-600 mt-1">
                      Claim before: {format(new Date(myQueueEntry.claimDeadline), 'PPp')}
                    </p>
                  )}
                </div>
                <Button
                  onClick={() => claimDesk.mutate(myQueueEntry.id)}
                  disabled={claimDesk.isPending}
                  className="w-full bg-green-600 hover:bg-green-700"
                >
                  <CheckCircle className="mr-2 h-4 w-4" />
                  {claimDesk.isPending ? 'Claiming…' : 'Claim Desk'}
                </Button>
              </div>
            )}

            {/* Assigned — non-assigned user: show queue option */}
            {desk.bookingStatus === 'assigned' && (
              <div className="space-y-4">
                <div className="rounded-md bg-slate-50 border border-slate-200 p-3">
                  <AlertCircle className="h-4 w-4 text-slate-500 mb-1" />
                  <p className="text-sm font-medium text-slate-800">Permanently assigned</p>
                  {desk.assignedUsers && desk.assignedUsers.length > 0 ? (
                    <p className="text-xs text-slate-600 mt-1">
                      Assigned to{' '}
                      <span className="font-medium">
                        {desk.assignedUsers.find((u) => u.isPrimary)?.displayName ?? desk.assignedUsers[0].displayName}
                      </span>
                      {desk.assignedUsers.length > 1 && ` +${desk.assignedUsers.length - 1} more`}.
                    </p>
                  ) : null}
                  <p className="text-xs text-slate-500 mt-1">
                    Join the queue to be notified if the assignee makes this desk available.
                  </p>
                </div>

                <div>
                  <Label className="text-sm font-medium">Time preference</Label>
                  <Select
                    value={timePreset}
                    onValueChange={(v) => setTimePreset(v as TimePreset)}
                  >
                    <SelectTrigger className="mt-1.5">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="full">Full Day</SelectItem>
                      <SelectItem value="am">Morning</SelectItem>
                      <SelectItem value="pm">Afternoon</SelectItem>
                      <SelectItem value="custom">Custom</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div>
                  <Label className="text-xs text-muted-foreground">
                    Queue expiry (optional — defaults to 2h before start)
                  </Label>
                  <Input
                    type="datetime-local"
                    value={queueExpiry}
                    onChange={(e) => setQueueExpiry(e.target.value)}
                    className="mt-1"
                  />
                </div>

                <Button
                  onClick={handleJoinQueue}
                  disabled={joinQueue.isPending}
                  className="w-full bg-amber-500 hover:bg-amber-600 text-white"
                >
                  <Users className="mr-2 h-4 w-4" />
                  {joinQueue.isPending ? 'Joining queue…' : 'Queue for this desk'}
                </Button>
                <p className="text-xs text-center text-muted-foreground">
                  You're joining a queue, not booking directly.
                </p>
              </div>
            )}

            {/* Restricted / Disabled */}
            {(desk.bookingStatus === 'restricted' || desk.bookingStatus === 'disabled') && (
              <div className="rounded-md bg-muted p-3">
                <AlertCircle className="h-4 w-4 text-muted-foreground mb-1" />
                <p className="text-sm font-medium">
                  {desk.bookingStatus === 'restricted'
                    ? 'This desk is restricted'
                    : 'This desk is disabled'}
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  {desk.bookingStatus === 'restricted'
                    ? 'You do not have permission to book this desk.'
                    : 'This desk is currently unavailable for booking.'}
                </p>
              </div>
            )}

            {/* Zone conflict */}
            {desk.bookingStatus === 'zone_conflict' && (
              <div className="rounded-md bg-orange-50 border border-orange-200 p-3">
                <AlertCircle className="h-4 w-4 text-orange-500 mb-1" />
                <p className="text-sm font-medium text-orange-800">Zone group conflict</p>
                <p className="text-xs text-orange-600 mt-1">
                  You already have a booking in another desk within the same zone group for this time period.
                </p>
              </div>
            )}

            {/* Admin section */}
            {canManageDesk && (
              <>
                <Separator />
                <div>
                  <button
                    type="button"
                    className="flex items-center justify-between w-full text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
                    onClick={() => setShowAdmin((v) => !v)}
                  >
                    <span className="flex items-center gap-1.5">
                      <Shield className="h-3.5 w-3.5" />
                      {isAdmin ? 'Admin Controls' : 'Floor Manager Controls'}
                    </span>
                    {showAdmin ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                  </button>

                  {showAdmin && (
                    <div className="mt-4 space-y-5">
                      {/* Edit asset details */}
                      <div>
                        <Button
                          size="sm"
                          variant="outline"
                          className="w-full h-8 text-xs"
                          onClick={() => setEditAssetOpen(true)}
                        >
                          <Pencil className="mr-1.5 h-3 w-3" />
                          Edit name, amenities &amp; booking status
                        </Button>
                      </div>

                      {/* Permanent user assignment */}
                      <div>
                        <div className="flex items-center justify-between mb-2">
                          <p className="text-sm font-medium flex items-center gap-1.5">
                            <UserPlus className="h-3.5 w-3.5 text-blue-500" />
                            Permanent Users
                          </p>
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 text-xs"
                            onClick={() => setAddAssignmentOpen(true)}
                          >
                            <UserPlus className="mr-1 h-3 w-3" />
                            Add user
                          </Button>
                        </div>
                        {!desk.assignedUsers || desk.assignedUsers.length === 0 ? (
                          <p className="text-xs text-muted-foreground">No users permanently assigned</p>
                        ) : (
                          <div className="space-y-1.5">
                            {desk.assignedUsers.map((u) => (
                              <div key={u.id} className="flex items-center justify-between rounded-md border px-3 py-2">
                                <div className="min-w-0 flex-1">
                                  <div className="flex items-center gap-1.5">
                                    <p className="text-sm font-medium truncate">{u.displayName}</p>
                                    {u.isPrimary && (
                                      <Badge variant="secondary" className="text-[10px] px-1.5 py-0 shrink-0">Primary</Badge>
                                    )}
                                  </div>
                                  <p className="text-xs text-muted-foreground truncate">{u.email}</p>
                                </div>
                                <div className="flex items-center gap-0.5 shrink-0 ml-2">
                                  {!u.isPrimary && (
                                    <Button
                                      size="icon"
                                      variant="ghost"
                                      className="h-7 w-7 hover:text-blue-600"
                                      title="Set as primary"
                                      onClick={() => setPrimaryAssignment.mutate(u.id)}
                                      disabled={setPrimaryAssignment.isPending}
                                    >
                                      <CheckCircle className="h-3.5 w-3.5" />
                                    </Button>
                                  )}
                                  <Button
                                    size="icon"
                                    variant="ghost"
                                    className="h-7 w-7 hover:text-destructive"
                                    title="Remove"
                                    onClick={() => removeAssignment.mutate(u.id)}
                                    disabled={removeAssignment.isPending}
                                  >
                                    <UserMinus className="h-3.5 w-3.5" />
                                  </Button>
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>

                      {/* Additional zones */}
                      <div>
                          <div className="flex items-center justify-between mb-2">
                            <p className="text-sm font-medium flex items-center gap-1.5">
                              <MapPin className="h-3.5 w-3.5 text-violet-500" />
                              Additional Zones
                            </p>
                            {floorZones.length > 1 && (
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-7 text-xs"
                                onClick={() => setAddZoneOpen(true)}
                              >
                                <UserPlus className="mr-1 h-3 w-3" />
                                Add zone
                              </Button>
                            )}
                          </div>
                          {!additionalZones || additionalZones.length === 0 ? (
                            <p className="text-xs text-muted-foreground">No additional zones assigned</p>
                          ) : (
                            <div className="space-y-1.5">
                              {additionalZones.map((z) => (
                                <div key={z.id} className="flex items-center justify-between rounded-md border px-3 py-2">
                                  <div className="flex items-center gap-2">
                                    <span className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: z.colour }} />
                                    <p className="text-sm font-medium">{z.name}</p>
                                  </div>
                                  <Button
                                    size="icon"
                                    variant="ghost"
                                    className="h-7 w-7 hover:text-destructive"
                                    title="Remove"
                                    onClick={() => removeZone.mutate(z.id)}
                                    disabled={removeZone.isPending}
                                  >
                                    <UserMinus className="h-3.5 w-3.5" />
                                  </Button>
                                </div>
                              ))}
                            </div>
                          )}
                      </div>

                      {/* Allow-list management (only for RESTRICTED or ASSIGNED desks) */}
                      {needsAllowList && (
                        <div>
                          <div className="flex items-center justify-between mb-2">
                            <p className="text-sm font-medium">Allow List</p>
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 text-xs"
                              onClick={() => setAddAllowListOpen(true)}
                            >
                              <UserPlus className="mr-1 h-3 w-3" />
                              Add user
                            </Button>
                          </div>
                          {!allowList || allowList.length === 0 ? (
                            <p className="text-xs text-muted-foreground">No users on the allow list</p>
                          ) : (
                            <div className="space-y-1.5">
                              {allowList.map((u) => (
                                <div key={u.id} className="flex items-center justify-between rounded-md border px-3 py-2">
                                  <div>
                                    <p className="text-sm font-medium">{u.displayName}</p>
                                    <p className="text-xs text-muted-foreground">{u.email}</p>
                                  </div>
                                  <Button
                                    size="icon"
                                    variant="ghost"
                                    className="h-7 w-7 hover:text-destructive"
                                    title="Remove"
                                    onClick={() => removeAllowList.mutate(u.id)}
                                    disabled={removeAllowList.isPending}
                                  >
                                    <UserMinus className="h-3.5 w-3.5" />
                                  </Button>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        </SheetContent>
      </Sheet>

      {editAssetOpen && (
        <EditAssetDialog
          open={editAssetOpen}
          desk={desk}
          onClose={() => setEditAssetOpen(false)}
        />
      )}

      {addAllowListOpen && (
        <AddAllowListDialog
          open={addAllowListOpen}
          deskId={desk.id}
          onClose={() => setAddAllowListOpen(false)}
        />
      )}

      {addAssignmentOpen && (
        <AddAssignmentDialog
          open={addAssignmentOpen}
          deskId={desk.id}
          onClose={() => setAddAssignmentOpen(false)}
        />
      )}

      {addZoneOpen && (
        <AddZoneDialog
          open={addZoneOpen}
          deskId={desk.id}
          primaryZoneId={desk.primaryZoneId ?? ''}
          floorZones={floorZones}
          existingZoneIds={(additionalZones ?? []).map((z) => z.id)}
          onClose={() => setAddZoneOpen(false)}
        />
      )}
    </>
  )
}
