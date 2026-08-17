import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { cn } from '@/lib/utils'
import { settingsApi, authProvidersApi, type LoginProvider } from '@/lib/api'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { CollapsibleCard } from './CollapsibleCard'

export function LoginDisplayCard() {
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
