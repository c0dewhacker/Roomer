import { useState, useEffect, useRef, useMemo } from 'react'
import { Upload, Image as ImageIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'

export function ImageUpload({
  label,
  hint,
  hasImage,
  imageUrl,
  onUpload,
  uploading,
}: {
  label: string
  hint: string
  hasImage: boolean
  imageUrl: string
  onUpload: (file: File) => void
  uploading: boolean
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  // Increment rev when upload completes (uploading true→false) to bust the browser cache.
  const [rev, setRev] = useState(0)
  const prevUploadingRef = useRef(uploading)
  useEffect(() => {
    if (prevUploadingRef.current && !uploading) setRev((r) => r + 1)
    prevUploadingRef.current = uploading
  }, [uploading])
  const cacheBustedUrl = useMemo(() => `${imageUrl}?t=${rev}`, [imageUrl, rev])
  return (
    <div>
      <Label className="text-xs">{label}</Label>
      <div className="flex items-center gap-3 mt-1.5">
        <div className="flex h-16 w-16 items-center justify-center overflow-hidden rounded-md border bg-muted">
          {hasImage ? (
            <img
              src={cacheBustedUrl}
              alt={label}
              className="max-h-full max-w-full object-contain"
            />
          ) : (
            <ImageIcon className="h-6 w-6 text-muted-foreground" />
          )}
        </div>
        <div className="flex flex-col gap-1.5">
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-8 text-xs"
            disabled={uploading}
            onClick={() => inputRef.current?.click()}
          >
            <Upload className="mr-1.5 h-3.5 w-3.5" />
            {uploading ? 'Uploading…' : hasImage ? 'Replace' : 'Upload'}
          </Button>
          <p className="text-[11px] text-muted-foreground">{hint}</p>
        </div>
        <input
          ref={inputRef}
          type="file"
          accept="image/png,image/jpeg,image/svg+xml,image/webp"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) {
              onUpload(f)
              e.target.value = ''
            }
          }}
        />
      </div>
    </div>
  )
}
