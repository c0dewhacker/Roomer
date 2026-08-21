import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { parseISO, isToday } from 'date-fns'
import { Calendar, MapPin, Clock, Trash2, Pencil, CalendarPlus, Armchair, Repeat, Check, List, Send, ArrowLeftRight, Inbox } from 'lucide-react'
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
import { Input } from '@/components/ui/input'
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
import { formatDateRange, formatDate, formatCalendarDate } from '@/lib/utils'
import { DateTimeLocalInput } from '@/components/ui/date-time-input'
import { assetsApi, recurringBookingsApi, bookingsApi, usersApi } from '@/lib/api'
import type { Booking, RecurringBookingRule, BookingTransfer, BookingSwap } from '@/types'
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

// ─── Transfer a booking to a colleague ─────────────────────────────────────────

function TransferBookingDialog({ booking, open, onClose }: { booking: Booking; open: boolean; onClose: () => void }) {
  const qc = useQueryClient()
  const [search, setSearch] = useState('')
  const [selectedUserId, setSelectedUserId] = useState('')

  const { data: users } = useQuery({
    queryKey: ['users', 'search', search],
    queryFn: () => usersApi.search(search),
    select: (r) => r.data,
    enabled: search.length >= 2,
  })

  const transfer = useMutation({
    mutationFn: () => bookingsApi.transfer(booking.id, selectedUserId),
    onSuccess: () => {
      toast.success('Transfer request sent')
      qc.invalidateQueries({ queryKey: ['bookings', 'transfers'] })
      onClose()
      setSearch('')
      setSelectedUserId('')
    },
    onError: (err: Error) => toast.error(err.message),
  })

  const bookingAsset = booking.asset ?? booking.desk

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Transfer booking</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <p className="text-sm text-muted-foreground">
            Hand your booking for <strong>{bookingAsset?.name}</strong> on {formatDate(booking.startsAt)} to a
            colleague. They'll need to accept before it's theirs.
          </p>
          <div>
            <Label>Search colleague</Label>
            <Input
              className="mt-1.5"
              placeholder="Name or email…"
              value={search}
              onChange={(e) => { setSearch(e.target.value); setSelectedUserId('') }}
            />
          </div>
          {users && users.length > 0 && (
            <div className="rounded-md border divide-y max-h-48 overflow-y-auto">
              {users.map((u) => (
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
          {search.length >= 2 && (!users || users.length === 0) && (
            <p className="text-sm text-muted-foreground">No users found</p>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={() => transfer.mutate()} disabled={!selectedUserId || transfer.isPending}>
            {transfer.isPending ? 'Sending…' : 'Send transfer request'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ─── Swap a booking with a colleague ───────────────────────────────────────────

function SwapBookingDialog({ booking, open, onClose }: { booking: Booking; open: boolean; onClose: () => void }) {
  const qc = useQueryClient()
  const [search, setSearch] = useState('')
  const [selectedUserId, setSelectedUserId] = useState('')

  const { data: users } = useQuery({
    queryKey: ['users', 'search', search],
    queryFn: () => usersApi.search(search),
    select: (r) => r.data,
    enabled: search.length >= 2,
  })

  // Swaps only work when the colleague has a booking at exactly this time
  // (see #83 — mismatched-time swaps are out of scope) — look up whether
  // they do as soon as one is selected, rather than letting the user submit
  // a request that's guaranteed to fail.
  const { data: candidate, isLoading: candidateLoading } = useQuery({
    queryKey: ['bookings', booking.id, 'swap-candidate', selectedUserId],
    queryFn: () => bookingsApi.swapCandidate(booking.id, selectedUserId),
    select: (r) => r.data,
    enabled: !!selectedUserId,
  })

  const swap = useMutation({
    mutationFn: () => bookingsApi.swapRequest(booking.id, candidate!.id),
    onSuccess: () => {
      toast.success('Swap request sent')
      qc.invalidateQueries({ queryKey: ['bookings', 'swaps'] })
      onClose()
      setSearch('')
      setSelectedUserId('')
    },
    onError: (err: Error) => toast.error(err.message),
  })

  const bookingAsset = booking.asset ?? booking.desk

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Swap booking</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <p className="text-sm text-muted-foreground">
            Trade your booking for <strong>{bookingAsset?.name}</strong> on {formatDate(booking.startsAt)} with a
            colleague who has a booking at the exact same time. They'll need to accept.
          </p>
          <div>
            <Label>Search colleague</Label>
            <Input
              className="mt-1.5"
              placeholder="Name or email…"
              value={search}
              onChange={(e) => { setSearch(e.target.value); setSelectedUserId('') }}
            />
          </div>
          {users && users.length > 0 && (
            <div className="rounded-md border divide-y max-h-48 overflow-y-auto">
              {users.map((u) => (
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
          {search.length >= 2 && (!users || users.length === 0) && (
            <p className="text-sm text-muted-foreground">No users found</p>
          )}
          {selectedUserId && candidateLoading && (
            <p className="text-sm text-muted-foreground">Checking for a matching booking…</p>
          )}
          {selectedUserId && !candidateLoading && candidate && (
            <p className="text-sm rounded-md border border-green-500/30 bg-green-500/5 px-3 py-2">
              They have <strong>{candidate.asset.name}</strong> booked at this exact time — ready to propose the swap.
            </p>
          )}
          {selectedUserId && !candidateLoading && !candidate && (
            <p className="text-sm rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2">
              They don't have a booking at this exact time, so a swap isn't possible with them for this slot.
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={() => swap.mutate()} disabled={!candidate || swap.isPending}>
            {swap.isPending ? 'Sending…' : 'Send swap request'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ─── Pending transfer/swap requests ────────────────────────────────────────────
// Only surfaces requests actually needing attention (received, still PENDING)
// or still withdrawable (sent, still PENDING) — accepted/declined/expired ones
// aren't actionable here, so they'd just be clutter; their outcome already
// arrives as a notification.

function TransferAndSwapRequestsSection() {
  const qc = useQueryClient()
  const { data: transfers } = useQuery({
    queryKey: ['bookings', 'transfers'],
    queryFn: () => bookingsApi.listTransfers(),
    select: (r) => r.data,
  })
  const { data: swaps } = useQuery({
    queryKey: ['bookings', 'swaps'],
    queryFn: () => bookingsApi.listSwaps(),
    select: (r) => r.data,
  })

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['bookings', 'transfers'] })
    qc.invalidateQueries({ queryKey: ['bookings', 'swaps'] })
    qc.invalidateQueries({ queryKey: ['bookings'] })
  }

  const acceptTransfer = useMutation({
    mutationFn: (id: string) => bookingsApi.acceptTransfer(id),
    onSuccess: () => { toast.success('Transfer accepted'); invalidate() },
    onError: (e: Error) => toast.error(e.message),
  })
  const declineTransfer = useMutation({
    mutationFn: (id: string) => bookingsApi.declineTransfer(id),
    onSuccess: () => { toast.success('Transfer declined'); invalidate() },
    onError: (e: Error) => toast.error(e.message),
  })
  const cancelTransfer = useMutation({
    mutationFn: (id: string) => bookingsApi.cancelTransfer(id),
    onSuccess: () => { toast.success('Transfer request withdrawn'); invalidate() },
    onError: (e: Error) => toast.error(e.message),
  })
  const acceptSwap = useMutation({
    mutationFn: (id: string) => bookingsApi.acceptSwap(id),
    onSuccess: () => { toast.success('Swap complete'); invalidate() },
    onError: (e: Error) => toast.error(e.message),
  })
  const declineSwap = useMutation({
    mutationFn: (id: string) => bookingsApi.declineSwap(id),
    onSuccess: () => { toast.success('Swap declined'); invalidate() },
    onError: (e: Error) => toast.error(e.message),
  })
  const cancelSwap = useMutation({
    mutationFn: (id: string) => bookingsApi.cancelSwap(id),
    onSuccess: () => { toast.success('Swap request withdrawn'); invalidate() },
    onError: (e: Error) => toast.error(e.message),
  })

  const receivedTransfers = (transfers?.received ?? []).filter((t) => t.status === 'PENDING')
  const sentTransfers = (transfers?.sent ?? []).filter((t) => t.status === 'PENDING')
  const receivedSwaps = (swaps?.received ?? []).filter((s) => s.status === 'PENDING')
  const sentSwaps = (swaps?.sent ?? []).filter((s) => s.status === 'PENDING')

  const hasAnything = receivedTransfers.length + sentTransfers.length + receivedSwaps.length + sentSwaps.length > 0
  if (!hasAnything) return null

  return (
    <Card className="mb-6">
      <CardContent className="p-4">
        <div className="flex items-center gap-2 mb-3">
          <Inbox className="h-4 w-4 text-primary" />
          <h2 className="font-medium text-sm">Transfer &amp; swap requests</h2>
        </div>
        <div className="space-y-2">
          {receivedTransfers.map((t: BookingTransfer) => (
            <div key={t.id} className="flex items-center justify-between gap-3 rounded-md border p-3">
              <div className="min-w-0">
                <p className="text-sm">
                  <strong>{t.fromUser?.displayName}</strong> wants to transfer <strong>{t.booking?.asset.name}</strong> to you
                </p>
                <p className="text-xs text-muted-foreground">
                  {t.booking && formatDateRange(t.booking.startsAt, t.booking.endsAt)}
                </p>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <Button size="sm" variant="outline" onClick={() => declineTransfer.mutate(t.id)} disabled={declineTransfer.isPending}>Decline</Button>
                <Button size="sm" onClick={() => acceptTransfer.mutate(t.id)} disabled={acceptTransfer.isPending}>Accept</Button>
              </div>
            </div>
          ))}
          {receivedSwaps.map((s: BookingSwap) => (
            <div key={s.id} className="flex items-center justify-between gap-3 rounded-md border p-3">
              <div className="min-w-0">
                <p className="text-sm">
                  <strong>{s.initiator?.displayName}</strong> wants to swap <strong>{s.bookingA?.asset.name}</strong> for your <strong>{s.bookingB?.asset.name}</strong>
                </p>
                <p className="text-xs text-muted-foreground">
                  {s.bookingA && formatDateRange(s.bookingA.startsAt, s.bookingA.endsAt)}
                </p>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <Button size="sm" variant="outline" onClick={() => declineSwap.mutate(s.id)} disabled={declineSwap.isPending}>Decline</Button>
                <Button size="sm" onClick={() => acceptSwap.mutate(s.id)} disabled={acceptSwap.isPending}>Accept</Button>
              </div>
            </div>
          ))}
          {sentTransfers.map((t: BookingTransfer) => (
            <div key={t.id} className="flex items-center justify-between gap-3 rounded-md border border-dashed p-3">
              <div className="min-w-0">
                <p className="text-sm text-muted-foreground">
                  Waiting for <strong>{t.toUser?.displayName}</strong> to respond to your transfer of <strong>{t.booking?.asset.name}</strong>
                </p>
              </div>
              <Button size="sm" variant="ghost" onClick={() => cancelTransfer.mutate(t.id)} disabled={cancelTransfer.isPending}>Withdraw</Button>
            </div>
          ))}
          {sentSwaps.map((s: BookingSwap) => (
            <div key={s.id} className="flex items-center justify-between gap-3 rounded-md border border-dashed p-3">
              <div className="min-w-0">
                <p className="text-sm text-muted-foreground">
                  Waiting for <strong>{s.recipient?.displayName}</strong> to respond to your swap request
                </p>
              </div>
              <Button size="sm" variant="ghost" onClick={() => cancelSwap.mutate(s.id)} disabled={cancelSwap.isPending}>Withdraw</Button>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
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
  const [transferOpen, setTransferOpen] = useState(false)
  const [swapOpen, setSwapOpen] = useState(false)
  const canModify = showCancel && booking.status === 'CONFIRMED'
  // Mirrors the backend's actual check-in window (bookings.ts POST
  // /:id/check-in: rejects with BOOKING_NOT_STARTED while startsAt > now,
  // BOOKING_ENDED once endsAt < now) — todayBooking alone enabled the button
  // for the whole calendar day, so clicking "I'm here" any time before the
  // booking actually started produced a guaranteed "Check-in failed" toast.
  const now = new Date()
  const inCheckInWindow = new Date(booking.startsAt) <= now && now <= new Date(booking.endsAt)
  // Mandatory QR check-in hides the manual button entirely — scanning the
  // desk's QR code becomes the only way to check in for that scope (see
  // #76 phase 3; the backend still treats no-show release as active
  // regardless of the org/building/floor noShowReleaseEnabled value once
  // QR is mandatory, so this isn't just cosmetic).
  const canCheckIn = inCheckInWindow && booking.status === 'CONFIRMED' && !booking.checkedInAt && booking.qrCheckInMode !== 'MANDATORY'

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
                {inCheckInWindow && booking.status === 'CONFIRMED' && !booking.checkedInAt && booking.qrCheckInMode === 'MANDATORY' && (
                  <span className="text-xs text-muted-foreground">Scan the desk's QR code to check in</span>
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
                <Button
                  variant="ghost"
                  size="icon"
                  title="Transfer to a colleague"
                  className="h-8 w-8 text-muted-foreground hover:text-foreground"
                  onClick={() => setTransferOpen(true)}
                >
                  <Send className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  title="Swap with a colleague"
                  className="h-8 w-8 text-muted-foreground hover:text-foreground"
                  onClick={() => setSwapOpen(true)}
                >
                  <ArrowLeftRight className="h-4 w-4" />
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
      {transferOpen && (
        <TransferBookingDialog booking={booking} open={transferOpen} onClose={() => setTransferOpen(false)} />
      )}
      {swapOpen && (
        <SwapBookingDialog booking={booking} open={swapOpen} onClose={() => setSwapOpen(false)} />
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

function EditRecurringEndDateDialog({
  rule,
  open,
  onClose,
}: {
  rule: RecurringBookingRule
  open: boolean
  onClose: () => void
}) {
  const qc = useQueryClient()
  const [lastDate, setLastDate] = useState(rule.lastDate.slice(0, 10))

  const update = useMutation({
    mutationFn: () => recurringBookingsApi.update(rule.id, { lastDate }),
    onSuccess: () => {
      const extended = new Date(lastDate) > new Date(rule.lastDate.slice(0, 10))
      toast.success(extended ? 'Series extended' : 'Series shortened')
      qc.invalidateQueries({ queryKey: ['recurring-bookings'] })
      // Same reasoning as cancel above — extending/shortening changes the
      // underlying Booking rows directly, not just the rule.
      qc.invalidateQueries({ queryKey: ['bookings'] })
      onClose()
    },
    onError: (err: Error) => toast.error(err.message),
  })

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Change end date</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div>
            <Label htmlFor="recur-lastdate">New end date</Label>
            <input
              id="recur-lastdate"
              type="date"
              value={lastDate}
              min={rule.firstDate.slice(0, 10)}
              onChange={(e) => setLastDate(e.target.value)}
              className="mt-1.5 flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm"
            />
            <p className="text-xs text-muted-foreground mt-1.5">
              Pick a later date to add more occurrences, or an earlier one to drop occurrences after it.
              Occurrences up to and including the new date are never affected.
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={update.isPending}>Cancel</Button>
          <Button onClick={() => update.mutate()} disabled={update.isPending || !lastDate}>
            {update.isPending ? 'Saving…' : 'Save changes'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function RecurringOccurrencesDialog({
  ruleId,
  assetLabel,
  open,
  onClose,
}: {
  ruleId: string
  assetLabel: string
  open: boolean
  onClose: () => void
}) {
  const { data, isLoading } = useQuery({
    queryKey: ['recurring-bookings', ruleId],
    queryFn: () => recurringBookingsApi.get(ruleId),
    select: (r) => r.data,
    enabled: open,
  })

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Occurrences — {assetLabel}</DialogTitle>
        </DialogHeader>
        <div className="space-y-1.5 py-2 max-h-96 overflow-y-auto">
          {isLoading ? (
            [1, 2, 3].map((i) => <Skeleton key={i} className="h-9 w-full" />)
          ) : !data?.bookings || data.bookings.length === 0 ? (
            <p className="text-sm text-muted-foreground">No occurrences.</p>
          ) : (
            data.bookings.map((b) => (
              <div key={b.id} className="flex items-center justify-between gap-2 text-sm py-1">
                <span>{formatDateRange(b.startsAt, b.endsAt)}</span>
                <Badge variant={statusVariant[b.status ?? ''] ?? 'secondary'} className="shrink-0 text-xs">
                  {b.status}
                </Badge>
              </div>
            ))
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function RecurringRuleCard({ rule }: { rule: RecurringBookingRule }) {
  const qc = useQueryClient()
  const [editDateOpen, setEditDateOpen] = useState(false)
  const [occurrencesOpen, setOccurrencesOpen] = useState(false)

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
    <>
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
                {formatCalendarDate(rule.firstDate)} → {formatCalendarDate(rule.lastDate)}
                {upcomingCount > 0 && <span className="ml-1">({upcomingCount} upcoming)</span>}
              </p>
              <button
                type="button"
                onClick={() => setOccurrencesOpen(true)}
                className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 mt-1 underline decoration-dotted underline-offset-2"
              >
                <List className="h-3 w-3 shrink-0" />
                View all occurrences
              </button>
            </div>

            {rule.status === 'ACTIVE' && (
              <div className="flex items-center gap-1 shrink-0">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-muted-foreground hover:text-foreground"
                  onClick={() => setEditDateOpen(true)}
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
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {editDateOpen && (
        <EditRecurringEndDateDialog rule={rule} open={editDateOpen} onClose={() => setEditDateOpen(false)} />
      )}
      {occurrencesOpen && (
        <RecurringOccurrencesDialog ruleId={rule.id} assetLabel={assetLabel} open={occurrencesOpen} onClose={() => setOccurrencesOpen(false)} />
      )}
    </>
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
      <TransferAndSwapRequestsSection />
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
