import { Fragment, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { auditLogApi } from '@/lib/api'
import { downloadCsv } from '@/lib/csv'
import { formatDate, formatDateTime } from '@/lib/utils'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Download, History, ChevronDown, ChevronRight } from 'lucide-react'
import type { AuditLogEntry } from '@/types'

const PAGE_SIZE = 20
const EXPORT_PAGE_SIZE = 100 // matches the backend's max — export loops pages at this size

interface Filters {
  from: string
  to: string
  resourceType: string
  resourceId: string
  action: string
}

function auditCsvRow(e: AuditLogEntry): string[] {
  return [
    e.createdAt,
    e.actor?.displayName ?? 'System',
    e.actor?.email ?? '',
    e.action,
    e.resourceType,
    e.resourceId,
    e.ipAddress ?? '',
    e.before ? JSON.stringify(e.before) : '',
    e.after ? JSON.stringify(e.after) : '',
  ]
}

const CSV_HEADER = [
  'Timestamp', 'Actor', 'Actor Email', 'Action', 'Resource Type', 'Resource ID', 'IP Address', 'Before', 'After',
]

export default function AuditLogAdminPage() {
  const [page, setPage] = useState(1)
  const [filters, setFilters] = useState<Filters>({ from: '', to: '', resourceType: '', resourceId: '', action: '' })
  const [exporting, setExporting] = useState(false)
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const queryParams = {
    from: filters.from ? new Date(filters.from + 'T00:00:00.000Z').toISOString() : undefined,
    to: filters.to ? new Date(filters.to + 'T23:59:59.999Z').toISOString() : undefined,
    resourceType: filters.resourceType || undefined,
    resourceId: filters.resourceId || undefined,
    action: filters.action || undefined,
  }

  const { data: listRes, isLoading } = useQuery({
    queryKey: ['audit-log', queryParams, page],
    queryFn: () => auditLogApi.list({ ...queryParams, page, limit: PAGE_SIZE }),
  })
  const entries = listRes?.data ?? []
  const meta = listRes?.meta

  function updateFilter<K extends keyof Filters>(key: K, value: Filters[K]) {
    setFilters((prev) => ({ ...prev, [key]: value }))
    setPage(1)
  }

  async function handleExportAll() {
    setExporting(true)
    try {
      const rows: string[][] = [CSV_HEADER]
      let exportPage = 1
      let totalPages = 1
      do {
        const res = await auditLogApi.list({ ...queryParams, page: exportPage, limit: EXPORT_PAGE_SIZE })
        totalPages = res.meta.totalPages
        rows.push(...res.data.map(auditCsvRow))
        exportPage++
      } while (exportPage <= totalPages)
      downloadCsv(`audit-log-${formatDate(new Date())}.csv`, rows)
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <History className="h-6 w-6 text-primary" />
            Audit Log
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            A record of who changed what, when.
            {meta && ` ${meta.total} matching entr${meta.total === 1 ? 'y' : 'ies'}.`}
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
            <div>
              <Label className="text-xs text-muted-foreground mb-1.5 block">Resource type</Label>
              <Input placeholder="e.g. Asset" value={filters.resourceType} onChange={(e) => updateFilter('resourceType', e.target.value)} className="h-8 w-32 text-sm" />
            </div>
            <div>
              <Label className="text-xs text-muted-foreground mb-1.5 block">Resource ID</Label>
              <Input placeholder="Resource ID" value={filters.resourceId} onChange={(e) => updateFilter('resourceId', e.target.value)} className="h-8 w-40 text-sm" />
            </div>
            <div>
              <Label className="text-xs text-muted-foreground mb-1.5 block">Action</Label>
              <Input placeholder="e.g. asset.updated" value={filters.action} onChange={(e) => updateFilter('action', e.target.value)} className="h-8 w-40 text-sm" />
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-6 space-y-2">{[1, 2, 3, 4, 5].map((i) => <Skeleton key={i} className="h-9 w-full" />)}</div>
          ) : entries.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <History className="h-10 w-10 text-muted-foreground/30 mb-3" />
              <p className="text-sm text-muted-foreground">No audit entries match these filters.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/40">
                    <th className="w-8" />
                    <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">When</th>
                    <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">Actor</th>
                    <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">Action</th>
                    <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">Resource</th>
                    <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">IP</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {entries.map((e) => {
                    const isExpanded = expandedId === e.id
                    return (
                      <Fragment key={e.id}>
                        <tr
                          className="hover:bg-muted/30 transition-colors cursor-pointer"
                          onClick={() => setExpandedId(isExpanded ? null : e.id)}
                        >
                          <td className="pl-4">
                            {isExpanded ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />}
                          </td>
                          <td className="px-4 py-2.5 text-muted-foreground whitespace-nowrap">{formatDateTime(e.createdAt)}</td>
                          <td className="px-4 py-2.5">
                            <div className="font-medium">{e.actor?.displayName ?? 'System'}</div>
                            {e.actor?.email && <div className="text-xs text-muted-foreground">{e.actor.email}</div>}
                          </td>
                          <td className="px-4 py-2.5 font-mono text-xs">{e.action}</td>
                          <td className="px-4 py-2.5 text-muted-foreground">
                            {e.resourceType} <span className="text-xs">({e.resourceId})</span>
                          </td>
                          <td className="px-4 py-2.5 text-muted-foreground text-xs">{e.ipAddress ?? '—'}</td>
                        </tr>
                        {isExpanded && (
                          <tr className="bg-muted/20">
                            <td />
                            <td colSpan={5} className="px-4 py-3">
                              <div className="grid grid-cols-2 gap-4">
                                <div>
                                  <div className="text-xs font-medium text-muted-foreground mb-1">Before</div>
                                  <pre className="text-xs bg-background rounded border p-2 overflow-x-auto max-h-64 overflow-y-auto">
                                    {e.before ? JSON.stringify(e.before, null, 2) : 'null'}
                                  </pre>
                                </div>
                                <div>
                                  <div className="text-xs font-medium text-muted-foreground mb-1">After</div>
                                  <pre className="text-xs bg-background rounded border p-2 overflow-x-auto max-h-64 overflow-y-auto">
                                    {e.after ? JSON.stringify(e.after, null, 2) : 'null'}
                                  </pre>
                                </div>
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
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
