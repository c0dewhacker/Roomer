import { useState, useEffect } from 'react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { TimezoneSelect } from '@/components/TimezoneSelect'

/**
 * Per-building timezone + working-hours override (see #72). Building.timezone
 * and workingHoursStart/End are independent nullable overrides — null means
 * inherit the org default for that field specifically, not "inherit
 * everything as one unit" — but the working-hours pair only makes sense
 * together, so they're shown/cleared as one unit here while timezone stays
 * separate.
 */
export function TimezoneOverrideControl({
  timezone,
  workingHoursStart,
  workingHoursEnd,
  onChangeTimezone,
  onChangeWorkingHours,
  disabled,
}: {
  timezone: string | null | undefined
  workingHoursStart: string | null | undefined
  workingHoursEnd: string | null | undefined
  onChangeTimezone: (v: string | null) => void
  onChangeWorkingHours: (v: { start: string; end: string } | null) => void
  disabled?: boolean
}) {
  const hasHoursOverride = !!(workingHoursStart && workingHoursEnd)
  const [overrideHours, setOverrideHours] = useState(hasHoursOverride)
  const [start, setStart] = useState(workingHoursStart ?? '07:00')
  const [end, setEnd] = useState(workingHoursEnd ?? '19:00')

  useEffect(() => {
    setOverrideHours(hasHoursOverride)
    if (workingHoursStart) setStart(workingHoursStart)
    if (workingHoursEnd) setEnd(workingHoursEnd)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workingHoursStart, workingHoursEnd])

  return (
    <div className="rounded-md border p-3 space-y-3">
      <div>
        <p className="text-sm font-medium">Timezone</p>
        <p className="text-xs text-muted-foreground mb-2">
          Overrides the org default for this building's booking display and working-hours validation.
        </p>
        <TimezoneSelect
          value={timezone ?? 'inherit'}
          onChange={(v) => onChangeTimezone(v === 'inherit' ? null : v)}
          extraOption={{ value: 'inherit', label: 'Inherit org default' }}
          disabled={disabled}
          className="h-8 w-64"
        />
      </div>
      <div>
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            className="h-4 w-4"
            checked={overrideHours}
            disabled={disabled}
            onChange={(e) => {
              setOverrideHours(e.target.checked)
              onChangeWorkingHours(e.target.checked ? { start, end } : null)
            }}
          />
          <span className="text-sm font-medium">Override working hours</span>
        </label>
        {overrideHours && (
          <div className="grid grid-cols-2 gap-3 mt-2 max-w-xs">
            <div>
              <Label className="text-xs">Start</Label>
              <Input
                type="time"
                value={start}
                disabled={disabled}
                onChange={(e) => { setStart(e.target.value); onChangeWorkingHours({ start: e.target.value, end }) }}
                className="mt-1"
              />
            </div>
            <div>
              <Label className="text-xs">End</Label>
              <Input
                type="time"
                value={end}
                disabled={disabled}
                onChange={(e) => { setEnd(e.target.value); onChangeWorkingHours({ start, end: e.target.value }) }}
                className="mt-1"
              />
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
