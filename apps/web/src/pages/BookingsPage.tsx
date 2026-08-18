import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { parseISO, isToday } from 'date-fns'
import { Calendar, MapPin, Clock, Trash2, Pencil, CalendarPlus, Armchair, Repeat, Check } from 'lucide-react'
import { useMyBookings, useCancelBooking, useUpdateBooking } from '@/hooks/useBookings'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
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
import { formatDateRange, formatDate } from '@/lib/utils'
import { DateTimeLocalInput } from '@/components/ui/date-time-input'
import { assetsApi, recurringBookingsApi, bookingsApi } from '@/lib/api'
import type { Booking, RecurringBookingRule } from '@/types'
import { AssignedDeskCard } from '@/components/AssignedDeskCard'

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
            <Label>Start</Label>
            <DateTimeLocalInput value={startsAt} onChange={setStartsAt} className="mt-1.5" />
          </div>
          <div>
            <Label>End</Label>
            <DateTimeLocalInput value={endsAt} onChange={setEndsAt} min={startsAt} className="mt-1.5" />
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
  const qc = useQueryClient()
  const bookingAsset = booking.asset ?? booking.desk
  const floorId = bookingAsset?.floor?.id ?? bookingAsset?.zone?.floor?.id
  const todayBooking = isToday(parseISO(booking.startsAt))
  const [editOpen, setEditOpen] = useState(false)
  const canModify = showCancel && booking.status === 'CONFIRMED'
  const canCheckIn = todayBooking && booking.status === 'CONFIRMED' && !booking.checkedInAt

  const checkIn = useMutation({
    mutationFn: () => bookingsApi.checkIn(booking.id),
    onSuccess: () => { toast.success('Checked in'); qc.invalidateQueries({ queryKey: ['bookings'] }) },
    onError: (e: Error) => toast.error(e.message || 'Check-in failed'),
  })

  return (
    <>
      <Card>
        <CardContent className="p-4">
          <div className="flex items-start justify-between gap-3">
            <div
              className="flex-1 min-w-0 cursor-pointer"
              onClick={() => floorId && navigate(`/floors/${floorId}`)}
            >
              <div className="flex items-center gap-2 flex-wrap">
                <p className="font-medium truncate">{bookingAsset?.name ?? 'Unknown asset'}</p>
                {todayBooking && (
                  <Badge variant="outline" className="shrink-0 text-xs border-green-500 text-green-600">Today</Badge>
                )}
                <Badge variant={statusVariant[booking.status] ?? 'secondary'} className="shrink-0 text-xs">
                  {booking.status}
                </Badge>
                {booking.checkedInAt && (
                  <Badge variant="outline" className="shrink-0 text-xs border-green-500 text-green-600">
                    <Check className="h-3 w-3 mr-0.5" /> Checked in
                  </Badge>
                )}
                {canCheckIn && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-6 px-2 text-xs gap-1"
                    onClick={(e) => { e.stopPropagation(); checkIn.mutate() }}
                    disabled={checkIn.isPending}
                  >
                    <Check className="h-3 w-3" /> I'm here
                  </Button>
                )}
              </div>
              <p className="text-xs text-muted-foreground flex items-center gap-1 mt-1">
                <MapPin className="h-3 w-3 shrink-0" />
                {[
                  bookingAsset?.floor?.building?.name ?? bookingAsset?.zone?.floor?.building?.name,
                  bookingAsset?.floor?.name ?? bookingAsset?.zone?.floor?.name,
                  bookingAsset?.primaryZone?.name ?? bookingAsset?.zone?.name,
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
                <a
                  href={`/api/v1/bookings/${booking.id}/calendar.ics`}
                  download
                  title="Add to calendar"
                  className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-accent"
                >
                  <CalendarPlus className="h-4 w-4" />
                </a>
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
                        {formatDate(booking.startsAt)}? This action cannot be undone.
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

// ─── Recurring bookings ───────────────────────────────────────────────────────

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

// The API stores startTime/endTime/dayOfWeek as UTC wall-clock values (see the
// comment in DeskPanel's createRecurring) — displaying them as-is shows a
// Sydney user's local 13:00–18:00 booking as "03:00–08:00", which reads as
// wrong even though the underlying bookings are scheduled correctly. Anchor
// each HH:MM to a UTC date matching the stored dayOfWeek (1970-01-04 was a UTC
// Sunday) and read the local wall-clock fields back off that same instant —
// this recovers the correct local time and day regardless of which direction
// the UTC conversion shifted the calendar day.
function utcRuleTimeToLocal(startTime: string, endTime: string, dayOfWeek?: number | null) {
  const toDate = (t: string) => {
    const [h, m] = t.split(':').map(Number)
    return new Date(Date.UTC(1970, 0, 4 + (dayOfWeek ?? 0), h, m))
  }
  const start = toDate(startTime)
  const end = toDate(endTime)
  const pad = (n: number) => String(n).padStart(2, '0')
  return {
    start: `${pad(start.getHours())}:${pad(start.getMinutes())}`,
    end: `${pad(end.getHours())}:${pad(end.getMinutes())}`,
    dayOfWeek: dayOfWeek != null ? start.getDay() : null,
  }
}

function RecurringRuleCard({ rule }: { rule: RecurringBookingRule }) {
  const qc = useQueryClient()

  const cancel = useMutation({
    mutationFn: () => recurringBookingsApi.cancel(rule.id),
    onSuccess: () => {
      toast.success('Recurring series cancelled')
      qc.invalidateQueries({ queryKey: ['recurring-bookings'] })
      // The backend cancels every future occurrence's underlying Booking row
      // too, not just the rule — without this, the already-fetched
      // ['bookings'] cache keeps showing those rows as CONFIRMED with live
      // Edit/Cancel buttons until an unrelated refetch happens to occur.
      qc.invalidateQueries({ queryKey: ['bookings'] })
    },
    onError: (err: Error) => toast.error(err.message),
  })

  const assetLabel = rule.asset?.bookingLabel ?? rule.asset?.name ?? 'Unknown asset'
  const location = [rule.asset?.floor?.building.name, rule.asset?.floor?.name].filter(Boolean).join(' › ')
  const upcomingCount = rule.bookings?.length ?? rule._count?.bookings ?? 0
  const local = utcRuleTimeToLocal(rule.startTime, rule.endTime, rule.dayOfWeek)

  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <p className="font-medium truncate">{assetLabel}</p>
              <Badge variant={rule.status === 'ACTIVE' ? 'default' : 'destructive'} className="shrink-0 text-xs">
                {rule.status}
              </Badge>
            </div>
            {location && (
              <p className="text-xs text-muted-foreground flex items-center gap-1 mt-1">
                <MapPin className="h-3 w-3 shrink-0" />{location}
              </p>
            )}
            <p className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
              <Repeat className="h-3 w-3 shrink-0" />
              {rule.frequency === 'DAILY' && `Every day, ${local.start}–${local.end}`}
              {rule.frequency === 'WEEKLY' && local.dayOfWeek != null && `Every ${DAY_NAMES[local.dayOfWeek]}, ${local.start}–${local.end}`}
              {rule.frequency === 'MONTHLY' && `Monthly, ${local.start}–${local.end}`}
            </p>
            <p className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
              <Calendar className="h-3 w-3 shrink-0" />
              {formatDate(rule.firstDate)} → {formatDate(rule.lastDate)}
              {upcomingCount > 0 && <span className="ml-1">({upcomingCount} upcoming)</span>}
            </p>
          </div>

          {rule.status === 'ACTIVE' && (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive">
                  <Trash2 className="h-4 w-4" />
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Cancel recurring series?</AlertDialogTitle>
                  <AlertDialogDescription>
                    All future bookings in this series for <strong>{assetLabel}</strong> will be cancelled.
                    Past bookings are not affected.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Keep series</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={() => cancel.mutate()}
                    className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  >
                    Cancel series
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

function RecurringBookingsSection() {
  const { data, isLoading } = useQuery({
    queryKey: ['recurring-bookings'],
    queryFn: () => recurringBookingsApi.list(),
    select: (r) => r.data,
  })

  if (isLoading) return <div className="mb-8"><Skeleton className="h-20 w-full" /></div>
  if (!data || data.length === 0) return null

  return (
    <div className="mb-8">
      <div className="flex items-center gap-2 mb-3">
        <Repeat className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-base font-semibold">Recurring Bookings</h2>
      </div>
      <div className="space-y-3">
        {data.map((rule) => (
          <RecurringRuleCard key={rule.id} rule={rule} />
        ))}
      </div>
    </div>
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
      <RecurringBookingsSection />

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
