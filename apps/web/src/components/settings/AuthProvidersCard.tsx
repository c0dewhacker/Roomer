import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { settingsApi, ApiError } from '@/lib/api'
import { CollapsibleCard } from './CollapsibleCard'
import { OidcConfigForm } from './OidcConfigForm'
import { SamlConfigForm } from './SamlConfigForm'
import { LdapConfigForm } from './LdapConfigForm'

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

export function AuthProvidersCard() {
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
    onError: (err: Error) => {
      // Backend field-level errors (e.g. LDAP's "must be ldap:// or ldaps://",
      // SAML's production-signature refine, OIDC's redirectUri origin check)
      // live in error.details.fieldErrors, not the generic top-level message
      // ("Merged config is invalid" / "Invalid config") — same fix already
      // applied to EmailSettingsCard/WebhooksAdminPage, missed here. Without
      // it, an admin got no indication of which field was wrong or why.
      const details = err instanceof ApiError ? (err.fieldErrors ?? err.message) : err.message
      toast.error(details || 'Failed to save')
    },
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
