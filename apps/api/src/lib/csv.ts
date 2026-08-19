import type { FastifyReply, FastifyRequest } from 'fastify'

/** True when the client asked for CSV via the Accept header (content
 * negotiation for the analytics endpoints — see #78). Fastify's default
 * Accept parsing isn't used here since we only care about this one
 * substring, not full quality-value negotiation. */
export function wantsCsv(request: FastifyRequest): boolean {
  return (request.headers.accept ?? '').includes('text/csv')
}

/** Same formula-injection guard as the frontend's sanitizeCsvCell
 * (apps/web/src/lib/csv.ts) — a cell starting with =, +, -, @, tab, or CR
 * can be interpreted as a formula by Excel/Sheets/LibreOffice (CWE-1236).
 * Mirrored here since this is a second, independent place CSV gets built
 * (server-side, for direct API consumption) rather than reusing the
 * frontend's copy. */
function sanitizeCsvCell(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value
}

function escapeCsvCell(value: unknown): string {
  const str = value === null || value === undefined ? '' : String(value)
  return `"${sanitizeCsvCell(str).replace(/"/g, '""')}"`
}

/** Send a CSV attachment response — header row + data rows, RFC 4180-ish
 * (CRLF line endings, every cell quoted). */
export function sendCsv(reply: FastifyReply, filename: string, header: string[], rows: unknown[][]): void {
  const lines = [header, ...rows].map((row) => row.map(escapeCsvCell).join(','))
  const csv = lines.join('\r\n') + '\r\n'
  reply
    .header('Content-Type', 'text/csv; charset=utf-8')
    .header('Content-Disposition', `attachment; filename="${filename}"`)
    .send(csv)
}
