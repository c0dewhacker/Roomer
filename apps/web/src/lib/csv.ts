// Cell values (display names, emails, department/building/floor/zone names) can
// contain arbitrary user-controlled text. If a cell starts with =, +, -, @, tab,
// or CR, Excel/Sheets/LibreOffice may interpret it as a formula when the file is
// opened — a stored CSV/formula-injection vector (CWE-1236). Prefixing with a
// leading apostrophe forces spreadsheet apps to treat the cell as literal text.
export function sanitizeCsvCell(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value
}

export function toCsv(rows: string[][]): string {
  return rows.map((r) => r.map((v) => `"${sanitizeCsvCell(String(v)).replace(/"/g, '""')}"`).join(',')).join('\n')
}

export function downloadCsv(filename: string, rows: string[][]) {
  const csv = toCsv(rows)
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}
