import { useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { Package, Star, MapPin, CalendarPlus } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { assetsApi, type MyAssignment } from '@/lib/api'
import { useFavourites } from '@/hooks/useFavourites'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { MakeAvailableDialog, WindowRow } from '@/components/AssignedDeskCard'

const statusVariant: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  AVAILABLE: 'default',
  ASSIGNED: 'secondary',
  MAINTENANCE: 'outline',
  RETIRED: 'destructive',
}

function AssignedAssetCard({ assignment }: { assignment: MyAssignment }) {
  const [dialogOpen, setDialogOpen] = useState(false)
  const navigate = useNavigate()

  const { asset } = assignment
  // Only a placed, floor-scoped asset can be shared out — equipment with no
  // floor (a laptop, a monitor) has nowhere on the floor plan for anyone
  // else to find or book it, so "Make available" only makes sense here.
  const isPlacedDesk = !!asset.floor
  const location = [
    asset.floor?.building.name,
    asset.floor?.name,
    asset.primaryZone?.name,
  ].filter(Boolean).join(' › ')

  return (
    <>
      <Card>
        <CardContent className="p-4">
          <div className="flex items-start justify-between gap-3">
            <div
              className={isPlacedDesk ? 'flex-1 min-w-0 cursor-pointer' : 'flex-1 min-w-0'}
              onClick={() => isPlacedDesk && asset.floor?.id && navigate(`/floors/${asset.floor.id}`)}
            >
              <div className="flex items-center gap-2 flex-wrap">
                <p className="font-medium truncate">{asset.name}</p>
                {asset.status && (
                  <Badge variant={statusVariant[asset.status] ?? 'secondary'} className="shrink-0 text-xs">
                    {asset.status}
                  </Badge>
                )}
                {assignment.isPrimary && (
                  <Badge variant="outline" className="shrink-0 text-xs">Primary</Badge>
                )}
              </div>
              {location && (
                <p className="text-xs text-muted-foreground flex items-center gap-1 mt-1">
                  <MapPin className="h-3 w-3 shrink-0" />
                  {location}
                </p>
              )}
              <p className="text-xs text-muted-foreground mt-0.5">{asset.category.name}</p>
              <div className="flex flex-wrap gap-x-4 gap-y-0.5 mt-1.5">
                {asset.serialNumber && (
                  <p className="text-xs text-muted-foreground">
                    <span className="font-medium">Serial:</span> {asset.serialNumber}
                  </p>
                )}
                {asset.assetTag && (
                  <p className="text-xs text-muted-foreground">
                    <span className="font-medium">Tag:</span> {asset.assetTag}
                  </p>
                )}
              </div>
              {asset.description && (
                <p className="text-xs text-muted-foreground mt-1 italic">{asset.description}</p>
              )}
            </div>

            {isPlacedDesk && (
              <Button
                size="sm"
                variant="outline"
                className="shrink-0 h-8 text-xs gap-1.5"
                onClick={() => setDialogOpen(true)}
              >
                <CalendarPlus className="h-3.5 w-3.5" />
                Make available
              </Button>
            )}
          </div>

          {asset.availabilityWindows.length > 0 && (
            <div className="mt-3 space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground">Shared periods</p>
              {asset.availabilityWindows.map((w) => (
                <WindowRow key={w.id} assetId={asset.id} window={w} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {isPlacedDesk && dialogOpen && (
        <MakeAvailableDialog assignment={assignment} open={dialogOpen} onClose={() => setDialogOpen(false)} />
      )}
    </>
  )
}

function FavouritesSection() {
  const { favourites, isLoading, toggleFavourite, isToggling } = useFavourites()

  if (isLoading || favourites.length === 0) return null

  return (
    <div className="mb-8">
      <div className="mb-3 flex items-center gap-2">
        <Star className="h-4 w-4 fill-amber-400 text-amber-500" />
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">My favourites</h2>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {favourites.map((asset) => (
          <Card key={asset.id}>
            <CardContent className="p-4 flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <p className="font-medium truncate">{asset.bookingLabel || asset.name}</p>
                {(asset.floor?.building?.name || asset.floor?.name) && (
                  <p className="mt-1 flex items-center gap-1 text-xs text-muted-foreground truncate">
                    <MapPin className="h-3 w-3 shrink-0" />
                    {[asset.floor?.building?.name, asset.floor?.name].filter(Boolean).join(' › ')}
                  </p>
                )}
                {asset.floor?.id && (
                  <Link to={`/floors/${asset.floor.id}`} className="mt-2 inline-block text-xs font-medium text-primary hover:underline">
                    Book on floor plan →
                  </Link>
                )}
              </div>
              <button
                type="button"
                onClick={() => toggleFavourite(asset.id)}
                disabled={isToggling}
                title="Remove from favourites"
                className="rounded-md p-1 text-amber-500 transition-colors hover:text-amber-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Star className="h-4 w-4 fill-amber-400" />
              </button>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  )
}

export default function AssetsPage() {
  const { data, isLoading } = useQuery({
    queryKey: ['assets', 'my'],
    // getMyAssignments (not list({mine:true})) — the same assetUserAssignment
    // query, but with floor/primaryZone/availabilityWindows included, so
    // permanently-assigned desks get a location and a "Make available"
    // action here, matching what the Bookings page's assigned-desk section
    // already shows for the identical underlying data.
    queryFn: () => assetsApi.getMyAssignments(),
    select: (r) => r.data,
  })

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold">My Assets</h1>
        <p className="text-muted-foreground text-sm mt-1">Equipment and items assigned to you</p>
      </div>

      <FavouritesSection />

      {isLoading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => <Skeleton key={i} className="h-24 w-full" />)}
        </div>
      ) : (data ?? []).length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <Package className="h-12 w-12 text-muted-foreground/30 mb-3" />
          <p className="text-sm text-muted-foreground">No assets assigned to you</p>
        </div>
      ) : (
        <div className="space-y-3">
          {(data ?? []).map((a) => (
            <AssignedAssetCard key={a.assetId} assignment={a} />
          ))}
        </div>
      )}
    </div>
  )
}
