import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Send } from 'lucide-react'
import { useState, useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { settingsApi, ApiError } from '@/lib/api'
import { CollapsibleCard } from './CollapsibleCard'

export function EmailSettingsCard() {
  const qc = useQueryClient()
  const { data } = useQuery({
    queryKey: ['settings', 'email'],
    queryFn: () => settingsApi.getEmail(),
    select: (r) => r.data,
  })

  const [host, setHost] = useState('')
  const [port, setPort] = useState('')
  const [secure, setSecure] = useState(false)
  const [user, setUser] = useState('')
  const [from, setFrom] = useState('')
  const [password, setPassword] = useState('')

  useEffect(() => {
    if (data) {
      setHost(data.host)
      setPort(data.port != null ? String(data.port) : '')
      setSecure(data.secure)
      setUser(data.user)
      setFrom(data.from)
      setPassword('')
    }
  }, [data])

  const ov = data?.envOverrides
  const eff = data?.effective

  // Same drift as leases/branding: an out-of-range port only ever surfaces
  // as the backend's generic "Validation failed" unless we mirror its
  // min/max here (1-65535, matching emailConfigSchema in settings.ts) and
  // catch it before the round trip.
  const portNum = port === '' ? null : Number(port)
  const portError = portNum !== null && (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535)
    ? 'Port must be a whole number between 1 and 65535'
    : null

  const isDirty = !!data && (
    host !== (data.host ?? '') ||
    port !== (data.port != null ? String(data.port) : '') ||
    secure !== data.secure ||
    user !== (data.user ?? '') ||
    from !== (data.from ?? '') ||
    password !== ''
  )

  const save = useMutation({
    mutationFn: () => settingsApi.updateEmail({
      host: host || undefined,
      port: port ? Number(port) : undefined,
      secure,
      user: user || undefined,
      from: from || undefined,
      ...(password ? { password } : {}),
    }),
    onSuccess: () => { toast.success('Email settings saved'); setPassword(''); qc.invalidateQueries({ queryKey: ['settings', 'email'] }) },
    onError: (err: Error) => {
      const details = err instanceof ApiError ? (err.fieldErrors ?? err.message) : err.message
      toast.error(details || 'Failed to save')
    },
  })

  const testEmail = useMutation({
    mutationFn: () => settingsApi.testEmail(),
    onSuccess: (res) => toast.success(res.data.message),
    onError: (err: Error) => toast.error(err.message),
  })

  const anyEnvOverride = ov && Object.values(ov).some(Boolean)

  return (
    <CollapsibleCard title="Email" description="SMTP configuration for outbound notifications">
      <div className="space-y-4">
        {anyEnvOverride && (
          <div className="rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground">
            Some fields are set by environment variables and take precedence over these settings (shown locked). Unset the matching <code className="font-mono">SMTP_*</code> / <code className="font-mono">EMAIL_FROM</code> env var and restart the API to edit them here.
          </div>
        )}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <Label className="text-xs">SMTP host</Label>
            <Input value={ov?.host ? (eff?.host ?? '') : host} onChange={(e) => setHost(e.target.value)} disabled={ov?.host} className="mt-1 h-8 text-sm" placeholder="smtp.example.com" />
            {ov?.host && <p className="text-[11px] text-muted-foreground mt-1">Set by environment</p>}
          </div>
          <div>
            <Label className="text-xs">Port</Label>
            <Input
              type="number"
              min={1}
              max={65535}
              value={ov?.port ? String(eff?.port ?? '') : port}
              onChange={(e) => setPort(e.target.value)}
              disabled={ov?.port}
              className="mt-1 h-8 text-sm"
              placeholder="587"
            />
            {ov?.port && <p className="text-[11px] text-muted-foreground mt-1">Set by environment</p>}
            {!ov?.port && portError && <p className="text-[11px] text-destructive mt-1">{portError}</p>}
          </div>
          <div>
            <Label className="text-xs">Username</Label>
            <Input value={ov?.user ? (eff?.user ?? '') : user} onChange={(e) => setUser(e.target.value)} disabled={ov?.user} className="mt-1 h-8 text-sm" placeholder="(optional)" />
            {ov?.user && <p className="text-[11px] text-muted-foreground mt-1">Set by environment</p>}
          </div>
          <div>
            <Label className="text-xs">Password</Label>
            <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} disabled={ov?.pass} className="mt-1 h-8 text-sm" placeholder={ov?.pass ? 'Set by environment' : (data?.hasPassword ? '•••••••• (unchanged)' : '(optional)')} />
            {ov?.pass && <p className="text-[11px] text-muted-foreground mt-1">Set by environment</p>}
          </div>
          <div>
            <Label className="text-xs">From address</Label>
            <Input value={ov?.from ? (eff?.from ?? '') : from} onChange={(e) => setFrom(e.target.value)} disabled={ov?.from} className="mt-1 h-8 text-sm" placeholder="noreply@example.com" />
            {ov?.from && <p className="text-[11px] text-muted-foreground mt-1">Set by environment</p>}
          </div>
          <div className="flex items-end">
            <label className="flex items-center gap-2 text-sm h-8">
              <input type="checkbox" className="h-4 w-4" checked={ov?.secure ? (eff?.secure ?? false) : secure} onChange={(e) => setSecure(e.target.checked)} disabled={ov?.secure} />
              <span>Use TLS (secure)</span>
            </label>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button type="button" size="sm" disabled={save.isPending || !isDirty || !!portError} onClick={() => save.mutate()}>
            {save.isPending ? 'Saving…' : 'Save email settings'}
          </Button>
          <Button type="button" variant="outline" size="sm" disabled={testEmail.isPending} onClick={() => testEmail.mutate()}>
            <Send className="mr-2 h-3.5 w-3.5" />
            {testEmail.isPending ? 'Sending…' : 'Send test email'}
          </Button>
          {isDirty && !portError && <Badge variant="outline" className="text-amber-600 border-amber-300">Unsaved changes</Badge>}
        </div>
      </div>
    </CollapsibleCard>
  )
}
