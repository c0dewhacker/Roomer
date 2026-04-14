import { Package } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { assetsApi } from '@/lib/api'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import type { Asset } from '@/types'

const statusVariant: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  AVAILABLE: 'default',
  ASSIGNED: 'secondary',
  MAINTENANCE: 'outline',
  RETIRED: 'destructive',
}

function AssetCard({ asset }: { asset: Asset }) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <p className="font-medium truncate">{asset.name}</p>
              <Badge variant={statusVariant[asset.status] ?? 'secondary'} className="shrink-0 text-xs">
                {asset.status}
              </Badge>
            </div>
            {asset.category && (
              <p className="text-xs text-muted-foreground mt-1">{asset.category.name}</p>
            )}
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
          <Package className="h-5 w-5 text-muted-foreground shrink-0 mt-0.5" />
        </div>
      </CardContent>
    </Card>
  )
}

export default function AssetsPage() {
  const { data, isLoading } = useQuery({
    queryKey: ['assets', 'my'],
    queryFn: () => assetsApi.list(),
    select: (r) => r.data,
  })

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold">My Assets</h1>
        <p className="text-muted-foreground text-sm mt-1">Equipment and items assigned to you</p>
      </div>

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
          {(data ?? []).map((asset) => (
            <AssetCard key={asset.id} asset={asset} />
          ))}
        </div>
      )}
    </div>
  )
}
