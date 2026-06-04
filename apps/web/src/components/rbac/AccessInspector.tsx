import { useState } from 'react'
import { useQuery, useMutation } from '@tanstack/react-query'
import { usersApi, buildingsApi, floorsApi, authProvidersApi, type RoleSource, type MappingTestResult } from '@/lib/api'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'

/** Small provenance pill: was this granted by an admin (Manual) or the IdP (Synced)? */
export function SourceBadge({ source }: { source: RoleSource }) {
  return source === 'IDP'
    ? <Badge variant="secondary" className="text-[10px]" title="Synced from your identity provider on login">Synced</Badge>
    : <Badge variant="outline" className="text-[10px]" title="Set manually by an administrator">Manual</Badge>
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1 py-2 border-b last:border-0">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <div className="text-sm">{children}</div>
    </div>
  )
}

// ─── Effective access: "what can this user do, and why?" ─────────────────────
export function EffectiveAccessDialog({
  userId, userName, open, onOpenChange,
}: { userId: string; userName: string; open: boolean; onOpenChange: (v: boolean) => void }) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['effective-access', userId],
    queryFn: () => usersApi.effectiveAccess(userId).then((r) => r.data),
    enabled: open,
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Effective access — {userName}</DialogTitle>
          <DialogDescription>Every permission this user has, and where it comes from.</DialogDescription>
        </DialogHeader>

        {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
        {isError && <p className="text-sm text-destructive">Could not load access details.</p>}
        {data && (
          <div className="max-h-[60vh] overflow-y-auto pr-1">
            <Row label="Global role">
              <span className="inline-flex items-center gap-2">
                <Badge variant={data.globalRole === 'SUPER_ADMIN' ? 'destructive' : 'secondary'}>{data.globalRole}</Badge>
                {data.globalRoleVia && <span className="text-xs text-muted-foreground">{data.globalRoleVia}</span>}
              </span>
            </Row>

            <Row label="Groups">
              {data.groups.length === 0
                ? <span className="text-muted-foreground">None</span>
                : (
                  <ul className="space-y-1">
                    {data.groups.map((g) => (
                      <li key={g.id} className="flex items-center gap-2">
                        <span>{g.name}</span>
                        <SourceBadge source={g.source} />
                        {g.confersAdmin && <Badge variant="destructive" className="text-[10px]">Grants admin</Badge>}
                      </li>
                    ))}
                  </ul>
                )}
            </Row>

            <Row label="Manager roles">
              {data.grants.length === 0
                ? <span className="text-muted-foreground">None</span>
                : (
                  <ul className="space-y-1">
                    {data.grants.map((grant, i) => (
                      <li key={i} className="flex flex-wrap items-center gap-2">
                        <Badge variant="outline" className="text-[10px]">{grant.role.replace('_', ' ')}</Badge>
                        <span>
                          {grant.targetName}
                          {grant.buildingName && <span className="text-muted-foreground"> · {grant.buildingName}</span>}
                        </span>
                        <span className="text-xs text-muted-foreground">({grant.via})</span>
                        <SourceBadge source={grant.source} />
                      </li>
                    ))}
                  </ul>
                )}
            </Row>

            {(data.idp.lastSsoLoginAt || data.idp.lastIdpGroups.length > 0) && (
              <Row label="Last identity-provider login">
                <div className="space-y-1">
                  {data.idp.lastSsoLoginAt && (
                    <p className="text-xs text-muted-foreground">{new Date(data.idp.lastSsoLoginAt).toLocaleString()}</p>
                  )}
                  {data.idp.lastIdpGroups.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {data.idp.lastIdpGroups.map((g) => (
                        <code key={g} className="rounded bg-muted px-1.5 py-0.5 text-[11px]">{g}</code>
                      ))}
                    </div>
                  )}
                </div>
              </Row>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

// ─── Access state badge for a building/floor ─────────────────────────────────
export function AccessStateBadge({ restricted, groupCount }: { restricted: boolean; groupCount: number }) {
  return restricted
    ? <Badge variant="secondary" title={`Restricted to ${groupCount} group(s)`}>🔒 Restricted to {groupCount} group{groupCount === 1 ? '' : 's'}</Badge>
    : <Badge variant="outline" title="Any signed-in user can access">🟢 Open to everyone</Badge>
}

// ─── "Who can access / manage this?" for a building or floor ──────────────────
export function AccessSummaryDialog({
  kind, id, name, open, onOpenChange,
}: { kind: 'building' | 'floor'; id: string; name: string; open: boolean; onOpenChange: (v: boolean) => void }) {
  const { data, isLoading } = useQuery({
    queryKey: ['access-summary', kind, id],
    queryFn: () => (kind === 'building' ? buildingsApi.accessSummary(id) : floorsApi.accessSummary(id)).then((r) => r.data),
    enabled: open,
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Access summary — {name}</DialogTitle>
          <DialogDescription>Who can access and who can manage this {kind}.</DialogDescription>
        </DialogHeader>
        {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
        {data && (
          <div className="space-y-3">
            <Row label="Access">
              <div className="flex items-center gap-2">
                <AccessStateBadge restricted={data.access.restricted} groupCount={data.access.groups.length} />
              </div>
              {data.access.restricted && (
                <ul className="mt-1 list-disc pl-5 text-sm text-muted-foreground">
                  {data.access.groups.map((g) => <li key={g.id}>{g.name}</li>)}
                </ul>
              )}
            </Row>
            <Row label="Managers">
              {data.managers.direct.length === 0 && data.managers.viaGroups.length === 0 && (!data.managers.inheritedFromBuildingAdmins?.length)
                ? <span className="text-muted-foreground">None assigned</span>
                : (
                  <ul className="space-y-1">
                    {data.managers.direct.map((m) => (
                      <li key={m.id} className="flex items-center gap-2">{m.displayName} <span className="text-xs text-muted-foreground">{m.email}</span> <SourceBadge source={m.source} /></li>
                    ))}
                    {data.managers.viaGroups.map((g) => (
                      <li key={g.id} className="flex items-center gap-2">Group “{g.name}” <span className="text-xs text-muted-foreground">({g.memberCount} members)</span> <SourceBadge source={g.source} /></li>
                    ))}
                    {data.managers.inheritedFromBuildingAdmins?.map((m) => (
                      <li key={m.id} className="flex items-center gap-2 text-muted-foreground">{m.displayName} <Badge variant="outline" className="text-[10px]">via building admin</Badge></li>
                    ))}
                  </ul>
                )}
            </Row>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

// ─── IdP mapping dry-run ─────────────────────────────────────────────────────
export function MappingTestPanel({ provider }: { provider: 'OIDC' | 'SAML' | 'LDAP' }) {
  const [groupsText, setGroupsText] = useState('')
  const [result, setResult] = useState<MappingTestResult | null>(null)

  const run = useMutation({
    mutationFn: (groups: string[] | undefined) => authProvidersApi.testMapping(provider, groups ? { groups } : {}).then((r) => r.data),
    onSuccess: (r) => setResult(r),
  })

  const parsedGroups = groupsText.split(/[\n,]/).map((s) => s.trim()).filter(Boolean)

  return (
    <div className="space-y-3 rounded-md border p-3">
      <div>
        <p className="text-sm font-medium">Test group mapping</p>
        <p className="text-xs text-muted-foreground">
          Paste a user’s IdP groups (one per line) to preview which Roomer groups and role they’d receive —
          or leave blank to evaluate against every group value seen across past logins (to spot dead rules).
        </p>
      </div>
      <Textarea
        rows={3}
        placeholder={'cn=Engineering,ou=Groups,dc=example,dc=com\ncn=Admins,ou=Groups,dc=example,dc=com'}
        value={groupsText}
        onChange={(e) => setGroupsText(e.target.value)}
        className="font-mono text-xs"
      />
      <div className="flex gap-2">
        <Button size="sm" variant="outline" onClick={() => run.mutate(parsedGroups.length ? parsedGroups : undefined)} disabled={run.isPending}>
          {run.isPending ? 'Testing…' : 'Run test'}
        </Button>
      </div>

      {result && (
        <div className="space-y-2 text-sm">
          <p className="text-xs text-muted-foreground">
            Evaluated against {result.evaluatedAgainst === 'provided' ? 'the groups you entered' : result.evaluatedAgainst === 'user' ? 'a user’s last login' : 'all groups seen across past logins'}
            {' '}({result.inputGroups.length} group{result.inputGroups.length === 1 ? '' : 's'}).
          </p>
          <p>
            Result:{' '}
            {result.resolvedGroups.length > 0
              ? result.resolvedGroups.map((g) => g.name).join(', ')
              : <span className="text-muted-foreground">no groups</span>}
            {' · role '}
            <Badge variant={result.resolvedGlobalRole === 'SUPER_ADMIN' ? 'destructive' : 'secondary'} className="text-[10px]">{result.resolvedGlobalRole}</Badge>
          </p>
          {result.unmatchedMappings.length > 0 && (
            <div className="rounded bg-amber-50 p-2 text-xs text-amber-800 dark:bg-amber-950 dark:text-amber-200">
              <p className="font-medium">⚠ Mappings that matched nothing (possible typos):</p>
              <ul className="mt-1 list-disc pl-4">
                {result.unmatchedMappings.map((m) => <li key={m}><code>{m}</code></li>)}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
