import { useState } from 'react'
import { Plus, Trash2, Send, Eye, CheckCircle2, XCircle, Pencil } from 'lucide-react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { webhooksApi, type WebhookEndpoint, type WebhookDelivery } from '@/lib/api'
import { toast } from 'sonner'
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
  Sheet, SheetContent, SheetHeader, SheetTitle,
} from '@/components/ui/sheet'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'

// ─── Toggle (matches ProfilePage notification preference style) ───────────────

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`
        relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full
        transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring
        ${checked ? 'bg-primary' : 'bg-input'}
      `}
    >
      <span
        className={`
          pointer-events-none block h-4 w-4 rounded-full bg-background shadow-lg ring-0 transition-transform
          ${checked ? 'translate-x-4' : 'translate-x-0.5'}
        `}
      />
    </button>
  )
}

// ─── Endpoint form dialog ─────────────────────────────────────────────────────

function EndpointDialog({
  open,
  onClose,
  endpoint,
  allEvents,
}: {
  open: boolean
  onClose: () => void
  endpoint?: WebhookEndpoint
  allEvents: string[]
}) {
  const qc = useQueryClient()
  const isEdit = !!endpoint
  const [url, setUrl] = useState(endpoint?.url ?? '')
  const [secret, setSecret] = useState('')
  const [enabled, setEnabled] = useState(endpoint?.enabled ?? true)
  const [selectedEvents, setSelectedEvents] = useState<Set<string>>(
    new Set(endpoint?.events ?? []),
  )

  function toggleEvent(event: string) {
    setSelectedEvents((prev) => {
      const next = new Set(prev)
      if (next.has(event)) next.delete(event)
      else next.add(event)
      return next
    })
  }

  function toggleGroup(events: string[]) {
    const allSelected = events.every((e) => selectedEvents.has(e))
    setSelectedEvents((prev) => {
      const next = new Set(prev)
      if (allSelected) events.forEach((e) => next.delete(e))
      else events.forEach((e) => next.add(e))
      return next
    })
  }

  const save = useMutation({
    mutationFn: () => {
      const body = { url, events: [...selectedEvents], ...(secret ? { secret } : {}), enabled }
      return isEdit
        ? webhooksApi.update(endpoint!.id, body)
        : webhooksApi.create(body)
    },
    onSuccess: (data) => {
      if (!isEdit) {
        const created = (data as { data: WebhookEndpoint & { secret: string } }).data
        toast.success(`Endpoint created. Secret: ${created.secret}`, { duration: 15000, description: 'Copy this secret now — it will not be shown again.' })
      } else {
        toast.success('Endpoint updated')
      }
      qc.invalidateQueries({ queryKey: ['webhooks'] })
      onClose()
    },
    onError: () => toast.error(isEdit ? 'Failed to update endpoint' : 'Failed to create endpoint'),
  })

  const grouped = allEvents.reduce<Record<string, string[]>>((acc, e) => {
    const prefix = e.split('.')[0]
    ;(acc[prefix] ??= []).push(e)
    return acc
  }, {})

  const canSave = url.trim().length > 0 && selectedEvents.size > 0

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Edit Endpoint' : 'Add Webhook Endpoint'}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-1">
          <div>
            <Label htmlFor="ep-url">URL *</Label>
            <Input id="ep-url" className="mt-1.5" placeholder="https://example.com/webhook" value={url} onChange={(e) => setUrl(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="ep-secret">{isEdit ? 'New secret (leave blank to keep existing)' : 'Secret (optional — auto-generated if blank)'}</Label>
            <Input id="ep-secret" className="mt-1.5" type="password" placeholder={isEdit ? 'Leave blank to keep existing' : 'Auto-generated'} value={secret} onChange={(e) => setSecret(e.target.value)} />
          </div>
          <div className="flex items-center gap-3">
            <Toggle checked={enabled} onChange={setEnabled} />
            <Label htmlFor="ep-enabled" className="cursor-pointer" onClick={() => setEnabled((v) => !v)}>Enabled</Label>
          </div>
          <div>
            <Label>Events *</Label>
            <div className="mt-2 space-y-3 rounded-md border p-3 max-h-64 overflow-y-auto">
              {Object.entries(grouped).map(([prefix, events]) => (
                <div key={prefix}>
                  <div className="flex items-center gap-3 mb-2">
                    <Toggle
                      checked={events.every((e) => selectedEvents.has(e))}
                      onChange={() => toggleGroup(events)}
                    />
                    <span className="text-sm font-medium capitalize">{prefix}</span>
                  </div>
                  <div className="ml-12 space-y-2">
                    {events.map((e) => (
                      <div key={e} className="flex items-center gap-3">
                        <Toggle checked={selectedEvents.has(e)} onChange={() => toggleEvent(e)} />
                        <span className="text-xs font-mono">{e}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => save.mutate()} disabled={!canSave || save.isPending}>
            {save.isPending ? 'Saving…' : isEdit ? 'Save changes' : 'Create endpoint'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ─── Delivery log sheet ───────────────────────────────────────────────────────

function DeliveryLogSheet({ endpoint, onClose }: { endpoint: WebhookEndpoint; onClose: () => void }) {
  const [page, setPage] = useState(1)
  const { data, isLoading } = useQuery({
    queryKey: ['webhook-deliveries', endpoint.id, page],
    queryFn: () => webhooksApi.deliveries(endpoint.id, page),
    select: (r) => r,
  })

  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full sm:max-w-2xl overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="truncate">Deliveries — {endpoint.url}</SheetTitle>
        </SheetHeader>
        <div className="mt-4">
          {isLoading ? (
            <div className="space-y-2">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-9 w-full" />)}</div>
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Status</TableHead>
                    <TableHead>Event</TableHead>
                    <TableHead>Code</TableHead>
                    <TableHead>Attempt</TableHead>
                    <TableHead>Time</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data?.data.length === 0 ? (
                    <TableRow><TableCell colSpan={5} className="text-center text-muted-foreground py-8">No deliveries yet</TableCell></TableRow>
                  ) : data?.data.map((d: WebhookDelivery) => (
                    <TableRow key={d.id}>
                      <TableCell>{d.success ? <CheckCircle2 className="h-4 w-4 text-green-500" /> : <XCircle className="h-4 w-4 text-destructive" />}</TableCell>
                      <TableCell className="font-mono text-xs">{d.event}</TableCell>
                      <TableCell>{d.statusCode ?? '—'}</TableCell>
                      <TableCell>{d.attempt}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{new Date(d.createdAt).toLocaleString()}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {data?.meta && data.meta.totalPages > 1 && (
                <div className="flex items-center justify-between mt-3 text-sm">
                  <span className="text-muted-foreground">Page {data.meta.page} of {data.meta.totalPages}</span>
                  <div className="flex gap-2">
                    <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</Button>
                    <Button size="sm" variant="outline" disabled={page >= data.meta.totalPages} onClick={() => setPage((p) => p + 1)}>Next</Button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function WebhooksAdminPage() {
  const qc = useQueryClient()
  const [showCreate, setShowCreate] = useState(false)
  const [editing, setEditing] = useState<WebhookEndpoint | null>(null)
  const [deleting, setDeleting] = useState<WebhookEndpoint | null>(null)
  const [viewingDeliveries, setViewingDeliveries] = useState<WebhookEndpoint | null>(null)

  const { data: endpoints, isLoading } = useQuery({
    queryKey: ['webhooks'],
    queryFn: () => webhooksApi.list(),
    select: (r) => r.data,
  })

  const { data: allEvents = [] } = useQuery({
    queryKey: ['webhook-events'],
    queryFn: () => webhooksApi.listEvents(),
    select: (r) => r.data,
  })

  const deleteEndpoint = useMutation({
    mutationFn: (id: string) => webhooksApi.delete(id),
    onSuccess: () => {
      toast.success('Endpoint deleted')
      qc.invalidateQueries({ queryKey: ['webhooks'] })
      setDeleting(null)
    },
    onError: () => toast.error('Failed to delete endpoint'),
  })

  const ping = useMutation({
    mutationFn: (id: string) => webhooksApi.ping(id),
    onSuccess: () => toast.success('Ping sent'),
    onError: () => toast.error('Ping failed'),
  })

  const toggleEnabled = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      webhooksApi.update(id, { enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['webhooks'] }),
    onError: () => toast.error('Failed to update endpoint'),
  })

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">Webhooks</h1>
          <p className="text-muted-foreground text-sm mt-1">Manage webhook endpoints and delivery history</p>
        </div>
        <Button onClick={() => setShowCreate(true)} size="sm">
          <Plus className="h-4 w-4 mr-2" />
          Add endpoint
        </Button>
      </div>

      <Card className="mb-6">
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-4 space-y-3">
              {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}
            </div>
          ) : endpoints?.length === 0 ? (
            <p className="text-center text-muted-foreground py-12">No webhook endpoints configured.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>URL</TableHead>
                  <TableHead>Events</TableHead>
                  <TableHead>Enabled</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {endpoints?.map((ep) => (
                  <TableRow key={ep.id}>
                    <TableCell className="font-mono text-sm max-w-xs truncate">{ep.url}</TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1 max-w-xs">
                        {ep.events.slice(0, 4).map((e) => (
                          <Badge key={e} variant="secondary" className="text-xs font-mono">{e}</Badge>
                        ))}
                        {ep.events.length > 4 && (
                          <Badge variant="outline" className="text-xs">+{ep.events.length - 4} more</Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Toggle
                        checked={ep.enabled}
                        onChange={(v) => toggleEnabled.mutate({ id: ep.id, enabled: v })}
                      />
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        <Button size="icon" variant="ghost" title="View deliveries" onClick={() => setViewingDeliveries(ep)}>
                          <Eye className="h-4 w-4" />
                        </Button>
                        <Button size="icon" variant="ghost" title="Send ping" onClick={() => ping.mutate(ep.id)} disabled={ping.isPending}>
                          <Send className="h-4 w-4" />
                        </Button>
                        <Button size="icon" variant="ghost" title="Edit" onClick={() => setEditing(ep)}>
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button size="icon" variant="ghost" title="Delete" onClick={() => setDeleting(ep)}>
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {showCreate && (
        <EndpointDialog open onClose={() => setShowCreate(false)} allEvents={allEvents} />
      )}

      {editing && (
        <EndpointDialog open onClose={() => setEditing(null)} endpoint={editing} allEvents={allEvents} />
      )}

      {viewingDeliveries && (
        <DeliveryLogSheet endpoint={viewingDeliveries} onClose={() => setViewingDeliveries(null)} />
      )}

      <AlertDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete endpoint?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete the endpoint <span className="font-mono">{deleting?.url}</span> and all its delivery history.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => deleting && deleteEndpoint.mutate(deleting.id)}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
