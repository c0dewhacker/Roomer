import { useState } from 'react'
import { Users, Plus, Trash2, Shield, Building2, Layers } from 'lucide-react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { groupsApi, buildingsApi, usersApi } from '@/lib/api'
import { toast } from 'sonner'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Separator } from '@/components/ui/separator'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog'
import {
  Sheet, SheetContent, SheetHeader, SheetTitle,
} from '@/components/ui/sheet'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import type { UserGroup } from '@/types'

// ─── Create Group Dialog ──────────────────────────────────────────────────────

function RoleBadge({ role }: { role: 'USER' | 'SUPER_ADMIN' }) {
  return role === 'SUPER_ADMIN' ? (
    <Badge className="text-xs bg-amber-100 text-amber-800 border-amber-200 hover:bg-amber-100">
      <Shield className="h-3 w-3 mr-1" />Super Admin
    </Badge>
  ) : (
    <Badge variant="outline" className="text-xs text-muted-foreground">
      <Shield className="h-3 w-3 mr-1" />User
    </Badge>
  )
}

function CreateGroupDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [globalRole, setGlobalRole] = useState<'USER' | 'SUPER_ADMIN'>('USER')

  const create = useMutation({
    mutationFn: () => groupsApi.create({ name, description: description || undefined, globalRole }),
    onSuccess: () => {
      toast.success('Group created')
      qc.invalidateQueries({ queryKey: ['groups'] })
      onClose()
      setName('')
      setDescription('')
      setGlobalRole('USER')
    },
    onError: () => toast.error('Failed to create group'),
  })

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create Group</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-1">
          <div>
            <Label htmlFor="gname">Name *</Label>
            <Input
              id="gname"
              className="mt-1.5"
              placeholder="e.g. London Office Staff"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="gdesc">Description</Label>
            <Input
              id="gdesc"
              className="mt-1.5"
              placeholder="Optional description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="grole">Role granted to members</Label>
            <Select value={globalRole} onValueChange={(v) => setGlobalRole(v as 'USER' | 'SUPER_ADMIN')}>
              <SelectTrigger id="grole" className="mt-1.5">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="USER">User — standard access</SelectItem>
                <SelectItem value="SUPER_ADMIN">Super Admin — full admin access</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={() => create.mutate()} disabled={!name.trim() || create.isPending}>
            {create.isPending ? 'Creating…' : 'Create group'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ─── Group Detail Sheet ───────────────────────────────────────────────────────

function GroupDetailSheet({ group, onClose }: { group: UserGroup | null; onClose: () => void }) {
  const qc = useQueryClient()
  const [memberSearch, setMemberSearch] = useState('')
  const [selectedMemberId, setSelectedMemberId] = useState('')
  const [selectedBuildingId, setSelectedBuildingId] = useState('')
  const [selectedFloorBuildingId, setSelectedFloorBuildingId] = useState('')
  const [selectedFloorId, setSelectedFloorId] = useState('')
  const [editRole, setEditRole] = useState<'USER' | 'SUPER_ADMIN' | null>(null)

  const { data: detail } = useQuery({
    queryKey: ['groups', group?.id],
    queryFn: () => groupsApi.get(group!.id),
    select: (r) => r.data,
    enabled: !!group,
  })

  const { data: userResults } = useQuery({
    queryKey: ['users', 'search', memberSearch],
    queryFn: () => usersApi.list({ q: memberSearch, limit: 15 }),
    select: (r) => r.data,
    enabled: memberSearch.length >= 2,
  })

  const { data: buildings = [] } = useQuery({
    queryKey: ['buildings'],
    queryFn: () => buildingsApi.list(),
    select: (r) => r.data,
  })

  const { data: floorBuildingDetail } = useQuery({
    queryKey: ['buildings', selectedFloorBuildingId],
    queryFn: () => buildingsApi.get(selectedFloorBuildingId),
    select: (r) => r.data,
    enabled: !!selectedFloorBuildingId,
  })

  const updateRole = useMutation({
    mutationFn: (role: 'USER' | 'SUPER_ADMIN') => groupsApi.update(group!.id, { globalRole: role }),
    onSuccess: () => {
      toast.success('Role updated')
      qc.invalidateQueries({ queryKey: ['groups'] })
      setEditRole(null)
    },
    onError: () => toast.error('Failed to update role'),
  })

  const addMember = useMutation({
    mutationFn: () => groupsApi.addMember(group!.id, selectedMemberId),
    onSuccess: () => {
      toast.success('Member added')
      qc.invalidateQueries({ queryKey: ['groups', group?.id] })
      setMemberSearch('')
      setSelectedMemberId('')
    },
    onError: () => toast.error('Failed to add member'),
  })

  const removeMember = useMutation({
    mutationFn: (userId: string) => groupsApi.removeMember(group!.id, userId),
    onSuccess: () => { toast.success('Member removed'); qc.invalidateQueries({ queryKey: ['groups', group?.id] }) },
    onError: () => toast.error('Failed to remove member'),
  })

  const addBuildingAccess = useMutation({
    mutationFn: () => groupsApi.addBuildingAccess(group!.id, selectedBuildingId),
    onSuccess: () => {
      toast.success('Building access added')
      qc.invalidateQueries({ queryKey: ['groups', group?.id] })
      setSelectedBuildingId('')
    },
    onError: () => toast.error('Failed to add building access'),
  })

  const removeBuildingAccess = useMutation({
    mutationFn: (buildingId: string) => groupsApi.removeBuildingAccess(group!.id, buildingId),
    onSuccess: () => { toast.success('Building access removed'); qc.invalidateQueries({ queryKey: ['groups', group?.id] }) },
    onError: () => toast.error('Failed to remove building access'),
  })

  const addFloorAccess = useMutation({
    mutationFn: () => groupsApi.addFloorAccess(group!.id, selectedFloorId),
    onSuccess: () => {
      toast.success('Floor access added')
      qc.invalidateQueries({ queryKey: ['groups', group?.id] })
      setSelectedFloorId('')
    },
    onError: () => toast.error('Failed to add floor access'),
  })

  const removeFloorAccess = useMutation({
    mutationFn: (floorId: string) => groupsApi.removeFloorAccess(group!.id, floorId),
    onSuccess: () => { toast.success('Floor access removed'); qc.invalidateQueries({ queryKey: ['groups', group?.id] }) },
    onError: () => toast.error('Failed to remove floor access'),
  })

  const members = detail?.members ?? []
  const buildingAccess = detail?.buildingAccess ?? []
  const floorAccess = detail?.floorAccess ?? []

  // Available buildings not yet in access list
  const availableBuildings = buildings.filter(
    (b) => !buildingAccess.some((a) => a.buildingId === b.id),
  )

  const floorBuildingFloors = floorBuildingDetail?.floors ?? []

  return (
    <Sheet open={!!group} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="w-full max-w-lg overflow-y-auto">
        {group && (
          <>
            <SheetHeader>
              <SheetTitle className="flex items-center gap-2">
                <Shield className="h-5 w-5 text-primary" />
                {group.name}
              </SheetTitle>
              {group.description && (
                <p className="text-sm text-muted-foreground">{group.description}</p>
              )}
            </SheetHeader>

            <div className="mt-6 space-y-6">
              {/* Role */}
              <div>
                <p className="text-sm font-semibold mb-2">Global Role</p>
                <p className="text-xs text-muted-foreground mb-3">
                  Members added via SSO group mapping are granted this role on login.
                </p>
                {editRole === null ? (
                  <div className="flex items-center gap-3">
                    <RoleBadge role={group.globalRole} />
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 text-xs"
                      onClick={() => setEditRole(group.globalRole)}
                    >
                      Change
                    </Button>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <Select value={editRole} onValueChange={(v) => setEditRole(v as 'USER' | 'SUPER_ADMIN')}>
                      <SelectTrigger className="h-8 text-sm w-56">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="USER">User</SelectItem>
                        <SelectItem value="SUPER_ADMIN">Super Admin</SelectItem>
                      </SelectContent>
                    </Select>
                    <Button
                      size="sm"
                      className="h-8"
                      onClick={() => updateRole.mutate(editRole)}
                      disabled={updateRole.isPending}
                    >
                      {updateRole.isPending ? 'Saving…' : 'Save'}
                    </Button>
                    <Button variant="ghost" size="sm" className="h-8" onClick={() => setEditRole(null)}>
                      Cancel
                    </Button>
                  </div>
                )}
              </div>

              <Separator />

              {/* Access restriction note */}
              <div className="rounded-md bg-blue-50 px-3 py-2 text-xs text-blue-700">
                <strong>How access control works:</strong> If a group has building or floor restrictions,
                members can only book desks in those locations. Users with no group restrictions, or not in any
                restricted group, can book anywhere.
              </div>

              {/* Members */}
              <div>
                <p className="text-sm font-semibold mb-3 flex items-center gap-1.5">
                  <Users className="h-3.5 w-3.5" />
                  Members ({members.length})
                </p>

                {/* Add member search */}
                <div className="mb-3">
                  <Input
                    placeholder="Search users to add…"
                    value={memberSearch}
                    onChange={(e) => { setMemberSearch(e.target.value); setSelectedMemberId('') }}
                    className="text-sm"
                  />
                  {!selectedMemberId && userResults && userResults.length > 0 && (
                    <div className="rounded-md border divide-y mt-1 max-h-36 overflow-y-auto">
                      {userResults
                        .filter((u) => !members.some((m) => m.userId === u.id))
                        .map((u) => (
                          <button
                            key={u.id}
                            type="button"
                            className="w-full text-left px-3 py-1.5 hover:bg-muted transition-colors"
                            onClick={() => { setSelectedMemberId(u.id); setMemberSearch(u.displayName) }}
                          >
                            <p className="text-sm font-medium">{u.displayName}</p>
                            <p className="text-xs text-muted-foreground">{u.email}</p>
                          </button>
                        ))}
                    </div>
                  )}
                  {selectedMemberId && (
                    <Button
                      size="sm"
                      className="mt-1.5 w-full"
                      onClick={() => addMember.mutate()}
                      disabled={addMember.isPending}
                    >
                      {addMember.isPending ? 'Adding…' : 'Add to group'}
                    </Button>
                  )}
                </div>

                {members.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No members yet</p>
                ) : (
                  <div className="space-y-1.5">
                    {members.map((m) => (
                      <div key={m.userId} className="flex items-center justify-between rounded-md border px-3 py-2">
                        <div>
                          <p className="text-sm font-medium">{m.user?.displayName}</p>
                          <p className="text-xs text-muted-foreground">{m.user?.email}</p>
                        </div>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 hover:text-destructive"
                          onClick={() => removeMember.mutate(m.userId)}
                          disabled={removeMember.isPending}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <Separator />

              {/* Building access rules */}
              <div>
                <p className="text-sm font-semibold mb-2 flex items-center gap-1.5">
                  <Building2 className="h-3.5 w-3.5" />
                  Allowed Buildings
                </p>
                <p className="text-xs text-muted-foreground mb-3">
                  Leave empty to allow all buildings. Adding rules restricts members to selected buildings only.
                </p>

                {availableBuildings.length > 0 && (
                  <div className="flex gap-2 mb-3">
                    <Select value={selectedBuildingId} onValueChange={setSelectedBuildingId}>
                      <SelectTrigger className="flex-1">
                        <SelectValue placeholder="Select building…" />
                      </SelectTrigger>
                      <SelectContent>
                        {availableBuildings.map((b) => (
                          <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button
                      size="sm"
                      onClick={() => addBuildingAccess.mutate()}
                      disabled={!selectedBuildingId || addBuildingAccess.isPending}
                    >
                      <Plus className="h-4 w-4" />
                    </Button>
                  </div>
                )}

                {buildingAccess.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No restrictions — all buildings allowed</p>
                ) : (
                  <div className="space-y-1.5">
                    {buildingAccess.map((a) => (
                      <div key={a.buildingId} className="flex items-center justify-between rounded-md border px-3 py-2">
                        <p className="text-sm font-medium">{a.building?.name ?? a.buildingId}</p>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 hover:text-destructive"
                          onClick={() => removeBuildingAccess.mutate(a.buildingId)}
                          disabled={removeBuildingAccess.isPending}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <Separator />

              {/* Floor access rules */}
              <div>
                <p className="text-sm font-semibold mb-2 flex items-center gap-1.5">
                  <Layers className="h-3.5 w-3.5" />
                  Allowed Floors
                </p>
                <p className="text-xs text-muted-foreground mb-3">
                  Restrict members to specific floors within a building.
                </p>

                <div className="flex gap-2 mb-2">
                  <Select value={selectedFloorBuildingId} onValueChange={(v) => { setSelectedFloorBuildingId(v); setSelectedFloorId('') }}>
                    <SelectTrigger className="flex-1">
                      <SelectValue placeholder="Building…" />
                    </SelectTrigger>
                    <SelectContent>
                      {buildings.map((b) => (
                        <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select value={selectedFloorId} onValueChange={setSelectedFloorId} disabled={!selectedFloorBuildingId}>
                    <SelectTrigger className="flex-1">
                      <SelectValue placeholder="Floor…" />
                    </SelectTrigger>
                    <SelectContent>
                      {floorBuildingFloors
                        .filter((f) => !floorAccess.some((a) => a.floorId === f.id))
                        .map((f) => (
                          <SelectItem key={f.id} value={f.id}>{f.name}</SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                  <Button
                    size="sm"
                    onClick={() => addFloorAccess.mutate()}
                    disabled={!selectedFloorId || addFloorAccess.isPending}
                  >
                    <Plus className="h-4 w-4" />
                  </Button>
                </div>

                {floorAccess.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No floor restrictions</p>
                ) : (
                  <div className="space-y-1.5">
                    {floorAccess.map((a) => (
                      <div key={a.floorId} className="flex items-center justify-between rounded-md border px-3 py-2">
                        <p className="text-sm font-medium">{a.floor?.name ?? a.floorId}</p>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 hover:text-destructive"
                          onClick={() => removeFloorAccess.mutate(a.floorId)}
                          disabled={removeFloorAccess.isPending}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function GroupsAdminPage() {
  const qc = useQueryClient()
  const [createOpen, setCreateOpen] = useState(false)
  const [selectedGroup, setSelectedGroup] = useState<UserGroup | null>(null)

  const { data: groups, isLoading } = useQuery({
    queryKey: ['groups'],
    queryFn: () => groupsApi.list(),
    select: (r) => r.data,
  })

  const deleteGroup = useMutation({
    mutationFn: (id: string) => groupsApi.delete(id),
    onSuccess: () => { toast.success('Group deleted'); qc.invalidateQueries({ queryKey: ['groups'] }) },
    onError: () => toast.error('Failed to delete group'),
  })

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Access Groups</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Manage user groups and control which buildings and floors they can access
        </p>
      </div>

      <div className="flex items-center justify-between mb-5">
        <p className="text-sm text-muted-foreground">
          {groups?.length ?? 0} group{(groups?.length ?? 0) !== 1 ? 's' : ''}
        </p>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="mr-2 h-4 w-4" /> Create Group
        </Button>
      </div>

      {isLoading ? (
        <div className="space-y-3">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-24 w-full" />)}</div>
      ) : (groups ?? []).length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <Shield className="h-12 w-12 text-muted-foreground/30 mb-3" />
          <p className="text-sm text-muted-foreground">No groups yet</p>
          <p className="text-xs text-muted-foreground mt-1">
            Groups let you restrict user access to specific buildings and floors
          </p>
          <Button variant="outline" size="sm" className="mt-3" onClick={() => setCreateOpen(true)}>
            Create first group
          </Button>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {(groups ?? []).map((group) => (
            <Card key={group.id} className="hover:shadow-md transition-shadow cursor-pointer" onClick={() => setSelectedGroup(group)}>
              <CardHeader className="pb-2">
                <div className="flex items-start justify-between">
                  <CardTitle className="text-base">{group.name}</CardTitle>
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 hover:text-destructive -mt-1 -mr-1"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Delete group?</AlertDialogTitle>
                        <AlertDialogDescription>
                          Delete <strong>{group.name}</strong>? Members will lose group-based access restrictions.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                          onClick={() => deleteGroup.mutate(group.id)}
                          className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                        >
                          Delete
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </div>
                {group.description && (
                  <p className="text-sm text-muted-foreground">{group.description}</p>
                )}
              </CardHeader>
              <CardContent className="pt-0">
                <div className="flex flex-wrap gap-1.5">
                  <RoleBadge role={group.globalRole} />
                  <Badge variant="secondary" className="text-xs">
                    <Users className="h-3 w-3 mr-1" />
                    {group._count?.members ?? 0} member{(group._count?.members ?? 0) !== 1 ? 's' : ''}
                  </Badge>
                  {(group.buildingAccess?.length ?? 0) > 0 && (
                    <Badge variant="outline" className="text-xs">
                      <Building2 className="h-3 w-3 mr-1" />
                      {group.buildingAccess?.length} building{(group.buildingAccess?.length ?? 0) !== 1 ? 's' : ''}
                    </Badge>
                  )}
                  {(group.floorAccess?.length ?? 0) > 0 && (
                    <Badge variant="outline" className="text-xs">
                      <Layers className="h-3 w-3 mr-1" />
                      {group.floorAccess?.length} floor{(group.floorAccess?.length ?? 0) !== 1 ? 's' : ''}
                    </Badge>
                  )}
                  {(group.buildingAccess?.length ?? 0) === 0 && (group.floorAccess?.length ?? 0) === 0 && (
                    <Badge variant="outline" className="text-xs text-muted-foreground">No restrictions</Badge>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <CreateGroupDialog open={createOpen} onClose={() => setCreateOpen(false)} />
      <GroupDetailSheet group={selectedGroup} onClose={() => setSelectedGroup(null)} />
    </div>
  )
}
