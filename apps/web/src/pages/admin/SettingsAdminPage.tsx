import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Send, ChevronDown, ChevronUp, Plus, Trash2, Zap, Upload, Image as ImageIcon, AlertTriangle, RefreshCw, Copy, Eye, EyeOff, Shield } from 'lucide-react'
import { useState, useEffect, useRef } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { Badge } from '@/components/ui/badge'
import { settingsApi, groupsApi, brandingApi, authProvidersApi, type Branding, type BrandingBanner, type LoginProvider } from '@/lib/api'
import { DATE_FORMAT_OPTIONS } from '@/lib/dateFormat'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

// ─── Collapsible card wrapper ─────────────────────────────────────────────────

function CollapsibleCard({
  title,
  description,
  children,
}: {
  title: string
  description: string
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(false)

  return (
    <Card>
      <CardHeader
        className="cursor-pointer select-none"
        onClick={() => setOpen((o) => !o)}
      >
        <div className="flex items-center justify-between">
          <div className="space-y-1">
            <CardTitle>{title}</CardTitle>
            <CardDescription>{description}</CardDescription>
          </div>
          <ChevronDown
            className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200', open && 'rotate-180')}
          />
        </div>
      </CardHeader>
      {open && <CardContent>{children}</CardContent>}
    </Card>
  )
}

const orgSchema = z.object({
  name: z.string().min(1, 'Organisation name is required'),
  defaultBookingDurationHours: z.coerce.number().int().min(1).max(24),
  maxAdvanceBookingDays: z.coerce.number().int().min(1).max(365),
  maxBookingsPerUser: z.coerce.number().int().min(1).max(100),
  queueClaimWindowHours: z.coerce.number().int().min(1).max(48),
  dateFormat: z.string().min(1),
})
type OrgForm = z.infer<typeof orgSchema>


function OrgSettingsCard() {
  const qc = useQueryClient()
  const { register, handleSubmit, reset, watch, setValue, formState: { errors, isDirty } } = useForm<OrgForm>({
    resolver: zodResolver(orgSchema),
    defaultValues: {
      name: 'Roomer',
      defaultBookingDurationHours: 8,
      maxAdvanceBookingDays: 14,
      maxBookingsPerUser: 5,
      queueClaimWindowHours: 4,
      dateFormat: 'dd/MM/yyyy',
    },
  })

  const { data: orgData } = useQuery({
    queryKey: ['settings', 'organisation'],
    queryFn: () => settingsApi.getOrg(),
    select: (r) => r.data,
  })

  useEffect(() => {
    if (orgData) {
      reset({
        name: orgData.name,
        defaultBookingDurationHours: orgData.defaultBookingDurationHours,
        maxAdvanceBookingDays: orgData.maxAdvanceBookingDays,
        maxBookingsPerUser: orgData.maxBookingsPerUser,
        queueClaimWindowHours: orgData.queueClaimWindowHours ?? 4,
        dateFormat: orgData.dateFormat ?? 'dd/MM/yyyy',
      })
    }
  }, [orgData, reset])

  const save = useMutation({
    mutationFn: (data: OrgForm) => settingsApi.updateOrg(data),
    onSuccess: (res) => {
      toast.success('Settings saved')
      reset({ name: res.data.name, defaultBookingDurationHours: res.data.defaultBookingDurationHours, maxAdvanceBookingDays: res.data.maxAdvanceBookingDays, maxBookingsPerUser: res.data.maxBookingsPerUser, queueClaimWindowHours: res.data.queueClaimWindowHours ?? 4, dateFormat: res.data.dateFormat ?? 'dd/MM/yyyy' })
      qc.invalidateQueries({ queryKey: ['settings', 'organisation'] })
      qc.invalidateQueries({ queryKey: ['settings', 'public'] })
    },
    onError: () => toast.error('Failed to save settings'),
  })

  return (
    <CollapsibleCard title="Organisation" description="General settings for your Roomer workspace">
      <form onSubmit={handleSubmit((d) => save.mutate(d))} className="space-y-4">
        <div>
          <Label htmlFor="orgName">Organisation name *</Label>
          <Input id="orgName" {...register('name')} className="mt-1.5 max-w-sm" />
          {errors.name && <p className="text-xs text-destructive mt-1">{errors.name.message}</p>}
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <Label htmlFor="defaultDuration">Default booking (hours)</Label>
            <Input id="defaultDuration" type="number" min={1} max={24} {...register('defaultBookingDurationHours')} className="mt-1.5" />
            {errors.defaultBookingDurationHours && (
              <p className="text-xs text-destructive mt-1">{errors.defaultBookingDurationHours.message}</p>
            )}
          </div>
          <div>
            <Label htmlFor="advanceDays">Max advance booking (days)</Label>
            <Input id="advanceDays" type="number" min={1} max={365} {...register('maxAdvanceBookingDays')} className="mt-1.5" />
            {errors.maxAdvanceBookingDays && (
              <p className="text-xs text-destructive mt-1">{errors.maxAdvanceBookingDays.message}</p>
            )}
          </div>
          <div>
            <Label htmlFor="maxBookings">Max bookings per user</Label>
            <Input id="maxBookings" type="number" min={1} max={100} {...register('maxBookingsPerUser')} className="mt-1.5" />
            {errors.maxBookingsPerUser && (
              <p className="text-xs text-destructive mt-1">{errors.maxBookingsPerUser.message}</p>
            )}
          </div>
          <div>
            <Label htmlFor="queueClaimWindow">Queue claim window (hours)</Label>
            <Input id="queueClaimWindow" type="number" min={1} max={48} {...register('queueClaimWindowHours')} className="mt-1.5" />
            <p className="text-xs text-muted-foreground mt-1">How long an assigned user's queue promotion stays open before passing to the next person.</p>
            {errors.queueClaimWindowHours && (
              <p className="text-xs text-destructive mt-1">{errors.queueClaimWindowHours.message}</p>
            )}
          </div>
        </div>
        <div>
          <Label htmlFor="dateFormat">Date format</Label>
          <Select value={watch('dateFormat')} onValueChange={(v) => setValue('dateFormat', v, { shouldDirty: true })}>
            <SelectTrigger id="dateFormat" className="mt-1.5 max-w-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DATE_FORMAT_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground mt-1">Controls how dates are displayed across the platform.</p>
        </div>
        <Button type="submit" size="sm" disabled={!isDirty || save.isPending}>
          {save.isPending ? 'Saving…' : 'Save changes'}
        </Button>
      </form>
    </CollapsibleCard>
  )
}

function EmailSettingsCard() {
  const testEmail = useMutation({
    mutationFn: () => settingsApi.testEmail(),
    onSuccess: (res) => toast.success(res.data.message),
    onError: (err: Error) => toast.error(err.message),
  })

  return (
    <CollapsibleCard title="Email" description="SMTP configuration for outbound notifications">
      <div className="space-y-4">
        <div className="rounded-md border bg-muted/40 p-3 text-sm text-muted-foreground">
          SMTP settings are configured via environment variables (<code className="font-mono text-xs">SMTP_HOST</code>,{' '}
          <code className="font-mono text-xs">SMTP_PORT</code>,{' '}
          <code className="font-mono text-xs">SMTP_USER</code>,{' '}
          <code className="font-mono text-xs">SMTP_PASS</code>,{' '}
          <code className="font-mono text-xs">EMAIL_FROM</code>). Update your <code className="font-mono text-xs">.env</code>{' '}
          file and restart the API to change email configuration.
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={testEmail.isPending}
            onClick={() => testEmail.mutate()}
          >
            <Send className="mr-2 h-3.5 w-3.5" />
            {testEmail.isPending ? 'Sending…' : 'Send test email'}
          </Button>
        </div>
      </div>
    </CollapsibleCard>
  )
}

// ─── Group mapping editor ─────────────────────────────────────────────────────

type GroupMapping = { idpGroup: string; roomerGroupId?: string; targetGlobalRole?: string }

function GroupMappingsEditor({
  mappings,
  onChange,
}: {
  mappings: GroupMapping[]
  onChange: (m: GroupMapping[]) => void
}) {
  const { data: groups } = useQuery({
    queryKey: ['groups'],
    queryFn: () => groupsApi.list(),
    select: (r) => r.data,
  })

  function add() {
    onChange([...mappings, { idpGroup: '', roomerGroupId: '', targetGlobalRole: '' }])
  }

  function remove(i: number) {
    onChange(mappings.filter((_, idx) => idx !== i))
  }

  function update(i: number, patch: Partial<GroupMapping>) {
    onChange(mappings.map((m, idx) => (idx === i ? { ...m, ...patch } : m)))
  }

  // When the combined "grant" select changes, set either targetGlobalRole or roomerGroupId
  function updateGrant(i: number, value: string) {
    if (value === 'SUPER_ADMIN' || value === 'USER') {
      update(i, { targetGlobalRole: value, roomerGroupId: '' })
    } else {
      update(i, { roomerGroupId: value, targetGlobalRole: '' })
    }
  }

  // Derive the current select value for a mapping
  function grantValue(m: GroupMapping): string {
    if (m.targetGlobalRole === 'SUPER_ADMIN' || m.targetGlobalRole === 'USER') return m.targetGlobalRole
    return m.roomerGroupId ?? ''
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div>
          <Label className="text-xs font-medium">Group Mappings</Label>
          <p className="text-xs text-muted-foreground mt-0.5">
            Map IdP groups to a Roomer access group or directly to a global role.
          </p>
        </div>
        <Button size="sm" variant="outline" className="h-7 gap-1 px-2 text-xs shrink-0" onClick={add}>
          <Plus className="h-3 w-3" /> Add
        </Button>
      </div>
      {mappings.length === 0 ? (
        <p className="text-xs text-muted-foreground py-1">
          No mappings — all SSO users sign in with the default User role.
        </p>
      ) : (
        <div className="space-y-1.5">
          <div className="grid grid-cols-[1fr_1fr_auto] gap-1.5 text-xs text-muted-foreground px-0.5">
            <span>IdP group</span><span>Grant</span><span />
          </div>
          {mappings.map((m, i) => {
            const val = grantValue(m)
            const isDirectRole = val === 'SUPER_ADMIN' || val === 'USER'
            return (
              <div key={i} className="grid grid-cols-[1fr_1fr_auto] gap-1.5 items-center">
                <Input
                  value={m.idpGroup}
                  onChange={(e) => update(i, { idpGroup: e.target.value })}
                  placeholder="e.g. Admins or CN=Admins,…"
                  className="h-7 text-xs"
                />
                <div className="flex items-center gap-1.5">
                  <select
                    value={val}
                    onChange={(e) => updateGrant(i, e.target.value)}
                    className="h-7 flex-1 min-w-0 rounded-md border border-input bg-background px-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <option value="">— select grant —</option>
                    <optgroup label="Direct role">
                      <option value="SUPER_ADMIN">Administrator (SUPER_ADMIN)</option>
                      <option value="USER">Standard user (USER)</option>
                    </optgroup>
                    {(groups ?? []).length > 0 && (
                      <optgroup label="Roomer access group">
                        {(groups ?? []).map((g) => (
                          <option key={g.id} value={g.id}>
                            {g.name} ({g.globalRole === 'SUPER_ADMIN' ? 'Admin' : 'User'})
                          </option>
                        ))}
                      </optgroup>
                    )}
                  </select>
                  {val && (
                    <span className={`shrink-0 text-xs font-medium px-1.5 py-0.5 rounded ${
                      isDirectRole && val === 'SUPER_ADMIN'
                        ? 'bg-amber-100 text-amber-700'
                        : isDirectRole
                        ? 'bg-muted text-muted-foreground'
                        : (groups ?? []).find((g) => g.id === val)?.globalRole === 'SUPER_ADMIN'
                        ? 'bg-amber-100 text-amber-700'
                        : 'bg-muted text-muted-foreground'
                    }`}>
                      {isDirectRole
                        ? (val === 'SUPER_ADMIN' ? 'Admin' : 'User')
                        : ((groups ?? []).find((g) => g.id === val)?.globalRole === 'SUPER_ADMIN' ? 'Admin' : 'User')
                      }
                    </span>
                  )}
                </div>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7 text-muted-foreground hover:text-destructive"
                  onClick={() => remove(i)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ─── Auth Provider config panels ─────────────────────────────────────────────

function ProviderRow({
  label,
  provider: _provider,
  enabled,
  children,
  onToggle,
  saving,
}: {
  label: string
  provider: string
  enabled: boolean
  children: React.ReactNode
  onToggle: (enabled: boolean) => void
  saving: boolean
}) {
  const [open, setOpen] = useState(false)
  return (
    <div className="rounded-md border">
      <div className="flex items-center justify-between px-3 py-2.5">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">{label}</span>
          <Badge variant={enabled ? 'secondary' : 'outline'} className="text-xs">
            {enabled ? 'Enabled' : 'Disabled'}
          </Badge>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs"
            disabled={saving}
            onClick={() => onToggle(!enabled)}
          >
            {enabled ? 'Disable' : 'Enable'}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => setOpen((o) => !o)}
          >
            {open ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          </Button>
        </div>
      </div>
      {open && <div className="border-t px-3 pb-4 pt-3">{children}</div>}
    </div>
  )
}

function AuthProvidersCard() {
  const qc = useQueryClient()

  const { data: authConfig } = useQuery({
    queryKey: ['settings', 'auth-config'],
    queryFn: () => settingsApi.getAuthConfig(),
    select: (r) => r.data,
  })

  const save = useMutation({
    mutationFn: ({
      provider,
      body,
    }: {
      provider: 'oidc' | 'saml' | 'ldap'
      body: { enabled?: boolean; config?: Record<string, unknown> }
    }) => settingsApi.updateAuthConfig(provider, body),
    onSuccess: () => {
      toast.success('Provider settings saved')
      qc.invalidateQueries({ queryKey: ['settings', 'auth-config'] })
      qc.invalidateQueries({ queryKey: ['auth-providers'] })
    },
    onError: (err: Error) => toast.error(err.message),
  })

  function toggle(provider: 'oidc' | 'saml' | 'ldap', enabled: boolean) {
    save.mutate({ provider, body: { enabled } })
  }

  function saveConfig(provider: 'oidc' | 'saml' | 'ldap', config: Record<string, unknown>) {
    save.mutate({ provider, body: { config } })
  }

  const oidc = authConfig?.['OIDC']
  const saml = authConfig?.['SAML']
  const ldap = authConfig?.['LDAP']

  return (
    <CollapsibleCard
      title="Authentication Providers"
      description="Configure OIDC, SAML, and LDAP enterprise authentication."
    >
      <div className="space-y-3">
        {/* Local */}
        <div className="flex items-center justify-between rounded-md border px-3 py-2.5">
          <span className="text-sm font-medium">Local (email + password)</span>
          <Badge variant="secondary" className="text-xs">Always on</Badge>
        </div>

        {/* OIDC */}
        <ProviderRow
          label="OpenID Connect / OAuth 2.0"
          provider="oidc"
          enabled={oidc?.enabled ?? false}
          onToggle={(v) => toggle('oidc', v)}
          saving={save.isPending}
        >
          <OidcConfigForm
            current={oidc?.config ?? {}}
            onSave={(cfg) => saveConfig('oidc', cfg)}
            saving={save.isPending}
          />
        </ProviderRow>

        {/* SAML */}
        <ProviderRow
          label="SAML 2.0"
          provider="saml"
          enabled={saml?.enabled ?? false}
          onToggle={(v) => toggle('saml', v)}
          saving={save.isPending}
        >
          <SamlConfigForm
            current={saml?.config ?? {}}
            onSave={(cfg) => saveConfig('saml', cfg)}
            saving={save.isPending}
          />
        </ProviderRow>

        {/* LDAP */}
        <ProviderRow
          label="LDAP / Active Directory"
          provider="ldap"
          enabled={ldap?.enabled ?? false}
          onToggle={(v) => toggle('ldap', v)}
          saving={save.isPending}
        >
          <LdapConfigForm
            current={ldap?.config ?? {}}
            onSave={(cfg) => saveConfig('ldap', cfg)}
            saving={save.isPending}
          />
        </ProviderRow>
      </div>
    </CollapsibleCard>
  )
}

function LoginDisplayCard() {
  const qc = useQueryClient()

  const { data: authConfig } = useQuery({
    queryKey: ['settings', 'auth-config'],
    queryFn: () => settingsApi.getAuthConfig(),
    select: (r) => r.data,
  })

  const { data: providers } = useQuery({
    queryKey: ['auth-providers'],
    queryFn: () => authProvidersApi.list(),
    select: (r) => r.data,
  })

  const saveLoginSettings = useMutation({
    mutationFn: (body: { defaultProvider?: LoginProvider | null; showProviderSelector?: boolean }) =>
      settingsApi.updateLoginSettings(body),
    onSuccess: () => {
      toast.success('Login display settings saved')
      qc.invalidateQueries({ queryKey: ['auth-providers'] })
    },
    onError: (err: Error) => toast.error(err.message),
  })

  const oidc = authConfig?.['OIDC']
  const saml = authConfig?.['SAML']
  const ldap = authConfig?.['LDAP']

  const showSelector = providers?.showProviderSelector ?? true
  const defaultProvider = providers?.defaultProvider ?? null

  const enabledProviders: { value: LoginProvider; label: string }[] = [
    { value: 'local', label: 'Local (email + password)' },
    ...(ldap?.enabled ? [{ value: 'ldap' as LoginProvider, label: 'LDAP / Active Directory' }] : []),
    ...(oidc?.enabled ? [{ value: 'oidc' as LoginProvider, label: providers?.oidc.label ?? 'OpenID Connect' }] : []),
    ...(saml?.enabled ? [{ value: 'saml' as LoginProvider, label: providers?.saml.label ?? 'SAML 2.0' }] : []),
  ]

  return (
    <CollapsibleCard
      title="Login Page Display"
      description="Control how the login screen presents authentication options to users."
    >
      <div className="space-y-6">
        {/* Show provider selector toggle */}
        <div className="flex items-start justify-between gap-6">
          <div className="space-y-1">
            <p className="text-sm font-medium">Show provider selector</p>
            <p className="text-xs text-muted-foreground">
              When on, users see all active providers on the login page and can choose.
              When off, they are sent directly to the default provider below.
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={showSelector}
            onClick={() => saveLoginSettings.mutate({ showProviderSelector: !showSelector })}
            disabled={saveLoginSettings.isPending}
            className={cn(
              'mt-0.5 relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50',
              showSelector ? 'bg-primary' : 'bg-input',
            )}
          >
            <span
              className={cn(
                'pointer-events-none block h-4 w-4 rounded-full bg-background shadow-lg ring-0 transition-transform',
                showSelector ? 'translate-x-4' : 'translate-x-0',
              )}
            />
          </button>
        </div>

        <Separator />

        {/* Default provider dropdown */}
        <div className="space-y-2">
          <Label htmlFor="default-provider-select">Default provider</Label>
          <p className="text-xs text-muted-foreground">
            {showSelector
              ? "This provider's sign-in button appears as the primary (filled) option on the login page."
              : 'Users are sent directly to this provider when the selector is turned off.'}
          </p>
          <Select
            value={defaultProvider ?? 'local'}
            onValueChange={(v) => saveLoginSettings.mutate({ defaultProvider: v as LoginProvider })}
            disabled={saveLoginSettings.isPending}
          >
            <SelectTrigger id="default-provider-select" className="w-full max-w-xs">
              <SelectValue placeholder="Select default provider" />
            </SelectTrigger>
            <SelectContent>
              {enabledProviders.map((p) => (
                <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <Separator />

        {/* URL override reference */}
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-muted-foreground">URL fallback overrides</p>
          <p className="text-xs text-muted-foreground">
            Append a query param to the login URL to force a specific provider regardless of these settings — useful for admin recovery or testing.
          </p>
          <div className="flex flex-wrap gap-2 pt-0.5">
            {(['local', 'ldap', 'oidc', 'saml'] as LoginProvider[]).map((p) => (
              <code key={p} className="bg-muted rounded px-2 py-0.5 text-xs">?login_provider={p}</code>
            ))}
          </div>
        </div>
      </div>
    </CollapsibleCard>
  )
}

// ─── OIDC form ────────────────────────────────────────────────────────────────

function OidcConfigForm({
  current,
  onSave,
  saving,
}: {
  current: Record<string, unknown>
  onSave: (cfg: Record<string, unknown>) => void
  saving: boolean
}) {
  const [issuerUrl, setIssuerUrl] = useState((current.issuerUrl as string) ?? '')
  const [clientId, setClientId] = useState((current.clientId as string) ?? '')
  const [clientSecret, setClientSecret] = useState('')
  const [redirectUri, setRedirectUri] = useState(
    (current.redirectUri as string) ?? `${window.location.origin.replace(':5173', ':3001')}/api/v1/auth/oidc/callback`,
  )
  const [scope, setScope] = useState((current.scope as string) ?? 'openid profile email groups')
  const [label, setLabel] = useState((current.label as string) ?? 'Sign in with SSO')
  const [groupsClaimName, setGroupsClaimName] = useState((current.groupsClaimName as string) ?? 'groups')
  const [groupMappings, setGroupMappings] = useState<GroupMapping[]>(
    (current.groupMappings as GroupMapping[]) ?? [],
  )

  function handleSave() {
    const cfg: Record<string, unknown> = {
      issuerUrl, clientId, redirectUri, scope, label, groupsClaimName, groupMappings,
    }
    if (clientSecret) cfg.clientSecret = clientSecret
    onSave(cfg)
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        Works with Entra ID (Azure AD), Okta, Google Workspace, Auth0, and any OIDC-compliant IdP.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="sm:col-span-2">
          <Label className="text-xs">Issuer URL</Label>
          <Input value={issuerUrl} onChange={(e) => setIssuerUrl(e.target.value)} className="mt-1 h-8 text-sm"
            placeholder="https://login.microsoftonline.com/{tenant}/v2.0" />
        </div>
        <div>
          <Label className="text-xs">Client ID</Label>
          <Input value={clientId} onChange={(e) => setClientId(e.target.value)} className="mt-1 h-8 text-sm" />
        </div>
        <div>
          <Label className="text-xs">Client Secret {current.clientSecret ? '(stored — leave blank to keep)' : ''}</Label>
          <Input type="password" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)}
            className="mt-1 h-8 text-sm" placeholder={current.clientSecret ? '••••••••' : ''} />
        </div>
        <div className="sm:col-span-2">
          <Label className="text-xs">Redirect URI (must match IdP app registration)</Label>
          <Input value={redirectUri} onChange={(e) => setRedirectUri(e.target.value)} className="mt-1 h-8 text-sm" />
        </div>
        <div>
          <Label className="text-xs">Scope</Label>
          <Input value={scope} onChange={(e) => setScope(e.target.value)} className="mt-1 h-8 text-sm" />
        </div>
        <div>
          <Label className="text-xs">Button label</Label>
          <Input value={label} onChange={(e) => setLabel(e.target.value)} className="mt-1 h-8 text-sm" />
        </div>
        <div>
          <Label className="text-xs">Groups claim name</Label>
          <Input value={groupsClaimName} onChange={(e) => setGroupsClaimName(e.target.value)}
            className="mt-1 h-8 text-sm" placeholder="groups" />
        </div>
      </div>
      <Separator />
      <GroupMappingsEditor mappings={groupMappings} onChange={setGroupMappings} />
      <Button size="sm" className="h-7 text-xs" disabled={saving || !issuerUrl || !clientId} onClick={handleSave}>
        {saving ? 'Saving…' : 'Save OIDC config'}
      </Button>
    </div>
  )
}

// ─── SAML form ────────────────────────────────────────────────────────────────

function SamlConfigForm({
  current,
  onSave,
  saving,
}: {
  current: Record<string, unknown>
  onSave: (cfg: Record<string, unknown>) => void
  saving: boolean
}) {
  const [entryPoint, setEntryPoint] = useState((current.entryPoint as string) ?? '')
  const [issuer, setIssuer] = useState((current.issuer as string) ?? 'roomer')
  const [cert, setCert] = useState((current.cert as string) ?? '')
  const [callbackUrl, setCallbackUrl] = useState(
    (current.callbackUrl as string) ?? `${window.location.origin.replace(':5173', ':3001')}/api/v1/auth/saml/callback`,
  )
  const [label, setLabel] = useState((current.label as string) ?? 'Sign in with SAML SSO')
  const [groupAttribute, setGroupAttribute] = useState((current.groupAttribute as string) ?? 'groups')
  const [groupMappings, setGroupMappings] = useState<GroupMapping[]>(
    (current.groupMappings as GroupMapping[]) ?? [],
  )
  const [wantAuthnResponseSigned, setWantAuthnResponseSigned] = useState(
    (current.wantAuthnResponseSigned as boolean) ?? true,
  )
  const [wantAssertionsSigned, setWantAssertionsSigned] = useState(
    (current.wantAssertionsSigned as boolean) ?? true,
  )
  const [allowClockSkewMs, setAllowClockSkewMs] = useState(
    (current.allowClockSkewMs as number) ?? 0,
  )

  function handleSave() {
    onSave({ entryPoint, issuer, cert, callbackUrl, label, groupAttribute, groupMappings, wantAuthnResponseSigned, wantAssertionsSigned, allowClockSkewMs })
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        Works with Okta, ADFS, OneLogin, Ping Identity, and any SAML 2.0 IdP.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="sm:col-span-2">
          <Label className="text-xs">IdP Single Sign-On URL (entryPoint)</Label>
          <Input value={entryPoint} onChange={(e) => setEntryPoint(e.target.value)} className="mt-1 h-8 text-sm"
            placeholder="https://idp.example.com/sso/saml" />
        </div>
        <div>
          <Label className="text-xs">Issuer (SP entity ID)</Label>
          <Input value={issuer} onChange={(e) => setIssuer(e.target.value)} className="mt-1 h-8 text-sm" />
        </div>
        <div>
          <Label className="text-xs">Button label</Label>
          <Input value={label} onChange={(e) => setLabel(e.target.value)} className="mt-1 h-8 text-sm" />
        </div>
        <div className="sm:col-span-2">
          <Label className="text-xs">Callback URL (ACS URL — register this with your IdP)</Label>
          <Input value={callbackUrl} onChange={(e) => setCallbackUrl(e.target.value)} className="mt-1 h-8 text-sm" />
        </div>
        <div>
          <Label className="text-xs">Group attribute name</Label>
          <Input value={groupAttribute} onChange={(e) => setGroupAttribute(e.target.value)}
            className="mt-1 h-8 text-sm" placeholder="groups" />
        </div>
        <div className="sm:col-span-2">
          <Label className="text-xs">IdP Certificate (PEM, without headers)</Label>
          <textarea
            value={cert}
            onChange={(e) => setCert(e.target.value)}
            rows={4}
            placeholder="MIIC..."
            className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-xs font-mono resize-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>
      </div>
      <Separator />
      <div>
        <p className="text-xs font-medium mb-2">Security options</p>
        <div className="space-y-2">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={wantAuthnResponseSigned}
              onChange={(e) => setWantAuthnResponseSigned(e.target.checked)}
              className="h-4 w-4 rounded border-border"
            />
            <span className="text-xs font-medium">Require signed SAML response envelope</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={wantAssertionsSigned}
              onChange={(e) => setWantAssertionsSigned(e.target.checked)}
              className="h-4 w-4 rounded border-border"
            />
            <span className="text-xs font-medium">Require signed SAML assertion</span>
          </label>
          {(!wantAuthnResponseSigned || !wantAssertionsSigned) && (
            <div className="rounded-md border border-amber-200 bg-amber-50 dark:bg-amber-950/20 dark:border-amber-800 px-3 py-2 flex items-start gap-2 text-xs text-amber-700 dark:text-amber-400">
              <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
              <span><strong>Security warning:</strong> Disabling signature verification allows unsigned SAML responses to be accepted. Only do this if your IdP cannot sign responses.</span>
            </div>
          )}
          <div className="flex items-center gap-2">
            <label className="text-xs font-medium whitespace-nowrap">Clock skew tolerance (ms)</label>
            <input
              type="number"
              min={0}
              max={300000}
              step={1000}
              value={allowClockSkewMs}
              onChange={(e) => setAllowClockSkewMs(Number(e.target.value))}
              className="h-8 w-28 rounded-md border border-input bg-background px-3 py-1 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            <span className="text-xs text-muted-foreground">0 = strict (recommended)</span>
          </div>
        </div>
      </div>
      <Separator />
      <GroupMappingsEditor mappings={groupMappings} onChange={setGroupMappings} />
      <Button size="sm" className="h-7 text-xs" disabled={saving || !entryPoint || !cert} onClick={handleSave}>
        {saving ? 'Saving…' : 'Save SAML config'}
      </Button>
    </div>
  )
}

// ─── LDAP form ────────────────────────────────────────────────────────────────

const LDAP_PRESETS = [
  {
    label: 'Active Directory (sAMAccountName)',
    hint: 'Login with Windows username (e.g. jsmith)',
    values: {
      searchFilter: '(sAMAccountName={{email}})',
      emailAttribute: 'mail',
      displayNameAttribute: 'displayName',
      groupAttribute: 'memberOf',
    },
  },
  {
    label: 'Active Directory (UPN / email)',
    hint: 'Login with UPN (e.g. jsmith@company.com)',
    values: {
      searchFilter: '(userPrincipalName={{email}})',
      emailAttribute: 'mail',
      displayNameAttribute: 'displayName',
      groupAttribute: 'memberOf',
    },
  },
  {
    label: 'OpenLDAP (uid)',
    hint: 'Login with POSIX uid (e.g. jsmith)',
    values: {
      searchFilter: '(uid={{email}})',
      emailAttribute: 'mail',
      displayNameAttribute: 'cn',
      groupAttribute: 'memberOf',
    },
  },
  {
    label: 'Generic LDAP (mail)',
    hint: 'Login with email address',
    values: {
      searchFilter: '(mail={{email}})',
      emailAttribute: 'mail',
      displayNameAttribute: 'displayName',
      groupAttribute: 'memberOf',
    },
  },
] as const

function LdapConfigForm({
  current,
  onSave,
  saving,
}: {
  current: Record<string, unknown>
  onSave: (cfg: Record<string, unknown>) => void
  saving: boolean
}) {
  const [url, setUrl] = useState((current.url as string) ?? 'ldap://ldap.example.com:389')
  const [bindDN, setBindDN] = useState((current.bindDN as string) ?? '')
  const [bindCredentials, setBindCredentials] = useState('')
  const [searchBase, setSearchBase] = useState((current.searchBase as string) ?? '')
  const [searchFilter, setSearchFilter] = useState(
    (current.searchFilter as string) ?? '(mail={{email}})',
  )
  const [emailAttribute, setEmailAttribute] = useState(
    (current.emailAttribute as string) ?? 'mail',
  )
  const [displayNameAttribute, setDisplayNameAttribute] = useState(
    (current.displayNameAttribute as string) ?? 'displayName',
  )
  const [groupAttribute, setGroupAttribute] = useState(
    (current.groupAttribute as string) ?? 'memberOf',
  )
  const [tlsEnabled, setTlsEnabled] = useState((current.tlsEnabled as boolean) ?? false)
  const [tlsRejectUnauthorized, setTlsRejectUnauthorized] = useState(
    (current.tlsRejectUnauthorized as boolean) ?? true,
  )
  const [groupMappings, setGroupMappings] = useState<GroupMapping[]>(
    (current.groupMappings as GroupMapping[]) ?? [],
  )
  const [syncBase, setSyncBase] = useState((current.syncBase as string) ?? '')
  const [syncFilter, setSyncFilter] = useState((current.syncFilter as string) ?? '(objectClass=person)')
  const [syncScope, setSyncScope] = useState<'sub' | 'one'>((current.syncScope as 'sub' | 'one') ?? 'sub')
  const [deactivateMissing, setDeactivateMissing] = useState((current.deactivateMissing as boolean) ?? false)
  const [showPresets, setShowPresets] = useState(false)

  const syncMutation = useMutation({
    mutationFn: () => settingsApi.syncLdap(),
    onSuccess: (res) => {
      const { created, updated, deactivated, skipped, errors } = res.data
      const parts = [`Created: ${created}`, `Updated: ${updated}`, `Skipped: ${skipped}`]
      if (deactivated) parts.push(`Deactivated: ${deactivated}`)
      if (errors.length) {
        toast.warning(`Sync complete with ${errors.length} error(s). ${parts.join(' · ')}`)
      } else {
        toast.success(`Sync complete. ${parts.join(' · ')}`)
      }
    },
    onError: () => toast.error('LDAP sync failed — check connection settings'),
  })

  function applyPreset(preset: typeof LDAP_PRESETS[number]) {
    setSearchFilter(preset.values.searchFilter)
    setEmailAttribute(preset.values.emailAttribute)
    setDisplayNameAttribute(preset.values.displayNameAttribute)
    setGroupAttribute(preset.values.groupAttribute)
    setShowPresets(false)
  }

  function handleSave() {
    const cfg: Record<string, unknown> = {
      url, bindDN, searchBase, searchFilter, emailAttribute,
      displayNameAttribute, groupAttribute, tlsEnabled, tlsRejectUnauthorized, groupMappings,
      syncFilter, syncScope, deactivateMissing,
    }
    if (bindCredentials) cfg.bindCredentials = bindCredentials
    if (syncBase.trim()) cfg.syncBase = syncBase.trim()
    onSave(cfg)
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        Users log in with their directory credentials via the standard login form.
        Use <code className="bg-muted px-1 rounded text-[11px]">{'{{email}}'}</code> as the placeholder in the search filter — it substitutes what the user typed.
      </p>

      {/* Preset picker */}
      <div className="relative">
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-7 gap-1.5 text-xs"
          onClick={() => setShowPresets((v) => !v)}
        >
          <Zap className="h-3 w-3" />
          Apply preset
          {showPresets ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
        </Button>
        {showPresets && (
          <div className="absolute z-10 mt-1 w-72 rounded-md border bg-popover shadow-md">
            {LDAP_PRESETS.map((p) => (
              <button
                key={p.label}
                type="button"
                className="w-full text-left px-3 py-2 hover:bg-muted transition-colors border-b last:border-0"
                onClick={() => applyPreset(p)}
              >
                <p className="text-xs font-medium">{p.label}</p>
                <p className="text-[11px] text-muted-foreground">{p.hint}</p>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="sm:col-span-2">
          <Label className="text-xs">LDAP URL</Label>
          <Input value={url} onChange={(e) => setUrl(e.target.value)} className="mt-1 h-8 text-sm"
            placeholder="ldap://ldap.example.com:389" />
        </div>
        <div>
          <Label className="text-xs">Bind DN (service account)</Label>
          <Input value={bindDN} onChange={(e) => setBindDN(e.target.value)} className="mt-1 h-8 text-sm"
            placeholder="cn=admin,dc=example,dc=com" />
        </div>
        <div>
          <Label className="text-xs">Bind password {current.bindCredentials ? '(stored — leave blank to keep)' : ''}</Label>
          <Input type="password" value={bindCredentials} onChange={(e) => setBindCredentials(e.target.value)}
            className="mt-1 h-8 text-sm" placeholder={current.bindCredentials ? '••••••••' : ''} />
        </div>
        <div>
          <Label className="text-xs">Search base</Label>
          <Input value={searchBase} onChange={(e) => setSearchBase(e.target.value)} className="mt-1 h-8 text-sm"
            placeholder="ou=users,dc=example,dc=com" />
        </div>
        <div>
          <Label className="text-xs">
            Search filter{' '}
            <span className="font-normal text-muted-foreground">(login identifier mapping)</span>
          </Label>
          <Input value={searchFilter} onChange={(e) => setSearchFilter(e.target.value)}
            className="mt-1 h-8 text-sm font-mono" placeholder="(mail={{email}})" />
        </div>

        <Separator className="sm:col-span-2" />

        <div>
          <Label className="text-xs">
            Email attribute{' '}
            <span className="font-normal text-muted-foreground">(read user's email from LDAP)</span>
          </Label>
          <Input value={emailAttribute} onChange={(e) => setEmailAttribute(e.target.value)}
            className="mt-1 h-8 text-sm" placeholder="mail" />
        </div>
        <div>
          <Label className="text-xs">Display name attribute</Label>
          <Input value={displayNameAttribute} onChange={(e) => setDisplayNameAttribute(e.target.value)}
            className="mt-1 h-8 text-sm" placeholder="displayName" />
        </div>
        <div>
          <Label className="text-xs">Group membership attribute</Label>
          <Input value={groupAttribute} onChange={(e) => setGroupAttribute(e.target.value)}
            className="mt-1 h-8 text-sm" placeholder="memberOf" />
        </div>

        <Separator className="sm:col-span-2" />

        <div className="sm:col-span-2 flex flex-wrap gap-4">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={tlsEnabled}
              onChange={(e) => setTlsEnabled(e.target.checked)}
              className="h-4 w-4 rounded border-border"
            />
            <span className="text-xs font-medium">Use TLS (ldaps://)</span>
          </label>
          {tlsEnabled && (
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={tlsRejectUnauthorized}
                onChange={(e) => setTlsRejectUnauthorized(e.target.checked)}
                className="h-4 w-4 rounded border-border"
              />
              <span className="text-xs font-medium">Verify TLS certificate</span>
            </label>
          )}
        </div>
        {tlsEnabled && !tlsRejectUnauthorized && (
          <div className="rounded-md border border-amber-200 bg-amber-50 dark:bg-amber-950/20 dark:border-amber-800 px-3 py-2 flex items-start gap-2 text-xs text-amber-700 dark:text-amber-400">
            <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            <span><strong>Security warning:</strong> TLS certificate verification is disabled. LDAP connections are vulnerable to man-in-the-middle attacks. Only use this in trusted, isolated networks.</span>
          </div>
        )}
      </div>
      <Separator />
      <GroupMappingsEditor mappings={groupMappings} onChange={setGroupMappings} />

      <Separator />

      {/* Directory sync */}
      <div className="space-y-3">
        <div>
          <p className="text-xs font-medium">Directory Sync</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            Provision users from the directory into Roomer. Uses the service account credentials above.
          </p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="sm:col-span-2">
            <Label className="text-xs">
              Sync base DN{' '}
              <span className="font-normal text-muted-foreground">(defaults to Search base above)</span>
            </Label>
            <Input value={syncBase} onChange={(e) => setSyncBase(e.target.value)} className="mt-1 h-8 text-sm"
              placeholder="ou=staff,dc=example,dc=com" />
          </div>
          <div>
            <Label className="text-xs">Sync filter</Label>
            <Input value={syncFilter} onChange={(e) => setSyncFilter(e.target.value)} className="mt-1 h-8 text-sm font-mono"
              placeholder="(objectClass=person)" />
          </div>
          <div>
            <Label className="text-xs">Search scope</Label>
            <select
              value={syncScope}
              onChange={(e) => setSyncScope(e.target.value as 'sub' | 'one')}
              className="mt-1 h-8 w-full rounded-md border border-input bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <option value="sub">Subtree (recursive)</option>
              <option value="one">One level</option>
            </select>
          </div>
          <div className="sm:col-span-2">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={deactivateMissing}
                onChange={(e) => setDeactivateMissing(e.target.checked)}
                className="h-4 w-4 rounded border-border"
              />
              <span className="text-xs font-medium">Deactivate LDAP users absent from sync results</span>
            </label>
            {deactivateMissing && (
              <p className="mt-1 text-xs text-muted-foreground ml-6">
                Users with provider=LDAP not returned by the sync search will be blocked.
              </p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" className="h-7 text-xs" disabled={saving || !url || !searchBase} onClick={handleSave}>
            {saving ? 'Saving…' : 'Save LDAP config'}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 text-xs gap-1.5"
            disabled={syncMutation.isPending || !url || !searchBase}
            onClick={() => syncMutation.mutate()}
          >
            <RefreshCw className={`h-3 w-3 ${syncMutation.isPending ? 'animate-spin' : ''}`} />
            {syncMutation.isPending ? 'Syncing…' : 'Sync users now'}
          </Button>
        </div>
      </div>
    </div>
  )
}

// ─── SCIM provisioning card ───────────────────────────────────────────────────

function ScimCard() {
  const qc = useQueryClient()
  const [showToken, setShowToken] = useState(false)
  const [newToken, setNewToken] = useState<string | null>(null)

  // Auto-clear the token from state after 60 seconds to reduce exposure in the DOM
  useEffect(() => {
    if (!newToken) return
    const timer = setTimeout(() => setNewToken(null), 60_000)
    return () => clearTimeout(timer)
  }, [newToken])

  const { data: scim } = useQuery({
    queryKey: ['settings', 'scim'],
    queryFn: () => settingsApi.getScim(),
    select: (r) => r.data,
  })

  const toggle = useMutation({
    mutationFn: (enabled: boolean) => settingsApi.patchScim({ enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['settings', 'scim'] }),
    onError: () => toast.error('Failed to update SCIM'),
  })

  const generate = useMutation({
    mutationFn: () => settingsApi.generateScimToken(),
    onSuccess: (res) => {
      setNewToken(res.data.token)
      setShowToken(false)
      qc.invalidateQueries({ queryKey: ['settings', 'scim'] })
    },
    onError: () => toast.error('Failed to generate token'),
  })

  const revoke = useMutation({
    mutationFn: () => settingsApi.revokeScimToken(),
    onSuccess: () => {
      setNewToken(null)
      qc.invalidateQueries({ queryKey: ['settings', 'scim'] })
      toast.success('SCIM token revoked')
    },
    onError: () => toast.error('Failed to revoke token'),
  })

  function copyEndpoint() {
    if (scim?.endpointUrl) {
      navigator.clipboard.writeText(scim.endpointUrl)
      toast.success('Endpoint URL copied')
    }
  }

  function copyToken() {
    if (newToken) {
      navigator.clipboard.writeText(newToken)
      toast.success('Token copied')
    }
  }

  return (
    <CollapsibleCard
      title="SCIM 2.0 Provisioning"
      description="Automatically provision users and groups from Entra ID, Okta, or any SCIM 2.0 IdP"
    >
      <div className="space-y-4">
        <p className="text-xs text-muted-foreground">
          SCIM 2.0 (RFC 7644) lets your identity provider automatically create, update, and deprovision users in Roomer.
          Compatible with Microsoft Entra ID, Okta, OneLogin, and any SCIM 2.0-compliant IdP.
        </p>

        {/* Enable / disable */}
        <div className="flex items-center justify-between rounded-md border px-3 py-2.5">
          <div className="flex items-center gap-2">
            <Shield className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-medium">SCIM provisioning</span>
            <Badge variant={scim?.enabled ? 'secondary' : 'outline'} className="text-xs">
              {scim?.enabled ? 'Enabled' : 'Disabled'}
            </Badge>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs"
            disabled={toggle.isPending || !scim?.hasToken}
            onClick={() => toggle.mutate(!scim?.enabled)}
          >
            {scim?.enabled ? 'Disable' : 'Enable'}
          </Button>
        </div>
        {!scim?.hasToken && (
          <p className="text-xs text-muted-foreground">Generate a bearer token below to enable SCIM.</p>
        )}

        {/* Endpoint URL */}
        {scim?.endpointUrl && (
          <div>
            <Label className="text-xs">SCIM endpoint URL</Label>
            <div className="flex items-center gap-2 mt-1">
              <Input value={scim.endpointUrl} readOnly className="h-8 text-sm font-mono bg-muted" />
              <Button variant="outline" size="icon" className="h-8 w-8 shrink-0" onClick={copyEndpoint}>
                <Copy className="h-3.5 w-3.5" />
              </Button>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Enter this URL as the tenant URL in your IdP's SCIM app configuration.
            </p>
          </div>
        )}

        {/* Token management */}
        <div className="space-y-2">
          <Label className="text-xs">Bearer token</Label>

          {newToken ? (
            <div className="rounded-md border border-amber-200 bg-amber-50 dark:bg-amber-950/20 dark:border-amber-800 p-3 space-y-2">
              <p className="text-xs font-medium text-amber-700 dark:text-amber-400">
                Copy this token now — it will not be shown again.
              </p>
              <div className="flex items-center gap-2">
                <Input
                  value={showToken ? newToken : '•'.repeat(Math.min(newToken.length, 48))}
                  readOnly
                  className="h-8 text-xs font-mono bg-white dark:bg-black"
                />
                <Button variant="outline" size="icon" className="h-8 w-8 shrink-0" onClick={() => setShowToken((v) => !v)}>
                  {showToken ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                </Button>
                <Button variant="outline" size="icon" className="h-8 w-8 shrink-0" onClick={copyToken}>
                  <Copy className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              {scim?.hasToken ? 'A token is configured. Generate a new one to rotate it.' : 'No token configured.'}
            </p>
          )}

          <div className="flex items-center gap-2 pt-1">
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs gap-1.5"
              disabled={generate.isPending}
              onClick={() => generate.mutate()}
            >
              <RefreshCw className={`h-3 w-3 ${generate.isPending ? 'animate-spin' : ''}`} />
              {scim?.hasToken ? 'Rotate token' : 'Generate token'}
            </Button>
            {scim?.hasToken && !newToken && (
              <Button
                size="sm"
                variant="ghost"
                className="h-7 text-xs text-destructive hover:text-destructive"
                disabled={revoke.isPending}
                onClick={() => revoke.mutate()}
              >
                {revoke.isPending ? 'Revoking…' : 'Revoke token'}
              </Button>
            )}
          </div>
        </div>

        {/* Setup guide */}
        <div className="rounded-md border bg-muted/40 p-3 space-y-1.5">
          <p className="text-xs font-medium">Quick setup — Entra ID / Azure AD</p>
          <ol className="text-xs text-muted-foreground space-y-0.5 list-decimal list-inside">
            <li>In Entra ID, go to Enterprise Applications → New application → Non-gallery</li>
            <li>Under Provisioning, set Mode to Automatic</li>
            <li>Enter the endpoint URL above as the Tenant URL</li>
            <li>Paste the bearer token as the Secret Token</li>
            <li>Click Test Connection, then Save and set Provisioning Status to On</li>
          </ol>
        </div>
      </div>
    </CollapsibleCard>
  )
}

// ─── Branding helpers ─────────────────────────────────────────────────────────

function ColorPicker({
  label,
  value,
  onChange,
}: {
  label: string
  value: string
  onChange: (v: string) => void
}) {
  return (
    <div>
      <Label className="text-xs">{label}</Label>
      <div className="flex items-center gap-2 mt-1.5">
        <input
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="h-9 w-10 cursor-pointer rounded border border-input bg-background p-0.5"
        />
        <Input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="h-9 w-28 font-mono text-sm"
          placeholder="#6366f1"
          maxLength={7}
        />
      </div>
    </div>
  )
}

function ImageUpload({
  label,
  hint,
  hasImage,
  imageUrl,
  onUpload,
  uploading,
}: {
  label: string
  hint: string
  hasImage: boolean
  imageUrl: string
  onUpload: (file: File) => void
  uploading: boolean
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  return (
    <div>
      <Label className="text-xs">{label}</Label>
      <div className="flex items-center gap-3 mt-1.5">
        <div className="flex h-16 w-16 items-center justify-center overflow-hidden rounded-md border bg-muted">
          {hasImage ? (
            <img
              src={`${imageUrl}?t=${Date.now()}`}
              alt={label}
              className="max-h-full max-w-full object-contain"
            />
          ) : (
            <ImageIcon className="h-6 w-6 text-muted-foreground" />
          )}
        </div>
        <div className="flex flex-col gap-1.5">
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-8 text-xs"
            disabled={uploading}
            onClick={() => inputRef.current?.click()}
          >
            <Upload className="mr-1.5 h-3.5 w-3.5" />
            {uploading ? 'Uploading…' : hasImage ? 'Replace' : 'Upload'}
          </Button>
          <p className="text-[11px] text-muted-foreground">{hint}</p>
        </div>
        <input
          ref={inputRef}
          type="file"
          accept="image/png,image/jpeg,image/svg+xml,image/webp"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) {
              onUpload(f)
              e.target.value = ''
            }
          }}
        />
      </div>
    </div>
  )
}

function BannerSection({
  title,
  value,
  onChange,
}: {
  title: string
  value: BrandingBanner
  onChange: (v: BrandingBanner) => void
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <Label className="text-sm font-medium">{title}</Label>
        <button
          type="button"
          role="switch"
          aria-checked={value.enabled}
          onClick={() => onChange({ ...value, enabled: !value.enabled })}
          className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
            value.enabled ? 'bg-primary' : 'bg-input'
          }`}
        >
          <span
            className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform ${
              value.enabled ? 'translate-x-4' : 'translate-x-0.5'
            }`}
          />
        </button>
      </div>

      {value.enabled && (
        <div className="space-y-3 rounded-md border p-3">
          <div>
            <Label className="text-xs">Banner text</Label>
            <Input
              value={value.text}
              onChange={(e) => onChange({ ...value, text: e.target.value })}
              placeholder="Enter banner message…"
              className="mt-1.5"
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <ColorPicker
              label="Background color"
              value={value.bgColor}
              onChange={(bgColor) => onChange({ ...value, bgColor })}
            />
            <ColorPicker
              label="Text color"
              value={value.textColor}
              onChange={(textColor) => onChange({ ...value, textColor })}
            />
          </div>
          {value.text && (
            <div>
              <Label className="text-xs text-muted-foreground">Preview</Label>
              <div
                className="mt-1.5 rounded px-4 py-2 text-center text-sm font-medium"
                style={{ backgroundColor: value.bgColor, color: value.textColor }}
              >
                {value.text}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Branding card ────────────────────────────────────────────────────────────

function BrandingCard() {
  const qc = useQueryClient()

  const { data: brandingData } = useQuery({
    queryKey: ['branding'],
    queryFn: () => brandingApi.get(),
    select: (r) => r.data,
  })

  // Local form state
  const [appName, setAppName] = useState('')
  const [sidebarTitle, setSidebarTitle] = useState('')
  const [sidebarSubtitle, setSidebarSubtitle] = useState('')
  const [primaryColor, setPrimaryColor] = useState('#6366f1')
  const [primaryColorDark, setPrimaryColorDark] = useState('#818cf8')
  const [borderRadius, setBorderRadius] = useState<Branding['borderRadius']>('medium')
  const [headerBanner, setHeaderBanner] = useState<BrandingBanner>({
    enabled: false, text: '', bgColor: '#f59e0b', textColor: '#ffffff',
  })
  const [footerBanner, setFooterBanner] = useState<BrandingBanner>({
    enabled: false, text: '', bgColor: '#6366f1', textColor: '#ffffff',
  })

  useEffect(() => {
    if (!brandingData) return
    setAppName(brandingData.appName ?? '')
    setSidebarTitle(brandingData.sidebarTitle ?? '')
    setSidebarSubtitle(brandingData.sidebarSubtitle ?? '')
    setPrimaryColor(brandingData.primaryColor ?? '#6366f1')
    setPrimaryColorDark(brandingData.primaryColorDark ?? '#818cf8')
    setBorderRadius(brandingData.borderRadius ?? 'medium')
    if (brandingData.headerBanner) setHeaderBanner(brandingData.headerBanner)
    if (brandingData.footerBanner) setFooterBanner(brandingData.footerBanner)
  }, [brandingData])

  const save = useMutation({
    mutationFn: () =>
      brandingApi.update({
        appName: appName || undefined,
        sidebarTitle: sidebarTitle || undefined,
        sidebarSubtitle: sidebarSubtitle || undefined,
        primaryColor,
        primaryColorDark,
        borderRadius,
        headerBanner,
        footerBanner,
      }),
    onSuccess: () => {
      toast.success('Branding saved')
      qc.invalidateQueries({ queryKey: ['branding'] })
    },
    onError: () => toast.error('Failed to save branding'),
  })

  const uploadLogo = useMutation({
    mutationFn: (file: File) => brandingApi.uploadLogo(file),
    onSuccess: () => {
      toast.success('Logo uploaded')
      qc.invalidateQueries({ queryKey: ['branding'] })
    },
    onError: () => toast.error('Failed to upload logo'),
  })

  const uploadFavicon = useMutation({
    mutationFn: (file: File) => brandingApi.uploadFavicon(file),
    onSuccess: () => {
      toast.success('Favicon uploaded')
      qc.invalidateQueries({ queryKey: ['branding'] })
    },
    onError: () => toast.error('Failed to upload favicon'),
  })

  const radiusOptions: { value: Branding['borderRadius']; label: string; preview: string }[] = [
    { value: 'sharp', label: 'Sharp', preview: '2px' },
    { value: 'medium', label: 'Medium', preview: '8px' },
    { value: 'large', label: 'Large', preview: '12px' },
  ]

  return (
    <CollapsibleCard title="Branding & Theme" description="Customise the look and feel of your workspace">
      <div className="space-y-6">

        {/* App Identity */}
        <div className="space-y-4">
          <p className="text-sm font-semibold">App Identity</p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <Label htmlFor="appName" className="text-xs">App name</Label>
              <Input
                id="appName"
                value={appName}
                onChange={(e) => setAppName(e.target.value)}
                placeholder="Roomer"
                className="mt-1.5"
              />
              <p className="mt-1 text-[11px] text-muted-foreground">Shown in the top bar</p>
            </div>
            <div>
              <Label htmlFor="sidebarTitle" className="text-xs">Sidebar title</Label>
              <Input
                id="sidebarTitle"
                value={sidebarTitle}
                onChange={(e) => setSidebarTitle(e.target.value)}
                placeholder="Roomer"
                className="mt-1.5"
              />
            </div>
            <div>
              <Label htmlFor="sidebarSubtitle" className="text-xs">Sidebar subtitle</Label>
              <Input
                id="sidebarSubtitle"
                value={sidebarSubtitle}
                onChange={(e) => setSidebarSubtitle(e.target.value)}
                placeholder="Desk Booking"
                className="mt-1.5"
              />
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
            <ImageUpload
              label="Logo"
              hint="PNG, JPG or SVG · max 512×128 px"
              hasImage={!!brandingData?.logoPath}
              imageUrl={brandingApi.getLogoUrl()}
              onUpload={(f) => uploadLogo.mutate(f)}
              uploading={uploadLogo.isPending}
            />
            <ImageUpload
              label="Favicon"
              hint="PNG or ICO · displayed as 64×64 px"
              hasImage={!!brandingData?.faviconPath}
              imageUrl={brandingApi.getFaviconUrl()}
              onUpload={(f) => uploadFavicon.mutate(f)}
              uploading={uploadFavicon.isPending}
            />
          </div>
        </div>

        <Separator />

        {/* Colors */}
        <div className="space-y-4">
          <p className="text-sm font-semibold">Theme Colors</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <ColorPicker label="Primary color (light mode)" value={primaryColor} onChange={setPrimaryColor} />
            <ColorPicker label="Primary color (dark mode)" value={primaryColorDark} onChange={setPrimaryColorDark} />
          </div>
        </div>

        <Separator />

        {/* Border radius */}
        <div className="space-y-3">
          <p className="text-sm font-semibold">Shape</p>
          <div className="flex gap-3">
            {radiusOptions.map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => setBorderRadius(opt.value)}
                className={`flex flex-col items-center gap-1.5 rounded-lg border px-4 py-3 text-xs transition-colors ${
                  borderRadius === opt.value
                    ? 'border-primary bg-primary/5 text-primary font-medium'
                    : 'border-input text-muted-foreground hover:border-muted-foreground'
                }`}
              >
                <div
                  className="h-8 w-14 border-2 border-current bg-muted/50"
                  style={{ borderRadius: opt.preview }}
                />
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        <Separator />

        {/* Banners */}
        <div className="space-y-4">
          <p className="text-sm font-semibold">Banners</p>
          <BannerSection title="Header banner" value={headerBanner} onChange={setHeaderBanner} />
          <BannerSection title="Footer banner" value={footerBanner} onChange={setFooterBanner} />
        </div>

        <Button size="sm" disabled={save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? 'Saving…' : 'Save branding'}
        </Button>
      </div>
    </CollapsibleCard>
  )
}

export default function SettingsAdminPage() {
  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Settings</h1>
        <p className="text-muted-foreground text-sm mt-1">Configure your Roomer workspace</p>
      </div>
      <OrgSettingsCard />
      <BrandingCard />
      <EmailSettingsCard />
      <AuthProvidersCard />
      <LoginDisplayCard />
      <ScimCard />
    </div>
  )
}
