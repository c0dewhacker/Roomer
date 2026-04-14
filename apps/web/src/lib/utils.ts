import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'
import { format, formatDistance } from 'date-fns'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatDate(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date
  return format(d, 'PPP')
}

export function formatDateTime(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date
  return format(d, 'PPp')
}

export function formatDateRange(start: Date | string, end: Date | string): string {
  const s = typeof start === 'string' ? new Date(start) : start
  const e = typeof end === 'string' ? new Date(end) : end
  const sameDay = format(s, 'yyyy-MM-dd') === format(e, 'yyyy-MM-dd')
  if (sameDay) {
    return `${format(s, 'PPP')} · ${format(s, 'p')} – ${format(e, 'p')}`
  }
  return `${format(s, 'PPP p')} – ${format(e, 'PPP p')}`
}

export function formatRelative(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date
  return formatDistance(d, new Date(), { addSuffix: true })
}

export function toISODateString(date: Date): string {
  return format(date, 'yyyy-MM-dd')
}
