import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Building2, Loader2, ArrowLeft, LogIn } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { useAuth } from '@/hooks/useAuth'
import { authProvidersApi, type LoginProvider } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
import { useEffect, useMemo } from 'react'
import { toast } from 'sonner'

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

function parseLoginProviderParam(): LoginProvider | null {
  const params = new URLSearchParams(window.location.search)
  // Support both ?login_provider=local and legacy ?local=true
  const lp = params.get('login_provider') as LoginProvider | null
  if (lp && ['local', 'ldap', 'oidc', 'saml'].includes(lp)) return lp
  if (params.get('local') === 'true') return 'local'
  return null
}

function CredentialForm({ ldapEnabled }: { ldapEnabled: boolean }) {
  const { login, isLoginPending } = useAuth()
  const { register, handleSubmit, formState: { errors } } = useForm<LoginFormData>({
    resolver: zodResolver(loginSchema),
  })

  const onSubmit = async (data: LoginFormData) => {
    try { await login(data.email, data.password) } catch { /* handled in useAuth */ }
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="email">{ldapEnabled ? 'Username or email' : 'Email'}</Label>
        <Input
          id="email"
          type={ldapEnabled ? 'text' : 'email'}
          placeholder={ldapEnabled ? 'jsmith or jsmith@company.com' : 'you@company.com'}
          autoComplete="username"
          {...register('email')}
        />
        {errors.email && <p className="text-xs text-destructive">{errors.email.message}</p>}
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="password">Password</Label>
        <Input id="password" type="password" placeholder="••••••••" autoComplete="current-password" {...register('password')} />
        {errors.password && <p className="text-xs text-destructive">{errors.password.message}</p>}
      </div>
      <Button type="submit" className="w-full" disabled={isLoginPending}>
        {isLoginPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
        {isLoginPending ? 'Signing in…' : 'Sign in'}
      </Button>
    </form>
  )
}

export default function LoginPage() {
  const urlProvider = useMemo(parseLoginProviderParam, [])

  // Show error passed back from SSO callback redirects.
  // Only treat recognised error codes as real errors — an unrecognised ?error=...
  // value must not suppress the SSO auto-redirect (phishing guard).
  const rawUrlError = useMemo(() => new URLSearchParams(window.location.search).get('error'), [])
  const urlError = useMemo(
    () => (rawUrlError && Object.prototype.hasOwnProperty.call(SSO_ERROR_MESSAGES, rawUrlError) ? rawUrlError : null),
    [rawUrlError],
  )
  useEffect(() => {
    if (urlError) {
      toast.error(SSO_ERROR_MESSAGES[urlError])
      window.history.replaceState({}, '', window.location.pathname)
    }
  }, [urlError])

  const { data: providers, isLoading } = useQuery({
    queryKey: ['auth-providers'],
    queryFn: () => authProvidersApi.list(),
    select: (r) => r.data,
    staleTime: 60_000,
  })

  // Auto-redirect when selector is hidden and default is an SSO provider
  useEffect(() => {
    if (!providers) return
    if (urlProvider) return        // explicit URL override — never auto-redirect
    if (urlError) return           // error state — must show login page
    if (providers.showProviderSelector) return  // selector shown — no redirect needed

    const dp = providers.defaultProvider
    if (dp === 'oidc' && providers.oidc.enabled) {
      window.location.replace('/api/v1/auth/oidc/authorize')
    } else if (dp === 'saml' && providers.saml.enabled) {
      window.location.replace('/api/v1/auth/saml/authorize')
    }
  }, [providers, urlProvider, urlError])

  if (isLoading || (!urlProvider && !urlError && providers && !providers.showProviderSelector &&
    (providers.defaultProvider === 'oidc' || providers.defaultProvider === 'saml'))) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-muted/30">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  // Determine effective mode
  const activeProvider: LoginProvider | null = urlProvider

  // Which credential form to show
  const showCredentialForm = !activeProvider
    ? (!providers?.showProviderSelector
        ? (providers?.defaultProvider === 'ldap' || providers?.defaultProvider === 'local' || !providers?.defaultProvider)
        : (providers?.ldap.enabled || (!providers?.oidc.enabled && !providers?.saml.enabled)))
    : (activeProvider === 'local' || activeProvider === 'ldap')

  // Which SSO buttons to show
  const showOidc = !activeProvider
    ? (providers?.oidc.enabled && (providers?.showProviderSelector || providers?.defaultProvider === 'oidc'))
    : false
  const showSaml = !activeProvider
    ? (providers?.saml.enabled && (providers?.showProviderSelector || providers?.defaultProvider === 'saml'))
    : false

  const defaultProvider = providers?.defaultProvider ?? null
  const ldapEnabled = providers?.ldap.enabled ?? false

  // Card title & description
  let cardTitle = 'Sign in'
  let cardDescription = 'Enter your credentials to access your workspace'
  if (activeProvider === 'local') {
    cardTitle = 'Local account sign in'
    cardDescription = 'Sign in with a local Roomer account'
  } else if (activeProvider === 'ldap') {
    cardTitle = 'Directory sign in'
    cardDescription = 'Sign in with your LDAP / Active Directory credentials'
  } else if (ldapEnabled && !activeProvider) {
    cardDescription = 'Use your directory credentials or email and password'
  }

  const hasAnySso = providers?.oidc.enabled || providers?.saml.enabled
  const allProvidersUrl = '/login'

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
            <CardTitle className="text-xl">{cardTitle}</CardTitle>
            <CardDescription>{cardDescription}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Back link when a specific provider is forced via URL */}
            {activeProvider && (
              <a
                href={allProvidersUrl}
                className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                <ArrowLeft className="h-3 w-3" />
                {hasAnySso ? 'Back to all sign-in options' : 'Back to sign in'}
              </a>
            )}

            {/* SSO buttons */}
            {(showOidc || showSaml) && (
              <div className="flex flex-col gap-2">
                {showOidc && providers?.oidc.enabled && (
                  <Button
                    variant={defaultProvider === 'oidc' ? 'default' : 'outline'}
                    className="w-full"
                    asChild
                  >
                    <a href="/api/v1/auth/oidc/authorize">
                      <LogIn className="mr-2 h-4 w-4" />
                      {providers.oidc.label}
                    </a>
                  </Button>
                )}
                {showSaml && providers?.saml.enabled && (
                  <Button
                    variant={defaultProvider === 'saml' ? 'default' : 'outline'}
                    className="w-full"
                    asChild
                  >
                    <a href="/api/v1/auth/saml/authorize">
                      <LogIn className="mr-2 h-4 w-4" />
                      {providers.saml.label}
                    </a>
                  </Button>
                )}
              </div>
            )}

            {/* Separator between SSO and credential form */}
            {(showOidc || showSaml) && showCredentialForm && (
              <div className="relative">
                <Separator />
                <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-card px-2 text-xs text-muted-foreground">
                  or
                </span>
              </div>
            )}

            {/* Credential form (local + LDAP) */}
            {showCredentialForm && <CredentialForm ldapEnabled={ldapEnabled && activeProvider !== 'local'} />}

            {/* Provider-specific fallback links */}
            {!activeProvider && providers?.showProviderSelector && (
              <div className="flex flex-col items-center gap-1 pt-1 text-xs text-muted-foreground">
                {providers.ldap.enabled && (
                  <a href="/login?login_provider=ldap" className="underline underline-offset-4 hover:text-foreground transition-colors">
                    Sign in with LDAP
                  </a>
                )}
                {!showCredentialForm && (
                  <a href="/login?login_provider=local" className="underline underline-offset-4 hover:text-foreground transition-colors">
                    Sign in with a local account
                  </a>
                )}
              </div>
            )}

            {/* When selector is hidden, always offer a local fallback */}
            {!activeProvider && !providers?.showProviderSelector && hasAnySso && (
              <p className="text-center text-xs text-muted-foreground pt-1">
                <a href="/login?login_provider=local" className="underline underline-offset-4 hover:text-foreground transition-colors">
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
