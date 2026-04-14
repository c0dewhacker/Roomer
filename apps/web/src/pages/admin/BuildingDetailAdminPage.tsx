import { useState, useRef } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { useForm } from 'react-hook-form'
import { z } from 'zod'
import { zodResolver } from '@hookform/resolvers/zod'
import { Layers, Plus, ChevronRight, Upload, Pencil, Trash2 } from 'lucide-react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { buildingsApi, floorsApi, ApiError } from '@/lib/api'
import { toast } from 'sonner'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
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
    resolver: zodResolver(floorSchema),
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
        <form onSubmit={handleSubmit((d) => existing ? update.mutate(d) : create.mutate(d))} className="space-y-4">
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
            <Button variant="ghost" size="sm" className="h-8 gap-1.5 text-xs"
              onClick={() => fileRef.current?.click()}>
              <Upload className="h-3.5 w-3.5" />
              {upload.isPending ? 'Uploading…' : 'Upload plan'}
            </Button>
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
                    This will permanently delete <strong>{floor.name}</strong>, all its zones, desks, and bookings.
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
            <Button size="sm" className="h-8 gap-1.5 text-xs"
              onClick={() => navigate(`/admin/floors/${floor.id}`)}>
              Manage zones & desks
              <ChevronRight className="h-3.5 w-3.5" />
            </Button>
          </div>
        </CardContent>
      </Card>

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

export default function BuildingDetailAdminPage() {
  const { buildingId } = useParams<{ buildingId: string }>()
  const [addFloorOpen, setAddFloorOpen] = useState(false)

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
        <Button onClick={() => setAddFloorOpen(true)}>
          <Plus className="mr-2 h-4 w-4" /> Add Floor
        </Button>
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
    </div>
  )
}
