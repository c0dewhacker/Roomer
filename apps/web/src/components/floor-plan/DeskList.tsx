import type { AssetWithStatus } from '@/types'
import { Button } from '@/components/ui/button'

export function DeskList({ desks, onSelect }: { desks: AssetWithStatus[]; onSelect: (desk: AssetWithStatus) => void }) {
  if (!desks.length) return <p className="p-6 text-muted-foreground">No desks match these filters.</p>
  return (
    <ul aria-label="Desks and availability" className="divide-y p-4">
      {desks.map((desk) => (
        <li key={desk.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
          <div>
            <p className="font-medium">{desk.bookingLabel || desk.name}</p>
            <p className="text-sm text-muted-foreground">{desk.zoneName} · {desk.bookingStatus === 'mine' ? 'Your booking' : desk.bookingStatus}</p>
          </div>
          <Button variant="outline" onClick={() => onSelect(desk)} aria-label={`View ${desk.bookingLabel || desk.name}, ${desk.bookingStatus}`}>
            View desk
          </Button>
        </li>
      ))}
    </ul>
  )
}
