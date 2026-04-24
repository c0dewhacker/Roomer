import { useState, useEffect } from 'react'
import { Bell } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { useSubscribeToFloor, useUpdateFloorSubscription, useUnsubscribeFromFloor } from '@/hooks/useSubscriptions'
import type { FloorSubscription } from '@/types'

interface Zone {
  id: string
  name: string
  colour: string
}

interface FloorSubscribeDialogProps {
  open: boolean
  floorId: string
  floorName: string
  zones: Zone[]
  existing: FloorSubscription | null
  onClose: () => void
}

export function FloorSubscribeDialog({
  open,
  floorId,
  floorName,
  zones,
  existing,
  onClose,
}: FloorSubscribeDialogProps) {
  const subscribe = useSubscribeToFloor()
  const update = useUpdateFloorSubscription()
  const unsubscribe = useUnsubscribeFromFloor()

  const existingZoneIds = existing?.zones.map((z) => z.zoneId) ?? []
  const allSelected = existingZoneIds.length === 0

  const [allZones, setAllZones] = useState(allSelected)
  const [selectedZones, setSelectedZones] = useState<Set<string>>(
    new Set(existingZoneIds),
  )

  useEffect(() => {
    if (open) {
      const ids = existing?.zones.map((z) => z.zoneId) ?? []
      setAllZones(ids.length === 0)
      setSelectedZones(new Set(ids))
    }
  }, [open, existing])

  const toggleZone = (id: string) => {
    setAllZones(false)
    setSelectedZones((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }

  const toggleAll = (checked: boolean) => {
    setAllZones(checked)
    if (checked) setSelectedZones(new Set())
  }

  const isPending = subscribe.isPending || update.isPending || unsubscribe.isPending

  const handleSave = () => {
    const zoneIds = allZones ? [] : Array.from(selectedZones)
    if (existing) {
      update.mutate({ id: existing.id, zoneIds }, { onSuccess: onClose })
    } else {
      subscribe.mutate({ floorId, zoneIds }, { onSuccess: onClose })
    }
  }

  const handleUnsubscribe = () => {
    if (existing) {
      unsubscribe.mutate(existing.id, { onSuccess: onClose })
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Bell className="h-4 w-4" />
            {existing ? 'Edit subscription' : `Subscribe to ${floorName}`}
          </DialogTitle>
        </DialogHeader>

        <p className="text-sm text-muted-foreground">
          Get an email when a desk becomes available on this floor.
        </p>

        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <input
              id="all-zones"
              type="checkbox"
              checked={allZones}
              onChange={(e) => toggleAll(e.target.checked)}
              className="h-4 w-4 rounded border-border"
            />
            <Label htmlFor="all-zones" className="font-medium cursor-pointer">All zones</Label>
          </div>

          {zones.length > 0 && (
            <>
              <Separator />
              <div className="space-y-2 max-h-48 overflow-y-auto">
                {zones.map((z) => (
                  <div key={z.id} className="flex items-center gap-2">
                    <input
                      id={`zone-${z.id}`}
                      type="checkbox"
                      checked={!allZones && selectedZones.has(z.id)}
                      onChange={() => toggleZone(z.id)}
                      disabled={allZones}
                      className="h-4 w-4 rounded border-border"
                    />
                    <Label
                      htmlFor={`zone-${z.id}`}
                      className={`flex items-center gap-2 cursor-pointer ${allZones ? 'opacity-40' : ''}`}
                    >
                      <span
                        className="h-3 w-3 rounded-full shrink-0"
                        style={{ backgroundColor: z.colour }}
                      />
                      {z.name}
                    </Label>
                  </div>
                ))}
              </div>
            </>
          )}

          <p className="text-xs text-muted-foreground">
            Notifications are grouped — you'll receive at most one email every 30 minutes per floor.
          </p>
        </div>

        <DialogFooter className="flex-col gap-2 sm:flex-row">
          {existing && (
            <Button
              variant="ghost"
              className="text-destructive hover:text-destructive sm:mr-auto"
              onClick={handleUnsubscribe}
              disabled={isPending}
            >
              Unsubscribe
            </Button>
          )}
          <Button variant="ghost" onClick={onClose} disabled={isPending}>Cancel</Button>
          <Button
            onClick={handleSave}
            disabled={isPending || (!allZones && selectedZones.size === 0)}
          >
            {isPending ? 'Saving…' : existing ? 'Update' : 'Subscribe'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
