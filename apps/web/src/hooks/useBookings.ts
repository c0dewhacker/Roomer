import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { bookingsApi, queueApi, ApiError } from '../lib/api'

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
  })
}

export function useCreateBooking() {
  const qc = useQueryClient()

  return useMutation({
    mutationFn: (body: { assetId: string; startsAt: string; endsAt: string; notes?: string }) =>
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
    },
    onError: () => {
      toast.error('Failed to cancel booking')
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
    },
    onError: (err: Error) => {
      toast.error(err.message ?? 'Failed to update booking')
    },
  })
}

export function useQueueEntries() {
  return useQuery({
    queryKey: ['queue'],
    queryFn: () => queueApi.list(),
    select: (res) => res.data,
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
    onError: () => {
      toast.error('Failed to join queue')
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
    },
    onError: () => {
      toast.error('Failed to leave queue')
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
    },
    onError: () => {
      toast.error('Failed to claim desk')
    },
  })
}
