import { useState, useRef } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { format, isPast } from 'date-fns'
import {
  FileText, Plus, Trash2, Upload, Download, ChevronDown, ChevronUp, Building2, AlertCircle,
} from 'lucide-react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { leasesApi, buildingsApi } from '@/lib/api'
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
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import type { Lease, Building } from '@/types'

// ─── Lease Form ───────────────────────────────────────────────────────────────

const leaseSchema = z.object({
  buildingId: z.string().min(1, 'Building is required'),
  name: z.string().min(1, 'Name is required').max(255),
  startDate: z.string().min(1, 'Start date is required'),
  endDate: z.string().optional(),
  landlord: z.string().optional(),
  rentAmount: z.coerce.number().positive().optional().or(z.literal('')),
  currency: z.string().length(3).default('GBP'),
  notes: z.string().optional(),
})
type LeaseForm = z.infer<typeof leaseSchema>

function LeaseDialog({
  open,
  onClose,
  existing,
  buildings,
}: {
  open: boolean
  onClose: () => void
  existing?: Lease
  buildings: Building[]
}) {
  const qc = useQueryClient()
  const { register, handleSubmit, setValue, watch, formState: { errors }, reset } = useForm<LeaseForm>({
    resolver: zodResolver(leaseSchema),
    defaultValues: {
      buildingId: existing?.buildingId ?? '',
      name: existing?.name ?? '',
      startDate: existing?.startDate ? existing.startDate.slice(0, 10) : '',
      endDate: existing?.endDate ? existing.endDate.slice(0, 10) : '',
      landlord: existing?.landlord ?? '',
      rentAmount: existing?.rentAmount ?? '',
      currency: existing?.currency ?? 'AUD',
      notes: existing?.notes ?? '',
    },
  })

  const create = useMutation({
    mutationFn: (d: LeaseForm) =>
      leasesApi.create({
        buildingId: d.buildingId,
        name: d.name,
        startDate: new Date(d.startDate).toISOString(),
        endDate: d.endDate ? new Date(d.endDate).toISOString() : undefined,
        landlord: d.landlord || undefined,
        rentAmount: d.rentAmount ? Number(d.rentAmount) : undefined,
        currency: d.currency,
        notes: d.notes || undefined,
      }),
    onSuccess: () => {
      toast.success('Lease created')
      qc.invalidateQueries({ queryKey: ['leases'] })
      onClose()
      reset()
    },
    onError: () => toast.error('Failed to create lease'),
  })

  const update = useMutation({
    mutationFn: (d: LeaseForm) =>
      leasesApi.update(existing!.id, {
        name: d.name,
        startDate: new Date(d.startDate).toISOString(),
        endDate: d.endDate ? new Date(d.endDate).toISOString() : null,
        landlord: d.landlord || undefined,
        rentAmount: d.rentAmount ? Number(d.rentAmount) : undefined,
        currency: d.currency,
        notes: d.notes || undefined,
      }),
    onSuccess: () => {
      toast.success('Lease updated')
      qc.invalidateQueries({ queryKey: ['leases'] })
      onClose()
    },
    onError: () => toast.error('Failed to update lease'),
  })

  const onSubmit = (d: LeaseForm) => existing ? update.mutate(d) : create.mutate(d)
  const isPending = create.isPending || update.isPending

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{existing ? 'Edit Lease' : 'Add Lease'}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          {!existing && (
            <div>
              <Label>Building *</Label>
              <Select value={watch('buildingId')} onValueChange={(v) => setValue('buildingId', v)}>
                <SelectTrigger className="mt-1.5">
                  <SelectValue placeholder="Select building…" />
                </SelectTrigger>
                <SelectContent>
                  {buildings.map((b) => (
                    <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {errors.buildingId && <p className="text-xs text-destructive mt-1">{errors.buildingId.message}</p>}
            </div>
          )}

          <div>
            <Label htmlFor="name">Lease Name *</Label>
            <Input id="name" {...register('name')} className="mt-1.5" placeholder="e.g. HQ Office Lease 2024–2029" />
            {errors.name && <p className="text-xs text-destructive mt-1">{errors.name.message}</p>}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="startDate">Start Date *</Label>
              <Input id="startDate" type="date" {...register('startDate')} className="mt-1.5" />
              {errors.startDate && <p className="text-xs text-destructive mt-1">{errors.startDate.message}</p>}
            </div>
            <div>
              <Label htmlFor="endDate">End Date</Label>
              <Input id="endDate" type="date" {...register('endDate')} className="mt-1.5" />
            </div>
          </div>

          <div>
            <Label htmlFor="landlord">Landlord</Label>
            <Input id="landlord" {...register('landlord')} className="mt-1.5" placeholder="Landlord name or company" />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="rentAmount">Rent Amount</Label>
              <Input id="rentAmount" type="number" step="0.01" {...register('rentAmount')} className="mt-1.5" placeholder="0.00" />
            </div>
            <div>
              <Label>Currency</Label>
              <Select value={watch('currency')} onValueChange={(v) => setValue('currency', v)}>
                <SelectTrigger className="mt-1.5">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="AUD">AUD</SelectItem>
                  <SelectItem value="GBP">GBP</SelectItem>
                  <SelectItem value="USD">USD</SelectItem>
                  <SelectItem value="EUR">EUR</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div>
            <Label htmlFor="notes">Notes</Label>
            <Input id="notes" {...register('notes')} className="mt-1.5" placeholder="Optional notes about this lease" />
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={isPending}>
              {isPending ? 'Saving…' : existing ? 'Save changes' : 'Create lease'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// ─── Lease Card ───────────────────────────────────────────────────────────────

function LeaseCard({ lease }: { lease: Lease }) {
  const qc = useQueryClient()
  const [expanded, setExpanded] = useState(false)
  const [editOpen, setEditOpen] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const { data: buildings = [] } = useQuery({
    queryKey: ['buildings'],
    queryFn: () => buildingsApi.list(),
    select: (r) => r.data,
  })

  const deleteLease = useMutation({
    mutationFn: () => leasesApi.delete(lease.id),
    onSuccess: () => { toast.success('Lease deleted'); qc.invalidateQueries({ queryKey: ['leases'] }) },
    onError: () => toast.error('Failed to delete lease'),
  })

  const uploadDoc = useMutation({
    mutationFn: (file: File) => leasesApi.uploadDocument(lease.id, file),
    onSuccess: () => { toast.success('Document uploaded'); qc.invalidateQueries({ queryKey: ['leases'] }) },
    onError: () => toast.error('Failed to upload document'),
  })

  const deleteDoc = useMutation({
    mutationFn: (docId: string) => leasesApi.deleteDocument(lease.id, docId),
    onSuccess: () => { toast.success('Document deleted'); qc.invalidateQueries({ queryKey: ['leases'] }) },
    onError: () => toast.error('Failed to delete document'),
  })

  const isExpired = lease.endDate ? isPast(new Date(lease.endDate)) : false
  const isExpiringSoon = lease.endDate && !isExpired
    ? (new Date(lease.endDate).getTime() - Date.now()) < 90 * 24 * 60 * 60 * 1000
    : false

  const formatCurrency = (amount: number, currency: string) =>
    new Intl.NumberFormat('en-GB', { style: 'currency', currency }).format(amount)

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <CardTitle className="text-base">{lease.name}</CardTitle>
              {isExpired && <Badge variant="destructive" className="text-xs">Expired</Badge>}
              {isExpiringSoon && !isExpired && (
                <Badge variant="outline" className="text-xs border-yellow-400 text-yellow-700">
                  <AlertCircle className="h-3 w-3 mr-1" />
                  Expiring soon
                </Badge>
              )}
            </div>
            <p className="text-sm text-muted-foreground mt-0.5">
              {lease.building?.name ?? lease.buildingId}
            </p>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <Button variant="ghost" size="sm" onClick={() => setEditOpen(true)}>Edit</Button>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-destructive">
                  <Trash2 className="h-4 w-4" />
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete lease?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This will delete <strong>{lease.name}</strong> and all attached documents.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={() => deleteLease.mutate()}
                    className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  >
                    Delete
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </div>

        {/* Key stats */}
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-1 mt-2 text-sm">
          <div>
            <span className="text-xs text-muted-foreground">Start</span>
            <p className="font-medium">{format(new Date(lease.startDate), 'd MMM yyyy')}</p>
          </div>
          {lease.endDate && (
            <div>
              <span className="text-xs text-muted-foreground">End</span>
              <p className={`font-medium ${isExpired ? 'text-destructive' : ''}`}>
                {format(new Date(lease.endDate), 'd MMM yyyy')}
              </p>
            </div>
          )}
          {lease.rentAmount && (
            <div>
              <span className="text-xs text-muted-foreground">Rent</span>
              <p className="font-medium">{formatCurrency(lease.rentAmount, lease.currency)}/yr</p>
            </div>
          )}
          {lease.landlord && (
            <div>
              <span className="text-xs text-muted-foreground">Landlord</span>
              <p className="font-medium truncate">{lease.landlord}</p>
            </div>
          )}
        </div>
      </CardHeader>

      <CardContent className="pt-0">
        {/* Toggle documents section */}
        <button
          type="button"
          className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
          onClick={() => setExpanded((v) => !v)}
        >
          <FileText className="h-3.5 w-3.5" />
          {(lease.documents?.length ?? 0)} document{(lease.documents?.length ?? 0) !== 1 ? 's' : ''}
          {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
        </button>

        {expanded && (
          <div className="mt-3 space-y-2">
            {/* Upload */}
            <div>
              <input
                ref={fileRef}
                type="file"
                className="hidden"
                accept=".pdf,.doc,.docx,.png,.jpg,.jpeg"
                onChange={(e) => {
                  const file = e.target.files?.[0]
                  if (file) uploadDoc.mutate(file)
                  e.target.value = ''
                }}
              />
              <Button
                size="sm"
                variant="outline"
                className="w-full"
                onClick={() => fileRef.current?.click()}
                disabled={uploadDoc.isPending}
              >
                <Upload className="mr-2 h-3.5 w-3.5" />
                {uploadDoc.isPending ? 'Uploading…' : 'Upload Document'}
              </Button>
            </div>

            {(lease.documents ?? []).length === 0 ? (
              <p className="text-xs text-muted-foreground text-center py-2">No documents attached</p>
            ) : (
              <div className="space-y-1.5">
                {(lease.documents ?? []).map((doc) => (
                  <div key={doc.id} className="flex items-center justify-between rounded-md border px-3 py-2">
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate">{doc.filename}</p>
                      <p className="text-xs text-muted-foreground">
                        {(doc.sizeBytes / 1024).toFixed(0)} KB · {format(new Date(doc.uploadedAt), 'd MMM yyyy')}
                      </p>
                    </div>
                    <div className="flex items-center gap-1 ml-2 shrink-0">
                      <a
                        href={leasesApi.downloadDocumentUrl(lease.id, doc.id)}
                        download={doc.filename}
                        className="inline-flex items-center justify-center h-7 w-7 rounded-md hover:bg-muted transition-colors"
                        title="Download"
                      >
                        <Download className="h-3.5 w-3.5" />
                      </a>
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button variant="ghost" size="icon" className="h-7 w-7 hover:text-destructive">
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>Delete document?</AlertDialogTitle>
                            <AlertDialogDescription>
                              Delete <strong>{doc.filename}</strong>? This cannot be undone.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                            <AlertDialogAction
                              onClick={() => deleteDoc.mutate(doc.id)}
                              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                            >
                              Delete
                            </AlertDialogAction>
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

        {lease.notes && (
          <>
            <Separator className="my-3" />
            <p className="text-xs text-muted-foreground">{lease.notes}</p>
          </>
        )}
      </CardContent>

      <LeaseDialog
        open={editOpen}
        onClose={() => setEditOpen(false)}
        existing={lease}
        buildings={buildings}
      />
    </Card>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function LeasesAdminPage() {
  const [buildingFilter, setBuildingFilter] = useState('all')
  const [dialogOpen, setDialogOpen] = useState(false)

  const { data: buildings = [] } = useQuery({
    queryKey: ['buildings'],
    queryFn: () => buildingsApi.list(),
    select: (r) => r.data,
  })

  const { data: leases, isLoading } = useQuery({
    queryKey: ['leases', buildingFilter],
    queryFn: () => leasesApi.list(buildingFilter !== 'all' ? buildingFilter : undefined),
    select: (r) => r.data,
  })

  const expiringSoon = (leases ?? []).filter((l) => {
    if (!l.endDate) return false
    const daysLeft = (new Date(l.endDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24)
    return daysLeft > 0 && daysLeft <= 90
  })

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Building Leases</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Manage lease agreements and associated documents for all buildings
        </p>
      </div>

      {/* Expiry banner */}
      {expiringSoon.length > 0 && (
        <div className="mb-5 flex items-start gap-2 rounded-md bg-yellow-50 border border-yellow-200 px-4 py-3">
          <AlertCircle className="h-4 w-4 text-yellow-600 mt-0.5 shrink-0" />
          <p className="text-sm text-yellow-800">
            <strong>{expiringSoon.length}</strong> lease{expiringSoon.length > 1 ? 's' : ''} expiring within the next 90 days:{' '}
            {expiringSoon.map((l) => l.name).join(', ')}
          </p>
        </div>
      )}

      {/* Toolbar */}
      <div className="flex items-center gap-3 mb-5">
        <Select value={buildingFilter} onValueChange={setBuildingFilter}>
          <SelectTrigger className="w-[220px]">
            <Building2 className="mr-2 h-4 w-4 text-muted-foreground" />
            <SelectValue placeholder="All buildings" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All buildings</SelectItem>
            {buildings.map((b) => (
              <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Button className="ml-auto" onClick={() => setDialogOpen(true)}>
          <Plus className="mr-2 h-4 w-4" /> Add Lease
        </Button>
      </div>

      {/* Lease list */}
      {isLoading ? (
        <div className="space-y-3">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-40 w-full" />)}</div>
      ) : (leases ?? []).length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <FileText className="h-12 w-12 text-muted-foreground/30 mb-3" />
          <p className="text-sm text-muted-foreground">No leases yet</p>
          <Button variant="outline" size="sm" className="mt-3" onClick={() => setDialogOpen(true)}>
            Add first lease
          </Button>
        </div>
      ) : (
        <div className="space-y-4">
          {(leases ?? []).map((lease) => (
            <LeaseCard key={lease.id} lease={lease} />
          ))}
        </div>
      )}

      <LeaseDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        buildings={buildings}
      />
    </div>
  )
}
