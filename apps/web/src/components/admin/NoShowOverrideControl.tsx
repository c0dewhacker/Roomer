import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

type Override = boolean | null | undefined

/**
 * Tri-state no-show release override for a building or floor.
 *   Inherit (null) → use the parent scope's setting (floor → building → org)
 *   On (true) / Off (false) → explicit override
 */
export function NoShowOverrideControl({
  scope,
  value,
  onChange,
  disabled,
}: {
  scope: 'building' | 'floor'
  value: Override
  onChange: (v: boolean | null) => void
  disabled?: boolean
}) {
  const current = value === undefined || value === null ? 'inherit' : value ? 'on' : 'off'
  const inheritFrom = scope === 'floor' ? 'building / organisation' : 'organisation'

  return (
    <div className="rounded-md border p-3">
      <p className="text-sm font-medium">No-show release</p>
      <p className="text-xs text-muted-foreground mb-2">
        Auto-release un-checked-in bookings on this {scope}. “Inherit” uses the {inheritFrom} default.
      </p>
      <Select
        value={current}
        onValueChange={(v) => onChange(v === 'inherit' ? null : v === 'on')}
        disabled={disabled}
      >
        <SelectTrigger className="h-8 w-44"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="inherit">Inherit default</SelectItem>
          <SelectItem value="on">On (override)</SelectItem>
          <SelectItem value="off">Off (override)</SelectItem>
        </SelectContent>
      </Select>
    </div>
  )
}
