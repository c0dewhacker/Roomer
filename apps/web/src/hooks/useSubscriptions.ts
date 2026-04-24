import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { subscriptionsApi } from '../lib/api'

export function useFloorSubscriptions() {
  return useQuery({
    queryKey: ['subscriptions'],
    queryFn: () => subscriptionsApi.list(),
    select: (res) => res.data,
  })
}

export function useSubscribeToFloor() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: { floorId: string; zoneIds?: string[] }) => subscriptionsApi.create(body),
    onSuccess: () => {
      toast.success('Subscribed to floor notifications')
      qc.invalidateQueries({ queryKey: ['subscriptions'] })
    },
    onError: () => toast.error('Failed to subscribe'),
  })
}

export function useUpdateFloorSubscription() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, zoneIds }: { id: string; zoneIds: string[] }) =>
      subscriptionsApi.update(id, { zoneIds }),
    onSuccess: () => {
      toast.success('Subscription updated')
      qc.invalidateQueries({ queryKey: ['subscriptions'] })
    },
    onError: () => toast.error('Failed to update subscription'),
  })
}

export function useUnsubscribeFromFloor() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => subscriptionsApi.remove(id),
    onSuccess: () => {
      toast.success('Unsubscribed from floor notifications')
      qc.invalidateQueries({ queryKey: ['subscriptions'] })
    },
    onError: () => toast.error('Failed to unsubscribe'),
  })
}
