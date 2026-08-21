import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Dices, Plus, X, ChevronDown, ChevronUp, Play, Shuffle, Trash2, Pause } from 'lucide-react'
import { buildingsApi, assetsApi } from '@/lib/api'
import {
  useBallots, useBallotRuns, useBallotRunDetail,
  useCreateBallot, useUpdateBallot, useDeleteBallot, useTriggerBallotRun, useForceDraw,
} from '@/hooks/useBallots'
import type { CreateBallotBody } from '@/lib/api'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from '@/components/ui/alert-dialog'

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

const STATUS_VARIANT: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  ACTIVE: 'default', PAUSED: 'secondary', CANCELLED: 'destructive',
  OPEN: 'default', DRAWN: 'secondary',
  ENTERED: 'outline', WON: 'default', DECLINED: 'destructive', LOST: 'secondary',
}

const emptyForm: CreateBallotBody = {
  name: '',
  buildingIds: [],
  floorIds: [],
  assetCategoryIds: [],
  frequency: 'WEEKLY',
  dayOfWeek: 4,
  registrationWindowHours: 72,
  slotStartTime: '00:00',
  slotEndTime: '23:59',
  slotLeadDays: 1,
  slotDurationDays: 1,
}

function CreateBallotDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [form, setForm] = useState<CreateBallotBody>(emptyForm)
  const [floorBuildingId, setFloorBuildingId] = useState('')
  const [floorId, setFloorId] = useState('')
  const [buildingToAdd, setBuildingToAdd] = useState('')
  const create = useCreateBallot()

  const { data: buildings } = useQuery({ queryKey: ['buildings'], queryFn: () => buildingsApi.list(), select: (r) => r.data })
  const { data: categories } = useQuery({ queryKey: ['asset-categories'], queryFn: () => assetsApi.listCategories(), select: (r) => r.data })
  const { data: floorBuilding } = useQuery({
    queryKey: ['buildings', floorBuildingId],
    queryFn: () => buildingsApi.get(floorBuildingId),
    select: (r) => r.data,
    enabled: !!floorBuildingId,
  })

  const buildingNameById = new Map((buildings ?? []).map((b) => [b.id, b.name]))

  const reset = () => {
    setForm(emptyForm)
    setFloorBuildingId('')
    setFloorId('')
    setBuildingToAdd('')
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) { reset(); onClose() } }}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto" aria-describedby={undefined}>
        <DialogHeader><DialogTitle>New Ballot</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <div>
            <Label htmlFor="ballotName">Name *</Label>
            <Input id="ballotName" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="mt-1.5" placeholder="e.g. Weekly Parking Ballot" />
          </div>

          <div>
            <Label>Buildings (every floor in scope)</Label>
            <div className="flex gap-2 mt-1.5">
              <Select value={buildingToAdd} onValueChange={setBuildingToAdd}>
                <SelectTrigger className="flex-1"><SelectValue placeholder="Add a building…" /></SelectTrigger>
                <SelectContent>
                  {(buildings ?? []).filter((b) => !form.buildingIds.includes(b.id)).map((b) => (
                    <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                size="sm"
                disabled={!buildingToAdd}
                onClick={() => { setForm({ ...form, buildingIds: [...form.buildingIds, buildingToAdd] }); setBuildingToAdd('') }}
              >
                <Plus className="h-4 w-4" />
              </Button>
            </div>
            <div className="flex flex-wrap gap-1.5 mt-2">
              {form.buildingIds.map((id) => (
                <Badge key={id} variant="secondary" className="gap-1">
                  {buildingNameById.get(id) ?? id}
                  <button type="button" onClick={() => setForm({ ...form, buildingIds: form.buildingIds.filter((b) => b !== id) })}>
                    <X className="h-3 w-3" />
                  </button>
                </Badge>
              ))}
            </div>
          </div>

          <div>
            <Label>Specific floors (optional, in addition to whole buildings above)</Label>
            <div className="flex gap-2 mt-1.5">
              <Select value={floorBuildingId} onValueChange={(v) => { setFloorBuildingId(v); setFloorId('') }}>
                <SelectTrigger className="flex-1"><SelectValue placeholder="Building…" /></SelectTrigger>
                <SelectContent>
                  {(buildings ?? []).map((b) => <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>)}
                </SelectContent>
              </Select>
              <Select value={floorId} onValueChange={setFloorId} disabled={!floorBuildingId}>
                <SelectTrigger className="flex-1"><SelectValue placeholder="Floor…" /></SelectTrigger>
                <SelectContent>
                  {(floorBuilding?.floors ?? []).filter((f) => !form.floorIds.includes(f.id)).map((f) => (
                    <SelectItem key={f.id} value={f.id}>{f.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                size="sm"
                disabled={!floorId}
                onClick={() => { setForm({ ...form, floorIds: [...form.floorIds, floorId] }); setFloorId('') }}
              >
                <Plus className="h-4 w-4" />
              </Button>
            </div>
            <div className="flex flex-wrap gap-1.5 mt-2">
              {form.floorIds.map((id) => {
                const floor = floorBuilding?.floors.find((f) => f.id === id)
                return (
                  <Badge key={id} variant="secondary" className="gap-1">
                    {floor?.name ?? id}
                    <button type="button" onClick={() => setForm({ ...form, floorIds: form.floorIds.filter((f) => f !== id) })}>
                      <X className="h-3 w-3" />
                    </button>
                  </Badge>
                )
              })}
            </div>
          </div>

          <div>
            <Label>Asset category filter (optional — empty means every bookable asset in scope)</Label>
            <div className="flex flex-wrap gap-2 mt-1.5">
              {(categories ?? []).map((c) => {
                const active = form.assetCategoryIds.includes(c.id)
                return (
                  <Badge
                    key={c.id}
                    variant={active ? 'default' : 'outline'}
                    className="cursor-pointer"
                    onClick={() => setForm({
                      ...form,
                      assetCategoryIds: active ? form.assetCategoryIds.filter((id) => id !== c.id) : [...form.assetCategoryIds, c.id],
                    })}
                  >
                    {c.name}
                  </Badge>
                )
              })}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label>Frequency</Label>
              <Select value={form.frequency} onValueChange={(v) => setForm({ ...form, frequency: v as CreateBallotBody['frequency'] })}>
                <SelectTrigger className="mt-1.5"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="ONCE">Once</SelectItem>
                  <SelectItem value="WEEKLY">Weekly</SelectItem>
                  <SelectItem value="MONTHLY">Monthly</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {form.frequency === 'WEEKLY' && (
              <div>
                <Label>Draw day</Label>
                <Select value={String(form.dayOfWeek ?? 4)} onValueChange={(v) => setForm({ ...form, dayOfWeek: Number(v) })}>
                  <SelectTrigger className="mt-1.5"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {DAY_NAMES.map((d, i) => <SelectItem key={i} value={String(i)}>{d}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            )}
            {form.frequency === 'MONTHLY' && (
              <div>
                <Label htmlFor="dayOfMonth">Day of month</Label>
                <Input
                  id="dayOfMonth" type="number" min={1} max={28}
                  value={form.dayOfMonth ?? 1}
                  onChange={(e) => setForm({ ...form, dayOfMonth: Number(e.target.value) })}
                  className="mt-1.5"
                />
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label htmlFor="regWindow">Registration opens (hours before draw)</Label>
              <Input id="regWindow" type="number" min={1} value={form.registrationWindowHours} onChange={(e) => setForm({ ...form, registrationWindowHours: Number(e.target.value) })} className="mt-1.5" />
            </div>
            <div />
            <div>
              <Label htmlFor="slotLead">Slot starts (days after draw)</Label>
              <Input id="slotLead" type="number" min={0} value={form.slotLeadDays} onChange={(e) => setForm({ ...form, slotLeadDays: Number(e.target.value) })} className="mt-1.5" />
            </div>
            <div>
              <Label htmlFor="slotDuration">Slot duration (days)</Label>
              <Input id="slotDuration" type="number" min={1} value={form.slotDurationDays} onChange={(e) => setForm({ ...form, slotDurationDays: Number(e.target.value) })} className="mt-1.5" />
            </div>
            <div>
              <Label htmlFor="slotStart">Daily start time</Label>
              <Input id="slotStart" type="time" value={form.slotStartTime} onChange={(e) => setForm({ ...form, slotStartTime: e.target.value })} className="mt-1.5" />
            </div>
            <div>
              <Label htmlFor="slotEnd">Daily end time</Label>
              <Input id="slotEnd" type="time" value={form.slotEndTime} onChange={(e) => setForm({ ...form, slotEndTime: e.target.value })} className="mt-1.5" />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => { reset(); onClose() }}>Cancel</Button>
          <Button
            disabled={!form.name.trim() || (form.buildingIds.length === 0 && form.floorIds.length === 0) || create.isPending}
            onClick={() => create.mutate(form, { onSuccess: () => { reset(); onClose() } })}
          >
            {create.isPending ? 'Creating…' : 'Create Ballot'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function RunResultsDialog({ runId, onClose }: { runId: string | null; onClose: () => void }) {
  const { data: run, isLoading } = useBallotRunDetail(runId ?? undefined)

  return (
    <Dialog open={!!runId} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg max-h-[80vh] overflow-y-auto" aria-describedby={undefined}>
        <DialogHeader><DialogTitle>Run results</DialogTitle></DialogHeader>
        {isLoading ? <Skeleton className="h-40 w-full" /> : !run ? null : (
          <div className="space-y-3">
            <div className="text-sm text-muted-foreground">
              {run.poolSize} eligible asset{run.poolSize === 1 ? '' : 's'} · {run.entries?.length ?? 0} entrant{run.entries?.length === 1 ? '' : 's'}
              {run.status === 'OPEN' && ' · not yet drawn'}
            </div>
            <div className="space-y-2">
              {(run.entries ?? []).map((e) => (
                <div key={e.id} className="flex items-center justify-between gap-2 rounded-md border p-2 text-sm">
                  <div className="min-w-0">
                    <p className="font-medium truncate">{e.user?.displayName}</p>
                    {e.asset && <p className="text-xs text-muted-foreground truncate">{e.asset.name}</p>}
                  </div>
                  <Badge variant={STATUS_VARIANT[e.status]} className="shrink-0 text-xs">{e.status}</Badge>
                </div>
              ))}
              {(run.entries ?? []).length === 0 && (
                <p className="text-sm text-muted-foreground text-center py-6">No entries yet.</p>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

function BallotRunsPanel({ ballotId }: { ballotId: string }) {
  const { data: runs, isLoading } = useBallotRuns(ballotId)
  const forceDraw = useForceDraw()
  const [viewingRun, setViewingRun] = useState<string | null>(null)

  if (isLoading) return <Skeleton className="h-16 w-full" />
  if (!runs || runs.length === 0) {
    return <p className="text-sm text-muted-foreground py-3">No runs yet.</p>
  }

  return (
    <>
      <div className="space-y-2 pt-2">
        {runs.map((r) => (
          <div key={r.id} className="flex items-center justify-between gap-2 rounded-md border p-2.5 text-sm">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <Badge variant={STATUS_VARIANT[r.status]} className="text-xs">{r.status}</Badge>
                <span className="text-xs text-muted-foreground">{r._count?.entries ?? 0} entrant{r._count?.entries === 1 ? '' : 's'}</span>
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                Slot: {new Date(r.slotStartsAt).toLocaleDateString()} – {new Date(r.slotEndsAt).toLocaleDateString()} · Registration closes {new Date(r.registrationClosesAt).toLocaleString()}
              </p>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <Button size="sm" variant="outline" onClick={() => setViewingRun(r.id)}>View</Button>
              {r.status === 'OPEN' && (
                <Button size="sm" disabled={forceDraw.isPending} onClick={() => forceDraw.mutate(r.id)}>
                  <Shuffle className="h-3.5 w-3.5 mr-1" /> Draw now
                </Button>
              )}
            </div>
          </div>
        ))}
      </div>
      <RunResultsDialog runId={viewingRun} onClose={() => setViewingRun(null)} />
    </>
  )
}

export default function BallotsAdminPage() {
  const [createOpen, setCreateOpen] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)
  const { data: ballots, isLoading } = useBallots()
  const updateBallot = useUpdateBallot()
  const deleteBallot = useDeleteBallot()
  const triggerRun = useTriggerBallotRun()
  const qc = useQueryClient()

  return (
    <div className="p-6 space-y-6 max-w-4xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <Dices className="h-6 w-6" />
            Booking Ballots
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Randomly allocate scarce assets (e.g. car parking) among opted-in entrants.
          </p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="mr-2 h-4 w-4" /> New Ballot
        </Button>
      </div>

      {isLoading ? (
        <div className="space-y-3">{[1, 2].map((i) => <Skeleton key={i} className="h-24 w-full" />)}</div>
      ) : !ballots || ballots.length === 0 ? (
        <Card><CardContent className="py-10 text-center text-sm text-muted-foreground">No ballots yet.</CardContent></Card>
      ) : (
        <div className="space-y-3">
          {ballots.map((b) => (
            <Card key={b.id}>
              <CardContent className="py-4">
                <div className="flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium">{b.name}</span>
                      <Badge variant={STATUS_VARIANT[b.status]} className="text-xs">{b.status}</Badge>
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">
                      {b.frequency === 'ONCE' ? 'One-off' : b.frequency === 'WEEKLY' ? `Weekly, ${DAY_NAMES[b.dayOfWeek ?? 0]}` : `Monthly, day ${b.dayOfMonth}`}
                      {' · '}{b.buildingIds.length} building{b.buildingIds.length === 1 ? '' : 's'}, {b.floorIds.length} floor{b.floorIds.length === 1 ? '' : 's'}
                      {' · '}{b._count?.runs ?? 0} run{b._count?.runs === 1 ? '' : 's'}
                    </p>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Button size="sm" variant="outline" onClick={() => setExpanded(expanded === b.id ? null : b.id)}>
                      {expanded === b.id ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                    </Button>
                    {b.status === 'ACTIVE' ? (
                      <Button size="sm" variant="outline" onClick={() => updateBallot.mutate({ id: b.id, body: { status: 'PAUSED' } })}>
                        <Pause className="h-3.5 w-3.5" />
                      </Button>
                    ) : b.status === 'PAUSED' ? (
                      <Button size="sm" variant="outline" onClick={() => updateBallot.mutate({ id: b.id, body: { status: 'ACTIVE' } })}>
                        <Play className="h-3.5 w-3.5" />
                      </Button>
                    ) : null}
                    <Button
                      size="sm" variant="outline"
                      onClick={() => triggerRun.mutate(b.id, { onSuccess: () => qc.invalidateQueries({ queryKey: ['ballots', b.id, 'runs'] }) })}
                      title="Open the next run now"
                    >
                      Open run
                    </Button>
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive">
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>Delete "{b.name}"?</AlertDialogTitle>
                          <AlertDialogDescription>
                            This removes the ballot and its run history. Bookings already won through it are unaffected — they stay as normal confirmed bookings.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancel</AlertDialogCancel>
                          <AlertDialogAction
                            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                            onClick={() => deleteBallot.mutate(b.id)}
                          >
                            Delete
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </div>
                </div>
                {expanded === b.id && <BallotRunsPanel ballotId={b.id} />}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <CreateBallotDialog open={createOpen} onClose={() => setCreateOpen(false)} />
    </div>
  )
}
