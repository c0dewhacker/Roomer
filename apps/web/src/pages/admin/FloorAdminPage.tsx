import { useState, useCallback, useRef, useMemo } from 'react'
import { useParams, Link } from 'react-router-dom'
import { useForm } from 'react-hook-form'
import { z } from 'zod'
import { zodResolver } from '@hookform/resolvers/zod'
import {
  Plus, Upload, List, LayoutTemplate, Pencil, Trash2, ChevronRight,
  ChevronDown, GripVertical, X, Users, UserMinus, UserPlus,
} from 'lucide-react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { floorsApi, desksApi, zonesApi, usersApi, groupsApi } from '@/lib/api'
import { toast } from 'sonner'
import { FloorPlanCanvas } from '@/components/floor-plan/FloorPlanCanvas'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from '@/components/ui/alert-dialog'

// ─── Types ───────────────────────────────────────────────────────────────────

type ZoneData = { id: string; name: string; colour: string; zoneGroupId: string | null; desks: DeskData[] }
type DeskData = { id: string; name: string; status: string; amenities: string[] }

const DESK_STATUSES = ['OPEN', 'RESTRICTED', 'ASSIGNED', 'DISABLED'] as const
const STATUS_LABELS: Record<string, string> = {
  OPEN: 'Open', RESTRICTED: 'Restricted', ASSIGNED: 'Assigned', DISABLED: 'Disabled',
}
const STATUS_VARIANTS: Record<string, 'default' | 'secondary' | 'outline' | 'destructive'> = {
  OPEN: 'secondary', RESTRICTED: 'outline', ASSIGNED: 'default', DISABLED: 'destructive',
}

// ─── Zone Dialog ─────────────────────────────────────────────────────────────

const zoneSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  colour: z.string().min(4, 'Colour required'),
})
type ZoneForm = z.infer<typeof zoneSchema>

function ZoneDialog({
  open, onClose, floorId, existing,
}: { open: boolean; onClose: () => void; floorId: string; existing?: ZoneData }) {
  const qc = useQueryClient()
  const { register, handleSubmit, formState: { errors }, watch, setValue } = useForm<ZoneForm>({
    resolver: zodResolver(zoneSchema),
    defaultValues: { name: existing?.name ?? '', colour: existing?.colour ?? '#6366f1' },
  })
  const colour = watch('colour')

  const create = useMutation({
    mutationFn: (d: ZoneForm) => zonesApi.create({ floorId, ...d }),
    onSuccess: () => { toast.success('Zone created'); qc.invalidateQueries({ queryKey: ['floors', floorId] }); onClose() },
    onError: () => toast.error('Failed to create zone'),
  })
  const update = useMutation({
    mutationFn: (d: ZoneForm) => zonesApi.update(existing!.id, d),
    onSuccess: () => { toast.success('Zone updated'); qc.invalidateQueries({ queryKey: ['floors', floorId] }); onClose() },
    onError: () => toast.error('Failed to update zone'),
  })
  const isPending = create.isPending || update.isPending

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>{existing ? 'Edit Zone' : 'Add Zone'}</DialogTitle></DialogHeader>
        <form onSubmit={handleSubmit((d) => existing ? update.mutate(d) : create.mutate(d))} className="space-y-4">
          <div>
            <Label htmlFor="zname">Zone name *</Label>
            <Input id="zname" {...register('name')} className="mt-1.5" placeholder="e.g. Open Plan" />
            {errors.name && <p className="text-xs text-destructive mt-1">{errors.name.message}</p>}
          </div>
          <div>
            <Label>Colour</Label>
            <div className="flex items-center gap-3 mt-1.5">
              <input
                type="color"
                value={colour}
                onChange={(e) => setValue('colour', e.target.value)}
                className="h-9 w-16 cursor-pointer rounded border border-input bg-transparent p-0.5"
              />
              <Input
                value={colour}
                onChange={(e) => setValue('colour', e.target.value)}
                className="w-32 font-mono"
                placeholder="#6366f1"
              />
              <div className="h-7 w-7 rounded border" style={{ backgroundColor: colour }} />
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={isPending}>
              {isPending ? 'Saving…' : existing ? 'Save changes' : 'Create zone'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// ─── Desk Dialog ──────────────────────────────────────────────────────────────

const deskSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  zoneId: z.string().min(1, 'Zone is required'),
  status: z.enum(DESK_STATUSES),
  amenities: z.string().optional(),
})
type DeskForm = z.infer<typeof deskSchema>

function DeskDialog({
  open, onClose, floorId, zones, defaultZoneId, existing,
}: {
  open: boolean; onClose: () => void; floorId: string
  zones: ZoneData[]; defaultZoneId?: string; existing?: DeskData & { zoneId: string }
}) {
  const qc = useQueryClient()
  const { register, handleSubmit, formState: { errors }, watch, setValue } = useForm<DeskForm>({
    resolver: zodResolver(deskSchema),
    defaultValues: {
      name: existing?.name ?? '',
      zoneId: existing?.zoneId ?? defaultZoneId ?? '',
      status: (existing?.status as typeof DESK_STATUSES[number]) ?? 'OPEN',
      amenities: existing?.amenities.join(', ') ?? '',
    },
  })
  const zoneId = watch('zoneId')
  const status = watch('status')

  // Additional zones (only relevant when editing)
  const { data: additionalZones, refetch: refetchZones } = useQuery({
    queryKey: ['desks', existing?.id, 'zones'],
    queryFn: () => desksApi.getZones(existing!.id),
    select: (r) => r.data,
    enabled: !!existing,
  })

  const addZone = useMutation({
    mutationFn: (zId: string) => desksApi.addZone(existing!.id, zId),
    onSuccess: () => { toast.success('Zone added'); refetchZones() },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : 'Failed to add zone'),
  })

  const removeZone = useMutation({
    mutationFn: (zId: string) => desksApi.removeZone(existing!.id, zId),
    onSuccess: () => { toast.success('Zone removed'); refetchZones() },
    onError: () => toast.error('Failed to remove zone'),
  })

  // Zones available to add (not primary, not already added)
  const primaryZoneId = existing?.zoneId ?? zoneId
  const addedZoneIds = useMemo(() => new Set((additionalZones ?? []).map((z) => z.id)), [additionalZones])
  const availableToAdd = zones.filter((z) => z.id !== primaryZoneId && !addedZoneIds.has(z.id))

  const create = useMutation({
    mutationFn: (d: DeskForm) => desksApi.create({
      zoneId: d.zoneId, name: d.name,
      x: 50, y: 50,
      amenities: d.amenities ? d.amenities.split(',').map((s) => s.trim()).filter(Boolean) : [],
    }),
    onSuccess: () => {
      toast.success('Desk added — drag it to position on the floor plan')
      qc.invalidateQueries({ queryKey: ['floors', floorId] })
      onClose()
    },
    onError: () => toast.error('Failed to add desk'),
  })
  const update = useMutation({
    mutationFn: (d: DeskForm) => desksApi.update(existing!.id, {
      name: d.name, status: d.status as any,
      amenities: d.amenities ? d.amenities.split(',').map((s) => s.trim()).filter(Boolean) : [],
    }),
    onSuccess: () => {
      toast.success('Desk updated')
      qc.invalidateQueries({ queryKey: ['floors', floorId] })
      onClose()
    },
    onError: () => toast.error('Failed to update desk'),
  })
  const isPending = create.isPending || update.isPending

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader><DialogTitle>{existing ? 'Edit Desk' : 'Add Desk'}</DialogTitle></DialogHeader>
        <form onSubmit={handleSubmit((d) => existing ? update.mutate(d) : create.mutate(d))} className="space-y-4">
          <div>
            <Label>Primary Zone *</Label>
            <Select value={zoneId} onValueChange={(v) => setValue('zoneId', v)} disabled={!!existing}>
              <SelectTrigger className="mt-1.5"><SelectValue placeholder="Select zone" /></SelectTrigger>
              <SelectContent>
                {zones.map((z) => (
                  <SelectItem key={z.id} value={z.id}>
                    <div className="flex items-center gap-2">
                      <span className="h-2.5 w-2.5 rounded-full inline-block" style={{ backgroundColor: z.colour }} />
                      {z.name}
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {errors.zoneId && <p className="text-xs text-destructive mt-1">{errors.zoneId.message}</p>}
          </div>

          {/* Additional zones — only when editing */}
          {existing && zones.length > 1 && (
            <div>
              <Label>Additional Zones</Label>
              <p className="text-xs text-muted-foreground mb-2 mt-0.5">
                Desk appears in these zones too (zone conflict only applies to the primary zone).
              </p>
              <div className="flex flex-wrap gap-1.5 mb-2">
                {(additionalZones ?? []).map((z) => (
                  <span
                    key={z.id}
                    className="inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium"
                  >
                    <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: z.colour }} />
                    {z.name}
                    <button
                      type="button"
                      className="ml-0.5 hover:text-destructive transition-colors"
                      onClick={() => removeZone.mutate(z.id)}
                      disabled={removeZone.isPending}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                ))}
                {(!additionalZones || additionalZones.length === 0) && (
                  <span className="text-xs text-muted-foreground">None</span>
                )}
              </div>
              {availableToAdd.length > 0 && (
                <Select onValueChange={(zId) => addZone.mutate(zId)} value="">
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue placeholder="+ Add to another zone…" />
                  </SelectTrigger>
                  <SelectContent>
                    {availableToAdd.map((z) => (
                      <SelectItem key={z.id} value={z.id}>
                        <div className="flex items-center gap-2">
                          <span className="h-2.5 w-2.5 rounded-full inline-block" style={{ backgroundColor: z.colour }} />
                          {z.name}
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
          )}

          <div>
            <Label htmlFor="dname">Desk name *</Label>
            <Input id="dname" {...register('name')} className="mt-1.5" placeholder="e.g. A-01" />
            {errors.name && <p className="text-xs text-destructive mt-1">{errors.name.message}</p>}
          </div>
          <div>
            <Label>Status</Label>
            <Select value={status} onValueChange={(v) => setValue('status', v as typeof DESK_STATUSES[number])}>
              <SelectTrigger className="mt-1.5"><SelectValue /></SelectTrigger>
              <SelectContent>
                {DESK_STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>{STATUS_LABELS[s]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label htmlFor="amenities">Amenities</Label>
            <Input id="amenities" {...register('amenities')} className="mt-1.5"
              placeholder="standing, dual-monitor, quiet (comma-separated)" />
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={isPending}>
              {isPending ? 'Saving…' : existing ? 'Save changes' : 'Add desk'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// ─── Zone Section ─────────────────────────────────────────────────────────────

function ZoneSection({
  zone, floorId, zones,
}: { zone: ZoneData; floorId: string; zones: ZoneData[] }) {
  const qc = useQueryClient()
  const [expanded, setExpanded] = useState(true)
  const [editZone, setEditZone] = useState(false)
  const [addDesk, setAddDesk] = useState(false)
  const [editDesk, setEditDesk] = useState<(DeskData & { zoneId: string }) | undefined>()

  const deleteZone = useMutation({
    mutationFn: () => zonesApi.delete(zone.id),
    onSuccess: () => { toast.success('Zone deleted'); qc.invalidateQueries({ queryKey: ['floors', floorId] }) },
    onError: () => toast.error('Failed to delete zone'),
  })
  const deleteDesk = useMutation({
    mutationFn: (id: string) => desksApi.delete(id),
    onSuccess: () => { toast.success('Desk deleted'); qc.invalidateQueries({ queryKey: ['floors', floorId] }) },
    onError: () => toast.error('Failed to delete desk'),
  })

  return (
    <div className="rounded-lg border">
      {/* Zone header */}
      <div className="flex items-center justify-between px-4 py-3 bg-muted/30">
        <button
          onClick={() => setExpanded((v) => !v)}
          className="flex items-center gap-2 text-sm font-semibold flex-1 text-left"
        >
          {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          <span className="h-3 w-3 rounded-full shrink-0" style={{ backgroundColor: zone.colour }} />
          {zone.name}
          <Badge variant="secondary" className="text-xs ml-1">{zone.desks.length} desks</Badge>
        </button>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" className="h-7 gap-1 text-xs"
            onClick={() => setAddDesk(true)}>
            <Plus className="h-3 w-3" /> Add desk
          </Button>
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setEditZone(true)}>
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="ghost" size="icon" className="h-7 w-7 hover:text-destructive">
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete zone "{zone.name}"?</AlertDialogTitle>
                <AlertDialogDescription>
                  This will permanently delete the zone and all {zone.desks.length} desk(s) within it.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => deleteZone.mutate()}
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                >Delete</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>

      {/* Desk list */}
      {expanded && (
        <div>
          {zone.desks.length === 0 ? (
            <p className="px-4 py-3 text-sm text-muted-foreground">
              No desks — <button className="underline" onClick={() => setAddDesk(true)}>add one</button>
            </p>
          ) : (
            <div className="divide-y">
              {zone.desks.map((desk) => (
                <div key={desk.id} className="flex items-center justify-between px-4 py-2.5">
                  <div className="flex items-center gap-3 min-w-0">
                    <GripVertical className="h-4 w-4 text-muted-foreground shrink-0" />
                    <span className="font-medium text-sm">{desk.name}</span>
                    <Badge variant={STATUS_VARIANTS[desk.status]} className="text-xs shrink-0">
                      {STATUS_LABELS[desk.status]}
                    </Badge>
                    <div className="hidden sm:flex gap-1 flex-wrap">
                      {desk.amenities.map((a) => (
                        <Badge key={a} variant="outline" className="text-xs">{a}</Badge>
                      ))}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Button variant="ghost" size="icon" className="h-7 w-7"
                      onClick={() => setEditDesk({ ...desk, zoneId: zone.id })}>
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button variant="ghost" size="icon" className="h-7 w-7 hover:text-destructive">
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>Delete desk "{desk.name}"?</AlertDialogTitle>
                          <AlertDialogDescription>
                            All future bookings for this desk will also be cancelled.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancel</AlertDialogCancel>
                          <AlertDialogAction
                            onClick={() => deleteDesk.mutate(desk.id)}
                            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                          >Delete</AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {editZone && (
        <ZoneDialog open floorId={floorId} existing={zone} onClose={() => setEditZone(false)} />
      )}
      {addDesk && (
        <DeskDialog open floorId={floorId} zones={zones} defaultZoneId={zone.id} onClose={() => setAddDesk(false)} />
      )}
      {editDesk && (
        <DeskDialog open floorId={floorId} zones={zones} existing={editDesk} onClose={() => setEditDesk(undefined)} />
      )}
    </div>
  )
}

// ─── Floor Managers Panel ─────────────────────────────────────────────────────

function FloorManagersPanel({ floorId }: { floorId: string }) {
  const qc = useQueryClient()
  const [tab, setTab] = useState<'users' | 'groups'>('users')

  // ── User managers ──────────────────────────────────────────────────────────
  const [search, setSearch] = useState('')
  const [selectedUserId, setSelectedUserId] = useState('')

  const { data: managers, isLoading } = useQuery({
    queryKey: ['floors', floorId, 'managers'],
    queryFn: () => floorsApi.getManagers(floorId),
    select: (r) => r.data,
  })

  const { data: searchResults } = useQuery({
    queryKey: ['users', 'search', search],
    queryFn: () => usersApi.list({ q: search, limit: 20 }),
    select: (r) => r.data,
    enabled: search.length >= 2,
  })

  const addUser = useMutation({
    mutationFn: () =>
      usersApi.assignResourceRole(selectedUserId, {
        role: 'FLOOR_MANAGER',
        scopeType: 'FLOOR',
        floorId,
      }),
    onSuccess: () => {
      toast.success('Floor manager assigned')
      qc.invalidateQueries({ queryKey: ['floors', floorId, 'managers'] })
      setSearch('')
      setSelectedUserId('')
    },
    onError: () => toast.error('Failed to assign floor manager'),
  })

  const removeUser = useMutation({
    mutationFn: ({ userId, roleId }: { userId: string; roleId: string }) =>
      usersApi.removeResourceRole(userId, roleId),
    onSuccess: () => {
      toast.success('Floor manager removed')
      qc.invalidateQueries({ queryKey: ['floors', floorId, 'managers'] })
    },
    onError: () => toast.error('Failed to remove floor manager'),
  })

  const existingUserIds = useMemo(() => new Set((managers ?? []).map((m) => m.id)), [managers])
  const filteredResults = (searchResults ?? []).filter((u) => !existingUserIds.has(u.id))

  // ── Group managers ─────────────────────────────────────────────────────────
  const [selectedGroupId, setSelectedGroupId] = useState('')

  const { data: groupManagers, isLoading: groupManagersLoading } = useQuery({
    queryKey: ['floors', floorId, 'group-managers'],
    queryFn: () => floorsApi.getGroupManagers(floorId),
    select: (r) => r.data,
  })

  const { data: allGroups } = useQuery({
    queryKey: ['groups'],
    queryFn: () => groupsApi.list(),
    select: (r) => r.data,
  })

  const addGroup = useMutation({
    mutationFn: () => floorsApi.assignGroupManager(floorId, selectedGroupId),
    onSuccess: () => {
      toast.success('Group assigned as floor manager')
      qc.invalidateQueries({ queryKey: ['floors', floorId, 'group-managers'] })
      setSelectedGroupId('')
    },
    onError: () => toast.error('Failed to assign group'),
  })

  const removeGroup = useMutation({
    mutationFn: (groupId: string) => floorsApi.removeGroupManager(floorId, groupId),
    onSuccess: () => {
      toast.success('Group manager removed')
      qc.invalidateQueries({ queryKey: ['floors', floorId, 'group-managers'] })
    },
    onError: () => toast.error('Failed to remove group manager'),
  })

  const existingGroupIds = useMemo(() => new Set((groupManagers ?? []).map((g) => g.id)), [groupManagers])
  const availableGroups = (allGroups ?? []).filter((g) => !existingGroupIds.has(g.id))

  return (
    <ScrollArea className="h-full">
      <div className="max-w-2xl mx-auto p-6 space-y-6">
        <div>
          <h2 className="text-base font-semibold">Floor Managers</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Floor managers can assign permanent users, edit desk amenities, and cancel bookings on this floor.
          </p>
        </div>

        {/* Tab toggle */}
        <div className="flex gap-1 border rounded-lg p-1 w-fit">
          <button
            onClick={() => setTab('users')}
            className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${tab === 'users' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}`}
          >
            Users
          </button>
          <button
            onClick={() => setTab('groups')}
            className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${tab === 'groups' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}`}
          >
            Groups
          </button>
        </div>

        {tab === 'users' && (
          <>
            {/* Current user managers */}
            <div>
              <p className="text-sm font-medium mb-3">Current managers</p>
              {isLoading ? (
                <div className="space-y-2">{[1, 2].map((i) => <Skeleton key={i} className="h-14" />)}</div>
              ) : !managers || managers.length === 0 ? (
                <div className="rounded-lg border border-dashed p-6 flex flex-col items-center justify-center text-center">
                  <Users className="h-8 w-8 text-muted-foreground/30 mb-2" />
                  <p className="text-sm text-muted-foreground">No individual floor managers assigned</p>
                </div>
              ) : (
                <div className="rounded-lg border divide-y">
                  {managers.map((m) => (
                    <div key={m.id} className="flex items-center justify-between px-4 py-3">
                      <div>
                        <p className="text-sm font-medium">{m.displayName}</p>
                        <p className="text-xs text-muted-foreground">{m.email}</p>
                      </div>
                      <Button
                        size="icon" variant="ghost" className="h-8 w-8 hover:text-destructive"
                        title="Remove manager"
                        onClick={() => removeUser.mutate({ userId: m.id, roleId: m.roleId })}
                        disabled={removeUser.isPending}
                      >
                        <UserMinus className="h-4 w-4" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Add user manager */}
            <div>
              <p className="text-sm font-medium mb-3">Add a manager</p>
              <div className="space-y-3">
                <Input
                  placeholder="Search by name or email…"
                  value={search}
                  onChange={(e) => { setSearch(e.target.value); setSelectedUserId('') }}
                />
                {search.length >= 2 && filteredResults.length > 0 && (
                  <div className="rounded-md border divide-y max-h-48 overflow-y-auto">
                    {filteredResults.map((u) => (
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
                {search.length >= 2 && filteredResults.length === 0 && (
                  <p className="text-sm text-muted-foreground">No users found</p>
                )}
                <Button onClick={() => addUser.mutate()} disabled={!selectedUserId || addUser.isPending} size="sm">
                  <UserPlus className="mr-1.5 h-3.5 w-3.5" />
                  {addUser.isPending ? 'Assigning…' : 'Assign as manager'}
                </Button>
              </div>
            </div>
          </>
        )}

        {tab === 'groups' && (
          <>
            {/* Current group managers */}
            <div>
              <p className="text-sm font-medium mb-3">Current group managers</p>
              {groupManagersLoading ? (
                <div className="space-y-2">{[1, 2].map((i) => <Skeleton key={i} className="h-14" />)}</div>
              ) : !groupManagers || groupManagers.length === 0 ? (
                <div className="rounded-lg border border-dashed p-6 flex flex-col items-center justify-center text-center">
                  <Users className="h-8 w-8 text-muted-foreground/30 mb-2" />
                  <p className="text-sm text-muted-foreground">No groups assigned as floor managers</p>
                </div>
              ) : (
                <div className="rounded-lg border divide-y">
                  {groupManagers.map((g) => (
                    <div key={g.id} className="flex items-center justify-between px-4 py-3">
                      <div>
                        <p className="text-sm font-medium">{g.name}</p>
                        <p className="text-xs text-muted-foreground">{g.memberCount} member{g.memberCount !== 1 ? 's' : ''}</p>
                      </div>
                      <Button
                        size="icon" variant="ghost" className="h-8 w-8 hover:text-destructive"
                        title="Remove group manager"
                        onClick={() => removeGroup.mutate(g.id)}
                        disabled={removeGroup.isPending}
                      >
                        <UserMinus className="h-4 w-4" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Add group manager */}
            <div>
              <p className="text-sm font-medium mb-3">Add a group</p>
              <div className="space-y-3">
                {availableGroups.length === 0 ? (
                  <p className="text-sm text-muted-foreground">All groups are already assigned, or no groups exist.</p>
                ) : (
                  <select
                    value={selectedGroupId}
                    onChange={(e) => setSelectedGroupId(e.target.value)}
                    className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <option value="">— select a group —</option>
                    {availableGroups.map((g) => (
                      <option key={g.id} value={g.id}>{g.name}</option>
                    ))}
                  </select>
                )}
                <Button onClick={() => addGroup.mutate()} disabled={!selectedGroupId || addGroup.isPending} size="sm">
                  <UserPlus className="mr-1.5 h-3.5 w-3.5" />
                  {addGroup.isPending ? 'Assigning…' : 'Assign group as manager'}
                </Button>
              </div>
            </div>
          </>
        )}
      </div>
    </ScrollArea>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function FloorAdminPage() {
  const { floorId } = useParams<{ floorId: string }>()
  const qc = useQueryClient()
  const [view, setView] = useState<'layout' | 'manage' | 'managers'>('layout')
  const [addZoneOpen, setAddZoneOpen] = useState(false)
  const [addDeskOpen, setAddDeskOpen] = useState(false)
  const [pendingUploadFile, setPendingUploadFile] = useState<File | null>(null)
  const [replaceConfirmOpen, setReplaceConfirmOpen] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const { data: floor, isLoading } = useQuery({
    queryKey: ['floors', floorId],
    queryFn: () => floorsApi.get(floorId!),
    select: (r) => r.data,
    enabled: !!floorId,
  })

  const upload = useMutation({
    mutationFn: (file: File) => floorsApi.uploadFloorPlan(floorId!, file),
    onSuccess: () => {
      toast.success('Floor plan uploaded')
      qc.invalidateQueries({ queryKey: ['floors', floorId] })
      if (fileRef.current) fileRef.current.value = ''
    },
    onError: () => {
      toast.error('Upload failed')
      if (fileRef.current) fileRef.current.value = ''
    },
  })

  const updatePositions = useMutation({
    mutationFn: (positions: Array<{ id: string; x: number; y: number; width: number; height: number; rotation: number }>) =>
      desksApi.updatePositions(positions),
    onSuccess: () => { toast.success('Layout saved'); qc.invalidateQueries({ queryKey: ['floors', floorId] }) },
    onError: () => toast.error('Failed to save layout'),
  })

  const handleLayoutSave = useCallback(
    (positions: Array<{ id: string; x: number; y: number; width: number; height: number; rotation: number }>) => {
      updatePositions.mutate(positions)
    },
    [updatePositions],
  )

  const buildingId = (floor as any)?.building?.id
  const buildingName = (floor as any)?.building?.name
  const zones: ZoneData[] = (floor?.zones ?? []) as ZoneData[]
  const totalDesks = zones.reduce((s, z) => s + z.desks.length, 0)

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="border-b px-6 py-3 flex items-center justify-between shrink-0 gap-4">
        <div className="flex items-center gap-2 text-sm min-w-0">
          <Link to="/admin/buildings" className="text-muted-foreground hover:text-foreground shrink-0">Buildings</Link>
          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          {buildingId && (
            <>
              <Link to={`/admin/buildings/${buildingId}`} className="text-muted-foreground hover:text-foreground truncate max-w-[120px]">
                {buildingName}
              </Link>
              <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            </>
          )}
          {isLoading ? <Skeleton className="h-4 w-28" /> : (
            <span className="font-medium truncate">{floor?.name}</span>
          )}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <Button variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
            <Upload className="mr-1.5 h-3.5 w-3.5" />
            {upload.isPending ? 'Uploading…' : 'Upload Floor Plan'}
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*,.pdf,.dxf"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (!file) return
              if (floor?.floorPlan) {
                setPendingUploadFile(file)
                setReplaceConfirmOpen(true)
              } else {
                upload.mutate(file)
              }
            }}
          />

          <Button variant="outline" size="sm" onClick={() => setAddZoneOpen(true)}>
            <Plus className="mr-1.5 h-3.5 w-3.5" /> Add Zone
          </Button>
          <Button variant="outline" size="sm" onClick={() => setAddDeskOpen(true)}>
            <Plus className="mr-1.5 h-3.5 w-3.5" /> Add Desk
          </Button>

          <div className="flex rounded-md border overflow-hidden">
            <Button variant={view === 'layout' ? 'secondary' : 'ghost'} size="sm"
              className="rounded-none h-8 gap-1.5 text-xs" onClick={() => setView('layout')}>
              <LayoutTemplate className="h-3.5 w-3.5" /> Layout
            </Button>
            <Button variant={view === 'manage' ? 'secondary' : 'ghost'} size="sm"
              className="rounded-none h-8 gap-1.5 text-xs" onClick={() => setView('manage')}>
              <List className="h-3.5 w-3.5" /> Manage
            </Button>
            <Button variant={view === 'managers' ? 'secondary' : 'ghost'} size="sm"
              className="rounded-none h-8 gap-1.5 text-xs" onClick={() => setView('managers')}>
              <Users className="h-3.5 w-3.5" /> Managers
            </Button>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-hidden">
        {view === 'managers' ? (
          <FloorManagersPanel floorId={floorId!} />
        ) : view === 'layout' ? (
          floorId && (
            <div className="relative h-full w-full">
              {!floor?.floorPlan && !isLoading && (
                <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-muted/50 pointer-events-none">
                  <div className="bg-background border rounded-lg px-6 py-5 text-center shadow-sm pointer-events-auto">
                    <Upload className="mx-auto h-10 w-10 text-muted-foreground/50 mb-3" />
                    <p className="font-medium text-sm">No floor plan uploaded</p>
                    <p className="text-xs text-muted-foreground mt-1 mb-4">Upload an image to enable visual desk positioning</p>
                    <Button size="sm" onClick={() => fileRef.current?.click()}>
                      <Upload className="mr-1.5 h-3.5 w-3.5" /> Upload Floor Plan
                    </Button>
                  </div>
                </div>
              )}
              <FloorPlanCanvas
                floorId={floorId}
                date={new Date()}
                editMode={true}
                onLayoutSave={handleLayoutSave}
              />
            </div>
          )
        ) : (
          <ScrollArea className="h-full">
            <div className="max-w-3xl mx-auto p-6 space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">
                    {zones.length} zone{zones.length !== 1 ? 's' : ''} · {totalDesks} desk{totalDesks !== 1 ? 's' : ''}
                  </p>
                </div>
              </div>

              {isLoading ? (
                <div className="space-y-3">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-20" />)}</div>
              ) : zones.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 text-center rounded-lg border border-dashed">
                  <p className="text-sm text-muted-foreground">No zones yet</p>
                  <Button variant="outline" size="sm" className="mt-4" onClick={() => setAddZoneOpen(true)}>
                    <Plus className="mr-1.5 h-3.5 w-3.5" /> Add your first zone
                  </Button>
                </div>
              ) : (
                zones.map((zone) => (
                  <ZoneSection key={zone.id} zone={zone} floorId={floorId!} zones={zones} />
                ))
              )}
            </div>
          </ScrollArea>
        )}
      </div>

      {addZoneOpen && (
        <ZoneDialog open floorId={floorId!} onClose={() => setAddZoneOpen(false)} />
      )}
      {addDeskOpen && (
        <DeskDialog open floorId={floorId!} zones={zones} onClose={() => setAddDeskOpen(false)} />
      )}

      <AlertDialog open={replaceConfirmOpen} onOpenChange={setReplaceConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Replace floor plan?</AlertDialogTitle>
            <AlertDialogDescription>
              The existing floor plan will be replaced with the new image. Desk positions are not
              affected — all desks will remain exactly where they are.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              onClick={() => {
                setPendingUploadFile(null)
                if (fileRef.current) fileRef.current.value = ''
              }}
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pendingUploadFile) upload.mutate(pendingUploadFile)
                setPendingUploadFile(null)
                setReplaceConfirmOpen(false)
              }}
            >
              Replace
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
