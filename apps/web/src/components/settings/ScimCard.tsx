import { useState, useEffect } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Shield, Copy, Eye, EyeOff, RefreshCw } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { settingsApi } from '@/lib/api'
import { CollapsibleCard } from './CollapsibleCard'

export function ScimCard() {
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
