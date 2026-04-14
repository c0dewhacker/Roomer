import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { format, parseISO } from 'date-fns'
import { Calendar, MapPin, Clock, Trash2, Pencil } from 'lucide-react'
import { useMyBookings, useCancelBooking, useUpdateBooking } from '@/hooks/useBookings'
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
import type { Booking } from '@/types'

type Tab = 'upcoming' | 'past' | 'all'

const statusVariant: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  CONFIRMED: 'default',
  CANCELLED: 'destructive',
  COMPLETED: 'secondary',
}

function toLocalDatetimeValue(iso: string): string {
  // Converts ISO string to value compatible with <input type="datetime-local">
  const d = parseISO(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

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
            <Input
              id="edit-starts"
              type="datetime-local"
              value={startsAt}
              onChange={(e) => setStartsAt(e.target.value)}
              className="mt-1.5"
            />
          </div>
          <div>
            <Label htmlFor="edit-ends">End</Label>
            <Input
              id="edit-ends"
              type="datetime-local"
              value={endsAt}
              onChange={(e) => setEndsAt(e.target.value)}
              min={startsAt}
              className="mt-1.5"
            />
          </div>
          <div>
            <Label htmlFor="edit-notes">Notes</Label>
            <Textarea
              id="edit-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              placeholder="Optional"
              className="mt-1.5 resize-none"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={update.isPending}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={update.isPending || !startsAt || !endsAt}>
            {update.isPending ? 'Saving…' : 'Save changes'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function BookingRow({ booking, showCancel }: { booking: Booking; showCancel: boolean }) {
  const navigate = useNavigate()
  const cancel = useCancelBooking()
  // Support both new `asset` field and legacy `desk` field
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
                ]
                  .filter(Boolean)
                  .join(' › ')}
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

export default function BookingsPage() {
  const [tab, setTab] = useState<Tab>('upcoming')

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold">My Bookings</h1>
        <p className="text-muted-foreground text-sm mt-1">All your desk reservations</p>
      </div>

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
