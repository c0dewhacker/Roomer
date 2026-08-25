import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { bookingsApi } from '../lib/api'

export function usePendingBookingApprovals() {
  return useQuery({
    queryKey: ['bookings', 'pending-approvals'],
    queryFn: () => bookingsApi.pendingApprovals(),
    select: (res) => res.data,
  })
}

export function useApproveBooking() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => bookingsApi.approve(id),
    onSuccess: () => {
      toast.success('Booking approved')
      qc.invalidateQueries({ queryKey: ['bookings'] })
    },
    onError: (err: Error) => toast.error(err.message),
  })
}

export function useRejectBooking() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, note }: { id: string; note?: string }) => bookingsApi.reject(id, note),
    onSuccess: () => {
      toast.success('Booking declined')
      qc.invalidateQueries({ queryKey: ['bookings'] })
    },
    onError: (err: Error) => toast.error(err.message),
  })
}
