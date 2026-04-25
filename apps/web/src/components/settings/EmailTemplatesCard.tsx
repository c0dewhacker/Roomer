import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { ChevronDown, ChevronUp, RotateCcw, Send, Save, Info } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { emailTemplatesApi } from '@/lib/api'

// ─── Template type metadata ───────────────────────────────────────────────────

const TEMPLATE_TYPES = [
  { value: 'BOOKING_CONFIRMED',          label: 'Booking Confirmed' },
  { value: 'BOOKING_CANCELLED',          label: 'Booking Cancelled (by user)' },
  { value: 'BOOKING_CANCELLED_BY_ADMIN', label: 'Booking Cancelled (by admin)' },
  { value: 'QUEUE_JOINED',               label: 'Queue Joined' },
  { value: 'QUEUE_PROMOTED',             label: 'Queue Promoted (Asset Available)' },
  { value: 'QUEUE_EXPIRED',              label: 'Queue Entry Expired' },
  { value: 'FLOOR_AVAILABLE',            label: 'Desk Available (Floor Subscription)' },
  { value: 'WELCOME',                    label: 'Welcome (Account Created)' },
] as const

const TEMPLATE_VARIABLES: Record<string, Array<{ name: string; description: string }>> = {
  BOOKING_CONFIRMED: [
    { name: 'userName',    description: "Recipient's display name" },
    { name: 'userEmail',   description: "Recipient's email address" },
    { name: 'assetName',   description: 'Asset / desk name' },
    { name: 'zoneName',    description: 'Zone name (empty if unset)' },
    { name: 'floorName',   description: 'Floor name (empty if unset)' },
    { name: 'startsAt',    description: 'Booking start date & time' },
    { name: 'endsAt',      description: 'Booking end date & time' },
    { name: 'notes',       description: 'Booking notes (empty if none)' },
    { name: 'bookingUrl',  description: 'Link to view the booking' },
    { name: 'appUrl',      description: 'Application base URL' },
  ],
  BOOKING_CANCELLED: [
    { name: 'userName',    description: "Recipient's display name" },
    { name: 'userEmail',   description: "Recipient's email address" },
    { name: 'assetName',   description: 'Asset / desk name' },
    { name: 'startsAt',    description: 'Booking start date & time' },
    { name: 'endsAt',      description: 'Booking end date & time' },
    { name: 'bookingsUrl', description: 'Link to the bookings page' },
    { name: 'appUrl',      description: 'Application base URL' },
  ],
  BOOKING_CANCELLED_BY_ADMIN: [
    { name: 'userName',    description: "Recipient's display name" },
    { name: 'userEmail',   description: "Recipient's email address" },
    { name: 'assetName',   description: 'Asset / desk name' },
    { name: 'startsAt',    description: 'Booking start date & time' },
    { name: 'endsAt',      description: 'Booking end date & time' },
    { name: 'bookingsUrl', description: 'Link to the bookings page' },
    { name: 'appUrl',      description: 'Application base URL' },
  ],
  QUEUE_JOINED: [
    { name: 'userName',       description: "Recipient's display name" },
    { name: 'userEmail',      description: "Recipient's email address" },
    { name: 'assetName',      description: 'Asset / desk name' },
    { name: 'position',       description: 'Queue position number' },
    { name: 'wantedStartsAt', description: 'Requested period start' },
    { name: 'wantedEndsAt',   description: 'Requested period end' },
    { name: 'queueUrl',       description: 'Link to the queue page' },
    { name: 'appUrl',         description: 'Application base URL' },
  ],
  QUEUE_PROMOTED: [
    { name: 'userName',       description: "Recipient's display name" },
    { name: 'userEmail',      description: "Recipient's email address" },
    { name: 'assetName',      description: 'Asset / desk name' },
    { name: 'wantedStartsAt', description: 'Requested period start' },
    { name: 'wantedEndsAt',   description: 'Requested period end' },
    { name: 'claimDeadline',  description: 'Deadline to claim the booking' },
    { name: 'claimUrl',       description: 'One-click claim link (no login required)' },
    { name: 'appUrl',         description: 'Application base URL' },
  ],
  QUEUE_EXPIRED: [
    { name: 'userName',       description: "Recipient's display name" },
    { name: 'userEmail',      description: "Recipient's email address" },
    { name: 'assetName',      description: 'Asset / desk name' },
    { name: 'wantedStartsAt', description: 'Requested period start' },
    { name: 'wantedEndsAt',   description: 'Requested period end' },
    { name: 'queueUrl',       description: 'Link to the queue page' },
    { name: 'appUrl',         description: 'Application base URL' },
  ],
  FLOOR_AVAILABLE: [
    { name: 'floorName', description: 'Floor name' },
    { name: 'zoneName',  description: 'Zone name (empty if unset)' },
    { name: 'assetName', description: 'Asset / desk name' },
    { name: 'slotDate',  description: 'Available date (YYYY-MM-DD)' },
    { name: 'floorUrl',  description: 'Link to the floor plan for that date' },
    { name: 'appUrl',    description: 'Application base URL' },
  ],
  WELCOME: [
    { name: 'userName',  description: "Recipient's display name" },
    { name: 'userEmail', description: "Recipient's email address" },
    { name: 'appUrl',    description: 'Application base URL' },
  ],
}

// ─── Variables reference panel ────────────────────────────────────────────────

function VariablesPanel({ type }: { type: string }) {
  const [open, setOpen] = useState(false)
  const vars = TEMPLATE_VARIABLES[type] ?? []
  return (
    <div className="rounded-md border bg-muted/30">
      <button
        type="button"
        className="flex w-full items-center justify-between px-3 py-2 text-sm font-medium"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="flex items-center gap-1.5 text-muted-foreground">
          <Info className="h-3.5 w-3.5" />
          Available variables
        </span>
        {open ? <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" /> : <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />}
      </button>
      {open && (
        <div className="border-t px-3 pb-3 pt-2">
          <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
            {vars.map((v) => (
              <div key={v.name} className="flex items-start gap-2 text-xs">
                <code className="shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-primary">{`{{${v.name}}}`}</code>
                <span className="text-muted-foreground pt-0.5">{v.description}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Template editor ──────────────────────────────────────────────────────────

function TemplateEditor({ type }: { type: string }) {
  const qc = useQueryClient()

  const { data, isLoading } = useQuery({
    queryKey: ['email-template', type],
    queryFn: () => emailTemplatesApi.get(type),
    select: (r) => r.data,
  })

  const [subject, setSubject] = useState<string | null>(null)
  const [html, setHtml] = useState<string | null>(null)

  const currentSubject = subject ?? data?.subject ?? ''
  const currentHtml = html ?? data?.html ?? ''
  const isDirty = subject !== null || html !== null

  const save = useMutation({
    mutationFn: () => emailTemplatesApi.save(type, { subject: currentSubject, html: currentHtml }),
    onSuccess: () => {
      toast.success('Template saved')
      setSubject(null)
      setHtml(null)
      qc.invalidateQueries({ queryKey: ['email-template', type] })
    },
    onError: () => toast.error('Failed to save template'),
  })

  const reset = useMutation({
    mutationFn: () => emailTemplatesApi.reset(type),
    onSuccess: (res) => {
      toast.success('Template reset to default')
      setSubject(null)
      setHtml(null)
      qc.setQueryData(['email-template', type], { data: res.data })
    },
    onError: () => toast.error('Failed to reset template'),
  })

  const sendTest = useMutation({
    mutationFn: () => emailTemplatesApi.sendTest(type, { subject: currentSubject, html: currentHtml }),
    onSuccess: (res) => toast.success(`Test email sent to ${res.data.sentTo}`),
    onError: () => toast.error('Failed to send test email — check your SMTP settings'),
  })

  if (isLoading) {
    return <div className="h-40 animate-pulse rounded-md bg-muted" />
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">
            {TEMPLATE_TYPES.find((t) => t.value === type)?.label}
          </span>
          <Badge variant={data?.isCustom ? 'default' : 'secondary'}>
            {data?.isCustom ? 'Custom' : 'Default'}
          </Badge>
          {isDirty && <Badge variant="outline" className="text-amber-600 border-amber-300">Unsaved changes</Badge>}
        </div>
      </div>

      <VariablesPanel type={type} />

      <div className="space-y-1.5">
        <Label htmlFor="email-subject">Subject line</Label>
        <Input
          id="email-subject"
          value={currentSubject}
          onChange={(e) => setSubject(e.target.value)}
          placeholder="Email subject — supports {{variables}}"
          className="font-mono text-sm"
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="email-html">HTML body</Label>
        <textarea
          id="email-html"
          value={currentHtml}
          onChange={(e) => setHtml(e.target.value)}
          placeholder="Full HTML email body — supports {{variables}}"
          rows={20}
          spellCheck={false}
          className={cn(
            'w-full rounded-md border bg-background px-3 py-2 font-mono text-xs',
            'resize-y focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            'placeholder:text-muted-foreground',
          )}
        />
      </div>

      <div className="flex flex-wrap items-center gap-2 pt-1">
        <Button
          size="sm"
          disabled={save.isPending || !isDirty}
          onClick={() => save.mutate()}
        >
          <Save className="mr-1.5 h-3.5 w-3.5" />
          {save.isPending ? 'Saving…' : 'Save template'}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={reset.isPending || (!data?.isCustom && !isDirty)}
          onClick={() => reset.mutate()}
        >
          <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
          {reset.isPending ? 'Resetting…' : 'Reset to default'}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={sendTest.isPending}
          onClick={() => sendTest.mutate()}
        >
          <Send className="mr-1.5 h-3.5 w-3.5" />
          {sendTest.isPending ? 'Sending…' : 'Send test email'}
        </Button>
      </div>
    </div>
  )
}

// ─── Card ─────────────────────────────────────────────────────────────────────

export function EmailTemplatesCard() {
  const [open, setOpen] = useState(false)
  const [selectedType, setSelectedType] = useState<string | null>(null)

  return (
    <Card>
      <CardHeader
        className="cursor-pointer select-none"
        onClick={() => setOpen((o) => !o)}
      >
        <div className="flex items-center justify-between">
          <div className="space-y-1">
            <CardTitle>Email Templates</CardTitle>
            <CardDescription>Customise the subject and HTML body for each notification email</CardDescription>
          </div>
          <ChevronDown
            className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200', open && 'rotate-180')}
          />
        </div>
      </CardHeader>

      {open && (
        <CardContent className="space-y-4 pt-0">
          <Separator />

          <div className="space-y-1.5">
            <Label>Notification type</Label>
            <Select
              value={selectedType ?? ''}
              onValueChange={(v) => setSelectedType(v || null)}
            >
              <SelectTrigger className="w-full max-w-sm">
                <SelectValue placeholder="Select a template to edit…" />
              </SelectTrigger>
              <SelectContent>
                {TEMPLATE_TYPES.map((t) => (
                  <SelectItem key={t.value} value={t.value}>
                    {t.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {selectedType && (
            <>
              <Separator />
              <TemplateEditor key={selectedType} type={selectedType} />
            </>
          )}
        </CardContent>
      )}
    </Card>
  )
}
