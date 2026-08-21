import { useState } from 'react'
import { Dices, Clock, XCircle } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import {
  useAvailableBallots, useMyBallotEntries, useEnterBallot, useWithdrawBallotEntry, useDeclineBallotEntry,
} from '@/hooks/useBallots'
import type { BallotEntryStatus } from '@/types'

const ENTRY_STATUS_LABEL: Record<BallotEntryStatus, string> = {
  ENTERED: 'Entered — awaiting draw',
  WON: 'Won',
  DECLINED: 'Declined',
  LOST: 'Not selected',
}

const ENTRY_STATUS_VARIANT: Record<BallotEntryStatus, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  ENTERED: 'outline', WON: 'default', DECLINED: 'destructive', LOST: 'secondary',
}

function formatRange(startIso: string, endIso: string): string {
  const start = new Date(startIso)
  const end = new Date(endIso)
  const sameDay = start.toDateString() === end.toDateString()
  return sameDay
    ? start.toLocaleDateString()
    : `${start.toLocaleDateString()} – ${end.toLocaleDateString()}`
}

function OpenBallotsTab() {
  const { data: runs, isLoading } = useAvailableBallots()
  const enter = useEnterBallot()
  const withdraw = useWithdrawBallotEntry()

  if (isLoading) return <div className="space-y-3">{[1, 2].map((i) => <Skeleton key={i} className="h-24 w-full" />)}</div>
  if (!runs || runs.length === 0) {
    return <Card><CardContent className="py-10 text-center text-sm text-muted-foreground">No ballots are open for entry right now.</CardContent></Card>
  }

  return (
    <div className="space-y-3">
      {runs.map((r) => {
        const entered = r.myEntry?.status === 'ENTERED'
        return (
          <Card key={r.id}>
            <CardContent className="py-4 flex items-center justify-between gap-4">
              <div className="min-w-0">
                <p className="font-medium">{r.ballot?.name}</p>
                <p className="text-sm text-muted-foreground mt-1">Slot: {formatRange(r.slotStartsAt, r.slotEndsAt)}</p>
                <p className="text-xs text-muted-foreground flex items-center gap-1 mt-1">
                  <Clock className="h-3 w-3" /> Registration closes {new Date(r.registrationClosesAt).toLocaleString()}
                </p>
              </div>
              <div className="shrink-0">
                {entered ? (
                  <Button size="sm" variant="outline" disabled={withdraw.isPending} onClick={() => withdraw.mutate(r.id)}>
                    Withdraw
                  </Button>
                ) : (
                  <Button size="sm" disabled={enter.isPending} onClick={() => enter.mutate(r.id)}>
                    Enter
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>
        )
      })}
    </div>
  )
}

function MyEntriesTab() {
  const { data: entries, isLoading } = useMyBallotEntries()
  const decline = useDeclineBallotEntry()

  if (isLoading) return <div className="space-y-3">{[1, 2].map((i) => <Skeleton key={i} className="h-20 w-full" />)}</div>
  if (!entries || entries.length === 0) {
    return <Card><CardContent className="py-10 text-center text-sm text-muted-foreground">You haven't entered any ballots yet.</CardContent></Card>
  }

  return (
    <div className="space-y-3">
      {entries.map((e) => (
        <Card key={e.id}>
          <CardContent className="py-4 flex items-center justify-between gap-4">
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-medium">{e.run?.ballot?.name}</span>
                <Badge variant={ENTRY_STATUS_VARIANT[e.status]} className="text-xs">{ENTRY_STATUS_LABEL[e.status]}</Badge>
              </div>
              {e.status === 'WON' && e.asset && e.booking && (
                <p className="text-sm text-muted-foreground mt-1">
                  {e.asset.name} · {formatRange(e.booking.startsAt, e.booking.endsAt)}
                </p>
              )}
            </div>
            {e.status === 'WON' && (
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button size="sm" variant="outline" disabled={decline.isPending} className="shrink-0">
                    <XCircle className="h-3.5 w-3.5 mr-1" /> Decline
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Decline this assignment?</AlertDialogTitle>
                    <AlertDialogDescription>
                      Your {e.asset?.name} booking will be cancelled and offered to another entrant in this ballot. This cannot be undone.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Keep it</AlertDialogCancel>
                    <AlertDialogAction
                      className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                      onClick={() => decline.mutate(e.id)}
                    >
                      Decline
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  )
}

export default function BallotsPage() {
  const [tab, setTab] = useState<'open' | 'mine'>('open')

  return (
    <div className="p-6 space-y-6 max-w-3xl mx-auto">
      <div>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <Dices className="h-6 w-6" />
          Ballots
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Enter open draws for scarce assets like parking — winners are picked at random once registration closes.
        </p>
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(v as 'open' | 'mine')}>
        <TabsList>
          <TabsTrigger value="open">Open ballots</TabsTrigger>
          <TabsTrigger value="mine">My entries</TabsTrigger>
        </TabsList>
      </Tabs>

      {tab === 'open' ? <OpenBallotsTab /> : <MyEntriesTab />}
    </div>
  )
}
