import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Building2, Loader2, ArrowLeft } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { useAuth } from '@/hooks/useAuth'
import { authProvidersApi } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
import { useEffect, useMemo } from 'react'
import { toast } from 'sonner'

// Accept either a valid email OR any non-empty string (for LDAP usernames like sAMAccountName)
const loginSchema = z.object({
  email: z.string().min(1, 'Username or email is required'),
  password: z.string().min(1, 'Password is required'),
})

type LoginFormData = z.infer<typeof loginSchema>

const SSO_ERROR_MESSAGES: Record<string, string> = {
  oidc_not_configured: 'OIDC SSO is not configured',
  oidc_no_email: 'SSO provider did not return an email address',
  oidc_callback_failed: 'SSO sign-in failed — please try again',
  saml_not_configured: 'SAML SSO is not configured',
  saml_no_profile: 'SAML provider returned no profile',
  saml_no_email: 'SAML provider did not return an email address',
  saml_callback_failed: 'SAML sign-in failed — please try again',
  saml_authorize_failed: 'Could not initiate SAML sign-in',
  account_blocked: 'Your account has been suspended',
}

export default function LoginPage() {
  const { login, isLoginPending } = useAuth()

  // ?local=true forces the local credential form (fallback for admins when SSO is broken)
  const forceLocal = useMemo(
    () => new URLSearchParams(window.location.search).get('local') === 'true',
    [],
  )

  // Show error passed back from SSO callback redirects
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const error = params.get('error')
    if (error) {
      toast.error(SSO_ERROR_MESSAGES[error] ?? 'Sign-in failed')
      window.history.replaceState({}, '', window.location.pathname)
    }
  }, [])

  const { data: providers } = useQuery({
    queryKey: ['auth-providers'],
    queryFn: () => authProvidersApi.list(),
    select: (r) => r.data,
    staleTime: 60_000,
  })

  const hasSso = providers?.oidc.enabled || providers?.saml.enabled
  // Show SSO buttons unless forced to local mode
  const showSso = hasSso && !forceLocal
  // Always show the local form when: forced local, LDAP enabled, or no SSO configured
  const showLocalForm = forceLocal || providers?.ldap.enabled || !hasSso

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<LoginFormData>({
    resolver: zodResolver(loginSchema),
  })

  const onSubmit = async (data: LoginFormData) => {
    try {
      await login(data.email, data.password)
    } catch {
      // Error handled in useAuth
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/30 px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center text-center">
          <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-primary">
            <Building2 className="h-7 w-7 text-primary-foreground" />
          </div>
          <h1 className="text-2xl font-bold">Roomer</h1>
          <p className="text-sm text-muted-foreground">Desk Booking Platform</p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-xl">
              {forceLocal ? 'Local account sign in' : 'Sign in'}
            </CardTitle>
            <CardDescription>
              {forceLocal
                ? 'Sign in with a local Roomer account'
                : providers?.ldap.enabled
                ? 'Use your directory credentials or email and password'
                : 'Enter your credentials to access your workspace'}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Back to SSO link when in forced-local mode */}
            {forceLocal && hasSso && (
              <a
                href="/login"
                className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                <ArrowLeft className="h-3 w-3" />
                Back to SSO sign in
              </a>
            )}

            {/* SSO buttons */}
            {showSso && (
              <>
                <div className="flex flex-col gap-2">
                  {providers?.oidc.enabled && (
                    <Button variant="outline" className="w-full" asChild>
                      <a href="/api/v1/auth/oidc/authorize">{providers.oidc.label}</a>
                    </Button>
                  )}
                  {providers?.saml.enabled && (
                    <Button variant="outline" className="w-full" asChild>
                      <a href="/api/v1/auth/saml/authorize">{providers.saml.label}</a>
                    </Button>
                  )}
                </div>
                {showLocalForm && (
                  <div className="relative">
                    <Separator />
                    <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-card px-2 text-xs text-muted-foreground">
                      or
                    </span>
                  </div>
                )}
              </>
            )}

            {/* Local / LDAP login form */}
            {showLocalForm && (
              <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="email">
                    {providers?.ldap.enabled ? 'Username or email' : 'Email'}
                  </Label>
                  <Input
                    id="email"
                    type={providers?.ldap.enabled ? 'text' : 'email'}
                    placeholder={providers?.ldap.enabled ? 'jsmith or jsmith@company.com' : 'you@company.com'}
                    autoComplete="username"
                    {...register('email')}
                  />
                  {errors.email && (
                    <p className="text-xs text-destructive">{errors.email.message}</p>
                  )}
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="password">Password</Label>
                  <Input
                    id="password"
                    type="password"
                    placeholder="••••••••"
                    autoComplete="current-password"
                    {...register('password')}
                  />
                  {errors.password && (
                    <p className="text-xs text-destructive">{errors.password.message}</p>
                  )}
                </div>

                <Button type="submit" className="w-full" disabled={isLoginPending}>
                  {isLoginPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  {isLoginPending ? 'Signing in…' : 'Sign in'}
                </Button>
              </form>
            )}

            {/* Local fallback link — shown when SSO is active and local form is hidden */}
            {showSso && !showLocalForm && (
              <p className="text-center text-xs text-muted-foreground pt-1">
                <a
                  href="/login?local=true"
                  className="underline underline-offset-4 hover:text-foreground transition-colors"
                >
                  Sign in with a local account
                </a>
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
