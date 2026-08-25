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
    onError: (err: Error) => toast.error(err.message),
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
    onError: (err: Error) => toast.error(err.message),
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
    onError: (err: Error) => toast.error(err.message),
  })
}
