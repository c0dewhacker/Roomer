import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import type { BrandingBanner } from '@/lib/api'
import { ColorPicker } from './ColorPicker'

export function BannerSection({
  title,
  value,
  onChange,
}: {
  title: string
  value: BrandingBanner
  onChange: (v: BrandingBanner) => void
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <Label className="text-sm font-medium">{title}</Label>
        <button
          type="button"
          role="switch"
          aria-checked={value.enabled}
          onClick={() => onChange({ ...value, enabled: !value.enabled })}
          className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
            value.enabled ? 'bg-primary' : 'bg-input'
          }`}
        >
          <span
            className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform ${
              value.enabled ? 'translate-x-4' : 'translate-x-0.5'
            }`}
          />
        </button>
      </div>

      {value.enabled && (
        <div className="space-y-3 rounded-md border p-3">
          <div>
            <Label className="text-xs">Banner text</Label>
            <Input
              value={value.text}
              onChange={(e) => onChange({ ...value, text: e.target.value })}
              placeholder="Enter banner message…"
              className="mt-1.5"
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <ColorPicker
              label="Background color"
              value={value.bgColor}
              onChange={(bgColor) => onChange({ ...value, bgColor })}
            />
            <ColorPicker
              label="Text color"
              value={value.textColor}
              onChange={(textColor) => onChange({ ...value, textColor })}
            />
          </div>
          {value.text && (
            <div>
              <Label className="text-xs text-muted-foreground">Preview</Label>
              <div
                className="mt-1.5 rounded px-4 py-2 text-center text-sm font-medium"
                style={{ backgroundColor: value.bgColor, color: value.textColor }}
              >
                {value.text}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
