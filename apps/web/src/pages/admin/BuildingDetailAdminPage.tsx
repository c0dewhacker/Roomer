import { useState, useRef } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { useForm, type Resolver } from 'react-hook-form'
import { z } from 'zod'
import { zodResolver } from '@hookform/resolvers/zod'
import { Layers, Plus, ChevronRight, Pencil, Trash2, Shield, Users, UserMinus, UserPlus, UserX } from 'lucide-react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { buildingsApi, floorsApi, groupsApi, usersApi, assetsApi, ApiError } from '@/lib/api'
import AssignmentImportDialog from '@/components/admin/AssignmentImportDialog'
import { toast } from 'sonner'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import type { Floor } from '@/types'

const floorSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  level: z.coerce.number().int().default(0),
})
type FloorForm = z.infer<typeof floorSchema>

function FloorDialog({
  open,
  onClose,
  buildingId,
  existing,
}: {
  open: boolean
  onClose: () => void
  buildingId: string
  existing?: Floor
}) {
  const qc = useQueryClient()
  const { register, handleSubmit, formState: { errors } } = useForm<FloorForm>({
    resolver: zodResolver(floorSchema) as Resolver<FloorForm>,
    defaultValues: { name: existing?.name ?? '', level: existing?.level ?? 0 },
  })

  const create = useMutation({
    mutationFn: (d: FloorForm) => floorsApi.create({ buildingId, ...d }),
    onSuccess: () => {
      toast.success('Floor created')
      qc.invalidateQueries({ queryKey: ['buildings', buildingId] })
      onClose()
    },
    onError: (err: Error) => {
      const details = err instanceof ApiError ? (err.fieldErrors ?? err.message) : err.message
      toast.error(details ?? 'Failed to create floor')
    },
  })

  const update = useMutation({
    mutationFn: (d: FloorForm) => floorsApi.update(existing!.id, d),
    onSuccess: () => {
      toast.success('Floor updated')
      qc.invalidateQueries({ queryKey: ['buildings', buildingId] })
      onClose()
    },
    onError: (err: Error) => {
      const details = err instanceof ApiError ? (err.fieldErrors ?? err.message) : err.message
      toast.error(details ?? 'Failed to update floor')
    },
  })

  const isPending = create.isPending || update.isPending

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{existing ? 'Edit Floor' : 'Add Floor'}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit((d: FloorForm) => existing ? update.mutate(d) : create.mutate(d))} className="space-y-4">
          <div>
            <Label htmlFor="fname">Floor name *</Label>
            <Input id="fname" {...register('name')} className="mt-1.5" placeholder="e.g. Ground Floor" />
            {errors.name && <p className="text-xs text-destructive mt-1">{errors.name.message}</p>}
          </div>
          <div>
            <Label htmlFor="level">Level number</Label>
            <Input id="level" type="number" {...register('level')} className="mt-1.5" placeholder="0" />
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={isPending}>
              {isPending ? 'Saving…' : existing ? 'Save' : 'Create floor'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function FloorCard({ floor, buildingId }: { floor: Floor; buildingId: string }) {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const fileRef = useRef<HTMLInputElement>(null)
  const [editOpen, setEditOpen] = useState(false)
  const [pendingUploadFile, setPendingUploadFile] = useState<File | null>(null)
  const [replaceConfirmOpen, setReplaceConfirmOpen] = useState(false)
  const [clearAssignOpen, setClearAssignOpen] = useState(false)

  const clearAssignments = useMutation({
    mutationFn: () => assetsApi.clearFloorAssignments(floor.id),
    onSuccess: (res) => {
      toast.success(`Cleared ${res.data.cleared} assignment${res.data.cleared !== 1 ? 's' : ''}`)
      qc.invalidateQueries({ queryKey: ['buildings', buildingId] })
      qc.invalidateQueries({ queryKey: ['floors', floor.id] })
      qc.invalidateQueries({ queryKey: ['assets'] })
    },
    onError: () => toast.error('Failed to clear assignments'),
  })

  const upload = useMutation({
    mutationFn: (file: File) => floorsApi.uploadFloorPlan(floor.id, file),
    onSuccess: () => {
      toast.success('Floor plan uploaded')
      qc.invalidateQueries({ queryKey: ['buildings', buildingId] })
      qc.invalidateQueries({ queryKey: ['floors', floor.id] })
      if (fileRef.current) fileRef.current.value = ''
    },
    onError: () => {
      toast.error('Failed to upload floor plan')
      if (fileRef.current) fileRef.current.value = ''
    },
  })

  const deleteFloor = useMutation({
    mutationFn: () => floorsApi.delete(floor.id),
    onSuccess: () => {
      toast.success('Floor deleted')
      qc.invalidateQueries({ queryKey: ['buildings', buildingId] })
    },
    onError: () => toast.error('Failed to delete floor'),
  })

  return (
    <>
      <Card>
        <CardContent className="p-4 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0 flex-1">
            <Layers className="h-5 w-5 text-muted-foreground shrink-0" />
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <p className="font-medium">{floor.name}</p>
                <Badge variant="outline" className="text-xs">Level {floor.level}</Badge>
                {(floor as any).floorPlan && (
                  <Badge variant="secondary" className="text-xs">Floor plan ✓</Badge>
                )}
              </div>
              <p className="text-xs text-muted-foreground mt-0.5">
                {(floor as any)._count?.zones ?? 0} zones
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            {/* <Button variant="ghost" size="sm" className="h-8 gap-1.5 text-xs"
              onClick={() => fileRef.current?.click()}>
              <Upload className="h-3.5 w-3.5" />
              {upload.isPending ? 'Uploading…' : 'Upload plan'}
            </Button> */}
            <input
              ref={fileRef}
              type="file"
              accept="image/*,.pdf,.dxf"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (!file) return
                if ((floor as any).floorPlan) {
                  setPendingUploadFile(file)
                  setReplaceConfirmOpen(true)
                } else {
                  upload.mutate(file)
                }
              }}
            />
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setEditOpen(true)}>
              <Pencil className="h-3.5 w-3.5" />
            </Button>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-destructive">
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete floor?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This will permanently delete <strong>{floor.name}</strong>, all its zones, assets, and bookings.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={() => deleteFloor.mutate()}
                    className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  >
                    Delete
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 hover:text-destructive"
              title="Clear floor assignments"
              onClick={() => setClearAssignOpen(true)}
            >
              <UserX className="h-3.5 w-3.5" />
            </Button>
            <Button size="sm" className="h-8 gap-1.5 text-xs"
              onClick={() => navigate(`/admin/floors/${floor.id}`)}>
              Manage zones & assets
              <ChevronRight className="h-3.5 w-3.5" />
            </Button>
          </div>
        </CardContent>
      </Card>

      <AlertDialog open={clearAssignOpen} onOpenChange={setClearAssignOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Clear all assignments on this floor?</AlertDialogTitle>
            <AlertDialogDescription>
              This will remove all permanent user assignments from every asset on <strong>{floor.name}</strong>.
              Assets will revert to open status. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => { clearAssignments.mutate(); setClearAssignOpen(false) }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Clear assignments
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <FloorDialog
        open={editOpen}
        onClose={() => setEditOpen(false)}
        buildingId={buildingId}
        existing={floor}
      />

      <AlertDialog open={replaceConfirmOpen} onOpenChange={setReplaceConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Replace floor plan?</AlertDialogTitle>
            <AlertDialogDescription>
              The existing floor plan for <strong>{floor.name}</strong> will be replaced with the
              new image. Desk positions are not affected — all desks will remain exactly where they
              are.
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
    </>
  )
}

// ─── Building managers management ────────────────────────────────────────────

function BuildingManagersPanel({ buildingId }: { buildingId: string }) {
  const qc = useQueryClient()
  const [tab, setTab] = useState<'users' | 'groups'>('users')

  // ── User managers ──────────────────────────────────────────────────────────
  const [search, setSearch] = useState('')
  const [selectedUserId, setSelectedUserId] = useState('')

  const { data: managers, isLoading } = useQuery({
    queryKey: ['buildings', buildingId, 'managers'],
    queryFn: () => buildingsApi.getManagers(buildingId),
    select: (r) => r.data,
  })

  const { data: searchResults } = useQuery({
    queryKey: ['users', 'search', search],
    queryFn: () => usersApi.list({ q: search, limit: 20 }),
    select: (r) => r.data,
    enabled: search.length >= 2,
  })

  const addUser = useMutation({
    mutationFn: () => buildingsApi.addManager(buildingId, selectedUserId),
    onSuccess: () => {
      toast.success('Building manager assigned')
      qc.invalidateQueries({ queryKey: ['buildings', buildingId, 'managers'] })
      setSearch('')
      setSelectedUserId('')
    },
    onError: () => toast.error('Failed to assign building manager'),
  })

  const removeUser = useMutation({
    mutationFn: (userId: string) => buildingsApi.removeManager(buildingId, userId),
    onSuccess: () => {
      toast.success('Building manager removed')
      qc.invalidateQueries({ queryKey: ['buildings', buildingId, 'managers'] })
    },
    onError: () => toast.error('Failed to remove building manager'),
  })

  const existingUserIds = new Set((managers ?? []).map((m) => m.id))
  const filteredResults = (searchResults ?? []).filter((u) => !existingUserIds.has(u.id))

  // ── Group managers ─────────────────────────────────────────────────────────
  const [selectedGroupId, setSelectedGroupId] = useState('')

  const { data: groupManagers, isLoading: groupManagersLoading } = useQuery({
    queryKey: ['buildings', buildingId, 'group-managers'],
    queryFn: () => buildingsApi.getGroupManagers(buildingId),
    select: (r) => r.data,
  })

  const { data: allGroups } = useQuery({
    queryKey: ['groups'],
    queryFn: () => groupsApi.list(),
    select: (r) => r.data,
  })

  const addGroup = useMutation({
    mutationFn: () => buildingsApi.addGroupManager(buildingId, selectedGroupId),
    onSuccess: () => {
      toast.success('Group assigned as building manager')
      qc.invalidateQueries({ queryKey: ['buildings', buildingId, 'group-managers'] })
      setSelectedGroupId('')
    },
    onError: () => toast.error('Failed to assign group'),
  })

  const removeGroup = useMutation({
    mutationFn: (groupId: string) => buildingsApi.removeGroupManager(buildingId, groupId),
    onSuccess: () => {
      toast.success('Group manager removed')
      qc.invalidateQueries({ queryKey: ['buildings', buildingId, 'group-managers'] })
    },
    onError: () => toast.error('Failed to remove group manager'),
  })

  const existingGroupIds = new Set((groupManagers ?? []).map((g) => g.id))
  const availableGroups = (allGroups ?? []).filter((g) => !existingGroupIds.has(g.id))

  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center gap-2 mb-3">
          <Users className="h-4 w-4 text-muted-foreground" />
          <span className="font-medium text-sm">Building Managers</span>
        </div>
        <p className="text-xs text-muted-foreground mb-4">
          Building managers can manage all floors, zones, and assets in this building. They inherit floor manager permissions for every floor.
        </p>

        {/* Tab toggle */}
        <div className="flex gap-1 border rounded-lg p-1 w-fit mb-4">
          <button
            onClick={() => setTab('users')}
            className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${tab === 'users' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}`}
          >
            Users
          </button>
          <button
            onClick={() => setTab('groups')}
            className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${tab === 'groups' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}`}
          >
            Groups
          </button>
        </div>

        {tab === 'users' && (
          <div className="space-y-3">
            {isLoading ? (
              <Skeleton className="h-10 w-full" />
            ) : (managers ?? []).length === 0 ? (
              <div className="rounded-lg border border-dashed p-4 flex flex-col items-center text-center">
                <Users className="h-6 w-6 text-muted-foreground/30 mb-1" />
                <p className="text-xs text-muted-foreground">No individual building managers assigned</p>
              </div>
            ) : (
              <div className="rounded-lg border divide-y">
                {managers!.map((m) => (
                  <div key={m.id} className="flex items-center justify-between px-3 py-2.5">
                    <div>
                      <p className="text-sm font-medium">{m.displayName}</p>
                      <p className="text-xs text-muted-foreground">{m.email}</p>
                    </div>
                    <Button
                      size="icon" variant="ghost" className="h-7 w-7 hover:text-destructive"
                      onClick={() => removeUser.mutate(m.id)}
                      disabled={removeUser.isPending}
                    >
                      <UserMinus className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ))}
              </div>
            )}

            <div className="space-y-2">
              <Input
                placeholder="Search by name or email…"
                value={search}
                onChange={(e) => { setSearch(e.target.value); setSelectedUserId('') }}
                className="h-8 text-xs"
              />
              {search.length >= 2 && filteredResults.length > 0 && (
                <div className="rounded-md border divide-y max-h-40 overflow-y-auto">
                  {filteredResults.map((u) => (
                    <button
                      key={u.id}
                      type="button"
                      className={`w-full text-left px-3 py-2 hover:bg-muted transition-colors ${selectedUserId === u.id ? 'bg-muted' : ''}`}
                      onClick={() => setSelectedUserId(u.id)}
                    >
                      <p className="text-xs font-medium">{u.displayName}</p>
                      <p className="text-xs text-muted-foreground">{u.email}</p>
                    </button>
                  ))}
                </div>
              )}
              {search.length >= 2 && filteredResults.length === 0 && (
                <p className="text-xs text-muted-foreground">No users found</p>
              )}
              <Button
                size="sm" className="h-7 text-xs"
                onClick={() => addUser.mutate()}
                disabled={!selectedUserId || addUser.isPending}
              >
                <UserPlus className="mr-1.5 h-3 w-3" />
                {addUser.isPending ? 'Assigning…' : 'Assign as manager'}
              </Button>
            </div>
          </div>
        )}

        {tab === 'groups' && (
          <div className="space-y-3">
            {groupManagersLoading ? (
              <Skeleton className="h-10 w-full" />
            ) : (groupManagers ?? []).length === 0 ? (
              <div className="rounded-lg border border-dashed p-4 flex flex-col items-center text-center">
                <Users className="h-6 w-6 text-muted-foreground/30 mb-1" />
                <p className="text-xs text-muted-foreground">No groups assigned as building managers</p>
              </div>
            ) : (
              <div className="rounded-lg border divide-y">
                {groupManagers!.map((g) => (
                  <div key={g.id} className="flex items-center justify-between px-3 py-2.5">
                    <div>
                      <p className="text-sm font-medium">{g.name}</p>
                      <p className="text-xs text-muted-foreground">{g.memberCount} member{g.memberCount !== 1 ? 's' : ''}</p>
                    </div>
                    <Button
                      size="icon" variant="ghost" className="h-7 w-7 hover:text-destructive"
                      onClick={() => removeGroup.mutate(g.id)}
                      disabled={removeGroup.isPending}
                    >
                      <UserMinus className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ))}
              </div>
            )}

            <div className="space-y-2">
              {availableGroups.length === 0 ? (
                <p className="text-xs text-muted-foreground">All groups are already assigned, or no groups exist.</p>
              ) : (
                <Select value={selectedGroupId} onValueChange={setSelectedGroupId}>
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue placeholder="Select a group…" />
                  </SelectTrigger>
                  <SelectContent>
                    {availableGroups.map((g) => (
                      <SelectItem key={g.id} value={g.id} className="text-xs">
                        {g.name}
                        {g._count && <span className="text-muted-foreground ml-1">({g._count.members})</span>}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              <Button
                size="sm" className="h-7 text-xs"
                onClick={() => addGroup.mutate()}
                disabled={!selectedGroupId || addGroup.isPending}
              >
                <UserPlus className="mr-1.5 h-3 w-3" />
                {addGroup.isPending ? 'Assigning…' : 'Assign group as manager'}
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// ─── Building access management ───────────────────────────────────────────────

function BuildingAccessSection({ buildingId }: { buildingId: string }) {
  const qc = useQueryClient()
  const [selectedGroupId, setSelectedGroupId] = useState('')

  const { data: accessGroups, isLoading } = useQuery({
    queryKey: ['buildings', buildingId, 'access-groups'],
    queryFn: () => buildingsApi.getAccessGroups(buildingId),
    select: (r) => r.data,
  })

  const { data: allGroups, isLoading: loadingGroups } = useQuery({
    queryKey: ['groups'],
    queryFn: () => groupsApi.list(),
    select: (r) => r.data,
  })

  const assignedIds = new Set((accessGroups ?? []).map((g) => g.id))
  const available = (allGroups ?? []).filter((g) => !assignedIds.has(g.id))

  const add = useMutation({
    mutationFn: (groupId: string) => buildingsApi.addAccessGroup(buildingId, groupId),
    onSuccess: () => {
      toast.success('Access group added')
      qc.invalidateQueries({ queryKey: ['buildings', buildingId, 'access-groups'] })
      setSelectedGroupId('')
    },
    onError: () => toast.error('Failed to add group'),
  })

  const remove = useMutation({
    mutationFn: (groupId: string) => buildingsApi.removeAccessGroup(buildingId, groupId),
    onSuccess: () => {
      toast.success('Access group removed')
      qc.invalidateQueries({ queryKey: ['buildings', buildingId, 'access-groups'] })
    },
    onError: () => toast.error('Failed to remove group'),
  })

  const isOpen = !isLoading && (accessGroups?.length ?? 0) === 0

  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Shield className="h-4 w-4 text-muted-foreground" />
            <span className="font-medium text-sm">Building Access</span>
          </div>
          {isOpen && !isLoading && (
            <Badge variant="secondary" className="text-xs">Open — all users can access</Badge>
          )}
        </div>

        {isLoading ? (
          <Skeleton className="h-8 w-full" />
        ) : (
          <div className="space-y-3">
            {(accessGroups ?? []).length > 0 && (
              <div className="space-y-1.5">
                {accessGroups!.map((group) => (
                  <div key={group.id} className="flex items-center justify-between rounded-md border px-3 py-2">
                    <div className="min-w-0">
                      <span className="text-sm font-medium">{group.name}</span>
                      <span className="text-xs text-muted-foreground ml-2">
                        {group._count.members} {group._count.members === 1 ? 'member' : 'members'}
                      </span>
                      {group.description && (
                        <p className="text-xs text-muted-foreground truncate">{group.description}</p>
                      )}
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 hover:text-destructive shrink-0"
                      onClick={() => remove.mutate(group.id)}
                      disabled={remove.isPending}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ))}
              </div>
            )}

            {isOpen && (
              <p className="text-xs text-muted-foreground">
                No access groups assigned. Add a group below to restrict this building to specific users.
              </p>
            )}

            {/* Add group row — always rendered so it's visible even before groups load */}
            {loadingGroups ? (
              <Skeleton className="h-8 w-full" />
            ) : allGroups && allGroups.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No access groups exist yet. Create groups in{' '}
                <a href="/admin/groups" className="underline underline-offset-2 hover:text-foreground">
                  Admin → Access Groups
                </a>{' '}
                first.
              </p>
            ) : available.length > 0 ? (
              <div className="flex gap-2">
                <Select value={selectedGroupId} onValueChange={setSelectedGroupId}>
                  <SelectTrigger className="h-8 text-xs flex-1">
                    <SelectValue placeholder="Select a group to add…" />
                  </SelectTrigger>
                  <SelectContent>
                    {available.map((g) => (
                      <SelectItem key={g.id} value={g.id} className="text-xs">
                        {g.name}
                        {g._count && (
                          <span className="text-muted-foreground ml-1">
                            ({g._count.members})
                          </span>
                        )}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  size="sm"
                  className="h-8 text-xs shrink-0"
                  disabled={!selectedGroupId || add.isPending}
                  onClick={() => selectedGroupId && add.mutate(selectedGroupId)}
                >
                  <Plus className="h-3.5 w-3.5 mr-1" />
                  Add
                </Button>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">All groups have been assigned.</p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

export default function BuildingDetailAdminPage() {
  const { buildingId } = useParams<{ buildingId: string }>()
  const [addFloorOpen, setAddFloorOpen] = useState(false)
  const [bulkAssignOpen, setBulkAssignOpen] = useState(false)

  const { data: building, isLoading } = useQuery({
    queryKey: ['buildings', buildingId],
    queryFn: () => buildingsApi.get(buildingId!),
    select: (r) => r.data,
    enabled: !!buildingId,
  })

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="flex items-center gap-2 text-sm text-muted-foreground mb-4">
        <Link to="/admin/buildings" className="hover:text-foreground">Buildings</Link>
        <ChevronRight className="h-3.5 w-3.5" />
        {isLoading ? <Skeleton className="h-4 w-28" /> : <span className="text-foreground font-medium">{building?.name}</span>}
      </div>

      <div className="flex items-center justify-between mb-6">
        <div>
          {isLoading ? <Skeleton className="h-8 w-48" /> : (
            <>
              <h1 className="text-2xl font-bold">{building?.name}</h1>
              {building?.address && <p className="text-muted-foreground text-sm mt-0.5">{building.address}</p>}
            </>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => setBulkAssignOpen(true)}>
            <UserPlus className="mr-2 h-4 w-4" /> Bulk assign users
          </Button>
          <Button onClick={() => setAddFloorOpen(true)}>
            <Plus className="mr-2 h-4 w-4" /> Add Floor
          </Button>
        </div>
      </div>

      <BuildingManagersPanel buildingId={buildingId!} />

      <BuildingAccessSection buildingId={buildingId!} />

      <div className="mt-6 mb-3 flex items-center justify-between">
        <h2 className="text-base font-semibold">Floors</h2>
      </div>

      {isLoading ? (
        <div className="space-y-3">{[1, 2].map((i) => <Skeleton key={i} className="h-20" />)}</div>
      ) : (building?.floors ?? []).length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12 text-center">
            <Layers className="h-12 w-12 text-muted-foreground/30 mb-3" />
            <p className="text-sm text-muted-foreground">No floors yet</p>
            <Button variant="outline" size="sm" className="mt-4" onClick={() => setAddFloorOpen(true)}>
              <Plus className="mr-2 h-3.5 w-3.5" /> Add a floor
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {(building?.floors ?? [])
            .sort((a, b) => a.level - b.level)
            .map((f) => <FloorCard key={f.id} floor={f} buildingId={buildingId!} />)}
        </div>
      )}

      <FloorDialog
        open={addFloorOpen}
        onClose={() => setAddFloorOpen(false)}
        buildingId={buildingId!}
      />

      <AssignmentImportDialog
        open={bulkAssignOpen}
        onClose={() => setBulkAssignOpen(false)}
        buildingId={buildingId}
        buildingName={building?.name}
      />
    </div>
  )
}
