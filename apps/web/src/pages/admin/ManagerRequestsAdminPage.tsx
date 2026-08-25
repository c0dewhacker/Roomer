import { useState } from 'react'
import { ShieldPlus, Check, X, Building2, Clock } from 'lucide-react'
import { formatDate } from '@/lib/utils'
import { useManagerRequestsAdmin, useApproveManagerRequest, useRejectManagerRequest } from '@/hooks/useManagerRequests'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog'
import type { FloorManagerRequest, ManagerRequestStatus } from '@/types'

const STATUS_LABEL: Record<ManagerRequestStatus, string> = {
  PENDING: 'Pending',
  APPROVED: 'Approved',
  REJECTED: 'Declined',
  CANCELLED: 'Withdrawn',
  EXPIRED: 'Expired',
}

const STATUS_CLASS: Record<ManagerRequestStatus, string> = {
  PENDING: 'bg-yellow-100 text-yellow-800 border-yellow-200',
  APPROVED: 'bg-green-100 text-green-800 border-green-200',
  REJECTED: 'bg-red-100 text-red-700 border-red-200',
  CANCELLED: 'bg-slate-100 text-slate-600 border-slate-200',
  EXPIRED: 'bg-slate-100 text-slate-500 border-slate-200',
}

function RejectDialog({
  request,
  onClose,
}: {
  request: FloorManagerRequest | null
  onClose: () => void
}) {
  const [note, setNote] = useState('')
  const reject = useRejectManagerRequest()

  return (
    <Dialog open={!!request} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Decline access request</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <p className="text-sm text-muted-foreground">
            {request?.user?.displayName} requested floor manager access to{' '}
            <strong>{request?.floor?.name}</strong>. Let them know why, if useful.
          </p>
          <Textarea
            placeholder="Optional note for the requester…"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            className="resize-none"
          />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            variant="destructive"
            disabled={reject.isPending}
            onClick={() => {
              if (!request) return
              reject.mutate({ id: request.id, reviewNote: note.trim() || undefined }, { onSuccess: () => { setNote(''); onClose() } })
            }}
          >
            {reject.isPending ? 'Declining…' : 'Decline Request'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default function ManagerRequestsAdminPage() {
  const [statusFilter, setStatusFilter] = useState<ManagerRequestStatus | 'all'>('PENDING')
  const { data: requests, isLoading } = useManagerRequestsAdmin(statusFilter)
  const approve = useApproveManagerRequest()
  const [rejecting, setRejecting] = useState<FloorManagerRequest | null>(null)

  return (
    <div className="p-6 space-y-6 max-w-4xl">
      <div>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <ShieldPlus className="h-6 w-6" />
          Manager Access Requests
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Review self-service requests for floor manager access.
        </p>
      </div>

      <Tabs value={statusFilter} onValueChange={(v) => setStatusFilter(v as ManagerRequestStatus | 'all')}>
        <TabsList>
          <TabsTrigger value="PENDING">Pending</TabsTrigger>
          <TabsTrigger value="APPROVED">Approved</TabsTrigger>
          <TabsTrigger value="REJECTED">Declined</TabsTrigger>
          <TabsTrigger value="all">All</TabsTrigger>
        </TabsList>
      </Tabs>

      {isLoading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => <Skeleton key={i} className="h-20 w-full" />)}
        </div>
      ) : !requests || requests.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            No {statusFilter === 'all' ? '' : STATUS_LABEL[statusFilter as ManagerRequestStatus].toLowerCase()} requests.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {requests.map((r) => (
            <Card key={r.id}>
              <CardContent className="py-4 flex items-start justify-between gap-4">
                <div className="space-y-1.5 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium text-sm">{r.user?.displayName}</span>
                    <span className="text-xs text-muted-foreground">{r.user?.email}</span>
                    <Badge variant="outline" className={`text-xs border ${STATUS_CLASS[r.status]}`}>
                      {STATUS_LABEL[r.status]}
                    </Badge>
                  </div>
                  <p className="text-sm flex items-center gap-1.5 text-foreground">
                    <Building2 className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                    {r.floor?.name}, {r.floor?.building.name}
                  </p>
                  {r.note && <p className="text-sm text-muted-foreground italic">"{r.note}"</p>}
                  {r.status === 'REJECTED' && r.reviewNote && (
                    <p className="text-xs text-muted-foreground">Reason: {r.reviewNote}</p>
                  )}
                  <p className="text-xs text-muted-foreground flex items-center gap-1">
                    <Clock className="h-3 w-3" />
                    Requested {formatDate(r.createdAt)}
                    {r.status === 'PENDING' && ` · expires ${formatDate(r.expiresAt)}`}
                    {r.reviewedAt && r.reviewedBy && ` · reviewed by ${r.reviewedBy.displayName} on ${formatDate(r.reviewedAt)}`}
                  </p>
                </div>
                {r.status === 'PENDING' && (
                  <div className="flex gap-2 shrink-0">
                    <Button size="sm" variant="outline" onClick={() => setRejecting(r)}>
                      <X className="h-3.5 w-3.5 mr-1" />
                      Decline
                    </Button>
                    <Button size="sm" disabled={approve.isPending} onClick={() => approve.mutate(r.id)}>
                      <Check className="h-3.5 w-3.5 mr-1" />
                      Approve
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <RejectDialog request={rejecting} onClose={() => setRejecting(null)} />
    </div>
  )
}
