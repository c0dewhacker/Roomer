import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { bookingsApi, queueApi, assetsApi, ApiError } from '../lib/api'

function apiErrMsg(err: Error, fallback: string): string {
  if (err instanceof ApiError) {
    return err.fieldErrors ?? err.message ?? fallback
  }
  return err.message ?? fallback
}

export function useMyBookings(status?: 'upcoming' | 'past' | 'all') {
  return useQuery({
    queryKey: ['bookings', status ?? 'all'],
    queryFn: () => bookingsApi.list(status),
    select: (res) => ({ bookings: res.data, total: res.meta?.total ?? res.data.length }),
    // Approval/rejection (by an admin, or the auto-reject cron) isn't driven
    // by this client, so a "Pending approval" badge here can go stale the
    // same way the approvals list itself could (see useBookingApprovals.ts).
    // Only polls while there's actually something to watch — this query
    // backs the main bookings list for every user regardless of whether
    // they have any pending request, so an unconditional interval here
    // would poll far more often than useQueueEntries/useBallots's
    // narrower, already-time-sensitive surfaces.
    refetchInterval: (query) => (query.state.data?.data ?? []).some((b) => b.status === 'PENDING_APPROVAL') ? 30_000 : false,
  })
}

export function useCreateBooking() {
  const qc = useQueryClient()

  return useMutation({
    mutationFn: (body: { assetId: string; startsAt: string; endsAt: string; notes?: string; attendeeCount?: number; guestName?: string; guestEmail?: string }) =>
      bookingsApi.create(body),
    onSuccess: () => {
      toast.success('Desk booked successfully')
      qc.invalidateQueries({ queryKey: ['bookings'] })
    },
    onError: (err: Error) => {
      toast.error(apiErrMsg(err, 'Failed to create booking'))
    },
  })
}

export function useCancelBooking() {
  const qc = useQueryClient()

  return useMutation({
    mutationFn: (bookingId: string) => bookingsApi.cancel(bookingId),
    onSuccess: () => {
      toast.success('Booking cancelled')
      qc.invalidateQueries({ queryKey: ['bookings'] })
      // Freeing a desk changes floor availability — useLeaveQueue,
      // useClaimDesk, and useMakeAvailable below all already invalidate this
      // too; cancel was the one mutation in this file that didn't, leaving
      // DeskPanel/the floor plan showing the just-cancelled booking (still
      // "yours", marker still blue) until an unrelated refetch happened to
      // occur.
      qc.invalidateQueries({ queryKey: ['floors'] })
      // A single occurrence of a recurring series is a plain Booking row,
      // cancelled through this same generic endpoint — without this,
      // RecurringBookingsSection's "(N upcoming)" count and its "view all
      // occurrences" dialog (BookingsPage.tsx) keep showing the
      // just-cancelled occurrence as still CONFIRMED. Harmless no-op
      // refetch when the cancelled booking wasn't part of a series.
      qc.invalidateQueries({ queryKey: ['recurring-bookings'] })
    },
    onError: (err: Error) => {
      toast.error(apiErrMsg(err, 'Failed to cancel booking'))
    },
  })
}

export function useUpdateBooking() {
  const qc = useQueryClient()

  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: Partial<{ startsAt: string; endsAt: string; notes: string }> }) =>
      bookingsApi.update(id, body),
    onSuccess: () => {
      toast.success('Booking updated')
      qc.invalidateQueries({ queryKey: ['bookings'] })
      // Same staleness gap as useCancelBooking above — rescheduling frees
      // the old slot and occupies a new one, both of which affect floor
      // availability.
      qc.invalidateQueries({ queryKey: ['floors'] })
    },
    onError: (err: Error) => {
      toast.error(err.message ?? 'Failed to update booking')
    },
  })
}

export function useQueueEntries(includeHistory?: boolean) {
  return useQuery({
    queryKey: ['queue', { history: includeHistory ?? false }],
    queryFn: () => queueApi.list(includeHistory),
    select: (res) => res.data,
    // Position numbers shift as other users join/leave/get promoted, and a
    // PROMOTED entry's claim window can lapse server-side at any moment —
    // neither is driven by anything this client does, so without polling the
    // "you are #N" text and "Claim before X" deadline just go stale until an
    // unrelated mutation happens to invalidate ['queue'].
    refetchInterval: 30 * 1000,
  })
}

export function useJoinQueue() {
  const qc = useQueryClient()

  return useMutation({
    mutationFn: (body: {
      assetId: string
      wantedStartsAt: string
      wantedEndsAt: string
      expiresAt: string
    }) => queueApi.join(body),
    onSuccess: () => {
      toast.success('Joined the queue')
      qc.invalidateQueries({ queryKey: ['queue'] })
    },
    onError: (err: Error) => {
      toast.error(apiErrMsg(err, 'Failed to join queue'))
    },
  })
}

export function useLeaveQueue() {
  const qc = useQueryClient()

  return useMutation({
    mutationFn: (queueEntryId: string) => queueApi.leave(queueEntryId),
    onSuccess: () => {
      toast.success('Left the queue')
      qc.invalidateQueries({ queryKey: ['queue'] })
      qc.invalidateQueries({ queryKey: ['floors'] })
    },
    onError: (err: Error) => {
      toast.error(apiErrMsg(err, 'Failed to leave queue'))
    },
  })
}

export function useClaimDesk() {
  const qc = useQueryClient()

  return useMutation({
    mutationFn: (queueEntryId: string) => queueApi.claim(queueEntryId),
    onSuccess: () => {
      toast.success('Desk claimed! Booking confirmed.')
      qc.invalidateQueries({ queryKey: ['queue'] })
      qc.invalidateQueries({ queryKey: ['bookings'] })
      qc.invalidateQueries({ queryKey: ['floors'] })
    },
    onError: (err: Error) => {
      toast.error(apiErrMsg(err, 'Failed to claim desk'))
    },
  })
}

export function useMakeAvailable() {
  const qc = useQueryClient()

  return useMutation({
    mutationFn: (assetId: string) => assetsApi.makeAvailable(assetId),
    onSuccess: (res) => {
      const { action } = res.data
      if (action === 'none') {
        toast.info('No one is queued for this desk right now.')
      } else if (action === 'auto_confirmed') {
        toast.success('Booking confirmed automatically for the person in queue.')
      } else {
        toast.success('The next person in the queue has been notified and has a limited time to claim the desk.')
      }
      qc.invalidateQueries({ queryKey: ['queue'] })
      qc.invalidateQueries({ queryKey: ['floors'] })
    },
    onError: (err: Error) => {
      toast.error(apiErrMsg(err, 'Failed to make desk available'))
    },
  })
}
