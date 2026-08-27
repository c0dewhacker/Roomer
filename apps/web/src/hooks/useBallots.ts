import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { ballotsApi, type CreateBallotBody } from '../lib/api'

// ─── Admin ──────────────────────────────────────────────────────────────────

export function useBallots() {
  return useQuery({
    queryKey: ['ballots'],
    queryFn: () => ballotsApi.list(),
    select: (res) => res.data,
  })
}

export function useBallotRuns(ballotId: string | undefined) {
  return useQuery({
    queryKey: ['ballots', ballotId, 'runs'],
    queryFn: () => ballotsApi.runs(ballotId!),
    select: (res) => res.data,
    enabled: !!ballotId,
  })
}

export function useBallotRunDetail(runId: string | undefined) {
  return useQuery({
    queryKey: ['ballots', 'runs', runId],
    queryFn: () => ballotsApi.runDetail(runId!),
    select: (res) => res.data,
    enabled: !!runId,
  })
}

export function useCreateBallot() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: CreateBallotBody) => ballotsApi.create(body),
    onSuccess: () => {
      toast.success('Ballot created')
      qc.invalidateQueries({ queryKey: ['ballots'] })
    },
    onError: (err: Error) => toast.error(err.message),
  })
}

export function useUpdateBallot() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: Partial<CreateBallotBody & { status: 'ACTIVE' | 'PAUSED' | 'CANCELLED' }> }) =>
      ballotsApi.update(id, body),
    onSuccess: () => {
      toast.success('Ballot updated')
      qc.invalidateQueries({ queryKey: ['ballots'] })
    },
    onError: (err: Error) => toast.error(err.message),
  })
}

export function useDeleteBallot() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => ballotsApi.remove(id),
    onSuccess: () => {
      toast.success('Ballot deleted')
      qc.invalidateQueries({ queryKey: ['ballots'] })
    },
    onError: (err: Error) => toast.error(err.message),
  })
}

export function useTriggerBallotRun() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => ballotsApi.triggerRun(id),
    onSuccess: () => {
      toast.success('Run opened')
      qc.invalidateQueries({ queryKey: ['ballots'] })
    },
    onError: (err: Error) => toast.error(err.message),
  })
}

export function useForceDraw() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (runId: string) => ballotsApi.forceDraw(runId),
    onSuccess: () => {
      toast.success('Draw complete')
      qc.invalidateQueries({ queryKey: ['ballots'] })
      // A draw synchronously creates a Booking for every winner (see
      // useDeclineBallotEntry below, which invalidates this same key for
      // the same reason: a ballot outcome changing bookings) — without
      // this, an admin who forced the draw and is also an entrant (or has
      // any other view reading ['bookings', ...] mounted) doesn't see the
      // new booking until an unrelated refetch.
      qc.invalidateQueries({ queryKey: ['bookings'] })
    },
    onError: (err: Error) => toast.error(err.message),
  })
}

// ─── User-facing ────────────────────────────────────────────────────────────

// Draws happen server-side (an hourly cron sweep, or another admin's manual
// force-draw) — never as a result of this browser's own mutations — so the
// invalidateQueries calls elsewhere in this file never reach a tab sitting on
// these two queries. Without polling, a user watching "Open ballots"/"My
// entries" for a result has no way to see it short of a manual reload, the
// same class of gap already fixed for NotificationBell/useBookings/WhosInPage.
export function useAvailableBallots() {
  return useQuery({
    queryKey: ['ballots', 'available'],
    queryFn: () => ballotsApi.available(),
    select: (res) => res.data,
    refetchInterval: 30_000,
  })
}

export function useMyBallotEntries() {
  return useQuery({
    queryKey: ['ballots', 'my-entries'],
    queryFn: () => ballotsApi.myEntries(),
    select: (res) => res.data,
    refetchInterval: 30_000,
  })
}

export function useEnterBallot() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (runId: string) => ballotsApi.enter(runId),
    onSuccess: () => {
      toast.success("You're entered")
      // Broad ['ballots'] invalidation (prefix-covers 'available'/'my-entries'
      // below too) — an admin watching BallotsAdminPage's run-results dialog
      // (['ballots', ballotId, 'runs'] / ['ballots', 'runs', runId]) needs
      // the entrant count/list to update the moment someone enters/withdraws/
      // declines, not just the entrant's own two views.
      qc.invalidateQueries({ queryKey: ['ballots'] })
    },
    onError: (err: Error) => toast.error(err.message),
  })
}

export function useWithdrawBallotEntry() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (runId: string) => ballotsApi.withdraw(runId),
    onSuccess: () => {
      toast.success('Entry withdrawn')
      qc.invalidateQueries({ queryKey: ['ballots'] })
    },
    onError: (err: Error) => toast.error(err.message),
  })
}

export function useDeclineBallotEntry() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (entryId: string) => ballotsApi.decline(entryId),
    onSuccess: () => {
      toast.success('Declined')
      qc.invalidateQueries({ queryKey: ['ballots'] })
      qc.invalidateQueries({ queryKey: ['bookings'] })
    },
    onError: (err: Error) => toast.error(err.message),
  })
}
