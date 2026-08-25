import { useState, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { format } from 'date-fns'
import { toZonedTime } from 'date-fns-tz'
import { Search, MapPin, Home, Calendar, Users } from 'lucide-react'
import { directoryApi, type WhereaboutsLocation, type WhereaboutsPerson } from '@/lib/api'
import { toISODateString, zoneQualifier } from '@/lib/utils'
import { Input } from '@/components/ui/input'
import { Card, CardContent } from '@/components/ui/card'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'

function initialsOf(name: string) {
  // split(' ') on a name with a double space, or a leading/trailing space,
  // produces an empty-string part — n[0] on that is undefined, and
  // .join('') renders the literal text "undefined" in the avatar. Splitting
  // on the trimmed name by any run of whitespace avoids empty parts entirely.
  return name.trim().split(/\s+/).map((n) => n[0]).join('').toUpperCase().slice(0, 2)
}

function locationLabel(l: WhereaboutsLocation) {
  return [l.assetName, l.zoneName, l.floorName, l.buildingName].filter(Boolean).join(' · ')
}

function LocationLink({
  l, date, kind, time,
}: {
  l: WhereaboutsLocation
  date: string
  kind: 'today' | 'home'
  // Someone can legitimately hold two bookings the same day (a morning desk,
  // an afternoon meeting room) — without a time label each "today" entry
  // read as an identical, unlabelled "Booked" row, giving no way to tell
  // which one is current or that they're actually different bookings.
  time?: string
}) {
  const label = locationLabel(l)
  const Icon = kind === 'today' ? Calendar : Home
  const inner = (
    <span className="inline-flex items-center gap-1.5 text-sm">
      <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <span className="text-muted-foreground">{kind === 'today' ? 'Booked' : 'Home desk'}{time && ` · ${time}`}</span>
      <span className="font-medium">{label}</span>
    </span>
  )
  // Deep-link to the floor plan with the desk highlighted (only when we know the floor).
  return l.floorId
    ? <Link to={`/floors/${l.floorId}?date=${date}&highlight=${l.assetId}`} className="hover:underline">{inner}</Link>
    : inner
}

function PersonCard({ person, date }: { person: WhereaboutsPerson; date: string }) {
  return (
    <Card>
      <CardContent className="flex items-start gap-3 p-4">
        <Avatar className="h-9 w-9 shrink-0">
          <AvatarFallback className="text-sm bg-primary/10 text-primary">{initialsOf(person.user.displayName)}</AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <p className="font-medium text-sm">{person.user.displayName}</p>
          <p className="text-xs text-muted-foreground truncate">{person.user.email}</p>
          <div className="mt-2 flex flex-col gap-1.5">
            {person.today.map((l, i) => {
              // Rendered in the booking's own building timezone (see #72),
              // not the viewer's browser timezone — "who's in the office
              // right now" is meaningless if a remote admin sees a time
              // shifted by their own offset from that office. A qualifier
              // (e.g. "AEST") only appears when it actually differs from
              // the viewer's own timezone, so the common same-timezone case
              // stays uncluttered.
              const zoned = (iso: string) => format(toZonedTime(new Date(iso), l.resolvedTimezone), 'HH:mm')
              const qualifier = zoneQualifier(l.resolvedTimezone, l.startsAt)
              return (
                <LocationLink
                  key={`b-${l.assetId}-${i}`}
                  l={l}
                  date={date}
                  kind="today"
                  time={`${zoned(l.startsAt)}–${zoned(l.endsAt)}${qualifier ? ` ${qualifier}` : ''}`}
                />
              )
            })}
            {person.assignedDesks.map((l) => (
              <div key={`a-${l.assetId}`} className="flex items-center gap-2">
                <LocationLink l={l} date={date} kind="home" />
                {l.isPrimary && <Badge variant="outline" className="text-[10px]">primary</Badge>}
              </div>
            ))}
            {person.today.length === 0 && person.assignedDesks.length === 0 && (
              <span className="text-sm text-muted-foreground">No location today</span>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

export default function WhosInPage() {
  // toISOString() reports the UTC date, not the viewer's local date — for
  // positive-offset timezones that's still "yesterday" in the early morning,
  // and for negative-offset timezones it's already "tomorrow" in the
  // evening, defaulting this page to a day with no bookings yet. Use the
  // same local-date convention the floor plan's "today" already relies on.
  const today = toISODateString(new Date())
  const [date, setDate] = useState(today)
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')

  // Debounce the search box
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim()), 250)
    return () => clearTimeout(t)
  }, [searchInput])

  const { data, isLoading, isError } = useQuery({
    queryKey: ['whereabouts', date, search],
    queryFn: () => directoryApi.whereabouts({ date, search: search || undefined }).then((r) => r.data),
    // No booking mutation anywhere in the app invalidates this query key —
    // wiring up every cancel/approve/check-in/swap/transfer path across the
    // codebase to remember to do so would be a lot of scattered surface area
    // for a page that's inherently "live-ish" anyway. Polling instead, same
    // pattern already used for the notification bell — a colleague's booking
    // getting cancelled elsewhere is reflected here within a bounded window
    // rather than staying stale indefinitely until the viewer changes the
    // date/search or manually reloads.
    refetchInterval: 30 * 1000,
  })

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <div className="mb-1 flex items-center gap-2">
        <MapPin className="h-5 w-5 text-primary" />
        <h1 className="text-2xl font-bold">Who's In</h1>
      </div>
      <p className="text-sm text-muted-foreground mb-5">
        Find where colleagues are sitting — today's bookings and permanently assigned desks.
      </p>

      <div className="flex flex-col sm:flex-row gap-3 mb-5">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            className="pl-9"
            placeholder="Search by name or email…"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
          />
        </div>
        <Input
          type="date"
          className="sm:w-44"
          value={date}
          onChange={(e) => setDate(e.target.value || today)}
        />
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-20 w-full" />)}
        </div>
      ) : isError ? (
        <p className="text-sm text-destructive">Could not load the directory.</p>
      ) : !data || data.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <Users className="h-10 w-10 text-muted-foreground/30 mb-3" />
          <p className="text-sm text-muted-foreground">
            {search ? `No one matching “${search}” for this date.` : 'Nobody booked in for this date yet.'}
          </p>
          {!search && <p className="text-xs text-muted-foreground mt-1">Search by name to find someone's assigned desk too.</p>}
        </div>
      ) : (
        <div className="space-y-2">
          {data.map((p) => <PersonCard key={p.user.id} person={p} date={date} />)}
        </div>
      )}
    </div>
  )
}
