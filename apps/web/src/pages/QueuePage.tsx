import { format } from 'date-fns'
import { Clock, MapPin, CheckCircle, XCircle } from 'lucide-react'
import { useQueueEntries, useLeaveQueue, useClaimDesk } from '@/hooks/useBookings'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { formatDateRange } from '@/lib/utils'
import type { QueueEntry } from '@/types'

const statusConfig: Record<string, { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' }> = {
  WAITING: { label: 'Waiting', variant: 'secondary' },
  PROMOTED: { label: 'Claim now!', variant: 'default' },
  CLAIMED: { label: 'Claimed', variant: 'secondary' },
  EXPIRED: { label: 'Expired', variant: 'outline' },
  CANCELLED: { label: 'Cancelled', variant: 'destructive' },
}

function QueueCard({ entry }: { entry: QueueEntry }) {
  const leave = useLeaveQueue()
  const claim = useClaimDesk()

  const cfg = statusConfig[entry.status] ?? { label: entry.status, variant: 'outline' as const }
  const isActive = entry.status === 'WAITING' || entry.status === 'PROMOTED'

  return (
    <Card className={entry.status === 'PROMOTED' ? 'border-green-500 shadow-md' : ''}>
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <p className="font-medium truncate">{entry.desk?.name ?? 'Unknown desk'}</p>
              <Badge variant={cfg.variant} className="shrink-0 text-xs">
                {cfg.label}
              </Badge>
            </div>

            {entry.desk?.zone && (
              <p className="text-xs text-muted-foreground flex items-center gap-1 mt-1">
                <MapPin className="h-3 w-3 shrink-0" />
                {entry.desk.zone.name}
              </p>
            )}

            <p className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
              <Clock className="h-3 w-3 shrink-0" />
              Wanted: {formatDateRange(entry.wantedStartsAt, entry.wantedEndsAt)}
            </p>

            {entry.status === 'WAITING' && (
              <p className="text-xs text-muted-foreground mt-0.5">
                Position <strong>#{entry.position}</strong> · Expires {format(new Date(entry.expiresAt), 'PPp')}
              </p>
            )}

            {entry.status === 'PROMOTED' && entry.claimDeadline && (
              <p className="text-xs font-medium text-green-700 mt-1">
                Claim before {format(new Date(entry.claimDeadline), 'PPp')}
              </p>
            )}
          </div>

          {isActive && (
            <div className="flex flex-col gap-2 shrink-0">
              {entry.status === 'PROMOTED' && (
                <Button
                  size="sm"
                  onClick={() => claim.mutate(entry.id)}
                  disabled={claim.isPending}
                  className="bg-green-600 hover:bg-green-700"
                >
                  <CheckCircle className="mr-1.5 h-3.5 w-3.5" />
                  Claim
                </Button>
              )}

              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-destructive">
                    <XCircle className="mr-1.5 h-3.5 w-3.5" />
                    Leave
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Leave queue?</AlertDialogTitle>
                    <AlertDialogDescription>
                      You will lose your position #{entry.position} in the queue for{' '}
                      <strong>{entry.desk?.name}</strong>.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Keep position</AlertDialogCancel>
                    <AlertDialogAction
                      onClick={() => leave.mutate(entry.id)}
                      className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                    >
                      Leave queue
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

export default function QueuePage() {
  const { data: entries, isLoading } = useQueueEntries()

  const active = (entries ?? []).filter((e) => e.status === 'WAITING' || e.status === 'PROMOTED')
  const past = (entries ?? []).filter((e) => e.status !== 'WAITING' && e.status !== 'PROMOTED')

  if (isLoading) {
    return (
      <div className="p-6 max-w-3xl mx-auto space-y-3">
        {[1, 2].map((i) => <Skeleton key={i} className="h-28 w-full" />)}
      </div>
    )
  }

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold">My Queue</h1>
        <p className="text-muted-foreground text-sm mt-1">Desks you're waiting for</p>
      </div>

      {active.length === 0 && past.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <Clock className="h-12 w-12 text-muted-foreground/30 mb-3" />
          <p className="text-sm text-muted-foreground">You're not in any queues</p>
          <p className="text-xs text-muted-foreground mt-1">
            When a desk you want is booked, click it and join the queue.
          </p>
        </div>
      )}

      {active.length > 0 && (
        <section>
          <h2 className="text-base font-semibold mb-3">Active ({active.length})</h2>
          <div className="space-y-3">
            {active
              .sort((a, b) => (a.status === 'PROMOTED' ? -1 : b.status === 'PROMOTED' ? 1 : 0))
              .map((e) => <QueueCard key={e.id} entry={e} />)}
          </div>
        </section>
      )}

      {past.length > 0 && (
        <section>
          <h2 className="text-base font-semibold mb-3 text-muted-foreground">History</h2>
          <div className="space-y-3">
            {past.slice(0, 10).map((e) => <QueueCard key={e.id} entry={e} />)}
          </div>
        </section>
      )}
    </div>
  )
}
