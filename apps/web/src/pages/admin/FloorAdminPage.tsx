import { useState, useCallback, useRef, useMemo } from 'react'
import { useParams, Link } from 'react-router-dom'
import { useForm } from 'react-hook-form'
import { z } from 'zod'
import { zodResolver } from '@hookform/resolvers/zod'
import {
  Plus, Upload, List, LayoutTemplate, Pencil, Trash2, ChevronRight,
  ChevronDown, GripVertical, X, Users, UserMinus, UserPlus, FileText, Download,
  AlertCircle, CheckCircle2,
} from 'lucide-react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { floorsApi, assetsApi, zonesApi, usersApi, groupsApi } from '@/lib/api'
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

type ZoneData = { id: string; name: string; colour: string; zoneGroupId: string | null; assets: AssetData[] }
type AssetData = { id: string; name: string; status: string; amenities: string[]; isBookable?: boolean }
/** @deprecated use AssetData */
type DeskData = AssetData

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

// ─── Add Asset to Floor Dialog ────────────────────────────────────────────────

function AddAssetToFloorDialog({
  open, onClose, floorId, zones, defaultZoneId,
}: {
  open: boolean; onClose: () => void; floorId: string
  zones: ZoneData[]; defaultZoneId?: string
}) {
  const qc = useQueryClient()
  const [search, setSearch] = useState('')
  const [selectedAssetId, setSelectedAssetId] = useState('')
  const [selectedZoneId, setSelectedZoneId] = useState(defaultZoneId ?? zones[0]?.id ?? '')

  const { data: allAssets } = useQuery({
    queryKey: ['assets'],
    queryFn: () => assetsApi.list(),
    select: (r) => r.data,
    enabled: open,
  })

  // Unplaced bookable assets not yet on any floor
  const unplacedAssets = (allAssets ?? []).filter((a) => a.isBookable && !a.floorId)
  const filteredAssets = search.trim()
    ? unplacedAssets.filter((a) => a.name.toLowerCase().includes(search.toLowerCase()))
    : unplacedAssets

  const place = useMutation({
    mutationFn: () => assetsApi.update(selectedAssetId, {
      floorId, primaryZoneId: selectedZoneId, x: 50, y: 50, width: 3, height: 2,
    }),
    onSuccess: () => {
      toast.success('Asset added to floor plan — drag it to position')
      qc.invalidateQueries({ queryKey: ['floors', floorId] })
      qc.invalidateQueries({ queryKey: ['assets'] })
      onClose()
    },
    onError: () => toast.error('Failed to add asset to floor plan'),
  })

  // Reset selections when dialog opens
  useMemo(() => {
    if (open) {
      setSearch('')
      setSelectedAssetId('')
      setSelectedZoneId(defaultZoneId ?? zones[0]?.id ?? '')
    }
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader><DialogTitle>Add Asset to Floor Plan</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Select an existing asset from the asset list to place it on this floor.
            To create new assets, use the <strong>Assets</strong> admin page or{' '}
            <strong>Bulk Import</strong>.
          </p>
          <div>
            <Label>Zone *</Label>
            <Select value={selectedZoneId} onValueChange={setSelectedZoneId}>
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
          </div>
          <div>
            <Label>Asset *</Label>
            <Input
              className="mt-1.5 mb-2"
              placeholder="Search by name…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            {unplacedAssets.length === 0 ? (
              <div className="rounded-md border border-dashed p-4 text-center">
                <p className="text-sm text-muted-foreground">
                  No unplaced bookable assets available.
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  Create assets in the Assets admin page first, or use Bulk Import.
                </p>
              </div>
            ) : filteredAssets.length === 0 ? (
              <p className="text-sm text-muted-foreground py-3 text-center">No assets match your search.</p>
            ) : (
              <div className="rounded-md border divide-y max-h-56 overflow-y-auto">
                {filteredAssets.map((a) => (
                  <button
                    key={a.id}
                    type="button"
                    className={`w-full text-left px-3 py-2.5 hover:bg-muted transition-colors ${selectedAssetId === a.id ? 'bg-muted' : ''}`}
                    onClick={() => setSelectedAssetId(a.id)}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-sm font-medium">{a.name}</p>
                      {selectedAssetId === a.id && <CheckCircle2 className="h-4 w-4 text-primary shrink-0" />}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {a.category?.name ?? 'No category'} · {a.bookingStatus ?? 'OPEN'}
                    </p>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
        <DialogFooter className="mt-2">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            onClick={() => place.mutate()}
            disabled={!selectedAssetId || !selectedZoneId || place.isPending}
          >
            {place.isPending ? 'Adding…' : 'Add to floor plan'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ─── Edit Asset Dialog (inline from zone list) ────────────────────────────────

const editAssetSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  status: z.enum(DESK_STATUSES),
  amenities: z.string().optional(),
})
type EditAssetForm = z.infer<typeof editAssetSchema>

function EditAssetDialog({
  open, onClose, floorId, asset,
}: {
  open: boolean; onClose: () => void; floorId: string
  asset: DeskData & { zoneId: string }
}) {
  const qc = useQueryClient()
  const { register, handleSubmit, formState: { errors }, watch, setValue } = useForm<EditAssetForm>({
    resolver: zodResolver(editAssetSchema),
    defaultValues: {
      name: asset.name,
      status: (asset.status as typeof DESK_STATUSES[number]) ?? 'OPEN',
      amenities: asset.amenities.join(', '),
    },
  })
  const status = watch('status')

  const update = useMutation({
    mutationFn: (d: EditAssetForm) => assetsApi.update(asset.id, {
      name: d.name, bookingStatus: d.status,
      amenities: d.amenities ? d.amenities.split(',').map((s) => s.trim()).filter(Boolean) : [],
    }),
    onSuccess: () => {
      toast.success('Asset updated')
      qc.invalidateQueries({ queryKey: ['floors', floorId] })
      onClose()
    },
    onError: () => toast.error('Failed to update asset'),
  })

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>Edit Asset</DialogTitle></DialogHeader>
        <form onSubmit={handleSubmit((d) => update.mutate(d))} className="space-y-4">
          <div>
            <Label htmlFor="aname">Name *</Label>
            <Input id="aname" {...register('name')} className="mt-1.5" />
            {errors.name && <p className="text-xs text-destructive mt-1">{errors.name.message}</p>}
          </div>
          <div>
            <Label>Booking Status</Label>
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
              placeholder="monitor, standing-desk (comma-separated)" />
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={update.isPending}>
              {update.isPending ? 'Saving…' : 'Save changes'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// ─── Bulk Import Dialog ───────────────────────────────────────────────────────

const CSV_TEMPLATE = [
  'name,category,bookingStatus,bookingLabel,amenities,serialNumber,assetTag,notes,zoneName',
  'A-01,Desk,OPEN,Desk,monitor;docking-station,,,, Open Plan',
  'A-02,Desk,OPEN,Desk,monitor,,SN-002,,Open Plan',
  'B-01,Desk,RESTRICTED,Desk,monitor;standing-desk,,,Quiet area,Quiet Zone',
].join('\n')

type ImportRow = {
  name: string; categoryName: string; bookingStatus?: string; bookingLabel?: string
  amenities?: string[]; serialNumber?: string; assetTag?: string; notes?: string; zoneName?: string
}

function parseCsv(text: string): { rows: ImportRow[]; parseErrors: string[] } {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)
  if (lines.length < 2) return { rows: [], parseErrors: ['CSV must have a header row and at least one data row'] }

  const header = lines[0].toLowerCase().split(',').map((h) => h.trim())
  const required = ['name', 'category']
  const missing = required.filter((r) => !header.includes(r))
  if (missing.length) return { rows: [], parseErrors: [`Missing required columns: ${missing.join(', ')}`] }

  const idx = (col: string) => header.indexOf(col)
  const rows: ImportRow[] = []
  const parseErrors: string[] = []

  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(',').map((c) => c.trim())
    const name = cells[idx('name')]
    if (!name) { parseErrors.push(`Row ${i + 1}: missing name`); continue }
    const categoryName = cells[idx('category')]
    if (!categoryName) { parseErrors.push(`Row ${i + 1}: missing category`); continue }

    const amenitiesRaw = idx('amenities') >= 0 ? cells[idx('amenities')] : ''
    rows.push({
      name,
      categoryName,
      bookingStatus: idx('bookingstatus') >= 0 ? cells[idx('bookingstatus')] || undefined : undefined,
      bookingLabel: idx('bookinglabel') >= 0 ? cells[idx('bookinglabel')] || undefined : undefined,
      amenities: amenitiesRaw ? amenitiesRaw.split(';').map((a) => a.trim()).filter(Boolean) : [],
      serialNumber: idx('serialnumber') >= 0 ? cells[idx('serialnumber')] || undefined : undefined,
      assetTag: idx('assettag') >= 0 ? cells[idx('assettag')] || undefined : undefined,
      notes: idx('notes') >= 0 ? cells[idx('notes')] || undefined : undefined,
      zoneName: idx('zonename') >= 0 ? cells[idx('zonename')] || undefined : undefined,
    })
  }

  return { rows, parseErrors }
}

function BulkImportDialog({
  open, onClose, floorId, floorName,
}: {
  open: boolean; onClose: () => void; floorId: string; floorName: string
}) {
  const qc = useQueryClient()
  const fileRef = useRef<HTMLInputElement>(null)
  const [rows, setRows] = useState<ImportRow[]>([])
  const [parseErrors, setParseErrors] = useState<string[]>([])
  const [importResult, setImportResult] = useState<{ created: number; errors: Array<{ row: number; name: string; error: string }> } | null>(null)

  const importMutation = useMutation({
    mutationFn: () => assetsApi.bulkImport(floorId, rows),
    onSuccess: (res) => {
      setImportResult(res.data)
      qc.invalidateQueries({ queryKey: ['floors', floorId] })
      qc.invalidateQueries({ queryKey: ['assets'] })
    },
    onError: () => toast.error('Import failed — check your CSV and try again'),
  })

  const handleFile = (file: File) => {
    setImportResult(null)
    const reader = new FileReader()
    reader.onload = (e) => {
      const text = e.target?.result as string
      const { rows: parsed, parseErrors: errs } = parseCsv(text)
      setRows(parsed)
      setParseErrors(errs)
    }
    reader.readAsText(file)
  }

  const handleClose = () => {
    setRows([])
    setParseErrors([])
    setImportResult(null)
    if (fileRef.current) fileRef.current.value = ''
    onClose()
  }

  const downloadTemplate = () => {
    const blob = new Blob([CSV_TEMPLATE], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'asset-import-template.csv'
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && handleClose()}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Bulk Import Assets</DialogTitle>
        </DialogHeader>

        {!importResult ? (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Import assets via CSV. All assets will be placed on <strong>{floorName}</strong>.
              Assign to zones using the <code className="text-xs bg-muted px-1 rounded">zoneName</code> column.
            </p>

            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={downloadTemplate}>
                <Download className="mr-1.5 h-3.5 w-3.5" /> Download template
              </Button>
            </div>

            <div>
              <Label>CSV File *</Label>
              <div className="mt-1.5 border-2 border-dashed rounded-lg p-6 text-center cursor-pointer hover:border-primary/50 transition-colors"
                onClick={() => fileRef.current?.click()}>
                <FileText className="mx-auto h-8 w-8 text-muted-foreground/50 mb-2" />
                <p className="text-sm text-muted-foreground">
                  {rows.length > 0
                    ? `${rows.length} row${rows.length !== 1 ? 's' : ''} ready to import`
                    : 'Click to select a CSV file'}
                </p>
              </div>
              <input
                ref={fileRef}
                type="file"
                accept=".csv,text/csv"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0]
                  if (file) handleFile(file)
                }}
              />
            </div>

            {parseErrors.length > 0 && (
              <div className="rounded-md bg-destructive/10 border border-destructive/20 p-3 space-y-1">
                <p className="text-sm font-medium text-destructive flex items-center gap-1.5">
                  <AlertCircle className="h-4 w-4" /> Parse errors
                </p>
                {parseErrors.map((e, i) => (
                  <p key={i} className="text-xs text-destructive">{e}</p>
                ))}
              </div>
            )}

            {rows.length > 0 && (
              <div>
                <p className="text-sm font-medium mb-2">Preview ({rows.length} assets)</p>
                <div className="rounded-md border overflow-hidden">
                  <table className="w-full text-xs">
                    <thead className="bg-muted">
                      <tr>
                        <th className="text-left px-3 py-2 font-medium">Name</th>
                        <th className="text-left px-3 py-2 font-medium">Category</th>
                        <th className="text-left px-3 py-2 font-medium">Status</th>
                        <th className="text-left px-3 py-2 font-medium">Zone</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {rows.slice(0, 10).map((r, i) => (
                        <tr key={i}>
                          <td className="px-3 py-2">{r.name}</td>
                          <td className="px-3 py-2">{r.categoryName}</td>
                          <td className="px-3 py-2">{r.bookingStatus ?? 'OPEN'}</td>
                          <td className="px-3 py-2">{r.zoneName ?? '—'}</td>
                        </tr>
                      ))}
                      {rows.length > 10 && (
                        <tr>
                          <td colSpan={4} className="px-3 py-2 text-muted-foreground text-center">
                            …and {rows.length - 10} more
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            <div className="rounded-md bg-green-50 border border-green-200 p-4 flex items-start gap-3">
              <CheckCircle2 className="h-5 w-5 text-green-600 shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-medium text-green-800">
                  Import complete — {importResult.created} asset{importResult.created !== 1 ? 's' : ''} created
                </p>
                {importResult.errors.length > 0 && (
                  <p className="text-xs text-green-700 mt-0.5">
                    {importResult.errors.length} row{importResult.errors.length !== 1 ? 's' : ''} failed
                  </p>
                )}
              </div>
            </div>
            {importResult.errors.length > 0 && (
              <div className="space-y-1">
                <p className="text-sm font-medium">Failed rows</p>
                {importResult.errors.map((e) => (
                  <p key={e.row} className="text-xs text-destructive">
                    Row {e.row} ({e.name}): {e.error}
                  </p>
                ))}
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={handleClose}>
            {importResult ? 'Close' : 'Cancel'}
          </Button>
          {!importResult && (
            <Button
              onClick={() => importMutation.mutate()}
              disabled={rows.length === 0 || parseErrors.length > 0 || importMutation.isPending}
            >
              {importMutation.isPending ? `Importing…` : `Import ${rows.length} asset${rows.length !== 1 ? 's' : ''}`}
            </Button>
          )}
        </DialogFooter>
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
  const [addAsset, setAddAsset] = useState(false)
  const [editAsset, setEditAsset] = useState<(DeskData & { zoneId: string }) | undefined>()

  const deleteZone = useMutation({
    mutationFn: () => zonesApi.delete(zone.id),
    onSuccess: () => { toast.success('Zone deleted'); qc.invalidateQueries({ queryKey: ['floors', floorId] }) },
    onError: () => toast.error('Failed to delete zone'),
  })
  const removeFromFloor = useMutation({
    mutationFn: (id: string) => assetsApi.update(id, { floorId: null, primaryZoneId: null, x: null, y: null } as Parameters<typeof assetsApi.update>[1]),
    onSuccess: () => { toast.success('Asset removed from floor plan'); qc.invalidateQueries({ queryKey: ['floors', floorId] }); qc.invalidateQueries({ queryKey: ['assets'] }) },
    onError: () => toast.error('Failed to remove asset from floor plan'),
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
          <Badge variant="secondary" className="text-xs ml-1">{zone.assets.length} assets</Badge>
        </button>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" className="h-7 gap-1 text-xs"
            onClick={() => setAddAsset(true)}>
            <Plus className="h-3 w-3" /> Add asset
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
                  This will permanently delete the zone. Assets in this zone will be unlinked from the floor plan but not deleted.
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
          {zone.assets.length === 0 ? (
            <p className="px-4 py-3 text-sm text-muted-foreground">
              No assets — <button className="underline" onClick={() => setAddAsset(true)}>add one</button>
            </p>
          ) : (
            <div className="divide-y">
              {zone.assets.map((asset) => (
                <div key={asset.id} className="flex items-center justify-between px-4 py-2.5">
                  <div className="flex items-center gap-3 min-w-0">
                    <GripVertical className="h-4 w-4 text-muted-foreground shrink-0" />
                    <span className="font-medium text-sm">{asset.name}</span>
                    <Badge variant={STATUS_VARIANTS[asset.status]} className="text-xs shrink-0">
                      {STATUS_LABELS[asset.status]}
                    </Badge>
                    <div className="hidden sm:flex gap-1 flex-wrap">
                      {(asset.amenities ?? []).map((a) => (
                        <Badge key={a} variant="outline" className="text-xs">{a}</Badge>
                      ))}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Button variant="ghost" size="icon" className="h-7 w-7"
                      onClick={() => setEditAsset({ ...asset, zoneId: zone.id })}>
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button variant="ghost" size="icon" className="h-7 w-7 hover:text-destructive"
                          title="Remove from floor plan">
                          <X className="h-3.5 w-3.5" />
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>Remove "{asset.name}" from floor plan?</AlertDialogTitle>
                          <AlertDialogDescription>
                            The asset will be unlinked from this floor plan but not deleted. You can re-add it later.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancel</AlertDialogCancel>
                          <AlertDialogAction
                            onClick={() => removeFromFloor.mutate(asset.id)}
                            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                          >Remove</AlertDialogAction>
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
      {addAsset && (
        <AddAssetToFloorDialog open floorId={floorId} zones={zones} defaultZoneId={zone.id} onClose={() => setAddAsset(false)} />
      )}
      {editAsset && (
        <EditAssetDialog open floorId={floorId} asset={editAsset} onClose={() => setEditAsset(undefined)} />
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
            Floor managers can assign permanent users, edit asset amenities, and cancel bookings on this floor.
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
  const [addAssetOpen, setAddAssetOpen] = useState(false)
  const [bulkImportOpen, setBulkImportOpen] = useState(false)
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
      assetsApi.updatePositions(positions),
    onSuccess: () => { toast.success('Layout saved'); qc.invalidateQueries({ queryKey: ['floors', floorId] }) },
    onError: () => toast.error('Failed to save layout'),
  })

  const handleLayoutSave = useCallback(
    (positions: Array<{ id: string; x: number; y: number; width: number; height: number; rotation: number }>) => {
      updatePositions.mutate(positions)
    },
    [updatePositions],
  )

  const updateTransform = useMutation({
    mutationFn: (displayScale: number) => floorsApi.updateFloorPlanTransform(floorId!, displayScale),
    onError: () => toast.error('Failed to save image scale'),
  })

  const handleDisplayScaleChange = useCallback(
    (displayScale: number) => { updateTransform.mutate(displayScale) },
    [updateTransform],
  )

  const buildingId = (floor as any)?.building?.id
  const buildingName = (floor as any)?.building?.name
  const zones: ZoneData[] = (floor?.zones ?? []) as ZoneData[]
  const totalDesks = zones.reduce((s, z) => s + (z.assets?.length ?? 0), 0)

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
          <Button variant="outline" size="sm" onClick={() => setAddAssetOpen(true)}>
            <Plus className="mr-1.5 h-3.5 w-3.5" /> Add Asset
          </Button>
          <Button variant="outline" size="sm" onClick={() => setBulkImportOpen(true)}>
            <FileText className="mr-1.5 h-3.5 w-3.5" /> Bulk Import
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
                    <p className="text-xs text-muted-foreground mt-1 mb-4">Upload an image to enable visual asset positioning</p>
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
                onDisplayScaleChange={handleDisplayScaleChange}
              />
            </div>
          )
        ) : (
          <ScrollArea className="h-full">
            <div className="max-w-3xl mx-auto p-6 space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">
                    {zones.length} zone{zones.length !== 1 ? 's' : ''} · {totalDesks} asset{totalDesks !== 1 ? 's' : ''}
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
      {addAssetOpen && (
        <AddAssetToFloorDialog open floorId={floorId!} zones={zones} onClose={() => setAddAssetOpen(false)} />
      )}
      {bulkImportOpen && (
        <BulkImportDialog
          open
          floorId={floorId!}
          floorName={floor?.name ?? 'this floor'}
          onClose={() => setBulkImportOpen(false)}
        />
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
