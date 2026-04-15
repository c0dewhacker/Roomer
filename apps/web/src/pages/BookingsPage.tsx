import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { format, parseISO } from 'date-fns'
import { Calendar, MapPin, Clock, Trash2, Pencil, CalendarPlus, X, Armchair } from 'lucide-react'
import { useMyBookings, useCancelBooking, useUpdateBooking } from '@/hooks/useBookings'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Input } from '@/components/ui/input'
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
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { formatDateRange } from '@/lib/utils'
import { assetsApi, type MyAssignment, type AvailabilityWindow } from '@/lib/api'
import type { Booking } from '@/types'

type Tab = 'upcoming' | 'past' | 'all'

const statusVariant: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  CONFIRMED: 'default',
  CANCELLED: 'destructive',
  COMPLETED: 'secondary',
}

function toLocalDatetimeValue(iso: string): string {
  const d = parseISO(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function nowLocalValue(): string {
  return toLocalDatetimeValue(new Date().toISOString())
}

// ─── Edit booking dialog ──────────────────────────────────────────────────────

function EditBookingDialog({
  booking,
  open,
  onClose,
}: {
  booking: Booking
  open: boolean
  onClose: () => void
}) {
  const update = useUpdateBooking()
  const [startsAt, setStartsAt] = useState(toLocalDatetimeValue(booking.startsAt))
  const [endsAt, setEndsAt] = useState(toLocalDatetimeValue(booking.endsAt))
  const [notes, setNotes] = useState(booking.notes ?? '')

  function handleSave() {
    update.mutate(
      {
        id: booking.id,
        body: {
          startsAt: new Date(startsAt).toISOString(),
          endsAt: new Date(endsAt).toISOString(),
          notes: notes || undefined,
        },
      },
      { onSuccess: onClose },
    )
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Modify booking — {(booking.asset ?? booking.desk)?.name}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div>
            <Label htmlFor="edit-starts">Start</Label>
            <Input id="edit-starts" type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} className="mt-1.5" />
          </div>
          <div>
            <Label htmlFor="edit-ends">End</Label>
            <Input id="edit-ends" type="datetime-local" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} min={startsAt} className="mt-1.5" />
          </div>
          <div>
            <Label htmlFor="edit-notes">Notes</Label>
            <Textarea id="edit-notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} placeholder="Optional" className="mt-1.5 resize-none" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={update.isPending}>Cancel</Button>
          <Button onClick={handleSave} disabled={update.isPending || !startsAt || !endsAt}>
            {update.isPending ? 'Saving…' : 'Save changes'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ─── Make available dialog ────────────────────────────────────────────────────

function MakeAvailableDialog({
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
            <Label htmlFor="avail-starts">Available from</Label>
            <Input
              id="avail-starts"
              type="datetime-local"
              value={startsAt}
              min={nowLocalValue()}
              onChange={(e) => setStartsAt(e.target.value)}
              className="mt-1.5"
            />
          </div>
          <div>
            <Label htmlFor="avail-ends">Available until</Label>
            <Input
              id="avail-ends"
              type="datetime-local"
              value={endsAt}
              min={startsAt}
              onChange={(e) => setEndsAt(e.target.value)}
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

// ─── Availability window row ──────────────────────────────────────────────────

function WindowRow({ assetId, window }: { assetId: string; window: AvailabilityWindow }) {
  const qc = useQueryClient()

  const remove = useMutation({
    mutationFn: () => assetsApi.deleteAvailabilityWindow(assetId, window.id),
    onSuccess: () => {
      toast.success('Availability window removed — desk is no longer shareable for that period')
      qc.invalidateQueries({ queryKey: ['my-assignments'] })
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

// ─── Assigned desk card ───────────────────────────────────────────────────────

function AssignedDeskCard({ assignment }: { assignment: MyAssignment }) {
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

// ─── My assigned desks section ────────────────────────────────────────────────

function MyAssignedDesks() {
  const { data, isLoading } = useQuery({
    queryKey: ['my-assignments'],
    queryFn: () => assetsApi.getMyAssignments(),
    select: (r) => r.data,
  })

  if (isLoading) return <Skeleton className="h-24 w-full" />
  if (!data || data.length === 0) return null

  return (
    <div className="mb-8">
      <div className="flex items-center gap-2 mb-3">
        <Armchair className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-base font-semibold">My Assigned Desk{data.length !== 1 ? 's' : ''}</h2>
      </div>
      <div className="space-y-3">
        {data.map((a) => (
          <AssignedDeskCard key={a.assetId} assignment={a} />
        ))}
      </div>
    </div>
  )
}

// ─── Booking list ─────────────────────────────────────────────────────────────

function BookingRow({ booking, showCancel }: { booking: Booking; showCancel: boolean }) {
  const navigate = useNavigate()
  const cancel = useCancelBooking()
  const bookingAsset = booking.asset ?? booking.desk
  const floorId = bookingAsset?.zone?.floor?.id
  const [editOpen, setEditOpen] = useState(false)
  const canModify = showCancel && booking.status === 'CONFIRMED'

  return (
    <>
      <Card>
        <CardContent className="p-4">
          <div className="flex items-start justify-between gap-3">
            <div
              className="flex-1 min-w-0 cursor-pointer"
              onClick={() => floorId && navigate(`/floors/${floorId}`)}
            >
              <div className="flex items-center gap-2">
                <p className="font-medium truncate">{bookingAsset?.name ?? 'Unknown asset'}</p>
                <Badge variant={statusVariant[booking.status] ?? 'secondary'} className="shrink-0 text-xs">
                  {booking.status}
                </Badge>
              </div>
              <p className="text-xs text-muted-foreground flex items-center gap-1 mt-1">
                <MapPin className="h-3 w-3 shrink-0" />
                {[
                  bookingAsset?.zone?.floor?.building?.name,
                  bookingAsset?.zone?.floor?.name,
                  bookingAsset?.zone?.name,
                ].filter(Boolean).join(' › ')}
              </p>
              <p className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
                <Clock className="h-3 w-3 shrink-0" />
                {formatDateRange(booking.startsAt, booking.endsAt)}
              </p>
              {booking.notes && (
                <p className="text-xs text-muted-foreground mt-1 italic">{booking.notes}</p>
              )}
            </div>

            {canModify && (
              <div className="flex items-center gap-1 shrink-0">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-muted-foreground hover:text-foreground"
                  onClick={() => setEditOpen(true)}
                >
                  <Pencil className="h-4 w-4" />
                </Button>

                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-destructive">
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Cancel booking?</AlertDialogTitle>
                      <AlertDialogDescription>
                        Cancel your booking for <strong>{(booking.asset ?? booking.desk)?.name}</strong> on{' '}
                        {format(parseISO(booking.startsAt), 'PPP')}? This action cannot be undone.
                        Anyone in the queue will be notified.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Keep booking</AlertDialogCancel>
                      <AlertDialogAction
                        onClick={() => cancel.mutate(booking.id)}
                        className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                      >
                        Cancel booking
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {editOpen && (
        <EditBookingDialog booking={booking} open={editOpen} onClose={() => setEditOpen(false)} />
      )}
    </>
  )
}

function BookingList({ tab }: { tab: Tab }) {
  const status = tab === 'upcoming' ? 'upcoming' : tab === 'past' ? 'past' : 'all'
  const { data, isLoading } = useMyBookings(status)
  const bookings = data?.bookings ?? []

  if (isLoading) {
    return (
      <div className="space-y-3">
        {[1, 2, 3].map((i) => <Skeleton key={i} className="h-24 w-full" />)}
      </div>
    )
  }

  if (bookings.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <Calendar className="h-12 w-12 text-muted-foreground/30 mb-3" />
        <p className="text-sm text-muted-foreground">No bookings found</p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {bookings.map((b) => (
        <BookingRow key={b.id} booking={b} showCancel={tab !== 'past'} />
      ))}
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function BookingsPage() {
  const [tab, setTab] = useState<Tab>('upcoming')

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold">My Bookings</h1>
        <p className="text-muted-foreground text-sm mt-1">All your desk reservations</p>
      </div>

      <MyAssignedDesks />

      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
        <TabsList className="mb-4">
          <TabsTrigger value="upcoming">Upcoming</TabsTrigger>
          <TabsTrigger value="past">Past</TabsTrigger>
          <TabsTrigger value="all">All</TabsTrigger>
        </TabsList>
        <TabsContent value="upcoming"><BookingList tab="upcoming" /></TabsContent>
        <TabsContent value="past"><BookingList tab="past" /></TabsContent>
        <TabsContent value="all"><BookingList tab="all" /></TabsContent>
      </Tabs>
    </div>
  )
}
