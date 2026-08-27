import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { managerRequestsApi } from '../lib/api'
import type { ManagerRequestStatus } from '../types'

export function useMyManagerRequests() {
  return useQuery({
    queryKey: ['manager-requests', 'mine'],
    queryFn: () => managerRequestsApi.mine(),
    select: (res) => res.data,
  })
}

export function useManagerRequestsAdmin(status?: ManagerRequestStatus | 'all') {
  return useQuery({
    queryKey: ['manager-requests', 'admin', status ?? 'all'],
    queryFn: () => managerRequestsApi.list(status),
    select: (res) => res.data,
    // canReview admits SUPER_ADMIN or ANY building admin of that building —
    // two reviewers can easily have this page open at once, and without
    // polling, one reviewer's list never learns the other already
    // approved/rejected a request (or the requester withdrew it) until an
    // unrelated action happens to invalidate this key. Same convention as
    // useBookingApprovals/useBallots/useQueueEntries.
    refetchInterval: 30_000,
  })
}

export function useCreateManagerRequest() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ floorId, note }: { floorId: string; note?: string }) => managerRequestsApi.create(floorId, note),
    onSuccess: () => {
      toast.success('Access request sent')
      qc.invalidateQueries({ queryKey: ['manager-requests'] })
    },
    onError: (err: Error) => toast.error(err.message),
  })
}

export function useApproveManagerRequest() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => managerRequestsApi.approve(id),
    onSuccess: () => {
      toast.success('Request approved')
      qc.invalidateQueries({ queryKey: ['manager-requests'] })
      // Approval grants a FLOOR_MANAGER UserResourceRole — the same data
      // FloorAdminPage's Managers tab reads via ['floors', floorId,
      // 'managers']. Broad ['floors'] invalidation since the mutation only
      // has the request id in scope here, not the floorId.
      qc.invalidateQueries({ queryKey: ['floors'] })
    },
    // A 409 here almost always means another reviewer already actioned this
    // exact request (canReview admits every building admin of that
    // building, not just one) or the requester withdrew it — without this,
    // the stale card's Approve/Reject buttons stayed exactly as they were,
    // so retrying just reproduced the same error instead of the list
    // correcting itself.
    onError: (err: Error) => { toast.error(err.message); qc.invalidateQueries({ queryKey: ['manager-requests'] }) },
  })
}

export function useRejectManagerRequest() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, reviewNote }: { id: string; reviewNote?: string }) => managerRequestsApi.reject(id, reviewNote),
    onSuccess: () => {
      toast.success('Request declined')
      qc.invalidateQueries({ queryKey: ['manager-requests'] })
    },
    onError: (err: Error) => { toast.error(err.message); qc.invalidateQueries({ queryKey: ['manager-requests'] }) },
  })
}

export function useWithdrawManagerRequest() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => managerRequestsApi.withdraw(id),
    onSuccess: () => {
      toast.success('Request withdrawn')
      qc.invalidateQueries({ queryKey: ['manager-requests'] })
    },
    onError: (err: Error) => { toast.error(err.message); qc.invalidateQueries({ queryKey: ['manager-requests'] }) },
  })
}
