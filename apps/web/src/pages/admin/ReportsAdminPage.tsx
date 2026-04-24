import { useState, useMemo } from 'react'
import { subDays, format, parseISO } from 'date-fns'
import { formatDate } from '@/lib/utils'
import { useQuery } from '@tanstack/react-query'
import {
  analyticsApi,
  buildingsApi,
  type AnalyticsParams,
  type StatusBreakdownPoint,
  type PeakDayPoint,
  type FloorUtilisationPoint,
} from '@/lib/api'
import type { UtilisationDataPoint, BookingDataPoint, TopUserDataPoint } from '@/types'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Download, Users,
  BarChart3, Clock, CheckCircle2, XCircle, Layers, UserCheck,
} from 'lucide-react'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, AreaChart, Area,
} from 'recharts'

// ─── CSV Export ───────────────────────────────────────────────────────────────

function downloadCsv(filename: string, rows: string[][]) {
  const csv = rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n')
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

// ─── Date Range ───────────────────────────────────────────────────────────────

type Preset = 7 | 30 | 90 | 'custom'

function useDateRange(preset: Preset, customFrom: string, customTo: string) {
  return useMemo(() => {
    if (preset === 'custom') {
      return { startDate: customFrom, endDate: customTo }
    }
    return {
      startDate: format(subDays(new Date(), preset), 'yyyy-MM-dd'),
      endDate: format(new Date(), 'yyyy-MM-dd'),
    }
  }, [preset, customFrom, customTo])
}

// ─── KPI Cards ────────────────────────────────────────────────────────────────

const PALETTE = {
  primary: 'hsl(var(--primary))',
  green: '#22c55e',
  amber: '#f59e0b',
  red: '#ef4444',
  blue: '#3b82f6',
  violet: '#8b5cf6',
  slate: '#64748b',
}

const PIE_COLOURS = [PALETTE.primary, PALETTE.green, PALETTE.red]

function KpiCard({
  label,
  value,
  sub,
  icon: Icon,
  colour = 'default',
  loading,
}: {
  label: string
  value: string | number
  sub?: string
  icon: React.ElementType
  colour?: 'default' | 'green' | 'amber' | 'red'
  loading?: boolean
}) {
  const iconColour = {
    default: 'text-primary bg-primary/10',
    green: 'text-green-600 bg-green-50',
    amber: 'text-amber-600 bg-amber-50',
    red: 'text-red-600 bg-red-50',
  }[colour]

  return (
    <Card>
      <CardContent className="p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{label}</p>
            {loading ? (
              <Skeleton className="h-7 w-20 mt-1.5" />
            ) : (
              <p className="text-2xl font-bold mt-1 tabular-nums">{value}</p>
            )}
            {sub && !loading && <p className="text-xs text-muted-foreground mt-0.5">{sub}</p>}
          </div>
          <div className={`rounded-lg p-2.5 shrink-0 ${iconColour}`}>
            <Icon className="h-4 w-4" />
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

function SummaryCards({ params }: { params: AnalyticsParams }) {
  const { data, isLoading } = useQuery({
    queryKey: ['analytics', 'summary', params],
    queryFn: () => analyticsApi.summary(params),
    select: (r) => r.data,
  })

  const cancellationColour = !data ? 'default' : data.cancellationRate > 20 ? 'red' : data.cancellationRate > 10 ? 'amber' : 'green'
  const utilisationColour = !data ? 'default' : data.overallUtilisationPct > 70 ? 'green' : data.overallUtilisationPct > 40 ? 'default' : 'amber'

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-7 gap-4">
      <KpiCard label="Confirmed Bookings" value={data?.totalBookings ?? '—'} sub={`over ${data?.workingDays ?? '…'} working days`} icon={CheckCircle2} loading={isLoading} colour="green" />
      <KpiCard label="Avg / Day" value={data?.avgDailyBookings ?? '—'} sub="confirmed bookings" icon={BarChart3} loading={isLoading} />
      <KpiCard label="Unique Bookers" value={data?.uniqueBookers ?? '—'} sub="distinct users" icon={Users} loading={isLoading} />
      <KpiCard label="Cancellation Rate" value={data ? `${data.cancellationRate}%` : '—'} sub={`${data?.cancelledBookings ?? '…'} cancelled`} icon={XCircle} loading={isLoading} colour={cancellationColour} />
      <KpiCard label="Desk Utilisation" value={data ? `${data.overallUtilisationPct}%` : '—'} sub={`${data?.bookableDesks ?? '…'} bookable desks`} icon={Layers} loading={isLoading} colour={utilisationColour} />
      <KpiCard label="Assigned Desks" value={data?.assignedDesks ?? '—'} sub={`${data?.disabledDesks ?? '…'} disabled`} icon={UserCheck} loading={isLoading} colour="default" />
      <KpiCard label="Queue Depth" value={data?.queueDepth ?? '—'} sub="currently waiting" icon={Clock} loading={isLoading} colour={data?.queueDepth && data.queueDepth > 10 ? 'amber' : 'default'} />
    </div>
  )
}

// ─── Chart Helpers ────────────────────────────────────────────────────────────

function ChartSkeleton({ h = 256 }: { h?: number }) {
  return <Skeleton style={{ height: h }} className="w-full rounded-lg" />
}

function ExportBtn({ onClick }: { onClick: () => void }) {
  return (
    <Button variant="ghost" size="sm" className="h-7 gap-1 text-xs shrink-0" onClick={onClick}>
      <Download className="h-3.5 w-3.5" />
      CSV
    </Button>
  )
}

function EmptyState({ message = 'No data available' }: { message?: string }) {
  return (
    <div className="h-64 flex flex-col items-center justify-center text-sm text-muted-foreground gap-2">
      <BarChart3 className="h-8 w-8 opacity-20" />
      {message}
    </div>
  )
}

// ─── Booking Activity (area chart) ───────────────────────────────────────────

function BookingActivityChart({ params }: { params: AnalyticsParams }) {
  const { data, isLoading } = useQuery({
    queryKey: ['analytics', 'bookings', params],
    queryFn: () => analyticsApi.bookings(params),
    select: (r) => r.data,
  })

  return (
    <Card className="col-span-2">
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <div>
          <CardTitle className="text-base">Booking Activity</CardTitle>
          <CardDescription className="text-xs">Confirmed bookings per day</CardDescription>
        </div>
        {data && data.length > 0 && (
          <ExportBtn onClick={() => downloadCsv('booking-activity.csv', [
            ['Date', 'Bookings'],
            ...(data as BookingDataPoint[]).map((d) => [d.date, String(d.count)]),
          ])} />
        )}
      </CardHeader>
      <CardContent>
        {isLoading ? <ChartSkeleton /> : !data || data.length === 0 ? <EmptyState /> : (
          <ResponsiveContainer width="100%" height={256}>
            <AreaChart data={data} margin={{ top: 4, right: 16, left: 0, bottom: 4 }}>
              <defs>
                <linearGradient id="bookingGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={PALETTE.primary} stopOpacity={0.25} />
                  <stop offset="95%" stopColor={PALETTE.primary} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis dataKey="date" tick={{ fontSize: 11 }} tickFormatter={(v) => { try { return format(parseISO(v), 'MMM d') } catch { return v } }} />
              <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
              <Tooltip labelFormatter={(v) => { try { return format(parseISO(v as string), 'PP') } catch { return v } }} formatter={(v) => [v, 'Bookings']} />
              <Area type="monotone" dataKey="count" name="Bookings" stroke={PALETTE.primary} fill="url(#bookingGrad)" strokeWidth={2} dot={false} />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </CardContent>
    </Card>
  )
}

// ─── Booking Status Breakdown (donut) ─────────────────────────────────────────

function StatusBreakdownChart({ params }: { params: AnalyticsParams }) {
  const { data, isLoading } = useQuery({
    queryKey: ['analytics', 'status-breakdown', params],
    queryFn: () => analyticsApi.statusBreakdown(params),
    select: (r) => r.data,
  })

  const total = data?.reduce((s, d) => s + d.count, 0) ?? 0

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <div>
          <CardTitle className="text-base">Booking Status</CardTitle>
          <CardDescription className="text-xs">Confirmed vs cancelled vs completed</CardDescription>
        </div>
        {data && total > 0 && (
          <ExportBtn onClick={() => downloadCsv('booking-status.csv', [
            ['Status', 'Count'],
            ...(data as StatusBreakdownPoint[]).map((d) => [d.label, String(d.count)]),
          ])} />
        )}
      </CardHeader>
      <CardContent>
        {isLoading ? <ChartSkeleton /> : !data || total === 0 ? <EmptyState /> : (
          <div className="flex flex-col items-center gap-4">
            <ResponsiveContainer width="100%" height={180}>
              <PieChart>
                <Pie data={data} dataKey="count" nameKey="label" cx="50%" cy="50%" innerRadius={52} outerRadius={80} paddingAngle={3}>
                  {data.map((_, i) => <Cell key={i} fill={PIE_COLOURS[i % PIE_COLOURS.length]} />)}
                </Pie>
                <Tooltip formatter={(v, n) => [v, n]} />
              </PieChart>
            </ResponsiveContainer>
            <div className="flex flex-wrap justify-center gap-3">
              {data.map((d, i) => (
                <div key={d.status} className="flex items-center gap-1.5 text-xs">
                  <span className="h-2.5 w-2.5 rounded-full shrink-0" style={{ background: PIE_COLOURS[i % PIE_COLOURS.length] }} />
                  <span className="text-muted-foreground">{d.label}</span>
                  <span className="font-semibold">{d.count}</span>
                  <span className="text-muted-foreground">({total > 0 ? Math.round(d.count / total * 100) : 0}%)</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// ─── Peak Days (bar chart) ────────────────────────────────────────────────────

function PeakDaysChart({ params }: { params: AnalyticsParams }) {
  const { data, isLoading } = useQuery({
    queryKey: ['analytics', 'peak-days', params],
    queryFn: () => analyticsApi.peakDays(params),
    select: (r) => r.data,
  })

  const peak = data ? Math.max(...data.map((d) => d.count)) : 0

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <div>
          <CardTitle className="text-base">Peak Days</CardTitle>
          <CardDescription className="text-xs">Bookings by day of week</CardDescription>
        </div>
        {data && peak > 0 && (
          <ExportBtn onClick={() => downloadCsv('peak-days.csv', [
            ['Day', 'Bookings'],
            ...(data as PeakDayPoint[]).map((d) => [d.dayName, String(d.count)]),
          ])} />
        )}
      </CardHeader>
      <CardContent>
        {isLoading ? <ChartSkeleton /> : !data || peak === 0 ? <EmptyState /> : (
          <ResponsiveContainer width="100%" height={256}>
            <BarChart data={data} margin={{ top: 4, right: 16, left: 0, bottom: 4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis dataKey="dayName" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
              <Tooltip formatter={(v) => [v, 'Bookings']} />
              <Bar dataKey="count" name="Bookings" radius={[4, 4, 0, 0]}>
                {data.map((d, i) => (
                  <Cell key={i} fill={d.count === peak ? PALETTE.primary : 'hsl(var(--primary) / 0.35)'} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        )}
      </CardContent>
    </Card>
  )
}

// ─── Floor Utilisation (horizontal bar) ───────────────────────────────────────

function FloorUtilisationChart({ params }: { params: AnalyticsParams }) {
  const { data, isLoading } = useQuery({
    queryKey: ['analytics', 'floor-utilisation', params],
    queryFn: () => analyticsApi.floorUtilisation(params),
    select: (r) => r.data,
  })

  const chartData = data?.map((d) => ({
    ...d,
    label: `${d.buildingName} › ${d.floorName}`,
  })) ?? []

  return (
    <Card className="col-span-2">
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <div>
          <CardTitle className="text-base">Floor Utilisation</CardTitle>
          <CardDescription className="text-xs">Confirmed bookings vs capacity per floor</CardDescription>
        </div>
        {data && data.length > 0 && (
          <ExportBtn onClick={() => downloadCsv('floor-utilisation.csv', [
            ['Building', 'Floor', 'Total Desks', 'Bookable', 'Assigned', 'Disabled', 'Bookings', 'Utilisation %'],
            ...(data as FloorUtilisationPoint[]).map((d) => [d.buildingName, d.floorName, String(d.totalDesks), String(d.bookableDesks), String(d.assignedDesks), String(d.disabledDesks), String(d.bookingCount), String(d.utilisationPct)]),
          ])} />
        )}
      </CardHeader>
      <CardContent>
        {isLoading ? <ChartSkeleton h={chartData.length > 0 ? chartData.length * 40 : 256} /> :
          !data || data.length === 0 ? <EmptyState /> : (
            <ResponsiveContainer width="100%" height={Math.max(180, chartData.length * 40)}>
              <BarChart data={chartData} layout="vertical" margin={{ top: 4, right: 64, left: 8, bottom: 4 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" horizontal={false} />
                <XAxis type="number" tick={{ fontSize: 11 }} domain={[0, 100]} unit="%" allowDecimals={false} />
                <YAxis type="category" dataKey="label" tick={{ fontSize: 11 }} width={160} />
                <Tooltip
                  formatter={(v, _n, props) => {
                    const p = props.payload ?? {}
                    const detail = `${p.bookingCount ?? '?'} bookings · ${p.bookableDesks ?? '?'} bookable · ${p.assignedDesks ?? 0} assigned · ${p.disabledDesks ?? 0} disabled`
                    return [`${v}% (${detail})`, 'Utilisation']
                  }}
                />
                <Bar dataKey="utilisationPct" name="Utilisation %" radius={[0, 4, 4, 0]}>
                  {chartData.map((d, i) => (
                    <Cell key={i} fill={d.utilisationPct > 70 ? PALETTE.green : d.utilisationPct > 40 ? PALETTE.primary : PALETTE.amber} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
      </CardContent>
    </Card>
  )
}

// ─── Zone Utilisation Table ───────────────────────────────────────────────────

function ZoneUtilisationTable({ params }: { params: AnalyticsParams }) {
  const { data, isLoading } = useQuery({
    queryKey: ['analytics', 'utilisation', params],
    queryFn: () => analyticsApi.utilisation(params),
    select: (r) => r.data,
  })

  return (
    <Card className="col-span-2">
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <div>
          <CardTitle className="text-base">Zone Breakdown</CardTitle>
          <CardDescription className="text-xs">Utilisation per zone with desk counts</CardDescription>
        </div>
        {data && data.length > 0 && (
          <ExportBtn onClick={() => downloadCsv('zone-utilisation.csv', [
            ['Building', 'Floor', 'Zone', 'Total', 'Bookable', 'Assigned', 'Disabled', 'Bookings', 'Utilisation %'],
            ...(data as UtilisationDataPoint[]).map((d) => [
              (d as any).buildingName ?? '', d.floorName, d.zoneName,
              String(d.totalDesks), String(d.bookableDesks), String(d.assignedDesks), String(d.disabledDesks),
              String(d.bookingCount), String(d.utilisationPct),
            ]),
          ])} />
        )}
      </CardHeader>
      <CardContent className="p-0">
        {isLoading ? (
          <div className="p-6 space-y-2">{[1,2,3,4].map((i) => <Skeleton key={i} className="h-9 w-full" />)}</div>
        ) : !data || data.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/40">
                  <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">Floor</th>
                  <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">Zone</th>
                  <th className="text-right px-4 py-2.5 text-xs font-medium text-muted-foreground">Bookable</th>
                  <th className="text-right px-4 py-2.5 text-xs font-medium text-muted-foreground">Assigned</th>
                  <th className="text-right px-4 py-2.5 text-xs font-medium text-muted-foreground">Bookings</th>
                  <th className="text-right px-4 py-2.5 text-xs font-medium text-muted-foreground">Utilisation</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {(data as UtilisationDataPoint[]).map((d) => (
                  <tr key={d.zoneId} className="hover:bg-muted/30 transition-colors">
                    <td className="px-4 py-2.5 text-muted-foreground text-xs">{d.floorName}</td>
                    <td className="px-4 py-2.5 font-medium">{d.zoneName}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{d.bookableDesks}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-violet-600">{d.assignedDesks > 0 ? d.assignedDesks : <span className="text-muted-foreground">—</span>}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{d.bookingCount}</td>
                    <td className="px-4 py-2.5 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <div className="w-16 bg-muted rounded-full h-1.5 overflow-hidden">
                          <div
                            className="h-full rounded-full"
                            style={{
                              width: `${Math.min(d.utilisationPct, 100)}%`,
                              background: d.utilisationPct > 70 ? PALETTE.green : d.utilisationPct > 40 ? PALETTE.primary : PALETTE.amber,
                            }}
                          />
                        </div>
                        <span className="tabular-nums text-xs font-medium w-10 text-right">{d.utilisationPct}%</span>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// ─── Top Users ────────────────────────────────────────────────────────────────

function TopUsersChart({ params }: { params: AnalyticsParams }) {
  const { data, isLoading } = useQuery({
    queryKey: ['analytics', 'top-users', params],
    queryFn: () => analyticsApi.topUsers(params),
    select: (r) => r.data?.slice(0, 10),
  })

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <div>
          <CardTitle className="text-base">Top Bookers</CardTitle>
          <CardDescription className="text-xs">Most active users by booking count</CardDescription>
        </div>
        {data && data.length > 0 && (
          <ExportBtn onClick={() => downloadCsv('top-users.csv', [
            ['Name', 'Email', 'Bookings'],
            ...(data as TopUserDataPoint[]).map((d) => [d.displayName, d.email, String(d.bookingCount)]),
          ])} />
        )}
      </CardHeader>
      <CardContent>
        {isLoading ? <ChartSkeleton /> : !data || data.length === 0 ? <EmptyState /> : (
          <ResponsiveContainer width="100%" height={256}>
            <BarChart data={data} layout="vertical" margin={{ top: 4, right: 32, left: 8, bottom: 4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" horizontal={false} />
              <XAxis type="number" tick={{ fontSize: 11 }} allowDecimals={false} />
              <YAxis type="category" dataKey="displayName" tick={{ fontSize: 11 }} width={110} />
              <Tooltip formatter={(v) => [v, 'Bookings']} />
              <Bar dataKey="bookingCount" name="Bookings" fill={PALETTE.primary} radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </CardContent>
    </Card>
  )
}

// ─── Export All ───────────────────────────────────────────────────────────────

function ExportAllButton({ params, days }: { params: AnalyticsParams; days: Preset }) {
  const { data: summary } = useQuery({ queryKey: ['analytics', 'summary', params], queryFn: () => analyticsApi.summary(params), select: (r) => r.data })
  const { data: bookings } = useQuery({ queryKey: ['analytics', 'bookings', params], queryFn: () => analyticsApi.bookings(params), select: (r) => r.data })
  const { data: utilisation } = useQuery({ queryKey: ['analytics', 'utilisation', params], queryFn: () => analyticsApi.utilisation(params), select: (r) => r.data })
  const { data: topUsers } = useQuery({ queryKey: ['analytics', 'top-users', params], queryFn: () => analyticsApi.topUsers(params), select: (r) => r.data })
  const { data: status } = useQuery({ queryKey: ['analytics', 'status-breakdown', params], queryFn: () => analyticsApi.statusBreakdown(params), select: (r) => r.data })
  const { data: peakDays } = useQuery({ queryKey: ['analytics', 'peak-days', params], queryFn: () => analyticsApi.peakDays(params), select: (r) => r.data })
  const { data: floorUtil } = useQuery({ queryKey: ['analytics', 'floor-utilisation', params], queryFn: () => analyticsApi.floorUtilisation(params), select: (r) => r.data })

  const handleExportAll = () => {
    const rangeStr = days === 'custom' ? `${params.startDate}_${params.endDate}` : `last-${days}d`
    const sections: string[][] = []

    if (summary) {
      sections.push(['=== SUMMARY ===', ''])
      sections.push(['Metric', 'Value'])
      sections.push(['Total Confirmed Bookings', String(summary.totalBookings)])
      sections.push(['Cancelled Bookings', String(summary.cancelledBookings)])
      sections.push(['Cancellation Rate', `${summary.cancellationRate}%`])
      sections.push(['Unique Bookers', String(summary.uniqueBookers)])
      sections.push(['Avg Daily Bookings', String(summary.avgDailyBookings)])
      sections.push(['Total Desks', String(summary.totalDesks)])
      sections.push(['Bookable Desks', String(summary.bookableDesks)])
      sections.push(['Permanently Assigned Desks', String(summary.assignedDesks)])
      sections.push(['Disabled Desks', String(summary.disabledDesks)])
      sections.push(['Overall Utilisation', `${summary.overallUtilisationPct}%`])
      sections.push(['Current Queue Depth', String(summary.queueDepth)])
      sections.push(['Working Days', String(summary.workingDays)])
      sections.push(['', ''])
    }

    if (bookings && bookings.length > 0) {
      sections.push(['=== BOOKING ACTIVITY ===', ''])
      sections.push(['Date', 'Bookings'])
      bookings.forEach((d) => sections.push([d.date, String(d.count)]))
      sections.push(['', ''])
    }

    if (status && status.length > 0) {
      sections.push(['=== BOOKING STATUS ===', ''])
      sections.push(['Status', 'Count'])
      status.forEach((d) => sections.push([d.label, String(d.count)]))
      sections.push(['', ''])
    }

    if (peakDays) {
      sections.push(['=== PEAK DAYS ===', ''])
      sections.push(['Day', 'Bookings'])
      peakDays.forEach((d) => sections.push([d.dayName, String(d.count)]))
      sections.push(['', ''])
    }

    if (floorUtil && floorUtil.length > 0) {
      sections.push(['=== FLOOR UTILISATION ===', ''])
      sections.push(['Building', 'Floor', 'Desks', 'Bookings', 'Utilisation %'])
      floorUtil.forEach((d) => sections.push([d.buildingName, d.floorName, String(d.totalDesks), String(d.bookingCount), String(d.utilisationPct)]))
      sections.push(['', ''])
    }

    if (utilisation && utilisation.length > 0) {
      sections.push(['=== ZONE BREAKDOWN ===', ''])
      sections.push(['Floor', 'Zone', 'Total', 'Bookable', 'Assigned', 'Disabled', 'Bookings', 'Utilisation %'])
      utilisation.forEach((d) => sections.push([d.floorName, d.zoneName, String(d.totalDesks), String(d.bookableDesks), String(d.assignedDesks), String(d.disabledDesks), String(d.bookingCount), String(d.utilisationPct)]))
      sections.push(['', ''])
    }

    if (topUsers && topUsers.length > 0) {
      sections.push(['=== TOP BOOKERS ===', ''])
      sections.push(['Name', 'Email', 'Bookings'])
      topUsers.forEach((d) => sections.push([d.displayName, d.email, String(d.bookingCount)]))
    }

    downloadCsv(`roomer-report-${rangeStr}.csv`, sections)
  }

  return (
    <Button variant="outline" size="sm" className="gap-1.5" onClick={handleExportAll}>
      <Download className="h-3.5 w-3.5" />
      Export All
    </Button>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function ReportsAdminPage() {
  const [preset, setPreset] = useState<Preset>(30)
  const [customFrom, setCustomFrom] = useState(format(subDays(new Date(), 30), 'yyyy-MM-dd'))
  const [customTo, setCustomTo] = useState(format(new Date(), 'yyyy-MM-dd'))
  const [buildingFilter, setBuildingFilter] = useState('')

  const { startDate, endDate } = useDateRange(preset, customFrom, customTo)

  const { data: buildings } = useQuery({
    queryKey: ['buildings'],
    queryFn: () => buildingsApi.list(),
    select: (r) => r.data,
  })

  const params: AnalyticsParams = {
    startDate,
    endDate,
    ...(buildingFilter ? { buildingId: buildingFilter } : {}),
  }

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Reports & Analytics</h1>
          <p className="text-muted-foreground text-sm mt-1">
            {formatDate(startDate)} – {formatDate(endDate)}
            {buildingFilter && buildings && ` · ${buildings.find(b => b.id === buildingFilter)?.name}`}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ExportAllButton params={params} days={preset} />
        </div>
      </div>

      {/* Filters */}
      <Card>
        <CardContent className="p-4">
          <div className="flex flex-wrap items-end gap-4">
            <div>
              <Label className="text-xs text-muted-foreground mb-1.5 block">Date range</Label>
              <div className="flex gap-1">
                {([7, 30, 90] as Preset[]).map((d) => (
                  <Button key={d} variant={preset === d ? 'default' : 'outline'} size="sm" className="h-8" onClick={() => setPreset(d)}>
                    {d}d
                  </Button>
                ))}
                <Button variant={preset === 'custom' ? 'default' : 'outline'} size="sm" className="h-8" onClick={() => setPreset('custom')}>
                  Custom
                </Button>
              </div>
            </div>

            {preset === 'custom' && (
              <>
                <div>
                  <Label className="text-xs text-muted-foreground mb-1.5 block">From</Label>
                  <Input type="date" value={customFrom} max={customTo} onChange={(e) => setCustomFrom(e.target.value)} className="h-8 w-36 text-sm" />
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground mb-1.5 block">To</Label>
                  <Input type="date" value={customTo} min={customFrom} max={format(new Date(), 'yyyy-MM-dd')} onChange={(e) => setCustomTo(e.target.value)} className="h-8 w-36 text-sm" />
                </div>
              </>
            )}

            {buildings && buildings.length > 1 && (
              <div>
                <Label className="text-xs text-muted-foreground mb-1.5 block">Building</Label>
                <select
                  value={buildingFilter}
                  onChange={(e) => setBuildingFilter(e.target.value)}
                  className="h-8 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <option value="">All buildings</option>
                  {buildings.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                </select>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* KPI summary */}
      <SummaryCards params={params} />

      {/* Charts grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <BookingActivityChart params={params} />
        <StatusBreakdownChart params={params} />
        <PeakDaysChart params={params} />
        <TopUsersChart params={params} />
        <FloorUtilisationChart params={params} />
        <ZoneUtilisationTable params={params} />
      </div>
    </div>
  )
}
