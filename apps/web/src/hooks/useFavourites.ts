import { useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { assetsApi } from '@/lib/api'

const FAVOURITES_KEY = ['assets', 'favourites']

/**
 * Loads the current user's favourite assets and exposes a toggle.
 * Shared between the booking flow (star on the desk panel) and the
 * "My favourites" section on the assets page.
 */
export function useFavourites() {
  const qc = useQueryClient()

  const { data: favourites = [], isLoading } = useQuery({
    queryKey: FAVOURITES_KEY,
    queryFn: () => assetsApi.listFavourites(),
    select: (r) => r.data,
  })

  const favouriteIds = useMemo(() => new Set(favourites.map((a) => a.id)), [favourites])

  const toggle = useMutation({
    mutationFn: ({ id, next }: { id: string; next: boolean }) =>
      next ? assetsApi.addFavourite(id) : assetsApi.removeFavourite(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: FAVOURITES_KEY }),
    onError: (err: Error) => toast.error(err.message),
  })

  return {
    favourites,
    isLoading,
    isFavourite: (id: string) => favouriteIds.has(id),
    toggleFavourite: (id: string) => toggle.mutate({ id, next: !favouriteIds.has(id) }),
    isToggling: toggle.isPending,
  }
}
