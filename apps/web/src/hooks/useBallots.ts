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
    },
    onError: (err: Error) => toast.error(err.message),
  })
}

// ─── User-facing ────────────────────────────────────────────────────────────

export function useAvailableBallots() {
  return useQuery({
    queryKey: ['ballots', 'available'],
    queryFn: () => ballotsApi.available(),
    select: (res) => res.data,
  })
}

export function useMyBallotEntries() {
  return useQuery({
    queryKey: ['ballots', 'my-entries'],
    queryFn: () => ballotsApi.myEntries(),
    select: (res) => res.data,
  })
}

export function useEnterBallot() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (runId: string) => ballotsApi.enter(runId),
    onSuccess: () => {
      toast.success("You're entered")
      qc.invalidateQueries({ queryKey: ['ballots', 'available'] })
      qc.invalidateQueries({ queryKey: ['ballots', 'my-entries'] })
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
      qc.invalidateQueries({ queryKey: ['ballots', 'available'] })
      qc.invalidateQueries({ queryKey: ['ballots', 'my-entries'] })
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
      qc.invalidateQueries({ queryKey: ['ballots', 'my-entries'] })
      qc.invalidateQueries({ queryKey: ['bookings'] })
    },
    onError: (err: Error) => toast.error(err.message),
  })
}
