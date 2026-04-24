import { useEffect, useState } from 'react'
import { useSearchParams, useNavigate, Link } from 'react-router-dom'
import { CheckCircle, XCircle, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { queueApi, ApiError } from '@/lib/api'
import type { Booking } from '@/types'

type State = 'loading' | 'success' | 'already_claimed' | 'expired' | 'invalid' | 'error'

export default function QueueClaimPage() {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const [state, setState] = useState<State>('loading')
  const [booking, setBooking] = useState<Booking | null>(null)

  useEffect(() => {
    const token = params.get('token')
    if (!token) {
      setState('invalid')
      return
    }

    queueApi.claimByToken(token)
      .then((res) => {
        setBooking(res.data.booking)
        setState('success')
      })
      .catch((err: unknown) => {
        if (err instanceof ApiError) {
          if (err.body && (err.body as { error?: { code?: string } }).error?.code === 'TOKEN_EXPIRED') {
            setState('expired')
          } else if (err.body && (err.body as { error?: { code?: string } }).error?.code === 'ALREADY_CLAIMED') {
            setState('already_claimed')
          } else {
            setState('invalid')
          }
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

  if (state === 'success' && booking) {
    return (
      <div className="flex h-screen items-center justify-center p-6">
        <div className="max-w-md w-full text-center space-y-4">
          <CheckCircle className="h-12 w-12 text-green-500 mx-auto" />
          <h1 className="text-2xl font-bold">Booking confirmed!</h1>
          <p className="text-muted-foreground">
            Your desk has been booked successfully. You'll receive a confirmation email shortly.
          </p>
          <Button onClick={() => navigate('/bookings')} className="w-full">
            View My Bookings
          </Button>
        </div>
      </div>
    )
  }

  const errorMessages: Record<Exclude<State, 'loading' | 'success'>, { title: string; body: string }> = {
    already_claimed: {
      title: 'Already claimed',
      body: 'This booking has already been claimed — either by you or automatically.',
    },
    expired: {
      title: 'Link expired',
      body: 'The claim deadline for this booking has passed. The desk may have been offered to the next person in the queue.',
    },
    invalid: {
      title: 'Invalid link',
      body: 'This link is not valid or has already been used.',
    },
    error: {
      title: 'Something went wrong',
      body: 'An unexpected error occurred. Please try claiming from your queue page.',
    },
  }

  const msg = errorMessages[state as Exclude<State, 'loading' | 'success'>]

  return (
    <div className="flex h-screen items-center justify-center p-6">
      <div className="max-w-md w-full text-center space-y-4">
        <XCircle className="h-12 w-12 text-destructive mx-auto" />
        <h1 className="text-2xl font-bold">{msg.title}</h1>
        <p className="text-muted-foreground">{msg.body}</p>
        <div className="flex flex-col gap-2">
          <Link to="/queue">
            <Button variant="outline" className="w-full">View My Queue</Button>
          </Link>
          <Link to="/bookings">
            <Button variant="ghost" className="w-full">View My Bookings</Button>
          </Link>
        </div>
      </div>
    </div>
  )
}
