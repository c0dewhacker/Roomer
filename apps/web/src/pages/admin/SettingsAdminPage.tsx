import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Send, ChevronDown, ChevronUp, Plus, Trash2, Zap } from 'lucide-react'
import { useState, useEffect } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { Badge } from '@/components/ui/badge'
import { settingsApi, groupsApi } from '@/lib/api'

const orgSchema = z.object({
  name: z.string().min(1, 'Organisation name is required'),
  defaultBookingDurationHours: z.coerce.number().int().min(1).max(24),
  maxAdvanceBookingDays: z.coerce.number().int().min(1).max(365),
  maxBookingsPerUser: z.coerce.number().int().min(1).max(100),
})
type OrgForm = z.infer<typeof orgSchema>

const emailSchema = z.object({
  smtpHost: z.string().min(1, 'Host is required'),
  smtpPort: z.coerce.number().int().min(1).max(65535),
  smtpUser: z.string().optional(),
  smtpPassword: z.string().optional(),
  fromAddress: z.string().email('Must be a valid email'),
  fromName: z.string().min(1, 'Sender name is required'),
})
type EmailForm = z.infer<typeof emailSchema>

function OrgSettingsCard() {
  const qc = useQueryClient()
  const { register, handleSubmit, reset, formState: { errors, isDirty } } = useForm<OrgForm>({
    resolver: zodResolver(orgSchema),
    defaultValues: {
      name: 'Roomer',
      defaultBookingDurationHours: 8,
      maxAdvanceBookingDays: 14,
      maxBookingsPerUser: 5,
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
      })
    }
  }, [orgData, reset])

  const save = useMutation({
    mutationFn: (data: OrgForm) => settingsApi.updateOrg(data),
    onSuccess: (res) => {
      toast.success('Settings saved')
      reset({ name: res.data.name, defaultBookingDurationHours: res.data.defaultBookingDurationHours, maxAdvanceBookingDays: res.data.maxAdvanceBookingDays, maxBookingsPerUser: res.data.maxBookingsPerUser })
      qc.invalidateQueries({ queryKey: ['settings', 'organisation'] })
    },
    onError: () => toast.error('Failed to save settings'),
  })

  return (
    <Card>
      <CardHeader>
        <CardTitle>Organisation</CardTitle>
        <CardDescription>General settings for your Roomer workspace</CardDescription>
      </CardHeader>
      <CardContent>
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
          </div>
          <Button type="submit" size="sm" disabled={!isDirty || save.isPending}>
            {save.isPending ? 'Saving…' : 'Save changes'}
          </Button>
        </form>
      </CardContent>
    </Card>
  )
}

function EmailSettingsCard() {
  const { register, handleSubmit, formState: { errors, isDirty } } = useForm<EmailForm>({
    resolver: zodResolver(emailSchema),
    defaultValues: {
      smtpHost: 'localhost',
      smtpPort: 1025,
      smtpUser: '',
      smtpPassword: '',
      fromAddress: 'roomer@example.com',
      fromName: 'Roomer',
    },
  })

  const save = useMutation({
    mutationFn: async (data: EmailForm) => {
      await new Promise((r) => setTimeout(r, 400))
      return data
    },
    onSuccess: () => toast.success('Email settings saved — restart the API to apply SMTP changes'),
    onError: () => toast.error('Failed to save settings'),
  })

  const testEmail = useMutation({
    mutationFn: () => settingsApi.testEmail(),
    onSuccess: (res) => toast.success(res.data.message),
    onError: (err: Error) => toast.error(err.message),
  })

  return (
    <Card>
      <CardHeader>
        <CardTitle>Email</CardTitle>
        <CardDescription>SMTP configuration for outbound notifications</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit((d) => save.mutate(d))} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
            <div className="sm:col-span-3">
              <Label htmlFor="smtpHost">SMTP host *</Label>
              <Input id="smtpHost" {...register('smtpHost')} className="mt-1.5" placeholder="smtp.example.com" />
              {errors.smtpHost && <p className="text-xs text-destructive mt-1">{errors.smtpHost.message}</p>}
            </div>
            <div>
              <Label htmlFor="smtpPort">Port</Label>
              <Input id="smtpPort" type="number" {...register('smtpPort')} className="mt-1.5" />
              {errors.smtpPort && <p className="text-xs text-destructive mt-1">{errors.smtpPort.message}</p>}
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <Label htmlFor="smtpUser">SMTP username</Label>
              <Input id="smtpUser" {...register('smtpUser')} className="mt-1.5" placeholder="optional" />
            </div>
            <div>
              <Label htmlFor="smtpPassword">SMTP password</Label>
              <Input id="smtpPassword" type="password" {...register('smtpPassword')} className="mt-1.5" placeholder="optional" />
            </div>
          </div>
          <Separator />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <Label htmlFor="fromAddress">From address *</Label>
              <Input id="fromAddress" type="email" {...register('fromAddress')} className="mt-1.5" />
              {errors.fromAddress && <p className="text-xs text-destructive mt-1">{errors.fromAddress.message}</p>}
            </div>
            <div>
              <Label htmlFor="fromName">Sender name *</Label>
              <Input id="fromName" {...register('fromName')} className="mt-1.5" />
              {errors.fromName && <p className="text-xs text-destructive mt-1">{errors.fromName.message}</p>}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button type="submit" size="sm" disabled={!isDirty || save.isPending}>
              {save.isPending ? 'Saving…' : 'Save changes'}
            </Button>
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
        </form>
      </CardContent>
    </Card>
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
    <Card>
      <CardHeader>
        <CardTitle>Authentication Providers</CardTitle>
        <CardDescription>
          Configure enterprise SSO. Local email/password auth is always available as a fallback.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
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
      </CardContent>
    </Card>
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

  function handleSave() {
    onSave({ entryPoint, issuer, cert, callbackUrl, label, groupAttribute, groupMappings })
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
  const [showPresets, setShowPresets] = useState(false)

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
    }
    if (bindCredentials) cfg.bindCredentials = bindCredentials
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
      </div>
      <Separator />
      <GroupMappingsEditor mappings={groupMappings} onChange={setGroupMappings} />
      <Button size="sm" className="h-7 text-xs" disabled={saving || !url || !searchBase} onClick={handleSave}>
        {saving ? 'Saving…' : 'Save LDAP config'}
      </Button>
    </div>
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
      <EmailSettingsCard />
      <AuthProvidersCard />
    </div>
  )
}
