import { useMemo, useState } from 'react'
import QRCode from 'qrcode'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import type { Asset } from '@/types'

interface QrAsset {
  id: string
  name: string
  bookingLabel?: string
}

// Asset name/label are admin-controlled but still arbitrary strings (e.g. via
// CSV import) — win.document.write() renders them as raw HTML, so this must
// escape the same way mailer.ts's escapeHtml does for email bodies.
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** Admin bulk action: generates a print-ready sheet of QR codes (one per
 * selected desk) with dashed cut-guides, opened in a new tab so the
 * browser's native print dialog (Save as PDF or an actual printer) handles
 * output — no PDF-authoring library needed for that (pdfjs-dist, already a
 * dependency elsewhere in this app, only reads/renders PDFs, it can't
 * generate one). */
export function BulkQrDialog({ assets, open, onClose }: { assets: Asset[]; open: boolean; onClose: () => void }) {
  const eligible = useMemo<QrAsset[]>(
    () => assets
      .filter((a) => a.isBookable && a.floorId)
      .map((a) => ({ id: a.id, name: a.name, bookingLabel: a.bookingLabel }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    [assets],
  )
  const [selected, setSelected] = useState<Set<string>>(() => new Set(eligible.map((a) => a.id)))
  const [generating, setGenerating] = useState(false)

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function generate() {
    const targets = eligible.filter((a) => selected.has(a.id))
    if (targets.length === 0) return
    setGenerating(true)
    try {
      const origin = window.location.origin
      const cards = await Promise.all(
        targets.map(async (a) => ({
          ...a,
          dataUrl: await QRCode.toDataURL(`${origin}/qr/${a.id}`, { width: 300, margin: 1 }),
        })),
      )

      const win = window.open('', '_blank')
      if (!win) return
      win.document.write(`<!doctype html>
<html><head><title>Desk QR codes</title>
<style>
  @page { margin: 12mm; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; margin: 0; padding: 16px; }
  .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 0; }
  .card {
    border: 1px dashed #999;
    padding: 16px;
    text-align: center;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    break-inside: avoid;
  }
  .card img { width: 140px; height: 140px; }
  .card .name { font-size: 14px; font-weight: 600; }
  .card .label { font-size: 11px; color: #666; }
</style>
</head><body>
  <div class="grid">
    ${cards.map((c) => `
      <div class="card">
        <img src="${c.dataUrl}" alt="QR code for ${escapeHtml(c.name)}" />
        <div class="name">${escapeHtml(c.name)}</div>
        ${c.bookingLabel ? `<div class="label">${escapeHtml(c.bookingLabel)}</div>` : ''}
      </div>
    `).join('')}
  </div>
</body></html>`)
      win.document.close()
      win.onload = () => win.print()
    } finally {
      setGenerating(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Bulk QR codes</DialogTitle>
          <DialogDescription>
            Select which bookable desks to include. Opens a print-ready sheet in a new tab — use your browser's
            print dialog to print it or save as PDF.
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-80 overflow-y-auto space-y-1 border rounded-md p-2">
          {eligible.length === 0 ? (
            <p className="text-sm text-muted-foreground p-2">No bookable, placed desks found.</p>
          ) : eligible.map((a) => (
            <label key={a.id} className="flex items-center gap-2 text-sm px-2 py-1 rounded hover:bg-muted cursor-pointer">
              <input
                type="checkbox"
                className="h-4 w-4"
                checked={selected.has(a.id)}
                onChange={() => toggle(a.id)}
              />
              <span>{a.name}</span>
            </label>
          ))}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Close</Button>
          <Button onClick={generate} disabled={generating || selected.size === 0}>
            {generating ? 'Generating…' : `Generate (${selected.size})`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
