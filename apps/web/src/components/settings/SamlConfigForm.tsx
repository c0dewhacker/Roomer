import { useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { Button } from '@/components/ui/button'
import { GroupMappingsEditor, type GroupMapping } from './GroupMappingsEditor'

export function SamlConfigForm({
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
  const [departmentAttribute, setDepartmentAttribute] = useState((current.departmentAttribute as string) ?? '')
  const [managerAttribute, setManagerAttribute] = useState((current.managerAttribute as string) ?? '')
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
    const cfg: Record<string, unknown> = { entryPoint, issuer, cert, callbackUrl, label, groupAttribute, groupMappings, wantAuthnResponseSigned, wantAssertionsSigned, allowClockSkewMs }
    if (departmentAttribute.trim()) cfg.departmentAttribute = departmentAttribute.trim()
    if (managerAttribute.trim()) cfg.managerAttribute = managerAttribute.trim()
    onSave(cfg)
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
        <div>
          <Label className="text-xs">Department attribute name <span className="text-muted-foreground font-normal">(optional)</span></Label>
          <Input value={departmentAttribute} onChange={(e) => setDepartmentAttribute(e.target.value)}
            className="mt-1 h-8 text-sm" placeholder="department" />
          <p className="text-[11px] text-muted-foreground mt-1">Maps to Roomer departments on login. Falls back to the Microsoft identity claim if blank.</p>
        </div>
        <div>
          <Label className="text-xs">Manager attribute name <span className="text-muted-foreground font-normal">(optional)</span></Label>
          <Input value={managerAttribute} onChange={(e) => setManagerAttribute(e.target.value)}
            className="mt-1 h-8 text-sm" placeholder="manager (email/UPN)" />
          <p className="text-[11px] text-muted-foreground mt-1">Builds the org chart. Falls back to the Microsoft manager claim if blank.</p>
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
      <GroupMappingsEditor mappings={groupMappings} onChange={setGroupMappings} provider="SAML" />
      <Button size="sm" className="h-7 text-xs" disabled={saving || !entryPoint || !cert} onClick={handleSave}>
        {saving ? 'Saving…' : 'Save SAML config'}
      </Button>
    </div>
  )
}
