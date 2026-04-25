import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { floorsApi, assetsApi } from '../lib/api'
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
    select: (res) => res.data.zones?.flatMap((z) => z.assets) ?? [],
    staleTime: 10 * 1000,
  })
}

export function useUpdateAssetPositions() {
  const qc = useQueryClient()

  return useMutation({
    mutationFn: ({
      positions,
    }: {
      floorId: string
      positions: Array<{ id: string; x: number; y: number; width: number; height: number; rotation: number }>
    }) => assetsApi.updatePositions(positions),
    onSuccess: (_, { floorId }) => {
      toast.success('Layout saved')
      qc.invalidateQueries({ queryKey: ['floors', floorId] })
    },
    onError: () => {
      toast.error('Failed to save layout')
    },
  })
}

/** @deprecated Use useUpdateAssetPositions */
export const useUpdateDeskPositions = useUpdateAssetPositions
