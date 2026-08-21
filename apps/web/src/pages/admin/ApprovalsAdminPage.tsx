import { useState } from 'react'
import { ClipboardCheck, Check, X, Building2, Clock, Repeat } from 'lucide-react'
import { formatDate } from '@/lib/utils'
import { usePendingBookingApprovals, useApproveBooking, useRejectBooking } from '@/hooks/useBookingApprovals'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog'
import type { Booking } from '@/types'

type PendingBooking = Booking & {
  user: { id: string; displayName: string; email: string }
  asset: { id: string; name: string; floor?: { id: string; name: string; building: { id: string; name: string } } }
}

function RejectDialog({
  booking,
  onClose,
}: {
  booking: PendingBooking | null
  onClose: () => void
}) {
  const [note, setNote] = useState('')
  const reject = useRejectBooking()

  return (
    <Dialog open={!!booking} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Decline booking request</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <p className="text-sm text-muted-foreground">
            {booking?.user.displayName} requested <strong>{booking?.asset.name}</strong>
            {booking?.recurringRuleId ? ' (and every occurrence in that recurring series)' : ''}. Let them know why, if useful.
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
              if (!booking) return
              reject.mutate({ id: booking.id, note: note.trim() || undefined }, { onSuccess: () => { setNote(''); onClose() } })
            }}
          >
            {reject.isPending ? 'Declining…' : 'Decline Request'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default function ApprovalsAdminPage() {
  const { data: bookings, isLoading } = usePendingBookingApprovals()
  const approve = useApproveBooking()
  const [rejecting, setRejecting] = useState<PendingBooking | null>(null)

  return (
    <div className="p-6 space-y-6 max-w-4xl">
      <div>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <ClipboardCheck className="h-6 w-6" />
          Booking Approvals
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Review booking requests that need sign-off before they're confirmed, for buildings and floors you manage.
        </p>
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => <Skeleton key={i} className="h-20 w-full" />)}
        </div>
      ) : !bookings || bookings.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            No booking requests are waiting on your approval.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {(bookings as PendingBooking[]).map((b) => (
            <Card key={b.id}>
              <CardContent className="py-4 flex items-start justify-between gap-4">
                <div className="space-y-1.5 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium text-sm">{b.user.displayName}</span>
                    <span className="text-xs text-muted-foreground">{b.user.email}</span>
                    <Badge variant="outline" className="text-xs border-amber-300 text-amber-700 bg-amber-50">
                      Pending approval
                    </Badge>
                    {b.recurringRuleId && (
                      <Badge variant="outline" className="text-xs gap-1">
                        <Repeat className="h-3 w-3" /> Recurring series
                      </Badge>
                    )}
                  </div>
                  <p className="text-sm flex items-center gap-1.5 text-foreground">
                    <Building2 className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                    {b.asset.name}
                    {b.asset.floor && ` · ${b.asset.floor.name}, ${b.asset.floor.building.name}`}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {formatDate(b.startsAt)} – {formatDate(b.endsAt)}
                  </p>
                  {b.notes && <p className="text-sm text-muted-foreground italic">"{b.notes}"</p>}
                  <p className="text-xs text-muted-foreground flex items-center gap-1">
                    <Clock className="h-3 w-3" />
                    {b.approvalExpiresAt && `Auto-rejected if not reviewed by ${formatDate(b.approvalExpiresAt)}`}
                  </p>
                </div>
                <div className="flex gap-2 shrink-0">
                  <Button size="sm" variant="outline" onClick={() => setRejecting(b)}>
                    <X className="h-3.5 w-3.5 mr-1" />
                    Decline
                  </Button>
                  <Button size="sm" disabled={approve.isPending} onClick={() => approve.mutate(b.id)}>
                    <Check className="h-3.5 w-3.5 mr-1" />
                    Approve
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <RejectDialog booking={rejecting} onClose={() => setRejecting(null)} />
    </div>
  )
}
