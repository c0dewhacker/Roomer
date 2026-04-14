import { useState, useEffect } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Package, Plus, Pencil, Trash2, UserCheck, UserX, X } from 'lucide-react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { assetsApi, usersApi } from '@/lib/api'
import { toast } from 'sonner'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import type { Asset, AssetCategory } from '@/types'

const statusVariant: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  AVAILABLE: 'default',
  ASSIGNED: 'secondary',
  MAINTENANCE: 'outline',
  RETIRED: 'destructive',
  DISABLED: 'outline',
}

const AVAILABLE_ICONS = [
  'monitor', 'desk', 'phone', 'phone-booth', 'locker',
  'printer', 'whiteboard', 'room', 'chair', 'coffee', 'wifi',
] as const

const ICON_DISPLAY: Record<string, string> = {
  monitor: '\uD83D\uDDA5',
  desk: '\uD83D\uDCBA',
  phone: '\uD83D\uDCDE',
  'phone-booth': '\u260E',
  locker: '\uD83D\uDD12',
  printer: '\uD83D\uDDA8',
  whiteboard: '\uD83D\uDCCB',
  room: '\uD83D\uDEAA',
  chair: '\uD83E\uDE91',
  coffee: '\u2615',
  wifi: '\uD83D\uDCF6',
}

// --- Asset Form Dialog ---
const assetSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  categoryId: z.string().min(1, 'Category is required'),
  description: z.string().optional(),
  serialNumber: z.string().optional(),
  assetTag: z.string().optional(),
  status: z.enum(['AVAILABLE', 'ASSIGNED', 'MAINTENANCE', 'RETIRED', 'DISABLED']),
  isBookable: z.boolean().optional(),
  bookingLabel: z.string().optional(),
  bookingStatus: z.enum(['OPEN', 'RESTRICTED', 'ASSIGNED', 'DISABLED']).optional(),
  notes: z.string().optional(),
})
type AssetForm = z.infer<typeof assetSchema>

function AssetDialog({
  open,
  onClose,
  existing,
  categories,
}: {
  open: boolean
  onClose: () => void
  existing?: Asset
  categories: AssetCategory[]
}) {
  const qc = useQueryClient()
  const [amenities, setAmenities] = useState<string[]>(existing?.amenities ?? [])
  const [amenityInput, setAmenityInput] = useState('')

  const { register, handleSubmit, setValue, watch, formState: { errors }, reset } = useForm<AssetForm>({
    resolver: zodResolver(assetSchema),
    defaultValues: {
      name: existing?.name ?? '',
      categoryId: existing?.categoryId ?? '',
      description: existing?.description ?? '',
      serialNumber: existing?.serialNumber ?? '',
      assetTag: existing?.assetTag ?? '',
      status: (existing?.status as AssetForm['status']) ?? 'AVAILABLE',
      isBookable: existing?.isBookable ?? false,
      bookingLabel: existing?.bookingLabel ?? '',
      bookingStatus: (existing?.bookingStatus as AssetForm['bookingStatus']) ?? 'OPEN',
      notes: existing?.notes ?? '',
    },
  })

  // Reset form and amenities whenever the dialog opens for a different asset
  useEffect(() => {
    reset({
      name: existing?.name ?? '',
      categoryId: existing?.categoryId ?? '',
      description: existing?.description ?? '',
      serialNumber: existing?.serialNumber ?? '',
      assetTag: existing?.assetTag ?? '',
      status: (existing?.status as AssetForm['status']) ?? 'AVAILABLE',
      isBookable: existing?.isBookable ?? false,
      bookingLabel: existing?.bookingLabel ?? '',
      bookingStatus: (existing?.bookingStatus as AssetForm['bookingStatus']) ?? 'OPEN',
      notes: existing?.notes ?? '',
    })
    setAmenities(existing?.amenities ?? [])
    setAmenityInput('')
  }, [existing, reset])

  const create = useMutation({
    mutationFn: (d: AssetForm) => assetsApi.create({ ...d, amenities }),
    onSuccess: () => { toast.success('Asset created'); qc.invalidateQueries({ queryKey: ['assets'] }); onClose(); reset() },
    onError: () => toast.error('Failed to create asset'),
  })

  const update = useMutation({
    mutationFn: (d: AssetForm) => assetsApi.update(existing!.id, { ...d, amenities }),
    onSuccess: () => { toast.success('Asset updated'); qc.invalidateQueries({ queryKey: ['assets'] }); onClose() },
    onError: () => toast.error('Failed to update asset'),
  })

  const onSubmit = (d: AssetForm) => existing ? update.mutate(d) : create.mutate(d)
  const isPending = create.isPending || update.isPending

  const addAmenity = () => {
    const val = amenityInput.trim()
    if (val && !amenities.includes(val)) setAmenities((prev) => [...prev, val])
    setAmenityInput('')
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{existing ? 'Edit Asset' : 'Add Asset'}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <div>
            <Label htmlFor="name">Name *</Label>
            <Input id="name" {...register('name')} className="mt-1.5" placeholder="e.g. Standing Desk 4A" />
            {errors.name && <p className="text-xs text-destructive mt-1">{errors.name.message}</p>}
          </div>
          <div>
            <Label>Category *</Label>
            <Select value={watch('categoryId')} onValueChange={(v) => setValue('categoryId', v)}>
              <SelectTrigger className="mt-1.5">
                <SelectValue placeholder="Select category" />
              </SelectTrigger>
              <SelectContent>
                {categories.map((c) => (
                  <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {errors.categoryId && <p className="text-xs text-destructive mt-1">{errors.categoryId.message}</p>}
          </div>
          <div>
            <Label htmlFor="description">Description</Label>
            <Textarea id="description" {...register('description')} className="mt-1.5 resize-none" rows={2} placeholder="Optional description" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="serialNumber">Serial Number</Label>
              <Input id="serialNumber" {...register('serialNumber')} className="mt-1.5" placeholder="SN-12345" />
            </div>
            <div>
              <Label htmlFor="assetTag">Asset Tag</Label>
              <Input id="assetTag" {...register('assetTag')} className="mt-1.5" placeholder="TAG-001" />
            </div>
          </div>
          <div>
            <Label>Physical Status</Label>
            <Select value={watch('status')} onValueChange={(v) => setValue('status', v as AssetForm['status'])}>
              <SelectTrigger className="mt-1.5">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="AVAILABLE">Available</SelectItem>
                <SelectItem value="ASSIGNED">Assigned</SelectItem>
                <SelectItem value="MAINTENANCE">Maintenance</SelectItem>
                <SelectItem value="RETIRED">Retired</SelectItem>
                <SelectItem value="DISABLED">Disabled</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label htmlFor="notes">Notes</Label>
            <Input id="notes" {...register('notes')} className="mt-1.5" placeholder="Internal notes" />
          </div>

          <div className="border-t pt-4">
            <div className="flex items-center gap-2 mb-3">
              <input
                id="isBookable"
                type="checkbox"
                checked={watch('isBookable') ?? false}
                onChange={(e) => setValue('isBookable', e.target.checked)}
                className="h-4 w-4 rounded border-border"
              />
              <Label htmlFor="isBookable" className="cursor-pointer text-sm font-medium">Bookable on floor plan</Label>
            </div>
            {watch('isBookable') && (
              <div className="space-y-4 pl-6">
                <div>
                  <Label>Booking Status</Label>
                  <Select value={watch('bookingStatus') ?? 'OPEN'} onValueChange={(v) => setValue('bookingStatus', v as AssetForm['bookingStatus'])}>
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
                  <Label htmlFor="bookingLabel">Booking Label</Label>
                  <Input id="bookingLabel" {...register('bookingLabel')} className="mt-1.5" placeholder="e.g. Hot desk, Standing desk…" />
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
                    <Button type="button" variant="outline" size="sm" onClick={addAmenity} className="shrink-0">Add</Button>
                  </div>
                  {amenities.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 mt-2">
                      {amenities.map((a) => (
                        <Badge key={a} variant="secondary" className="gap-1 pr-1.5">
                          {a}
                          <button
                            type="button"
                            onClick={() => setAmenities((prev) => prev.filter((x) => x !== a))}
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
            )}
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={isPending}>
              {isPending ? 'Saving…' : existing ? 'Save changes' : 'Create asset'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// --- Assign Dialog ---

function AssignDialog({ open, onClose, assetId }: { open: boolean; onClose: () => void; assetId: string }) {
  const qc = useQueryClient()
  const [userSearch, setUserSearch] = useState('')
  const [selectedUser, setSelectedUser] = useState<{ id: string; displayName: string; email: string } | null>(null)

  const { data: userResults } = useQuery({
    queryKey: ['users', 'search', userSearch],
    queryFn: () => usersApi.list({ q: userSearch, limit: 20 }),
    select: (r) => r.data,
    enabled: userSearch.length >= 2,
  })

  const assign = useMutation({
    mutationFn: () => assetsApi.assign(assetId, { assigneeType: 'USER', assigneeId: selectedUser!.id }),
    onSuccess: () => {
      toast.success('Asset assigned')
      qc.invalidateQueries({ queryKey: ['assets'] })
      onClose()
      setSelectedUser(null)
      setUserSearch('')
    },
    onError: () => toast.error('Failed to assign asset'),
  })

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Assign Asset to User</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-1">
          <div className="space-y-2">
            <Label>Search user</Label>
            <Input
              placeholder="Name or email…"
              value={userSearch}
              onChange={(e) => { setUserSearch(e.target.value); setSelectedUser(null) }}
              className="mt-1"
            />
            {selectedUser && (
              <div className="rounded-md border bg-muted/40 px-3 py-2">
                <p className="text-sm font-medium">{selectedUser.displayName}</p>
                <p className="text-xs text-muted-foreground">{selectedUser.email}</p>
              </div>
            )}
            {!selectedUser && userResults && userResults.length > 0 && (
              <div className="rounded-md border divide-y max-h-40 overflow-y-auto">
                {userResults.map((u) => (
                  <button
                    key={u.id}
                    type="button"
                    className="w-full text-left px-3 py-2 hover:bg-muted transition-colors"
                    onClick={() => { setSelectedUser(u); setUserSearch(u.displayName) }}
                  >
                    <p className="text-sm font-medium">{u.displayName}</p>
                    <p className="text-xs text-muted-foreground">{u.email}</p>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            onClick={() => assign.mutate()}
            disabled={!selectedUser || assign.isPending}
          >
            {assign.isPending ? 'Assigning…' : 'Assign'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// --- Category Dialog ---
const categorySchema = z.object({
  name: z.string().min(1, 'Name is required'),
  description: z.string().optional(),
  defaultIsBookable: z.boolean().optional(),
  defaultIcon: z.string().optional(),
  colour: z.string().optional(),
})
type CategoryForm = z.infer<typeof categorySchema>

function CategoryDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient()
  const { register, handleSubmit, formState: { errors }, reset, watch, setValue } = useForm<CategoryForm>({
    resolver: zodResolver(categorySchema),
    defaultValues: { name: '', description: '', defaultIsBookable: false, defaultIcon: '', colour: '#6366f1' },
  })
  const selectedIcon = watch('defaultIcon')
  const colour = watch('colour')

  const create = useMutation({
    mutationFn: (d: CategoryForm) => assetsApi.createCategory(d),
    onSuccess: () => { toast.success('Category created'); qc.invalidateQueries({ queryKey: ['asset-categories'] }); onClose(); reset() },
    onError: () => toast.error('Failed to create category'),
  })

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add Category</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit((d) => create.mutate(d))} className="space-y-4">
          <div>
            <Label htmlFor="catName">Name *</Label>
            <Input id="catName" {...register('name')} className="mt-1.5" placeholder="e.g. Desks" />
            {errors.name && <p className="text-xs text-destructive mt-1">{errors.name.message}</p>}
          </div>
          <div>
            <Label htmlFor="catDesc">Description</Label>
            <Input id="catDesc" {...register('description')} className="mt-1.5" placeholder="Optional description" />
          </div>
          <div className="flex items-center gap-2">
            <input
              id="defaultIsBookable"
              type="checkbox"
              checked={watch('defaultIsBookable') ?? false}
              onChange={(e) => setValue('defaultIsBookable', e.target.checked)}
              className="h-4 w-4 rounded border-border"
            />
            <Label htmlFor="defaultIsBookable" className="cursor-pointer text-sm">Bookable by default</Label>
          </div>
          <div>
            <Label>Colour</Label>
            <div className="flex items-center gap-3 mt-1.5">
              <input
                type="color"
                value={colour ?? '#6366f1'}
                onChange={(e) => setValue('colour', e.target.value)}
                className="h-9 w-16 cursor-pointer rounded border border-input bg-transparent p-0.5"
              />
              <Input
                value={colour ?? ''}
                onChange={(e) => setValue('colour', e.target.value)}
                className="w-32 font-mono"
                placeholder="#6366f1"
              />
              <div className="h-7 w-7 rounded border" style={{ backgroundColor: colour ?? '#6366f1' }} />
            </div>
          </div>
          <div>
            <Label>Default Icon</Label>
            <p className="text-xs text-muted-foreground mb-2 mt-0.5">Select an icon for assets in this category</p>
            <div className="grid grid-cols-6 gap-2">
              {AVAILABLE_ICONS.map((icon) => (
                <button
                  key={icon}
                  type="button"
                  title={icon}
                  onClick={() => setValue('defaultIcon', icon === selectedIcon ? '' : icon)}
                  className={`flex flex-col items-center gap-0.5 p-2 rounded-md border text-lg transition-colors ${selectedIcon === icon ? 'border-primary bg-primary/10' : 'border-border hover:bg-muted'}`}
                >
                  <span>{ICON_DISPLAY[icon]}</span>
                  <span className="text-[9px] text-muted-foreground truncate w-full text-center">{icon}</span>
                </button>
              ))}
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={create.isPending}>
              {create.isPending ? 'Creating…' : 'Create category'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// --- Assets Tab ---
function AssetsTab({ categories }: { categories: AssetCategory[] }) {
  const qc = useQueryClient()
  const [search, setSearch] = useState('')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editTarget, setEditTarget] = useState<Asset | undefined>()
  const [assignTarget, setAssignTarget] = useState<string | null>(null)

  const { data: assets, isLoading } = useQuery({
    queryKey: ['assets'],
    queryFn: () => assetsApi.list(),
    select: (r) => r.data,
  })

  const deleteAsset = useMutation({
    mutationFn: (id: string) => assetsApi.delete(id),
    onSuccess: () => { toast.success('Asset deleted'); qc.invalidateQueries({ queryKey: ['assets'] }) },
    onError: () => toast.error('Failed to delete asset'),
  })

  const unassign = useMutation({
    mutationFn: (id: string) => assetsApi.unassign(id),
    onSuccess: () => { toast.success('Asset unassigned'); qc.invalidateQueries({ queryKey: ['assets'] }) },
    onError: () => toast.error('Failed to unassign asset'),
  })

  const filtered = (assets ?? []).filter((a) =>
    a.name.toLowerCase().includes(search.toLowerCase()) ||
    (a.serialNumber ?? '').toLowerCase().includes(search.toLowerCase()) ||
    (a.assetTag ?? '').toLowerCase().includes(search.toLowerCase()),
  )

  return (
    <>
      <div className="flex items-center gap-3 mb-4">
        <Input
          placeholder="Search assets…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="max-w-sm"
        />
        <Button onClick={() => { setEditTarget(undefined); setDialogOpen(true) }}>
          <Plus className="mr-2 h-4 w-4" /> Add Asset
        </Button>
      </div>

      {isLoading ? (
        <div className="space-y-2">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <Package className="h-12 w-12 text-muted-foreground/30 mb-3" />
          <p className="text-sm text-muted-foreground">{search ? 'No assets match your search' : 'No assets yet'}</p>
        </div>
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Category</TableHead>
                <TableHead>Serial</TableHead>
                <TableHead>Tag</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Bookable</TableHead>
                <TableHead>Assignee</TableHead>
                <TableHead className="w-[120px]">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((asset) => {
                const currentAssignment = asset.assignments?.find((a) => !a.returnedAt)
                return (
                  <TableRow key={asset.id}>
                    <TableCell className="font-medium">{asset.name}</TableCell>
                    <TableCell>{asset.category?.name ?? '—'}</TableCell>
                    <TableCell className="text-muted-foreground text-sm">{asset.serialNumber ?? '—'}</TableCell>
                    <TableCell className="text-muted-foreground text-sm">{asset.assetTag ?? '—'}</TableCell>
                    <TableCell>
                      <Badge variant={statusVariant[asset.status] ?? 'secondary'} className="text-xs">
                        {asset.status}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {asset.isBookable ? (
                        <Badge variant="default" className="text-xs">
                          {asset.bookingStatus ?? 'OPEN'}
                        </Badge>
                      ) : (
                        <span className="text-xs text-muted-foreground">No</span>
                      )}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {currentAssignment?.user?.displayName ?? (currentAssignment ? '—' : '—')}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          title="Edit"
                          onClick={() => { setEditTarget(asset); setDialogOpen(true) }}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        {currentAssignment ? (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8"
                            title="Unassign"
                            onClick={() => unassign.mutate(asset.id)}
                          >
                            <UserX className="h-4 w-4" />
                          </Button>
                        ) : (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8"
                            title="Assign"
                            onClick={() => setAssignTarget(asset.id)}
                          >
                            <UserCheck className="h-4 w-4" />
                          </Button>
                        )}
                        <AlertDialog>
                          <AlertDialogTrigger asChild>
                            <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-destructive">
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>Delete asset?</AlertDialogTitle>
                              <AlertDialogDescription>
                                This will permanently delete <strong>{asset.name}</strong> and all its history.
                              </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel>Cancel</AlertDialogCancel>
                              <AlertDialogAction
                                onClick={() => deleteAsset.mutate(asset.id)}
                                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                              >
                                Delete
                              </AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      </div>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>
      )}

      <AssetDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        existing={editTarget}
        categories={categories}
      />
      {assignTarget && (
        <AssignDialog
          open={!!assignTarget}
          onClose={() => setAssignTarget(null)}
          assetId={assignTarget}
        />
      )}
    </>
  )
}

// --- Categories Tab ---
function CategoriesTab() {
  const qc = useQueryClient()
  const [dialogOpen, setDialogOpen] = useState(false)

  const { data: categories, isLoading } = useQuery({
    queryKey: ['asset-categories'],
    queryFn: () => assetsApi.listCategories(),
    select: (r) => r.data,
  })

  const deleteCategory = useMutation({
    mutationFn: (id: string) => assetsApi.delete(id),
    onSuccess: () => { toast.success('Category deleted'); qc.invalidateQueries({ queryKey: ['asset-categories'] }) },
    onError: () => toast.error('Failed to delete category'),
  })

  return (
    <>
      <div className="flex items-center justify-end mb-4">
        <Button onClick={() => setDialogOpen(true)}>
          <Plus className="mr-2 h-4 w-4" /> Add Category
        </Button>
      </div>

      {isLoading ? (
        <div className="space-y-2">{[1, 2].map((i) => <Skeleton key={i} className="h-16 w-full" />)}</div>
      ) : (categories ?? []).length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12 text-center">
            <Package className="h-12 w-12 text-muted-foreground/30 mb-3" />
            <p className="text-sm text-muted-foreground">No categories yet</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {(categories ?? []).map((cat) => (
            <Card key={cat.id}>
              <CardContent className="p-4 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  {cat.colour && (
                    <div className="h-8 w-8 rounded-full border shrink-0" style={{ backgroundColor: cat.colour }} />
                  )}
                  <div>
                    <div className="flex items-center gap-2">
                      <p className="font-medium">{cat.name}</p>
                      {cat.defaultIcon && ICON_DISPLAY[cat.defaultIcon] && (
                        <span className="text-base" title={cat.defaultIcon}>{ICON_DISPLAY[cat.defaultIcon]}</span>
                      )}
                      {cat.defaultIsBookable && (
                        <Badge variant="secondary" className="text-xs">Bookable</Badge>
                      )}
                    </div>
                    {cat.description && (
                      <p className="text-xs text-muted-foreground">{cat.description}</p>
                    )}
                  </div>
                </div>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-destructive">
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Delete category?</AlertDialogTitle>
                      <AlertDialogDescription>
                        Delete <strong>{cat.name}</strong>? Assets in this category will be unlinked.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction
                        onClick={() => deleteCategory.mutate(cat.id)}
                        className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                      >
                        Delete
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <CategoryDialog open={dialogOpen} onClose={() => setDialogOpen(false)} />
    </>
  )
}

// --- Main Page ---
export default function AssetsAdminPage() {
  const { data: categories = [] } = useQuery({
    queryKey: ['asset-categories'],
    queryFn: () => assetsApi.listCategories(),
    select: (r) => r.data,
  })

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Asset Register</h1>
        <p className="text-muted-foreground text-sm mt-1">Manage all company assets and their assignments</p>
      </div>

      <Tabs defaultValue="assets">
        <TabsList className="mb-4">
          <TabsTrigger value="assets">Assets</TabsTrigger>
          <TabsTrigger value="categories">Categories</TabsTrigger>
        </TabsList>
        <TabsContent value="assets">
          <AssetsTab categories={categories} />
        </TabsContent>
        <TabsContent value="categories">
          <CategoriesTab />
        </TabsContent>
      </Tabs>
    </div>
  )
}
