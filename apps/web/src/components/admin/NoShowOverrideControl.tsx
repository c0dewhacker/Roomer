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

/**
 * Tri-state booking-approval override — same inherit/on/off shape as
 * NoShowOverrideControl, but for building/zone (not floor: the approval
 * override chain is org → building → zone, zone being the most granular
 * level rather than floor — see #74's feasibility assessment).
 */
export function ApprovalOverrideControl({
  scope,
  value,
  onChange,
  disabled,
}: {
  scope: 'building' | 'zone'
  value: Override
  onChange: (v: boolean | null) => void
  disabled?: boolean
}) {
  const current = value === undefined || value === null ? 'inherit' : value ? 'on' : 'off'
  const inheritFrom = scope === 'zone' ? 'building / organisation' : 'organisation'

  return (
    <div className="rounded-md border p-3">
      <p className="text-sm font-medium">Booking approval</p>
      <p className="text-xs text-muted-foreground mb-2">
        Require an admin/floor manager to approve bookings on this {scope} before they're confirmed. “Inherit” uses the {inheritFrom} default.
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
