import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { bookingsApi } from '../lib/api'

export function usePendingBookingApprovals() {
  return useQuery({
    queryKey: ['bookings', 'pending-approvals'],
    queryFn: () => bookingsApi.pendingApprovals(),
    select: (res) => res.data,
    // Another admin/floor-manager with access to the same booking can
    // approve/reject it from their own session at any moment, and the
    // auto-reject-pending-approvals cron sweeps every 15 minutes — neither
    // is driven by this client, so without polling a resolved request's
    // Approve/Decline buttons stayed live here until an unrelated
    // invalidation happened to catch up. Same convention as queue/ballots/
    // transfer-swap.
    refetchInterval: 30_000,
  })
}

export function useApproveBooking() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => bookingsApi.approve(id),
    onSuccess: () => {
      toast.success('Booking approved')
      qc.invalidateQueries({ queryKey: ['bookings'] })
      // useFloorAvailability derives 'mine_pending' vs 'mine' from the
      // booking's status — without this, DeskPanel/the floor plan kept
      // showing the requester's desk as "Awaiting approval" after the
      // admin approved it, same missing-sibling-invalidation bug already
      // fixed in useBookings.ts's cancel/reschedule mutations.
      qc.invalidateQueries({ queryKey: ['floors'] })
    },
    onError: (err: Error) => {
      toast.error(err.message)
      // A 409 here almost always means the row was already stale (someone
      // else actioned it, or the auto-reject cron beat us to it) — without
      // this, the failed card just sits there with the same live buttons,
      // so retrying gets the identical error again instead of the list
      // correcting itself.
      qc.invalidateQueries({ queryKey: ['bookings'] })
    },
  })
}

export function useRejectBooking() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, note }: { id: string; note?: string }) => bookingsApi.reject(id, note),
    onSuccess: () => {
      toast.success('Booking declined')
      qc.invalidateQueries({ queryKey: ['bookings'] })
      qc.invalidateQueries({ queryKey: ['floors'] })
    },
    onError: (err: Error) => {
      toast.error(err.message)
      qc.invalidateQueries({ queryKey: ['bookings'] })
    },
  })
}
