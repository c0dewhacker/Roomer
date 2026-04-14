import { useState, useCallback, useMemo } from 'react'
import { useParams, Link } from 'react-router-dom'
import { format, addDays } from 'date-fns'
import { ChevronLeft, ChevronRight, CalendarDays, Info, Users } from 'lucide-react'
import { FloorPlanCanvas } from '@/components/floor-plan/FloorPlanCanvas'
import { DeskPanel } from '@/components/floor-plan/DeskPanel'
import { useFloorData, useFloorAvailability } from '@/hooks/useFloor'
import { useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import type { AssetWithStatus } from '@/types'

const STATUS_LEGEND: Array<{ label: string; colour: string; status: string }> = [
  { label: 'Available', colour: 'bg-green-500', status: 'available' },
  { label: 'Your booking', colour: 'bg-blue-500', status: 'mine' },
  { label: 'Booked', colour: 'bg-red-400', status: 'booked' },
  { label: 'Queued', colour: 'bg-yellow-400', status: 'queued' },
  { label: 'Restricted', colour: 'bg-orange-400', status: 'restricted' },
  { label: 'Disabled', colour: 'bg-gray-300', status: 'disabled' },
]

export default function FloorPage() {
  const { floorId } = useParams<{ floorId: string }>()
  const [selectedDate, setSelectedDate] = useState(new Date())
  const [selectedDesk, setSelectedDesk] = useState<AssetWithStatus | null>(null)
  const qc = useQueryClient()

  const [showWhoIsIn, setShowWhoIsIn] = useState(false)
  const { data: floor, isLoading } = useFloorData(floorId!)
  const { data: desks } = useFloorAvailability(floorId!, selectedDate)

  const whoIsIn = useMemo(() => {
    if (!desks) return []
    const seen = new Map<string, { userId: string; displayName: string; deskName: string }>()
    for (const desk of desks) {
      if (desk.bookedBy) {
        for (const person of desk.bookedBy) {
          if (!seen.has(person.userId)) {
            seen.set(person.userId, { ...person, deskName: desk.name })
          }
        }
      }
      if (desk.bookingStatus === 'mine' && desk.currentBooking) {
        seen.set('__me__', { userId: '__me__', displayName: 'You', deskName: desk.name })
      }
    }
    return Array.from(seen.values()).sort((a, b) => a.displayName.localeCompare(b.displayName))
  }, [desks])

  const handlePrevDay = () => setSelectedDate((d) => addDays(d, -1))
  const handleNextDay = () => setSelectedDate((d) => addDays(d, 1))

  const handleDeskClick = useCallback((desk: AssetWithStatus) => {
    setSelectedDesk(desk)
  }, [])

  const handleBookingCreated = useCallback(() => {
    qc.invalidateQueries({ queryKey: ['floors', floorId, 'availability'] })
    setSelectedDesk(null)
  }, [qc, floorId])

  const today = new Date()
  const isPast = selectedDate < new Date(today.toDateString())

  if (!floorId) return null

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="border-b bg-background px-6 py-3 flex items-center justify-between gap-4 shrink-0">
        <div className="flex items-center gap-2 text-sm">
          {floor?.building && (
            <>
              <Link
                to={`/buildings/${floor.building.id}`}
                className="text-muted-foreground hover:text-foreground"
              >
                {floor.building.name}
              </Link>
              <ChevronLeft className="h-3.5 w-3.5 text-muted-foreground rotate-180" />
            </>
          )}
          {isLoading ? (
            <Skeleton className="h-4 w-32" />
          ) : (
            <span className="font-medium">{floor?.name}</span>
          )}
        </div>

        {/* Date nav */}
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={handlePrevDay}
            disabled={isPast}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <div className="flex items-center gap-1.5 px-3 py-1 rounded-md border bg-background min-w-[160px] justify-center">
            <CalendarDays className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-sm font-medium">{format(selectedDate, 'EEE, d MMM')}</span>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={handleNextDay}
            disabled={selectedDate >= addDays(today, 14)}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>

        {/* Legend + Who's in */}
        <div className="hidden md:flex items-center gap-3">
          {STATUS_LEGEND.map(({ label, colour }) => (
            <div key={label} className="flex items-center gap-1.5">
              <span className={`inline-block h-3 w-3 rounded-sm ${colour}`} />
              <span className="text-xs text-muted-foreground">{label}</span>
            </div>
          ))}
          <div className="ml-2 border-l pl-3">
            <Button
              variant={showWhoIsIn ? 'secondary' : 'ghost'}
              size="sm"
              className="h-7 gap-1.5 text-xs"
              onClick={() => setShowWhoIsIn((v) => !v)}
            >
              <Users className="h-3.5 w-3.5" />
              Who's in
              {whoIsIn.length > 0 && (
                <Badge variant="secondary" className="ml-0.5 h-4 rounded-full px-1.5 text-xs">
                  {whoIsIn.length}
                </Badge>
              )}
            </Button>
          </div>
        </div>
      </div>

      {/* No floor plan warning */}
      {!isLoading && floor && !floor.floorPlan && (
        <div className="mx-6 mt-4 flex items-center gap-2 rounded-md bg-muted px-4 py-2 text-sm text-muted-foreground shrink-0">
          <Info className="h-4 w-4 shrink-0" />
          No floor plan uploaded yet. An admin can upload one from the floor settings.
        </div>
      )}

      {/* Canvas area + Who's in panel */}
      <div className="flex flex-1 overflow-hidden">
        <div className="flex-1 overflow-hidden">
          {isLoading ? (
            <div className="flex h-full items-center justify-center">
              <Skeleton className="h-3/4 w-3/4" />
            </div>
          ) : (
            <FloorPlanCanvas
              floorId={floorId}
              date={selectedDate}
              onAssetClick={handleDeskClick}
            />
          )}
        </div>

        {/* Who's in sidebar */}
        {showWhoIsIn && (
          <div className="w-64 shrink-0 border-l bg-background overflow-y-auto">
            <div className="px-4 py-3 border-b">
              <p className="text-sm font-semibold">Who's in</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {format(selectedDate, 'EEEE, d MMM')}
              </p>
            </div>
            {whoIsIn.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-10 px-4 text-center">
                <Users className="h-8 w-8 text-muted-foreground/30 mb-2" />
                <p className="text-xs text-muted-foreground">Nobody booked in yet</p>
              </div>
            ) : (
              <div className="divide-y">
                {whoIsIn.map((person) => {
                  const initials = person.displayName
                    .split(' ')
                    .map((n) => n[0])
                    .join('')
                    .toUpperCase()
                    .slice(0, 2)
                  return (
                    <div key={person.userId} className="flex items-center gap-3 px-4 py-2.5">
                      <Avatar className="h-7 w-7 shrink-0">
                        <AvatarFallback className="text-xs bg-primary/10 text-primary">
                          {initials}
                        </AvatarFallback>
                      </Avatar>
                      <div className="min-w-0">
                        <p className="text-sm font-medium truncate">{person.displayName}</p>
                        <p className="text-xs text-muted-foreground truncate">{person.deskName}</p>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Desk panel */}
      <DeskPanel
        desk={selectedDesk}
        date={selectedDate}
        floorId={floorId}
        floorZones={floor?.zones?.map((z) => ({ id: z.id, name: z.name, colour: z.colour })) ?? []}
        onClose={() => setSelectedDesk(null)}
        onBookingCreated={handleBookingCreated}
      />
    </div>
  )
}
