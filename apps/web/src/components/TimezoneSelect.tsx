import { useState } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { IANA_TIMEZONES } from '@/lib/timezones'

/**
 * Searchable timezone picker — replaces a plain <Select> rendering all ~420
 * IANA zones as unfiltered SelectItem nodes every time it opens, which was
 * both slow to open and (per Radix's own roving-tabindex/typeahead wiring
 * across that many items) prone to a duplicated-label render glitch. A
 * filtered button list keeps the DOM small and sidesteps Radix's Select
 * primitive for this list entirely.
 */
export function TimezoneSelect({
  value,
  onChange,
  extraOption,
  disabled,
  className,
  id,
}: {
  value: string
  onChange: (v: string) => void
  extraOption?: { value: string; label: string }
  disabled?: boolean
  className?: string
  id?: string
}) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const filtered = IANA_TIMEZONES.filter((tz) => tz.toLowerCase().includes(search.toLowerCase()))
  const displayLabel = extraOption && value === extraOption.value ? extraOption.label : value

  return (
    <Popover open={open} onOpenChange={(o) => { setOpen(o); if (!o) setSearch('') }}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          disabled={disabled}
          className={cn('justify-between font-normal', className)}
        >
          <span className="truncate">{displayLabel || 'Select timezone…'}</span>
          <ChevronDown className="h-4 w-4 opacity-50 shrink-0" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-0" align="start">
        <div className="p-2 border-b">
          <Input
            placeholder="Search timezones…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-8"
            autoFocus
          />
        </div>
        <div className="max-h-64 overflow-y-auto p-1">
          {extraOption && (
            <button
              type="button"
              onClick={() => { onChange(extraOption.value); setOpen(false) }}
              className="flex w-full items-center gap-2 px-2 py-1.5 rounded-sm hover:bg-accent text-sm text-left"
            >
              <Check className={cn('h-3.5 w-3.5 shrink-0', value === extraOption.value ? 'opacity-100' : 'opacity-0')} />
              {extraOption.label}
            </button>
          )}
          {filtered.length === 0 && (
            <p className="text-xs text-muted-foreground px-2 py-3 text-center">No timezones match</p>
          )}
          {filtered.map((tz) => (
            <button
              key={tz}
              type="button"
              onClick={() => { onChange(tz); setOpen(false) }}
              className="flex w-full items-center gap-2 px-2 py-1.5 rounded-sm hover:bg-accent text-sm text-left"
            >
              <Check className={cn('h-3.5 w-3.5 shrink-0', value === tz ? 'opacity-100' : 'opacity-0')} />
              {tz}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}
