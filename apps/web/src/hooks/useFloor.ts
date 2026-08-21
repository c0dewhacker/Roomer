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
    // A shared asset (an AssetZone secondary membership) appears once per
    // zone it belongs to in the nested response — the floor plan renders one
    // marker per asset at its single x/y, so the flattened list must keep
    // only one entry per asset id. Always keep the primary-zone entry: it's
    // the canonical one (its zoneColour/zoneId match the asset's actual
    // placement), and every placed asset has exactly one.
    select: (res) => {
      const flat = res.data.zones?.flatMap((z) => z.assets) ?? []
      const byId = new Map<string, (typeof flat)[number]>()
      for (const asset of flat) {
        const existing = byId.get(asset.id)
        if (!existing || asset.isPrimaryZone) byId.set(asset.id, asset)
      }
      // Every asset on a floor shares the same building (see #72) — attached
      // per-asset here (rather than returned as a separate top-level value)
      // so DeskPanel, which only receives one `desk` object, can read it
      // directly without a second hook/response to thread through.
      return [...byId.values()].map((asset) => ({ ...asset, resolvedTimezone: res.data.resolvedTimezone }))
    },
    staleTime: 10 * 1000,
  })
}

/** "Suggested for you" — ranked available desks for a date, for the booking flow. */
export function useAssetSuggestions(date: Date) {
  const dateStr = toISODateString(date)
  return useQuery({
    queryKey: ['assets', 'suggestions', dateStr],
    queryFn: () => assetsApi.suggestions(dateStr),
    select: (res) => res.data,
    staleTime: 60 * 1000,
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
    onError: (err: Error) => {
      toast.error(err.message)
    },
  })
}

/** @deprecated Use useUpdateAssetPositions */
export const useUpdateDeskPositions = useUpdateAssetPositions
