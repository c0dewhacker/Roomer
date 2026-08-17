import { useQuery } from '@tanstack/react-query'
import { Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { groupsApi } from '@/lib/api'
import { MappingTestPanel } from '@/components/rbac/AccessInspector'

export type GroupMapping = { idpGroup: string; roomerGroupId?: string; targetGlobalRole?: string }

export function GroupMappingsEditor({
  mappings,
  onChange,
  provider,
}: {
  mappings: GroupMapping[]
  onChange: (m: GroupMapping[]) => void
  provider: 'OIDC' | 'SAML' | 'LDAP'
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
      <MappingTestPanel provider={provider} />
    </div>
  )
}
