import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { QrCheckInMode } from '@/types'

type Override = QrCheckInMode | null | undefined

/**
 * Tri-state QR check-in mode override for a building or floor — same shape
 * as NoShowOverrideControl, just with three explicit values instead of a
 * boolean (disabled / optional / mandatory) alongside "inherit".
 */
export function QrCheckInModeControl({
  scope,
  value,
  onChange,
  disabled,
}: {
  scope: 'building' | 'floor'
  value: Override
  onChange: (v: QrCheckInMode | null) => void
  disabled?: boolean
}) {
  const current = value ?? 'inherit'
  const inheritFrom = scope === 'floor' ? 'building / organisation' : 'organisation'

  return (
    <div className="rounded-md border p-3">
      <p className="text-sm font-medium">QR desk check-in</p>
      <p className="text-xs text-muted-foreground mb-2">
        Scan-to-book / check-in via a QR code on this {scope}. “Inherit” uses the {inheritFrom} default.
      </p>
      <Select
        value={current}
        onValueChange={(v) => onChange(v === 'inherit' ? null : (v as QrCheckInMode))}
        disabled={disabled}
      >
        <SelectTrigger className="h-8 w-56"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="inherit">Inherit default</SelectItem>
          <SelectItem value="DISABLED">Disabled (override)</SelectItem>
          <SelectItem value="OPTIONAL">Optional (override)</SelectItem>
          <SelectItem value="MANDATORY">Mandatory (override)</SelectItem>
        </SelectContent>
      </Select>
    </div>
  )
}
