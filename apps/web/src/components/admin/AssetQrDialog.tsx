import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'

/** Admin dialog: generates the desk's QR code (client-side, no network call —
 * the code just encodes a URL) for printing/sticking on the physical desk. */
export function AssetQrDialog({
  assetId,
  assetName,
  open,
  onClose,
}: {
  assetId: string
  assetName: string
  open: boolean
  onClose: () => void
}) {
  const [dataUrl, setDataUrl] = useState<string | null>(null)
  const scanUrl = `${window.location.origin}/qr/${assetId}`

  useEffect(() => {
    if (!open) return
    let cancelled = false
    QRCode.toDataURL(scanUrl, { width: 512, margin: 2 }).then((url) => {
      if (!cancelled) setDataUrl(url)
    })
    return () => { cancelled = true }
  }, [open, scanUrl])

  function download() {
    if (!dataUrl) return
    const a = document.createElement('a')
    a.href = dataUrl
    a.download = `${assetName.replace(/[^a-z0-9]/gi, '_')}-qr.png`
    a.click()
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>QR code — {assetName}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col items-center gap-3 py-2">
          {dataUrl ? (
            <img src={dataUrl} alt={`QR code for ${assetName}`} className="w-56 h-56" />
          ) : (
            <div className="w-56 h-56 animate-pulse bg-muted rounded" />
          )}
          <p className="text-xs text-muted-foreground text-center break-all">{scanUrl}</p>
          <p className="text-xs text-muted-foreground text-center">
            Print and stick this on the desk. Scanning it opens the booking/check-in page for this asset — only
            works while QR check-in is enabled for this desk's floor/building/organisation in Settings.
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Close</Button>
          <Button onClick={download} disabled={!dataUrl}>Download PNG</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
