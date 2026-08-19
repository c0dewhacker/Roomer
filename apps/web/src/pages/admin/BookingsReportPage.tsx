import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavConfig } from '@/hooks/useNavConfig'
import { bookingsApi, buildingsApi } from '@/lib/api'
import { downloadCsv } from '@/lib/csv'
import { formatDate, formatDateRange } from '@/lib/utils'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Download, FileSpreadsheet } from 'lucide-react'
import type { Booking } from '@/types'

const statusVariant: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  CONFIRMED: 'default',
  CANCELLED: 'destructive',
  COMPLETED: 'secondary',
}

const PAGE_SIZE = 20
const EXPORT_PAGE_SIZE = 100 // matches the backend's max — export loops pages at this size

interface Filters {
  from: string
  to: string
  buildingId: string
  floorId: string
  status: '' | 'CONFIRMED' | 'CANCELLED' | 'COMPLETED'
}

function bookingCsvRow(b: Booking): string[] {
  const asset = b.asset ?? b.desk
  return [
    b.id,
    b.user?.displayName ?? '',
    b.user?.email ?? '',
    asset?.name ?? '',
    asset?.floor?.building?.name ?? '',
    asset?.floor?.name ?? '',
    asset?.primaryZone?.name ?? '',
    b.startsAt,
    b.endsAt,
    b.status,
    b.checkedInAt ?? '',
    b.notes ?? '',
  ]
}

const CSV_HEADER = [
  'Booking ID', 'User', 'Email', 'Asset', 'Building', 'Floor', 'Zone',
  'Starts At', 'Ends At', 'Status', 'Checked In At', 'Notes',
]

export default function BookingsReportPage() {
  const { isSuperAdmin, managedBuildings } = useNavConfig()
  const [page, setPage] = useState(1)
  const [filters, setFilters] = useState<Filters>({ from: '', to: '', buildingId: '', floorId: '', status: '' })
  const [exporting, setExporting] = useState(false)

  // Same reasoning as ReportsAdminPage's building picker: GET /buildings
  // returns a broader set for non-admins (open/unrestricted buildings, not
  // just ones this user administers) than this report can actually filter
  // by — the backend only ever authorizes non-super-admins against their
  // managed set.
  const { data: allBuildings } = useQuery({
    queryKey: ['buildings'],
    queryFn: () => buildingsApi.list(),
    select: (r) => r.data,
    enabled: isSuperAdmin,
  })
  const buildings = isSuperAdmin ? allBuildings : managedBuildings

  const { data: buildingDetail } = useQuery({
    queryKey: ['buildings', filters.buildingId],
    queryFn: () => buildingsApi.get(filters.buildingId),
    select: (r) => r.data,
    enabled: !!filters.buildingId,
  })
  const floors = buildingDetail?.floors ?? []

  const queryParams = {
    from: filters.from ? new Date(filters.from + 'T00:00:00.000Z').toISOString() : undefined,
    to: filters.to ? new Date(filters.to + 'T23:59:59.999Z').toISOString() : undefined,
    buildingId: filters.buildingId || undefined,
    floorId: filters.floorId || undefined,
    status: filters.status || undefined,
  }

  const { data: reportRes, isLoading } = useQuery({
    queryKey: ['bookings-report', queryParams, page],
    queryFn: () => bookingsApi.report({ ...queryParams, page, limit: PAGE_SIZE }),
  })
  const bookings = reportRes?.data ?? []
  const meta = reportRes?.meta

  function updateFilter<K extends keyof Filters>(key: K, value: Filters[K]) {
    setFilters((prev) => {
      const next = { ...prev, [key]: value }
      if (key === 'buildingId') next.floorId = '' // floor list depends on building
      return next
    })
    setPage(1)
  }

  async function handleExportAll() {
    setExporting(true)
    try {
      const rows: string[][] = [CSV_HEADER]
      let exportPage = 1
      let totalPages = 1
      do {
        const res = await bookingsApi.report({ ...queryParams, page: exportPage, limit: EXPORT_PAGE_SIZE })
        totalPages = res.meta.totalPages
        rows.push(...res.data.map(bookingCsvRow))
        exportPage++
      } while (exportPage <= totalPages)
      downloadCsv(`bookings-report-${formatDate(new Date())}.csv`, rows)
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <FileSpreadsheet className="h-6 w-6 text-primary" />
            Bookings Report
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            Raw booking-level data for export to spreadsheets or BI tools.
            {meta && ` ${meta.total} matching booking${meta.total === 1 ? '' : 's'}.`}
          </p>
        </div>
        <Button variant="outline" size="sm" className="gap-1.5" onClick={handleExportAll} disabled={exporting || isLoading}>
          <Download className="h-3.5 w-3.5" />
          {exporting ? 'Exporting…' : 'Export CSV'}
        </Button>
      </div>

      <Card>
        <CardContent className="p-4">
          <div className="flex flex-wrap items-end gap-4">
            <div>
              <Label className="text-xs text-muted-foreground mb-1.5 block">From</Label>
              <Input type="date" value={filters.from} max={filters.to || undefined} onChange={(e) => updateFilter('from', e.target.value)} className="h-8 w-36 text-sm" />
            </div>
            <div>
              <Label className="text-xs text-muted-foreground mb-1.5 block">To</Label>
              <Input type="date" value={filters.to} min={filters.from || undefined} onChange={(e) => updateFilter('to', e.target.value)} className="h-8 w-36 text-sm" />
            </div>
            {buildings && buildings.length > 1 && (
              <div>
                <Label className="text-xs text-muted-foreground mb-1.5 block">Building</Label>
                <select
                  value={filters.buildingId}
                  onChange={(e) => updateFilter('buildingId', e.target.value)}
                  className="h-8 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <option value="">All buildings</option>
                  {buildings.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                </select>
              </div>
            )}
            {filters.buildingId && floors.length > 0 && (
              <div>
                <Label className="text-xs text-muted-foreground mb-1.5 block">Floor</Label>
                <select
                  value={filters.floorId}
                  onChange={(e) => updateFilter('floorId', e.target.value)}
                  className="h-8 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <option value="">All floors</option>
                  {floors.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
                </select>
              </div>
            )}
            <div>
              <Label className="text-xs text-muted-foreground mb-1.5 block">Status</Label>
              <select
                value={filters.status}
                onChange={(e) => updateFilter('status', e.target.value as Filters['status'])}
                className="h-8 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <option value="">All statuses</option>
                <option value="CONFIRMED">Confirmed</option>
                <option value="CANCELLED">Cancelled</option>
                <option value="COMPLETED">Completed</option>
              </select>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-6 space-y-2">{[1, 2, 3, 4, 5].map((i) => <Skeleton key={i} className="h-9 w-full" />)}</div>
          ) : bookings.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <FileSpreadsheet className="h-10 w-10 text-muted-foreground/30 mb-3" />
              <p className="text-sm text-muted-foreground">No bookings match these filters.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/40">
                    <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">User</th>
                    <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">Asset</th>
                    <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">Location</th>
                    <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">When</th>
                    <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {bookings.map((b) => {
                    const asset = b.asset ?? b.desk
                    return (
                      <tr key={b.id} className="hover:bg-muted/30 transition-colors">
                        <td className="px-4 py-2.5">
                          <div className="font-medium">{b.user?.displayName ?? 'Unknown'}</div>
                          <div className="text-xs text-muted-foreground">{b.user?.email}</div>
                        </td>
                        <td className="px-4 py-2.5">{asset?.name ?? 'Unknown'}</td>
                        <td className="px-4 py-2.5 text-muted-foreground">
                          {[asset?.floor?.building?.name, asset?.floor?.name].filter(Boolean).join(' › ')}
                        </td>
                        <td className="px-4 py-2.5 text-muted-foreground">{formatDateRange(b.startsAt, b.endsAt)}</td>
                        <td className="px-4 py-2.5">
                          <Badge variant={statusVariant[b.status] ?? 'secondary'} className="text-xs">{b.status}</Badge>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {meta && meta.totalPages > 1 && (
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>Page {meta.page} of {meta.totalPages}</span>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</Button>
            <Button variant="outline" size="sm" disabled={page >= meta.totalPages} onClick={() => setPage((p) => p + 1)}>Next</Button>
          </div>
        </div>
      )}
    </div>
  )
}
