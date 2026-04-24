import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'
import { format, formatDistance } from 'date-fns'
import { getDateFormat } from './dateFormat'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatDate(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date
  return format(d, getDateFormat())
}

export function formatDateTime(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date
  return `${format(d, getDateFormat())} · ${format(d, 'HH:mm')}`
}

export function formatDateRange(start: Date | string, end: Date | string): string {
  const s = typeof start === 'string' ? new Date(start) : start
  const e = typeof end === 'string' ? new Date(end) : end
  const sameDay = format(s, 'yyyy-MM-dd') === format(e, 'yyyy-MM-dd')
  if (sameDay) {
    return `${format(s, getDateFormat())} · ${format(s, 'HH:mm')} – ${format(e, 'HH:mm')}`
  }
  return `${format(s, getDateFormat())} ${format(s, 'HH:mm')} – ${format(e, getDateFormat())} ${format(e, 'HH:mm')}`
}

export function formatRelative(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date
  return formatDistance(d, new Date(), { addSuffix: true })
}

export function toISODateString(date: Date): string {
  return format(date, 'yyyy-MM-dd')
}
