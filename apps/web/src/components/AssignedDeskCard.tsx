import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { MapPin, Clock, CalendarPlus, X } from 'lucide-react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
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
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { DateTimeLocalInput } from '@/components/ui/date-time-input'
import { formatDateRange } from '@/lib/utils'
import { assetsApi, type MyAssignment, type AvailabilityWindow } from '@/lib/api'

function nowLocalValue(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

// ─── Make-available dialog ──────────────────────────────────────────────────

export function MakeAvailableDialog({
  assignment,
  open,
  onClose,
}: {
  assignment: MyAssignment
  open: boolean
  onClose: () => void
}) {
  const qc = useQueryClient()
  const [startsAt, setStartsAt] = useState(nowLocalValue())
  const [endsAt, setEndsAt] = useState('')
  const [note, setNote] = useState('')

  const create = useMutation({
    mutationFn: () =>
      assetsApi.createAvailabilityWindow(assignment.assetId, {
        startsAt: new Date(startsAt).toISOString(),
        endsAt: new Date(endsAt).toISOString(),
        note: note || undefined,
      }),
    onSuccess: () => {
      toast.success(`${assignment.asset.name} is now available for booking during that period`)
      qc.invalidateQueries({ queryKey: ['my-assignments'] })
      qc.invalidateQueries({ queryKey: ['assets', 'my'] })
      onClose()
    },
    onError: (err: Error) => toast.error(err.message),
  })

  const assetLabel = assignment.asset.bookingLabel ?? assignment.asset.name
  const location = [
    assignment.asset.floor?.building.name,
    assignment.asset.floor?.name,
    assignment.asset.primaryZone?.name,
  ].filter(Boolean).join(' › ')

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Make {assetLabel} available</DialogTitle>
        </DialogHeader>
        <div className="space-y-1 pb-1">
          {location && <p className="text-xs text-muted-foreground flex items-center gap-1"><MapPin className="h-3 w-3" />{location}</p>}
          <p className="text-xs text-muted-foreground">
            Other users will be able to temporarily book your desk during this period. Your permanent assignment is not affected.
          </p>
        </div>
        <div className="space-y-4 py-1">
          <div>
            <Label>Available from</Label>
            <DateTimeLocalInput
              value={startsAt}
              min={nowLocalValue()}
              onChange={setStartsAt}
              className="mt-1.5"
            />
          </div>
          <div>
            <Label>Available until</Label>
            <DateTimeLocalInput
              value={endsAt}
              min={startsAt}
              onChange={setEndsAt}
              className="mt-1.5"
            />
          </div>
          <div>
            <Label htmlFor="avail-note">Note <span className="text-muted-foreground font-normal">(optional)</span></Label>
            <Textarea
              id="avail-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              placeholder="e.g. Working from home this week"
              className="mt-1.5 resize-none"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={create.isPending}>Cancel</Button>
          <Button
            onClick={() => create.mutate()}
            disabled={create.isPending || !startsAt || !endsAt || new Date(endsAt) <= new Date(startsAt)}
          >
            {create.isPending ? 'Saving…' : 'Make available'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ─── Availability window row ────────────────────────────────────────────────

export function WindowRow({ assetId, window }: { assetId: string; window: AvailabilityWindow }) {
  const qc = useQueryClient()

  const remove = useMutation({
    mutationFn: () => assetsApi.deleteAvailabilityWindow(assetId, window.id),
    onSuccess: () => {
      toast.success('Availability window removed — desk is no longer shareable for that period')
      qc.invalidateQueries({ queryKey: ['my-assignments'] })
      qc.invalidateQueries({ queryKey: ['assets', 'my'] })
    },
    onError: (err: Error) => toast.error(err.message),
  })

  return (
    <div className="flex items-center justify-between gap-2 rounded-md bg-muted/50 px-3 py-2 text-xs">
      <div className="flex items-center gap-1.5 text-muted-foreground min-w-0">
        <Clock className="h-3 w-3 shrink-0" />
        <span className="truncate">{formatDateRange(window.startsAt, window.endsAt)}</span>
        {window.note && <span className="italic truncate">— {window.note}</span>}
      </div>
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button variant="ghost" size="icon" className="h-6 w-6 shrink-0 text-muted-foreground hover:text-destructive">
            <X className="h-3.5 w-3.5" />
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove availability window?</AlertDialogTitle>
            <AlertDialogDescription>
              Others will no longer be able to book your desk during{' '}
              <strong>{formatDateRange(window.startsAt, window.endsAt)}</strong>.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => remove.mutate()}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

// ─── Assigned desk card ──────────────────────────────────────────────────────
// Shared by BookingsPage ("My Assigned Desks") and AssetsPage ("My Assets") —
// both pages fetch the exact same assetUserAssignment-backed data, so a
// permanently-assigned desk gets the same location display and "Make
// available" action wherever a user looks for it.

export function AssignedDeskCard({ assignment }: { assignment: MyAssignment }) {
  const [dialogOpen, setDialogOpen] = useState(false)
  const navigate = useNavigate()

  const { asset } = assignment
  const location = [
    asset.floor?.building.name,
    asset.floor?.name,
    asset.primaryZone?.name,
  ].filter(Boolean).join(' › ')

  return (
    <>
      <Card>
        <CardContent className="p-4">
          <div className="flex items-start justify-between gap-3">
            <div
              className="flex-1 min-w-0 cursor-pointer"
              onClick={() => asset.floor?.id && navigate(`/floors/${asset.floor.id}`)}
            >
              <div className="flex items-center gap-2 flex-wrap">
                <p className="font-medium truncate">{asset.name}</p>
                <Badge variant="secondary" className="shrink-0 text-xs">Permanently assigned</Badge>
                {assignment.isPrimary && (
                  <Badge variant="outline" className="shrink-0 text-xs">Primary</Badge>
                )}
              </div>
              {location && (
                <p className="text-xs text-muted-foreground flex items-center gap-1 mt-1">
                  <MapPin className="h-3 w-3 shrink-0" />
                  {location}
                </p>
              )}
              <p className="text-xs text-muted-foreground mt-0.5">{asset.category.name}</p>
            </div>

            <Button
              size="sm"
              variant="outline"
              className="shrink-0 h-8 text-xs gap-1.5"
              onClick={() => setDialogOpen(true)}
            >
              <CalendarPlus className="h-3.5 w-3.5" />
              Make available
            </Button>
          </div>

          {asset.availabilityWindows.length > 0 && (
            <div className="mt-3 space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground">Shared periods</p>
              {asset.availabilityWindows.map((w) => (
                <WindowRow key={w.id} assetId={asset.id} window={w} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {dialogOpen && (
        <MakeAvailableDialog assignment={assignment} open={dialogOpen} onClose={() => setDialogOpen(false)} />
      )}
    </>
  )
}
