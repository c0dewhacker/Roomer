import { useState } from 'react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { Button } from '@/components/ui/button'
import { GroupMappingsEditor, type GroupMapping } from './GroupMappingsEditor'

export function OidcConfigForm({
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
  const [departmentClaimName, setDepartmentClaimName] = useState((current.departmentClaimName as string) ?? '')
  const [managerClaimName, setManagerClaimName] = useState((current.managerClaimName as string) ?? '')
  const [groupMappings, setGroupMappings] = useState<GroupMapping[]>(
    (current.groupMappings as GroupMapping[]) ?? [],
  )

  function handleSave() {
    const cfg: Record<string, unknown> = {
      issuerUrl, clientId, redirectUri, scope, label, groupsClaimName, departmentClaimName, managerClaimName, groupMappings,
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
        <div>
          <Label className="text-xs">Department claim name <span className="text-muted-foreground font-normal">(optional)</span></Label>
          <Input value={departmentClaimName} onChange={(e) => setDepartmentClaimName(e.target.value)}
            className="mt-1 h-8 text-sm" placeholder="department" />
        </div>
        <div>
          <Label className="text-xs">Manager claim name <span className="text-muted-foreground font-normal">(optional)</span></Label>
          <Input value={managerClaimName} onChange={(e) => setManagerClaimName(e.target.value)}
            className="mt-1 h-8 text-sm" placeholder="manager (email/UPN)" />
        </div>
      </div>
      <Separator />
      <GroupMappingsEditor mappings={groupMappings} onChange={setGroupMappings} provider="OIDC" />
      <Button size="sm" className="h-7 text-xs" disabled={saving || !issuerUrl || !clientId} onClick={handleSave}>
        {saving ? 'Saving…' : 'Save OIDC config'}
      </Button>
    </div>
  )
}
