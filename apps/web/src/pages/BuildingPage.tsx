import { useParams, useNavigate, Link } from 'react-router-dom'
import { Layers, ChevronRight, MapPin } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { buildingsApi } from '@/lib/api'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'

export default function BuildingPage() {
  const { buildingId } = useParams<{ buildingId: string }>()
  const navigate = useNavigate()

  const { data: building, isLoading } = useQuery({
    queryKey: ['buildings', buildingId],
    queryFn: () => buildingsApi.get(buildingId!),
    select: (r) => r.data,
    enabled: !!buildingId,
  })

  const floors = (building?.floors ?? []) as Array<{
    id: string
    name: string
    level: number
    floorPlan?: { id: string } | null
    _count?: { zones: number }
  }>

  return (
    <div className="p-6 max-w-4xl mx-auto">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-sm text-muted-foreground mb-6">
        <Link to="/buildings" className="hover:text-foreground transition-colors">
          Buildings
        </Link>
        <ChevronRight className="h-3.5 w-3.5" />
        {isLoading ? (
          <Skeleton className="h-4 w-32" />
        ) : (
          <span className="text-foreground font-medium">{building?.name}</span>
        )}
      </div>

      <div className="mb-6">
        {isLoading ? (
          <Skeleton className="h-8 w-48" />
        ) : (
          <>
            <h1 className="text-2xl font-bold">{building?.name}</h1>
            {building?.address && (
              <p className="text-sm text-muted-foreground mt-1 flex items-center gap-1.5">
                <MapPin className="h-3.5 w-3.5" />
                {building.address}
              </p>
            )}
          </>
        )}
      </div>

      <p className="text-sm text-muted-foreground mb-4">
        Select a floor to view the desk map and make a booking.
      </p>

      {isLoading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => <Skeleton key={i} className="h-20" />)}
        </div>
      ) : floors.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12 text-center">
            <Layers className="h-12 w-12 text-muted-foreground/30 mb-3" />
            <p className="text-sm text-muted-foreground">No floors configured for this building</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {floors
            .slice()
            .sort((a, b) => a.level - b.level)
            .map((floor) => (
              <Card
                key={floor.id}
                className="cursor-pointer hover:shadow-md transition-shadow"
                onClick={() => navigate(`/floors/${floor.id}`)}
              >
                <CardContent className="p-4 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="h-10 w-10 rounded-lg bg-muted flex items-center justify-center shrink-0">
                      <Layers className="h-5 w-5 text-muted-foreground" />
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <p className="font-medium">{floor.name}</p>
                        <Badge variant="outline" className="text-xs">
                          Level {floor.level}
                        </Badge>
                        {floor.floorPlan && (
                          <Badge variant="secondary" className="text-xs">
                            Map available
                          </Badge>
                        )}
                      </div>
                      {floor._count && (
                        <p className="text-xs text-muted-foreground mt-0.5">
                          {floor._count.zones} zone{floor._count.zones !== 1 ? 's' : ''}
                        </p>
                      )}
                    </div>
                  </div>
                  <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                </CardContent>
              </Card>
            ))}
        </div>
      )}
    </div>
  )
}
