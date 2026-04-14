import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { floorsApi, desksApi } from '../lib/api'
import { toISODateString } from '../lib/utils'

export function useFloorData(floorId: string) {
  return useQuery({
    queryKey: ['floors', floorId],
    queryFn: () => floorsApi.get(floorId),
    enabled: !!floorId,
    select: (res) => res.data,
  })
}

export function useFloorAvailability(floorId: string, date: Date) {
  const dateStr = toISODateString(date)
  return useQuery({
    queryKey: ['floors', floorId, 'availability', dateStr],
    queryFn: () => floorsApi.getAvailability(floorId, dateStr),
    enabled: !!floorId,
    select: (res) => res.data.desks,
    staleTime: 10 * 1000,
  })
}

export function useUpdateDeskPositions() {
  const qc = useQueryClient()

  return useMutation({
    mutationFn: (
      positions: Array<{ id: string; x: number; y: number; width: number; height: number; rotation: number }>,
    ) => desksApi.updatePositions(positions),
    onSuccess: (_, _vars, context: { floorId?: string } | undefined) => {
      toast.success('Layout saved')
      if (context?.floorId) {
        qc.invalidateQueries({ queryKey: ['floors', context.floorId] })
      }
    },
    onError: () => {
      toast.error('Failed to save layout')
    },
  })
}
