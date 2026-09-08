const URL_VARS = new Set(['bookingUrl', 'bookingsUrl', 'queueUrl', 'claimUrl', 'floorUrl', 'appUrl'])

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

export function formatDate(date: Date | string, timeZone = 'UTC'): string {
  const d = new Date(date)
  const formatted = d.toLocaleString('en-GB', { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone })
  const zoneLabel = new Intl.DateTimeFormat('en', { timeZone, timeZoneName: 'short' }).formatToParts(d).find((p) => p.type === 'timeZoneName')?.value ?? timeZone
  return `${formatted} ${zoneLabel}`
}

export function baseHtml(title: string, body: string): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><title>${escapeHtml(title)}</title><style>body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f4f4f5; margin: 0; padding: 20px; }.card { background: #fff; border-radius: 8px; max-width: 560px; margin: 0 auto; padding: 32px; }h1 { font-size: 22px; color: #18181b; margin-top: 0; }p { color: #52525b; line-height: 1.6; }.detail { background: #f4f4f5; border-radius: 6px; padding: 16px; margin: 16px 0; }.detail dt { font-size: 12px; color: #71717a; text-transform: uppercase; letter-spacing: 0.05em; }.detail dd { font-size: 15px; color: #18181b; margin: 2px 0 12px 0; font-weight: 500; }.btn { display: inline-block; background: #6366f1; color: #fff; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 600; margin-top: 16px; }.footer { text-align: center; color: #a1a1aa; font-size: 12px; margin-top: 24px; }</style></head><body><div class="card">${body}<div class="footer">Roomer — Desk &amp; Asset Management</div></div></body></html>`
}

export function interpolateTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    const val = vars[key] ?? ''
    return URL_VARS.has(key) ? val : escapeHtml(val)
  })
}

export function stripHtmlToText(html: string): string {
  return html.replace(/<[^>]*>/g, ' ').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim()
}
