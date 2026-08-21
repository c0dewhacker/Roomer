import { useEffect, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { CheckCircle, Loader2, MapPin, Lock } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { assetsApi, bookingsApi, ApiError } from '@/lib/api'

type QrStatusData = Awaited<ReturnType<typeof assetsApi.qrStatus>>['data']

type State = 'loading' | 'ready' | 'error'
type Action = 'idle' | 'booking' | 'checking-in' | 'done'

export default function QrScanPage() {
  const { assetId } = useParams<{ assetId: string }>()
  const [state, setState] = useState<State>('loading')
  const [status, setStatus] = useState<QrStatusData | null>(null)
  const [action, setAction] = useState<Action>('idle')
  const [errorMessage, setErrorMessage] = useState('')

  function load() {
    if (!assetId) return
    setState('loading')
    assetsApi.qrStatus(assetId)
      .then((res) => { setStatus(res.data); setState('ready') })
      .catch((err: unknown) => {
        setErrorMessage(err instanceof ApiError ? err.message : 'Something went wrong')
        setState('error')
      })
  }

  useEffect(load, [assetId])

  async function bookNow() {
    if (!assetId || !status?.proposedStartsAt || !status?.proposedEndsAt) return
    setAction('booking')
    try {
      const created = await bookingsApi.create({
        assetId,
        startsAt: status.proposedStartsAt,
        endsAt: status.proposedEndsAt,
      })
      // Standing at the desk right now — check in immediately rather than
      // making them scan again, mirroring how QUEUE_PROMOTED-style instant
      // actions in this app avoid a second round trip where possible.
      await bookingsApi.checkIn(created.data.id)
      setAction('done')
    } catch (err) {
      setErrorMessage(err instanceof ApiError ? err.message : 'Failed to book this desk')
      setAction('idle')
    }
  }

  async function checkInNow() {
    if (!status?.currentBooking?.id) return
    setAction('checking-in')
    try {
      await bookingsApi.checkIn(status.currentBooking.id)
      setAction('done')
    } catch (err) {
      setErrorMessage(err instanceof ApiError ? err.message : 'Failed to check in')
      setAction('idle')
    }
  }

  if (state === 'loading') {
    return (
      <div className="flex h-screen items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    )
  }

  if (state === 'error' || !status) {
    return (
      <div className="flex h-screen items-center justify-center p-6">
        <div className="max-w-sm w-full text-center space-y-4">
          <h1 className="text-xl font-bold">Couldn't load this desk</h1>
          <p className="text-muted-foreground text-sm">{errorMessage}</p>
          <Link to="/bookings"><Button variant="outline">Go to My Bookings</Button></Link>
        </div>
      </div>
    )
  }

  const location = [status.asset.floorName, status.asset.buildingName].filter(Boolean).join(' · ')

  return (
    <div className="flex h-screen items-center justify-center p-6">
      <div className="max-w-sm w-full text-center space-y-4">
        <div>
          <h1 className="text-2xl font-bold">{status.asset.name}</h1>
          {location && (
            <p className="text-muted-foreground text-sm flex items-center justify-center gap-1 mt-1">
              <MapPin className="h-3.5 w-3.5" /> {location}
            </p>
          )}
        </div>

        {status.qrCheckInMode === 'DISABLED' ? (
          <p className="text-muted-foreground text-sm">QR check-in isn't enabled for this desk.</p>
        ) : action === 'done' ? (
          <div className="space-y-2">
            <CheckCircle className="h-12 w-12 text-green-500 mx-auto" />
            <p className="font-medium">You're checked in!</p>
          </div>
        ) : status.currentBooking ? (
          status.currentBooking.isOwnBooking ? (
            status.currentBooking.checkedInAt ? (
              <div className="space-y-2">
                <CheckCircle className="h-12 w-12 text-green-500 mx-auto" />
                <p className="font-medium">You're already checked in.</p>
              </div>
            ) : (
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground">This is your booking. Confirm you're here:</p>
                <Button onClick={checkInNow} disabled={action === 'checking-in'} size="lg" className="w-full">
                  {action === 'checking-in' ? 'Checking in…' : "I'm here — Check in"}
                </Button>
              </div>
            )
          ) : (
            <div className="space-y-2">
              <Lock className="h-8 w-8 text-muted-foreground mx-auto" />
              <p className="text-sm text-muted-foreground">This desk is currently booked by someone else.</p>
            </div>
          )
        ) : status.canBookNow ? (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">This desk is free right now.</p>
            <Button onClick={bookNow} disabled={action === 'booking'} size="lg" className="w-full">
              {action === 'booking' ? 'Booking…' : 'Book this desk now'}
            </Button>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{status.deniedReason ?? "You can't book this desk."}</p>
        )}

        {errorMessage && action === 'idle' && (
          <p className="text-xs text-destructive">{errorMessage}</p>
        )}

        <Link to="/bookings" className="block text-xs text-muted-foreground hover:text-foreground pt-2">
          View my bookings
        </Link>
      </div>
    </div>
  )
}
