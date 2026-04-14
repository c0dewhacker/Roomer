import { Monitor } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { Badge } from '@/components/ui/badge'
import type { AssetWithStatus } from '@/types'

const STATUS_BG: Record<string, string> = {
  available:    'bg-green-500 hover:bg-green-600',
  mine:         'bg-blue-500 hover:bg-blue-600',
  booked:       'bg-red-400 hover:bg-red-500',
  restricted:   'bg-orange-400 hover:bg-orange-500',
  disabled:     'bg-slate-300 hover:bg-slate-400',
  queued:       'bg-yellow-400 hover:bg-yellow-500',
  promoted:     'bg-emerald-500 hover:bg-emerald-600',
  zone_conflict:'bg-orange-500 hover:bg-orange-600',
}

const STATUS_DOT: Record<string, string> = {
  available:    'bg-green-500',
  mine:         'bg-blue-500',
  booked:       'bg-red-400',
  restricted:   'bg-orange-400',
  disabled:     'bg-slate-300',
  queued:       'bg-yellow-400',
  promoted:     'bg-emerald-500',
  zone_conflict:'bg-orange-500',
}

const STATUS_LABEL: Record<string, string> = {
  available:    'Available',
  mine:         'Your booking',
  booked:       'Booked',
  restricted:   'Restricted',
  disabled:     'Disabled',
  queued:       'In queue',
  promoted:     'Claim available!',
  zone_conflict:'Zone conflict',
}

interface DeskMarkerProps {
  desk: AssetWithStatus
  bgWidth: number
  bgHeight: number
  stageX: number
  stageY: number
  scale: number
  onClick: () => void
}

export function DeskMarker({
  desk,
  bgWidth,
  bgHeight,
  stageX,
  stageY,
  scale,
  onClick,
}: DeskMarkerProps) {
  // Convert percentage world coords → screen pixel coords
  const assetX = desk.x ?? 50
  const assetY = desk.y ?? 50
  const assetW = desk.width ?? 5
  const assetH = desk.height ?? 5
  const cx = stageX + ((assetX / 100 + assetW / 200) * bgWidth) * scale
  const cy = stageY + ((assetY / 100 + assetH / 200) * bgHeight) * scale

  const bgClass = STATUS_BG[desk.bookingStatus] ?? 'bg-slate-400 hover:bg-slate-500 border-slate-200'
  const dotClass = STATUS_DOT[desk.bookingStatus] ?? 'bg-slate-400'

  // Scale icon size with zoom, clamped to a readable range
  const iconSize = Math.round(Math.min(Math.max(scale * 54, 42), 78))
  const fontSize = Math.round(Math.min(Math.max(scale * 13, 12), 18))

  return (
    <div
      className="absolute"
      style={{
        left: cx,
        top: cy,
        transform: 'translate(-50%, -50%)',
        pointerEvents: 'auto',
      }}
    >
      <TooltipProvider delayDuration={150}>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={onClick}
              className="group flex flex-col items-center gap-1 outline-none focus-visible:outline-none"
            >
              {/* Icon disc */}
              <div
                className={`
                  relative rounded-full flex items-center justify-center
                  shadow-md
                  transition-all duration-150 ease-out
                  group-hover:scale-110 group-hover:shadow-lg group-focus-visible:ring-2 group-focus-visible:ring-ring
                  ${bgClass}
                `}
                style={{
                  width: iconSize,
                  height: iconSize,
                  border: `3px solid ${desk.zoneColour ?? '#94a3b8'}`,
                }}
              >
                <Monitor
                  className="text-white drop-shadow"
                  style={{ width: iconSize * 0.42, height: iconSize * 0.42 }}
                  strokeWidth={2.2}
                />
                {/* Assigned-user dot */}
                {desk.assignedUsers && desk.assignedUsers.length > 0 && (
                  <span
                    className="absolute rounded-full bg-blue-300 border border-white"
                    style={{
                      width: Math.max(6, iconSize * 0.22),
                      height: Math.max(6, iconSize * 0.22),
                      top: -Math.max(2, iconSize * 0.06),
                      left: -Math.max(2, iconSize * 0.06),
                    }}
                  />
                )}
              </div>

              {/* Name chip */}
              <span
                className="
                  font-semibold leading-none
                  bg-background/95 text-foreground
                  px-1.5 py-0.5 rounded shadow-sm
                  border border-border/60
                  max-w-[64px] truncate
                  backdrop-blur-sm
                "
                style={{ fontSize }}
              >
                {desk.name}
              </span>
            </button>
          </TooltipTrigger>

          <TooltipContent side="top" className="p-3 max-w-[220px]">
            <div className="space-y-2">
              <p className="font-semibold text-sm">{desk.name}</p>

              <div className="flex items-center gap-1.5">
                <span className={`w-2 h-2 rounded-full shrink-0 ${dotClass}`} />
                <span className="text-xs">{STATUS_LABEL[desk.bookingStatus] ?? desk.bookingStatus}</span>
              </div>

              <p className="text-xs text-muted-foreground">
                Zone: <span className="text-foreground font-medium">{desk.zoneName}</span>
              </p>

              {desk.assignedUsers && desk.assignedUsers.length > 0 && (
                <p className="text-xs text-muted-foreground">
                  Assigned to:{' '}
                  <span className="text-foreground font-medium">
                    {desk.assignedUsers.find((u) => u.isPrimary)?.displayName ?? desk.assignedUsers[0].displayName}
                    {desk.assignedUsers.length > 1 && ` +${desk.assignedUsers.length - 1}`}
                  </span>
                </p>
              )}

              {desk.currentBooking?.bookerName && desk.bookingStatus === 'booked' && (
                <p className="text-xs text-muted-foreground">
                  Booked by:{' '}
                  <span className="text-foreground font-medium">{desk.currentBooking.bookerName}</span>
                </p>
              )}

              {(desk.amenities ?? []).length > 0 && (
                <div className="flex flex-wrap gap-1 pt-0.5">
                  {(desk.amenities ?? []).map((a) => (
                    <Badge key={a} variant="secondary" className="text-[10px] px-1.5 py-0">
                      {a}
                    </Badge>
                  ))}
                </div>
              )}

              <p className="text-[10px] text-muted-foreground/70 pt-0.5">Click to open</p>
            </div>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
  )
}
