import { cn } from '@/lib/utils'
import { Input } from './input'

interface DateTimeLocalInputProps {
  value: string
  onChange: (value: string) => void
  min?: string
  className?: string
}

export function DateTimeLocalInput({ value, onChange, min, className }: DateTimeLocalInputProps) {
  const datePart = value ? value.slice(0, 10) : ''
  const timePart = value ? value.slice(11, 16) : ''

  const minDate = min ? min.slice(0, 10) : undefined
  const minTime = min && datePart === minDate ? min.slice(11, 16) : undefined

  const handleDate = (newDate: string) => {
    onChange(`${newDate}T${timePart || '00:00'}`)
  }

  const handleTime = (newTime: string) => {
    if (!datePart) return
    onChange(`${datePart}T${newTime}`)
  }

  return (
    <div className={cn('flex gap-2', className)}>
      <Input
        type="date"
        value={datePart}
        min={minDate}
        onChange={(e) => handleDate(e.target.value)}
        className="flex-1"
      />
      <Input
        type="time"
        value={timePart}
        min={minTime}
        onChange={(e) => handleTime(e.target.value)}
        className="w-28"
      />
    </div>
  )
}
