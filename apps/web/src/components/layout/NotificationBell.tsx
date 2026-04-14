import { useState } from 'react'
import { Bell, CheckCheck } from 'lucide-react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { formatRelative } from '@/lib/utils'
import { notificationsApi } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

export function NotificationBell() {
  const [open, setOpen] = useState(false)
  const qc = useQueryClient()

  const { data: countData } = useQuery({
    queryKey: ['notifications', 'unread-count'],
    queryFn: () => notificationsApi.unreadCount(),
    refetchInterval: 60 * 1000,
    select: (res) => res.data.count,
  })

  const { data: notificationsData } = useQuery({
    queryKey: ['notifications'],
    queryFn: () => notificationsApi.list({ limit: 30 }),
    enabled: open,
    select: (res) => res.data,
  })

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

      <Sheet open={open} onOpenChange={setOpen}>
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
            {!notificationsData || notificationsData.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
                <Bell className="mb-3 h-10 w-10 opacity-30" />
                <p className="text-sm">No notifications yet</p>
              </div>
            ) : (
              <div className="divide-y">
                {notificationsData.map((n) => (
                  <button
                    key={n.id}
                    onClick={() => !n.read && markRead.mutate(n.id)}
                    className={cn(
                      'w-full px-4 py-3 text-left transition-colors hover:bg-muted/50',
                      !n.read && 'bg-primary/5',
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
                ))}
              </div>
            )}
          </ScrollArea>
        </SheetContent>
      </Sheet>
    </>
  )
}
