import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { toast } from 'sonner'
import { ChevronDown, ChevronUp, Zap, AlertTriangle, RefreshCw } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { Button } from '@/components/ui/button'
import { settingsApi } from '@/lib/api'
import { GroupMappingsEditor, type GroupMapping } from './GroupMappingsEditor'

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

export function LdapConfigForm({
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
  const [departmentAttribute, setDepartmentAttribute] = useState(
    (current.departmentAttribute as string) ?? '',
  )
  const [managerAttribute, setManagerAttribute] = useState(
    (current.managerAttribute as string) ?? '',
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
    onError: (err: Error) => toast.error(err.message),
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
    cfg.syncBase = syncBase.trim() || null
    if (departmentAttribute.trim()) cfg.departmentAttribute = departmentAttribute.trim()
    if (managerAttribute.trim()) cfg.managerAttribute = managerAttribute.trim()
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
        <div>
          <Label className="text-xs">Department attribute <span className="text-muted-foreground font-normal">(optional)</span></Label>
          <Input value={departmentAttribute} onChange={(e) => setDepartmentAttribute(e.target.value)}
            className="mt-1 h-8 text-sm" placeholder="department" />
          <p className="text-[11px] text-muted-foreground mt-1">Syncs the user's department on login and during directory sync.</p>
        </div>
        <div>
          <Label className="text-xs">Manager attribute <span className="text-muted-foreground font-normal">(optional)</span></Label>
          <Input value={managerAttribute} onChange={(e) => setManagerAttribute(e.target.value)}
            className="mt-1 h-8 text-sm" placeholder="manager" />
          <p className="text-[11px] text-muted-foreground mt-1">The DN attribute pointing to the user's manager (e.g. <code>manager</code>). Builds the org chart on sync.</p>
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
      <GroupMappingsEditor mappings={groupMappings} onChange={setGroupMappings} provider="LDAP" />

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
