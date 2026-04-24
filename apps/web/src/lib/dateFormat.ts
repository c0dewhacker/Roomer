import { format } from 'date-fns'

let _dateFormat = 'dd/MM/yyyy'

export const DATE_FORMAT_OPTIONS = [
  { value: 'dd/MM/yyyy', label: 'DD/MM/YYYY  (e.g. 05/01/2025)' },
  { value: 'dd-MM-yyyy', label: 'DD-MM-YYYY  (e.g. 05-01-2025)' },
  { value: 'dd.MM.yyyy', label: 'DD.MM.YYYY  (e.g. 05.01.2025)' },
  { value: 'MM/dd/yyyy', label: 'MM/DD/YYYY  (e.g. 01/05/2025)' },
  { value: 'yyyy-MM-dd', label: 'YYYY-MM-DD  (e.g. 2025-01-05)' },
  { value: 'd MMM yyyy', label: 'D MMM YYYY  (e.g. 5 Jan 2025)' },
  { value: 'MMMM d, yyyy', label: 'Month D, YYYY  (e.g. January 5, 2025)' },
] as const

export type DateFormatValue = (typeof DATE_FORMAT_OPTIONS)[number]['value']

export function setDateFormat(fmt: string): void {
  _dateFormat = fmt
}

export function getDateFormat(): string {
  return _dateFormat
}

export function fmtDate(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date
  return format(d, _dateFormat)
}

export function fmtDateTime(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date
  return `${format(d, _dateFormat)} · ${format(d, 'HH:mm')}`
}

export function fmtDateRange(start: Date | string, end: Date | string): string {
  const s = typeof start === 'string' ? new Date(start) : start
  const e = typeof end === 'string' ? new Date(end) : end
  const sameDay = format(s, 'yyyy-MM-dd') === format(e, 'yyyy-MM-dd')
  if (sameDay) {
    return `${format(s, _dateFormat)} · ${format(s, 'HH:mm')} – ${format(e, 'HH:mm')}`
  }
  return `${format(s, _dateFormat)} ${format(s, 'HH:mm')} – ${format(e, _dateFormat)} ${format(e, 'HH:mm')}`
}
