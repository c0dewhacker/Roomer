import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Bell, CheckCheck } from 'lucide-react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { formatRelative } from '@/lib/utils'
import { notificationsApi } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'

// Every notification type maps to a list page, not a per-entity detail route
// — this app doesn't have one for bookings/queue/assets — so routing only
// needs the notification's type, not the bookingId/queueEntryId in its
// metadata (which isn't even populated for every type).
const NOTIFICATION_ROUTES: Record<string, string> = {
  BOOKING_CONFIRMED: '/bookings',
  BOOKING_CANCELLED: '/bookings',
  BOOKING_CANCELLED_BY_ADMIN: '/bookings',
  BOOKING_NO_SHOW: '/bookings',
  BOOKING_REMINDER: '/bookings',
  QUEUE_JOINED: '/queue',
  QUEUE_PROMOTED: '/queue',
  QUEUE_EXPIRED: '/queue',
  QUEUE_CLAIM_EXPIRING: '/queue',
  ASSET_ASSIGNED: '/assets',
  ASSET_DUE_RETURN: '/assets',
}

const PAGE_SIZE = 30

export function NotificationBell() {
  const [open, setOpen] = useState(false)
  const [page, setPage] = useState(1)
  const qc = useQueryClient()
  const navigate = useNavigate()

  const { data: countData } = useQuery({
    queryKey: ['notifications', 'unread-count'],
    queryFn: () => notificationsApi.unreadCount(),
    refetchInterval: 60 * 1000,
    select: (res) => res.data.count,
  })

  const { data: notificationsRes, isLoading: notificationsLoading } = useQuery({
    queryKey: ['notifications', page],
    queryFn: () => notificationsApi.list({ limit: PAGE_SIZE, page }),
    enabled: open,
    // A new notification can land at any time (a booking gets promoted from
    // the queue, someone cancels a booking on your behalf, etc.) — without
    // this, the sheet only ever shows what was fetched the moment it opened,
    // same staleness the queue-position/claim-deadline UI had before it got
    // the same fix.
    refetchInterval: open ? 30 * 1000 : false,
  })
  const notificationsData = notificationsRes?.data
  const meta = notificationsRes?.meta

  const markAllRead = useMutation({
    mutationFn: () => notificationsApi.markAllRead(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['notifications'] })
    },
  })

  const markRead = useMutation({
    mutationFn: (id: string) => notificationsApi.markRead(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['notifications'] })
    },
  })

  const handleNotificationClick = (n: NonNullable<typeof notificationsData>[number]) => {
    if (!n.read) markRead.mutate(n.id)
    const target = NOTIFICATION_ROUTES[n.type]
    if (target) {
      setOpen(false)
      navigate(target)
    }
  }

  const unread = countData ?? 0

  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        className="relative"
        onClick={() => setOpen(true)}
        aria-label="Notifications"
      >
        <Bell className="h-5 w-5" />
        {unread > 0 && (
          <Badge
            variant="destructive"
            className="absolute -right-1 -top-1 h-5 min-w-[20px] rounded-full px-1 text-xs"
          >
            {unread > 99 ? '99+' : unread}
          </Badge>
        )}
      </Button>

      <Sheet open={open} onOpenChange={(o) => { setOpen(o); if (o) setPage(1) }}>
        <SheetContent side="right" className="w-full max-w-md p-0">
          <SheetHeader className="flex flex-row items-center justify-between border-b px-4 py-3">
            <SheetTitle>Notifications</SheetTitle>
            {unread > 0 && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => markAllRead.mutate()}
                className="h-7 gap-1 text-xs"
              >
                <CheckCheck className="h-3.5 w-3.5" />
                Mark all read
              </Button>
            )}
          </SheetHeader>

          <ScrollArea className="h-[calc(100vh-65px)]">
            {notificationsLoading ? (
              <div className="space-y-0.5 p-4">
                {[1, 2, 3, 4, 5].map((i) => <Skeleton key={i} className="h-14 w-full" />)}
              </div>
            ) : !notificationsData || notificationsData.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
                <Bell className="mb-3 h-10 w-10 opacity-30" />
                <p className="text-sm">No notifications yet</p>
              </div>
            ) : (
              <div className="divide-y">
                {notificationsData.map((n) => {
                  const clickable = !!NOTIFICATION_ROUTES[n.type]
                  return (
                    <button
                      key={n.id}
                      onClick={() => handleNotificationClick(n)}
                      className={cn(
                        'w-full px-4 py-3 text-left transition-colors hover:bg-muted/50',
                        !n.read && 'bg-primary/5',
                        !clickable && !n.read && 'cursor-default',
                      )}
                    >
                      <div className="flex items-start gap-3">
                        {!n.read && (
                          <div className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-primary" />
                        )}
                        <div className={cn('flex-1', n.read && 'ml-5')}>
                          <p className="text-sm font-medium">{n.title}</p>
                          <p className="mt-0.5 text-xs text-muted-foreground">{n.body}</p>
                          <p className="mt-1 text-xs text-muted-foreground">
                            {formatRelative(n.createdAt)}
                          </p>
                        </div>
                      </div>
                    </button>
                  )
                })}
                {meta && meta.totalPages > 1 && (
                  <div className="flex items-center justify-between px-4 py-3 text-sm">
                    <span className="text-muted-foreground">Page {meta.page} of {meta.totalPages}</span>
                    <div className="flex gap-2">
                      <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                        Previous
                      </Button>
                      <Button size="sm" variant="outline" disabled={page >= meta.totalPages} onClick={() => setPage((p) => p + 1)}>
                        Next
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </ScrollArea>
        </SheetContent>
      </Sheet>
    </>
  )
}
