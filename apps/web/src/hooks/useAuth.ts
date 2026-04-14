import { useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { authApi, ApiError } from '../lib/api'
import { useAuthStore } from '../stores/auth'

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
      setUser((data?.data as any)?.user ?? null)
      setLoading(false)
    }
  }, [data, queryLoading, error, setUser, setLoading, qc, navigate])

  const loginMutation = useMutation({
    mutationFn: ({ email, password }: { email: string; password: string }) =>
      authApi.login(email, password),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['auth', 'me'] })
      navigate('/bookings', { replace: true })
    },
    onError: () => {
      toast.error('Invalid email or password')
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
