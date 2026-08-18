import { useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { authApi, ApiError } from '../lib/api'
import { useAuthStore } from '../stores/auth'

// The access token cookie is a fixed 8-hour JWT (apps/api/src/lib/jwt.ts,
// MAX_AGE_SECONDS) with no refresh-token/short-lived-access-token split, so
// an active user was silently logged out exactly 8 hours after login
// regardless of activity — POST /auth/refresh existed but nothing ever
// called it (see #208). A *reactive* refresh-on-401 approach doesn't work
// here: /auth/refresh itself verifies the incoming token with jsonwebtoken's
// default strict expiry check, so it rejects an already-expired token the
// same as any other route would — refresh can only succeed while the
// current token is still valid. So this has to run proactively, well inside
// the 8h window, not in response to a failure. 30 minutes keeps the token
// continuously fresh for an active session while staying far under the
// refresh endpoint's own 10-per-15-min rate limit; the backend's separate
// MAX_SESSION_SECONDS (24h) ceiling still applies end-to-end regardless of
// how often this fires, so this can't turn into an indefinite session.
const REFRESH_INTERVAL_MS = 30 * 60 * 1000

export function useAuth() {
  const { user, isLoading, setUser, setLoading } = useAuthStore()
  const qc = useQueryClient()
  const navigate = useNavigate()

  const { data, isLoading: queryLoading, error } = useQuery({
    queryKey: ['auth', 'me'],
    queryFn: () => authApi.me(),
    retry: false,
    staleTime: 5 * 60 * 1000,
  })

  useEffect(() => {
    if (queryLoading) return

    if (error) {
      setUser(null)
      setLoading(false)
      // If the server explicitly rejects our token (401 = expired/revoked,
      // 403 = account blocked), redirect to the login page.
      // Do NOT call qc.clear() here — it removes the query's error state from
      // the cache, which causes the active observer to immediately re-fetch,
      // producing an infinite 401/403 loop while the hook is still mounted.
      // With retry: false the query stays in error state until loginMutation
      // calls qc.invalidateQueries, at which point a fresh fetch runs.
      if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
        navigate('/login', { replace: true })
      }
    } else {
      setUser(data?.data?.user ?? null)
      setLoading(false)
    }
  }, [data, queryLoading, error, setUser, setLoading, qc, navigate])

  // Proactively keep the access token fresh for as long as the user is
  // actively authenticated — see REFRESH_INTERVAL_MS above for why this has
  // to be proactive rather than reactive. If a refresh call itself fails
  // (token revoked, or the 24h absolute session ceiling reached), don't
  // retry it here — invalidate ['auth','me'] so the existing 401-handling
  // effect above runs and redirects to /login, the same as any other
  // request hitting an expired session would.
  useEffect(() => {
    if (!user) return
    const interval = setInterval(() => {
      authApi.refresh().catch(() => {
        qc.invalidateQueries({ queryKey: ['auth', 'me'] })
      })
    }, REFRESH_INTERVAL_MS)
    return () => clearInterval(interval)
  }, [user, qc])

  const loginMutation = useMutation({
    mutationFn: ({ email, password }: { email: string; password: string }) =>
      authApi.login(email, password),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['auth', 'me'] })
      navigate('/bookings', { replace: true })
    },
    onError: (err: Error) => {
      // The backend already distinguishes wrong credentials from a suspended
      // account (403) and a rate limit (429, "try again in N minutes") with
      // their own specific messages — hardcoding "Invalid email or password"
      // here regardless of cause hid both, telling a suspended or
      // rate-limited user their password was wrong when retrying it again
      // would never help either way.
      toast.error(err.message || 'Invalid email or password')
    },
  })

  const logoutMutation = useMutation({
    mutationFn: () => authApi.logout(),
    onSuccess: () => {
      setUser(null)
      qc.clear()
      navigate('/login', { replace: true })
    },
    onError: () => {
      // Force local logout even if API fails
      setUser(null)
      qc.clear()
      navigate('/login', { replace: true })
    },
  })

  return {
    user,
    isLoading: isLoading || queryLoading,
    isAuthenticated: !!user,
    login: (email: string, password: string) => loginMutation.mutateAsync({ email, password }),
    logout: () => logoutMutation.mutate(),
    isLoginPending: loginMutation.isPending,
  }
}
