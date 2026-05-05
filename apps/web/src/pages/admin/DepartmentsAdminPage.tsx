import { useState } from 'react'
import { Network, Plus, Trash2, Users, ChevronRight } from 'lucide-react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { departmentsApi, usersApi, type Department, type DepartmentMember } from '@/lib/api'
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

// ─── Create Dialog ────────────────────────────────────────────────────────────

function CreateDepartmentDialog({
  open,
  onClose,
  departments,
}: {
  open: boolean
  onClose: () => void
  departments: Department[]
}) {
  const qc = useQueryClient()
  const [name, setName] = useState('')
  const [parentId, setParentId] = useState<string>('none')

  const create = useMutation({
    mutationFn: () =>
      departmentsApi.create({ name, ...(parentId !== 'none' ? { parentId } : {}) }),
    onSuccess: () => {
      toast.success('Department created')
      qc.invalidateQueries({ queryKey: ['departments'] })
      onClose()
      setName('')
      setParentId('none')
    },
    onError: () => toast.error('Failed to create department'),
  })

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create Department</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-1">
          <div>
            <Label htmlFor="dname">Name *</Label>
            <Input
              id="dname"
              className="mt-1.5"
              placeholder="e.g. Engineering"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="dparent">Parent department</Label>
            <Select value={parentId} onValueChange={setParentId}>
              <SelectTrigger id="dparent" className="mt-1.5">
                <SelectValue placeholder="None (top-level)" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">None (top-level)</SelectItem>
                {departments.map((d) => (
                  <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={() => create.mutate()} disabled={!name.trim() || create.isPending}>
            {create.isPending ? 'Creating…' : 'Create department'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ─── Detail Sheet ─────────────────────────────────────────────────────────────

function DepartmentDetailSheet({
  department,
  allDepartments,
  onClose,
}: {
  department: Department | null
  allDepartments: Department[]
  onClose: () => void
}) {
  const qc = useQueryClient()
  const [memberSearch, setMemberSearch] = useState('')
  const [selectedMemberId, setSelectedMemberId] = useState('')
  const [editName, setEditName] = useState<string | null>(null)
  const [editParentId, setEditParentId] = useState<string>('none')

  const { data: detail } = useQuery({
    queryKey: ['departments', department?.id],
    queryFn: () => departmentsApi.get(department!.id),
    select: (r) => r.data,
    enabled: !!department,
  })

  const { data: members = [] } = useQuery({
    queryKey: ['departments', department?.id, 'members'],
    queryFn: () => departmentsApi.listMembers(department!.id),
    select: (r) => r.data,
    enabled: !!department,
  })

  const { data: userResults } = useQuery({
    queryKey: ['users', 'search', memberSearch],
    queryFn: () => usersApi.list({ q: memberSearch, limit: 15 }),
    select: (r) => r.data,
    enabled: memberSearch.length >= 2,
  })

  const updateDept = useMutation({
    mutationFn: (body: { name?: string; parentId?: string | null }) =>
      departmentsApi.update(department!.id, body),
    onSuccess: () => {
      toast.success('Department updated')
      qc.invalidateQueries({ queryKey: ['departments'] })
      setEditName(null)
    },
    onError: () => toast.error('Failed to update department'),
  })

  const addMember = useMutation({
    mutationFn: () => departmentsApi.addMember(department!.id, selectedMemberId),
    onSuccess: () => {
      toast.success('Member added')
      qc.invalidateQueries({ queryKey: ['departments', department?.id, 'members'] })
      setMemberSearch('')
      setSelectedMemberId('')
    },
    onError: () => toast.error('Failed to add member'),
  })

  const removeMember = useMutation({
    mutationFn: (userId: string) => departmentsApi.removeMember(department!.id, userId),
    onSuccess: () => {
      toast.success('Member removed')
      qc.invalidateQueries({ queryKey: ['departments', department?.id, 'members'] })
    },
    onError: () => toast.error('Failed to remove member'),
  })

  const children = detail?.children ?? []
  // Exclude self and own children from parent options to avoid cycles
  const parentOptions = allDepartments.filter(
    (d) => d.id !== department?.id && !children.some((c) => c.id === d.id),
  )

  function startEdit() {
    if (!department) return
    setEditName(department.name)
    setEditParentId(department.parentId ?? 'none')
  }

  function saveEdit() {
    if (editName === null) return
    updateDept.mutate({
      name: editName.trim() || undefined,
      parentId: editParentId === 'none' ? null : editParentId,
    })
  }

  return (
    <Sheet open={!!department} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="w-full max-w-lg overflow-y-auto">
        {department && (
          <>
            <SheetHeader>
              <SheetTitle className="flex items-center gap-2">
                <Network className="h-5 w-5 text-primary" />
                {department.name}
              </SheetTitle>
              {department.parent && (
                <p className="text-sm text-muted-foreground flex items-center gap-1">
                  <ChevronRight className="h-3.5 w-3.5" />
                  {department.parent.name}
                </p>
              )}
            </SheetHeader>

            <div className="mt-6 space-y-6">
              {/* Edit name / parent */}
              <div>
                <p className="text-sm font-semibold mb-2">Details</p>
                {editName === null ? (
                  <Button variant="outline" size="sm" onClick={startEdit}>Edit name / parent</Button>
                ) : (
                  <div className="space-y-3">
                    <div>
                      <Label htmlFor="edit-name">Name</Label>
                      <Input
                        id="edit-name"
                        className="mt-1.5"
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                      />
                    </div>
                    <div>
                      <Label htmlFor="edit-parent">Parent department</Label>
                      <Select value={editParentId} onValueChange={setEditParentId}>
                        <SelectTrigger id="edit-parent" className="mt-1.5">
                          <SelectValue placeholder="None (top-level)" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">None (top-level)</SelectItem>
                          {parentOptions.map((d) => (
                            <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="flex gap-2">
                      <Button size="sm" onClick={saveEdit} disabled={!editName.trim() || updateDept.isPending}>
                        {updateDept.isPending ? 'Saving…' : 'Save'}
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => setEditName(null)}>Cancel</Button>
                    </div>
                  </div>
                )}
              </div>

              {/* Sub-departments */}
              {children.length > 0 && (
                <>
                  <Separator />
                  <div>
                    <p className="text-sm font-semibold mb-3">Sub-departments ({children.length})</p>
                    <div className="space-y-1.5">
                      {children.map((child) => (
                        <div key={child.id} className="flex items-center justify-between rounded-md border px-3 py-2">
                          <p className="text-sm font-medium">{child.name}</p>
                          <Badge variant="secondary" className="text-xs">
                            <Users className="h-3 w-3 mr-1" />
                            {child._count.members}
                          </Badge>
                        </div>
                      ))}
                    </div>
                  </div>
                </>
              )}

              <Separator />

              {/* Members */}
              <div>
                <p className="text-sm font-semibold mb-3 flex items-center gap-1.5">
                  <Users className="h-3.5 w-3.5" />
                  Members ({members.length})
                </p>

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
                        .filter((u) => !members.some((m: DepartmentMember) => m.id === u.id))
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
                      {addMember.isPending ? 'Adding…' : 'Add to department'}
                    </Button>
                  )}
                </div>

                {members.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No members yet</p>
                ) : (
                  <div className="space-y-1.5">
                    {members.map((m: DepartmentMember) => (
                      <div key={m.id} className="flex items-center justify-between rounded-md border px-3 py-2">
                        <div>
                          <p className="text-sm font-medium">{m.displayName}</p>
                          <p className="text-xs text-muted-foreground">{m.email}</p>
                        </div>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 hover:text-destructive"
                          onClick={() => removeMember.mutate(m.id)}
                          disabled={removeMember.isPending}
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

export default function DepartmentsAdminPage() {
  const qc = useQueryClient()
  const [createOpen, setCreateOpen] = useState(false)
  const [selectedDept, setSelectedDept] = useState<Department | null>(null)

  const { data: departments = [], isLoading } = useQuery({
    queryKey: ['departments'],
    queryFn: () => departmentsApi.list(),
    select: (r) => r.data,
  })

  const deleteDept = useMutation({
    mutationFn: (id: string) => departmentsApi.delete(id),
    onSuccess: () => {
      toast.success('Department deleted')
      qc.invalidateQueries({ queryKey: ['departments'] })
    },
    onError: () => toast.error('Failed to delete department'),
  })

  // Group into top-level and children for display
  const topLevel = departments.filter((d) => !d.parentId)
  const childDepts = departments.filter((d) => !!d.parentId)

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Departments</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Manage organisational departments and their members
        </p>
      </div>

      <div className="flex items-center justify-between mb-5">
        <p className="text-sm text-muted-foreground">
          {departments.length} department{departments.length !== 1 ? 's' : ''}
        </p>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="mr-2 h-4 w-4" /> Create Department
        </Button>
      </div>

      {isLoading ? (
        <div className="space-y-3">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-24 w-full" />)}</div>
      ) : departments.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <Network className="h-12 w-12 text-muted-foreground/30 mb-3" />
          <p className="text-sm text-muted-foreground">No departments yet</p>
          <p className="text-xs text-muted-foreground mt-1">
            Departments let you organise users into teams and track usage by group
          </p>
          <Button variant="outline" size="sm" className="mt-3" onClick={() => setCreateOpen(true)}>
            Create first department
          </Button>
        </div>
      ) : (
        <div className="space-y-6">
          {/* Top-level departments */}
          <div className="grid gap-3 sm:grid-cols-2">
            {topLevel.map((dept) => {
              const ownChildren = childDepts.filter((c) => c.parentId === dept.id)
              return (
                <Card
                  key={dept.id}
                  className="hover:shadow-md transition-shadow cursor-pointer"
                  onClick={() => setSelectedDept(dept)}
                >
                  <CardHeader className="pb-2">
                    <div className="flex items-start justify-between">
                      <CardTitle className="text-base">{dept.name}</CardTitle>
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
                            <AlertDialogTitle>Delete department?</AlertDialogTitle>
                            <AlertDialogDescription>
                              Delete <strong>{dept.name}</strong>? Members will be unassigned and sub-departments will become top-level.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                            <AlertDialogAction
                              onClick={() => deleteDept.mutate(dept.id)}
                              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                            >
                              Delete
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </div>
                  </CardHeader>
                  <CardContent className="pt-0">
                    <div className="flex flex-wrap gap-1.5">
                      <Badge variant="secondary" className="text-xs">
                        <Users className="h-3 w-3 mr-1" />
                        {dept._count?.members ?? 0} member{(dept._count?.members ?? 0) !== 1 ? 's' : ''}
                      </Badge>
                      {ownChildren.length > 0 && (
                        <Badge variant="outline" className="text-xs">
                          <Network className="h-3 w-3 mr-1" />
                          {ownChildren.length} sub-dept{ownChildren.length !== 1 ? 's' : ''}
                        </Badge>
                      )}
                    </div>
                    {/* Sub-departments inline */}
                    {ownChildren.length > 0 && (
                      <div className="mt-2 space-y-1">
                        {ownChildren.map((child) => (
                          <div
                            key={child.id}
                            className="flex items-center gap-1.5 text-xs text-muted-foreground"
                          >
                            <ChevronRight className="h-3 w-3 shrink-0" />
                            <span>{child.name}</span>
                            <span className="ml-auto">{child._count?.members ?? 0} members</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </CardContent>
                </Card>
              )
            })}
          </div>
        </div>
      )}

      <CreateDepartmentDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        departments={departments}
      />
      <DepartmentDetailSheet
        department={selectedDept}
        allDepartments={departments}
        onClose={() => setSelectedDept(null)}
      />
    </div>
  )
}
