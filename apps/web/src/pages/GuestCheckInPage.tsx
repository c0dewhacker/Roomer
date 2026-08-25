import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { CheckCircle, XCircle, Loader2 } from 'lucide-react'
import { bookingsApi, ApiError } from '@/lib/api'

// Note: re-visiting an already-used check-in link is idempotent (the API
// returns 200 again, not an error), so there's no separate "already checked
// in" error state here — it just lands back on `success`.
type State = 'loading' | 'success' | 'not_started' | 'ended' | 'invalid' | 'error'

export default function GuestCheckInPage() {
  const [params] = useSearchParams()
  const [state, setState] = useState<State>('loading')
  const [guestName, setGuestName] = useState<string | null>(null)

  useEffect(() => {
    const token = params.get('token')
    if (!token) {
      setState('invalid')
      return
    }

    bookingsApi.guestCheckInByToken(token)
      .then((res) => {
        setGuestName(res.data.guestName)
        setState('success')
      })
      .catch((err: unknown) => {
        if (err instanceof ApiError) {
          const code = (err.body as { error?: { code?: string } } | undefined)?.error?.code
          if (code === 'BOOKING_NOT_STARTED') setState('not_started')
          else if (code === 'BOOKING_ENDED') setState('ended')
          else setState('invalid')
        } else {
          setState('error')
        }
      })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (state === 'loading') {
    return (
      <div className="flex h-screen items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    )
  }

  if (state === 'success') {
    return (
      <div className="flex h-screen items-center justify-center p-6">
        <div className="max-w-md w-full text-center space-y-4">
          <CheckCircle className="h-12 w-12 text-green-500 mx-auto" />
          <h1 className="text-2xl font-bold">You're checked in!</h1>
          <p className="text-muted-foreground">
            {guestName ? `Welcome, ${guestName}. ` : ''}Your host has been notified. Enjoy your visit.
          </p>
        </div>
      </div>
    )
  }

  const errorMessages: Record<Exclude<State, 'loading' | 'success'>, { title: string; body: string }> = {
    not_started: {
      title: 'Too early',
      body: 'This booking hasn\'t started yet — try again once it begins.',
    },
    ended: {
      title: 'Booking ended',
      body: 'This booking has already ended.',
    },
    invalid: {
      title: 'Invalid link',
      body: 'This check-in link is not valid.',
    },
    error: {
      title: 'Something went wrong',
      body: 'An unexpected error occurred. Please ask your host for help.',
    },
  }

  const msg = errorMessages[state as Exclude<State, 'loading' | 'success'>]

  return (
    <div className="flex h-screen items-center justify-center p-6">
      <div className="max-w-md w-full text-center space-y-4">
        <XCircle className="h-12 w-12 text-destructive mx-auto" />
        <h1 className="text-2xl font-bold">{msg.title}</h1>
        <p className="text-muted-foreground">{msg.body}</p>
      </div>
    </div>
  )
}
