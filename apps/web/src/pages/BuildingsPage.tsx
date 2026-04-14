import { useNavigate } from 'react-router-dom'
import { Building2, ChevronRight, Layers } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { buildingsApi } from '@/lib/api'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'

export default function BuildingsPage() {
  const navigate = useNavigate()

  const { data: buildings, isLoading } = useQuery({
    queryKey: ['buildings'],
    queryFn: () => buildingsApi.list(),
    select: (r) => r.data,
  })

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Book a Desk</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Select a building to browse available floors and desks.
        </p>
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => <Skeleton key={i} className="h-20" />)}
        </div>
      ) : (buildings ?? []).length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12 text-center">
            <Building2 className="h-12 w-12 text-muted-foreground/30 mb-3" />
            <p className="text-sm text-muted-foreground">No buildings available</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {(buildings ?? []).map((b) => (
            <Card
              key={b.id}
              className="cursor-pointer hover:shadow-md transition-shadow"
              onClick={() => navigate(`/buildings/${b.id}`)}
            >
              <CardContent className="p-4 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                    <Building2 className="h-5 w-5 text-primary" />
                  </div>
                  <div>
                    <p className="font-medium">{b.name}</p>
                    {b.address && (
                      <p className="text-xs text-muted-foreground">{b.address}</p>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2 text-muted-foreground">
                  <Layers className="h-4 w-4" />
                  <ChevronRight className="h-4 w-4" />
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
