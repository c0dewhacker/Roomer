import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Building2, Plus, ChevronRight, Pencil, Trash2, Upload } from 'lucide-react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { buildingsApi } from '@/lib/api'
import { BulkImportDialog } from '@/components/admin/BulkImportDialog'
import { toast } from 'sonner'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
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
import type { Building } from '@/types'

const buildingSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  address: z.string().optional(),
})
type BuildingForm = z.infer<typeof buildingSchema>

function BuildingDialog({
  open,
  onClose,
  existing,
}: {
  open: boolean
  onClose: () => void
  existing?: Building
}) {
  const qc = useQueryClient()
  const { register, handleSubmit, formState: { errors }, reset } = useForm<BuildingForm>({
    resolver: zodResolver(buildingSchema),
    defaultValues: { name: existing?.name ?? '', address: existing?.address ?? '' },
  })

  const create = useMutation({
    mutationFn: (d: BuildingForm) => buildingsApi.create(d),
    onSuccess: () => { toast.success('Building created'); qc.invalidateQueries({ queryKey: ['buildings'] }); onClose(); reset() },
    onError: () => toast.error('Failed to create building'),
  })

  const update = useMutation({
    mutationFn: (d: BuildingForm) => buildingsApi.update(existing!.id, d),
    onSuccess: () => { toast.success('Building updated'); qc.invalidateQueries({ queryKey: ['buildings'] }); onClose() },
    onError: () => toast.error('Failed to update building'),
  })

  const onSubmit = (d: BuildingForm) => existing ? update.mutate(d) : create.mutate(d)
  const isPending = create.isPending || update.isPending

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{existing ? 'Edit Building' : 'Add Building'}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <div>
            <Label htmlFor="name">Name *</Label>
            <Input id="name" {...register('name')} className="mt-1.5" placeholder="e.g. HQ London" />
            {errors.name && <p className="text-xs text-destructive mt-1">{errors.name.message}</p>}
          </div>
          <div>
            <Label htmlFor="address">Address</Label>
            <Input id="address" {...register('address')} className="mt-1.5" placeholder="123 Example St" />
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={isPending}>
              {isPending ? 'Saving…' : existing ? 'Save changes' : 'Create building'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export default function BuildingsAdminPage() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editTarget, setEditTarget] = useState<Building | undefined>()
  const [importOpen, setImportOpen] = useState(false)

  const { data: buildings, isLoading } = useQuery({
    queryKey: ['buildings'],
    queryFn: () => buildingsApi.list(),
    select: (r) => r.data,
  })

  const deleteBuilding = useMutation({
    mutationFn: (id: string) => buildingsApi.delete(id),
    onSuccess: () => { toast.success('Building deleted'); qc.invalidateQueries({ queryKey: ['buildings'] }) },
    onError: () => toast.error('Failed to delete building'),
  })

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">Buildings</h1>
          <p className="text-muted-foreground text-sm mt-1">Manage your office buildings and floors</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => setImportOpen(true)}>
            <Upload className="mr-2 h-4 w-4" /> Import CSV
          </Button>
          <Button onClick={() => { setEditTarget(undefined); setDialogOpen(true) }}>
            <Plus className="mr-2 h-4 w-4" /> Add Building
          </Button>
        </div>
      </div>

      {isLoading ? (
        <div className="space-y-3">{[1, 2].map((i) => <Skeleton key={i} className="h-20" />)}</div>
      ) : (buildings ?? []).length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12 text-center">
            <Building2 className="h-12 w-12 text-muted-foreground/30 mb-3" />
            <p className="text-sm text-muted-foreground">No buildings yet</p>
            <Button variant="outline" size="sm" className="mt-4" onClick={() => setDialogOpen(true)}>
              <Plus className="mr-2 h-3.5 w-3.5" /> Add your first building
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {(buildings ?? []).map((b) => (
            <Card key={b.id} className="cursor-pointer hover:shadow-md transition-shadow"
              onClick={() => navigate(`/admin/buildings/${b.id}`)}>
              <CardContent className="p-4 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <Building2 className="h-5 w-5 text-muted-foreground" />
                  <div>
                    <p className="font-medium">{b.name}</p>
                    {b.address && <p className="text-xs text-muted-foreground">{b.address}</p>}
                  </div>
                </div>
                <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                  <Button variant="ghost" size="icon" className="h-8 w-8"
                    onClick={() => { setEditTarget(b); setDialogOpen(true) }}>
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-destructive">
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Delete building?</AlertDialogTitle>
                        <AlertDialogDescription>
                          This will permanently delete <strong>{b.name}</strong> and all its floors and desks.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction onClick={() => deleteBuilding.mutate(b.id)}
                          className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
                          Delete
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                  <ChevronRight className="h-4 w-4 text-muted-foreground ml-1" />
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <BuildingDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        existing={editTarget}
      />
      <BulkImportDialog open={importOpen} onClose={() => setImportOpen(false)} />
    </div>
  )
}
