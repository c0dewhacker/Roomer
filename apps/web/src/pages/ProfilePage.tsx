import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { User, Mail, Shield, Building2, Layers, Users, KeyRound, Bell, BellOff, MapPin, EyeOff } from 'lucide-react'
import { useAuthStore } from '@/stores/auth'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { usersApi } from '@/lib/api'
import { toast } from 'sonner'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { useFloorSubscriptions, useUnsubscribeFromFloor } from '@/hooks/useSubscriptions'
import { useMyManagerRequests, useWithdrawManagerRequest } from '@/hooks/useManagerRequests'
import type { ManagerRequestStatus } from '@/types'

const profileSchema = z.object({
  displayName: z.string().min(2, 'Name must be at least 2 characters'),
})
type ProfileForm = z.infer<typeof profileSchema>

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required'),
  newPassword: z.string().min(12, 'Password must be at least 12 characters'),
  confirmPassword: z.string().min(1, 'Please confirm your password'),
}).refine((d) => d.newPassword === d.confirmPassword, {
  message: 'Passwords do not match',
  path: ['confirmPassword'],
})
type ChangePasswordForm = z.infer<typeof changePasswordSchema>

const PROVIDER_LABELS: Record<string, string> = {
  LOCAL: 'Local account',
  LDAP: 'LDAP / Active Directory',
  OIDC: 'Single Sign-On (OIDC)',
  SAML: 'Single Sign-On (SAML)',
}

const PROVIDER_COLOURS: Record<string, string> = {
  LOCAL: 'bg-muted text-muted-foreground',
  LDAP: 'bg-blue-100 text-blue-700',
  OIDC: 'bg-violet-100 text-violet-700',
  SAML: 'bg-violet-100 text-violet-700',
}

type NotifPref = { email?: boolean; inApp?: boolean }

const NOTIFICATION_GROUPS: Array<{ label: string; types: Array<{ key: string; label: string }> }> = [
  {
    label: 'Bookings',
    types: [
      { key: 'BOOKING_CONFIRMED', label: 'Booking confirmed' },
      { key: 'BOOKING_CANCELLED', label: 'Booking cancelled' },
      { key: 'BOOKING_CANCELLED_BY_ADMIN', label: 'Booking cancelled by admin' },
      { key: 'BOOKING_REMINDER', label: 'Booking reminder' },
      { key: 'BOOKING_NO_SHOW', label: 'Booking released (no-show)' },
    ],
  },
  {
    label: 'Waitlist',
    types: [
      { key: 'QUEUE_JOINED', label: 'Joined a waitlist' },
      { key: 'QUEUE_PROMOTED', label: 'Promoted from waitlist' },
      { key: 'QUEUE_EXPIRED', label: 'Waitlist expired' },
      { key: 'QUEUE_CLAIM_EXPIRING', label: 'Claim expiring soon' },
    ],
  },
  {
    label: 'Assets',
    types: [
      { key: 'ASSET_ASSIGNED', label: 'Asset assigned to you' },
    ],
  },
  {
    label: 'Other',
    types: [
      { key: 'WELCOME', label: 'Welcome email' },
      { key: 'FLOOR_AVAILABLE', label: 'Floor availability alert' },
    ],
  },
]

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`
        relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full
        transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring
        ${checked ? 'bg-primary' : 'bg-input'}
      `}
    >
      <span
        className={`
          pointer-events-none block h-4 w-4 rounded-full bg-background shadow-lg ring-0 transition-transform
          ${checked ? 'translate-x-4' : 'translate-x-0.5'}
        `}
      />
    </button>
  )
}

export default function ProfilePage() {
  const user = useAuthStore((s) => s.user)
  const setUser = useAuthStore((s) => s.setUser)
  const qc = useQueryClient()
  const [editing, setEditing] = useState(false)
  const [changingPassword, setChangingPassword] = useState(false)

  const { register, handleSubmit, formState: { errors, isDirty }, reset } = useForm<ProfileForm>({
    resolver: zodResolver(profileSchema),
    defaultValues: { displayName: user?.displayName ?? '' },
  })

  const {
    register: regPw,
    handleSubmit: handlePw,
    formState: { errors: pwErrors },
    reset: resetPw,
  } = useForm<ChangePasswordForm>({ resolver: zodResolver(changePasswordSchema) })

  const updateProfile = useMutation({
    mutationFn: (data: ProfileForm) => usersApi.update(user!.id, data),
    onSuccess: (res) => {
      setUser({ ...user!, displayName: res.data.displayName })
      toast.success('Profile updated')
      setEditing(false)
      qc.invalidateQueries({ queryKey: ['auth', 'me'] })
    },
    onError: (err: Error) => toast.error(err.message),
  })

  const updateVisibility = useMutation({
    mutationFn: (visible: boolean) => usersApi.update(user!.id, { visibleInColleagueSearch: visible }),
    onSuccess: (res) => {
      setUser({ ...user!, visibleInColleagueSearch: res.data.visibleInColleagueSearch })
      toast.success('Privacy preference saved')
      qc.invalidateQueries({ queryKey: ['auth', 'me'] })
    },
    onError: (err: Error) => toast.error(err.message),
  })

  const changePassword = useMutation({
    mutationFn: (data: ChangePasswordForm) =>
      usersApi.changePassword({ currentPassword: data.currentPassword, newPassword: data.newPassword }),
    onSuccess: () => {
      toast.success('Password changed successfully')
      setChangingPassword(false)
      resetPw()
    },
    onError: (err: Error) => toast.error(err.message ?? 'Failed to change password'),
  })

  const { data: notifPrefsData } = useQuery({
    queryKey: ['notification-preferences'],
    queryFn: () => usersApi.getNotificationPreferences(),
  })
  const [localPrefs, setLocalPrefs] = useState<Record<string, NotifPref> | null>(null)
  const savedPrefs = notifPrefsData?.data.preferences ?? {}
  const prefs: Record<string, NotifPref> = localPrefs ?? savedPrefs

  const updatePreferences = useMutation({
    mutationFn: (p: Record<string, NotifPref>) => usersApi.updateNotificationPreferences(p),
    onSuccess: () => {
      toast.success('Notification preferences saved')
      qc.invalidateQueries({ queryKey: ['notification-preferences'] })
      setLocalPrefs(null)
    },
    onError: (err: Error) => toast.error(err.message),
  })

  const handleToggle = (key: string, channel: 'email' | 'inApp', value: boolean) => {
    const next = { ...prefs, [key]: { ...prefs[key], [channel]: value } }
    setLocalPrefs(next)
  }

  const { data: subscriptions } = useFloorSubscriptions()
  const { data: managerRequests } = useMyManagerRequests()
  const withdrawManagerRequest = useWithdrawManagerRequest()
  const unsubscribe = useUnsubscribeFromFloor()

  if (!user) return null

  // A double space, or a leading/trailing space, in displayName produces an
  // empty-string part when split on a literal ' ' — n[0] on that is
  // undefined, and Array.join('') renders it as the literal text
  // "undefined". Trim and split on any run of whitespace instead.
  const initials = user.displayName
    .trim()
    .split(/\s+/)
    .map((n) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2)

  const provider = user.provider ?? 'LOCAL'
  const isIdpUser = provider !== 'LOCAL'

  const floorManagerRoles = (user.resourceRoles ?? []).filter(
    (r) => r.scopeType === 'FLOOR' && r.role === 'FLOOR_MANAGER',
  )
  const buildingAdminRoles = (user.resourceRoles ?? []).filter(
    (r) => r.scopeType === 'BUILDING' && r.role === 'BUILDING_ADMIN',
  )
  const hasResourceRoles = floorManagerRoles.length > 0 || buildingAdminRoles.length > 0

  const groupMemberships = user.groupMemberships ?? []

  return (
    <div className="p-6 max-w-2xl mx-auto space-y-6">
      <h1 className="text-2xl font-bold">Profile</h1>

      {/* Identity card */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-4">
            <Avatar className="h-16 w-16">
              <AvatarFallback className="text-xl bg-primary text-primary-foreground">
                {initials}
              </AvatarFallback>
            </Avatar>
            <div>
              <CardTitle>{user.displayName}</CardTitle>
              <CardDescription>{user.email}</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <Separator />

          <div className="grid grid-cols-2 gap-4 text-sm">
            <div className="flex items-center gap-2">
              <Mail className="h-4 w-4 text-muted-foreground" />
              <div>
                <p className="text-xs text-muted-foreground">Email</p>
                <p className="font-medium">{user.email}</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Shield className="h-4 w-4 text-muted-foreground" />
              <div>
                <p className="text-xs text-muted-foreground">Role</p>
                <Badge variant={user.globalRole === 'SUPER_ADMIN' ? 'default' : 'secondary'} className="text-xs">
                  {user.globalRole === 'SUPER_ADMIN' ? 'Administrator' : 'User'}
                </Badge>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <User className="h-4 w-4 text-muted-foreground" />
              <div>
                <p className="text-xs text-muted-foreground">Sign-in method</p>
                <span className={`inline-block text-xs font-medium px-2 py-0.5 rounded mt-0.5 ${PROVIDER_COLOURS[provider] ?? PROVIDER_COLOURS.LOCAL}`}>
                  {PROVIDER_LABELS[provider] ?? provider}
                </span>
              </div>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Account status</p>
              <Badge variant={user.accountStatus === 'ACTIVE' ? 'secondary' : 'destructive'} className="text-xs mt-0.5">
                {user.accountStatus}
              </Badge>
            </div>
          </div>

          <Separator />

          {/* Colleague-finder privacy */}
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-start gap-2">
              <MapPin className="h-4 w-4 text-muted-foreground mt-0.5" />
              <div>
                <p className="text-sm font-medium">Show me in “Who's In”</p>
                <p className="text-xs text-muted-foreground">
                  When off, you won't appear in Who's In or colleague search. This doesn't hide your name
                  from the floor plan for people who already have access to your floor.
                </p>
              </div>
            </div>
            <Button
              variant={user.visibleInColleagueSearch === false ? 'outline' : 'secondary'}
              size="sm"
              className="shrink-0 gap-1.5"
              disabled={updateVisibility.isPending}
              onClick={() => updateVisibility.mutate(user.visibleInColleagueSearch === false)}
            >
              {user.visibleInColleagueSearch === false
                ? <><EyeOff className="h-3.5 w-3.5" /> Hidden</>
                : <><Users className="h-3.5 w-3.5" /> Visible</>}
            </Button>
          </div>

          {/* IdP-specific info */}
          {isIdpUser && user.externalId && (
            <>
              <Separator />
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-1">
                  {provider === 'LDAP' ? 'Directory identity (DN)' : 'External identity'}
                </p>
                <p className="text-xs font-mono bg-muted rounded px-2 py-1 break-all">
                  {user.externalId}
                </p>
              </div>
            </>
          )}

          <Separator />

          {editing ? (
            <form onSubmit={handleSubmit((d) => updateProfile.mutate(d))} className="space-y-4">
              <div>
                <Label htmlFor="displayName">Display name</Label>
                {isIdpUser && (
                  <p className="text-xs text-muted-foreground mt-0.5 mb-1.5">
                    This overrides the display name from your identity provider within Roomer.
                  </p>
                )}
                <Input id="displayName" {...register('displayName')} className="mt-1.5" />
                {errors.displayName && (
                  <p className="text-xs text-destructive mt-1">{errors.displayName.message}</p>
                )}
              </div>
              <div className="flex gap-2">
                <Button type="submit" size="sm" disabled={!isDirty || updateProfile.isPending}>
                  {updateProfile.isPending ? 'Saving…' : 'Save changes'}
                </Button>
                <Button type="button" variant="ghost" size="sm" onClick={() => { setEditing(false); reset() }}>
                  Cancel
                </Button>
              </div>
            </form>
          ) : (
            <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
              Edit display name
            </Button>
          )}
        </CardContent>
      </Card>

      {/* Change password — local accounts only */}
      {!isIdpUser && (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <KeyRound className="h-4 w-4 text-muted-foreground" />
              <CardTitle className="text-base">Password</CardTitle>
            </div>
            <CardDescription>Change your account password</CardDescription>
          </CardHeader>
          <CardContent>
            {changingPassword ? (
              <form onSubmit={handlePw((d) => changePassword.mutate(d))} className="space-y-4">
                <div>
                  <Label htmlFor="cur-pass">Current password</Label>
                  <Input id="cur-pass" type="password" {...regPw('currentPassword')} className="mt-1.5" autoComplete="current-password" />
                  {pwErrors.currentPassword && (
                    <p className="text-xs text-destructive mt-1">{pwErrors.currentPassword.message}</p>
                  )}
                </div>
                <div>
                  <Label htmlFor="new-pass">New password</Label>
                  <Input id="new-pass" type="password" {...regPw('newPassword')} className="mt-1.5" autoComplete="new-password" />
                  {pwErrors.newPassword && (
                    <p className="text-xs text-destructive mt-1">{pwErrors.newPassword.message}</p>
                  )}
                </div>
                <div>
                  <Label htmlFor="conf-pass">Confirm new password</Label>
                  <Input id="conf-pass" type="password" {...regPw('confirmPassword')} className="mt-1.5" autoComplete="new-password" />
                  {pwErrors.confirmPassword && (
                    <p className="text-xs text-destructive mt-1">{pwErrors.confirmPassword.message}</p>
                  )}
                </div>
                <div className="flex gap-2">
                  <Button type="submit" size="sm" disabled={changePassword.isPending}>
                    {changePassword.isPending ? 'Updating…' : 'Update password'}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => { setChangingPassword(false); resetPw() }}
                  >
                    Cancel
                  </Button>
                </div>
              </form>
            ) : (
              <Button variant="outline" size="sm" onClick={() => setChangingPassword(true)}>
                Change password
              </Button>
            )}
          </CardContent>
        </Card>
      )}

      {/* Group memberships */}
      {groupMemberships.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <Users className="h-4 w-4 text-muted-foreground" />
              <CardTitle className="text-base">Groups</CardTitle>
            </div>
            <CardDescription>Roomer access groups you belong to</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2">
              {groupMemberships.map((m) => (
                <div key={m.groupId} className="flex items-center gap-1.5 rounded-full border px-3 py-1">
                  <span className="text-sm font-medium">{m.group.name}</span>
                  {m.group.globalRole === 'SUPER_ADMIN' && (
                    <Badge variant="outline" className="text-[10px] px-1 py-0 h-4">Admin</Badge>
                  )}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Notification preferences */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <Bell className="h-4 w-4 text-muted-foreground" />
            <CardTitle className="text-base">Notification preferences</CardTitle>
          </div>
          <CardDescription>Choose which notifications to receive and how</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Header row */}
          <div className="grid grid-cols-[1fr_56px_56px] gap-2 pb-1 border-b">
            <span className="text-xs font-medium text-muted-foreground">Notification</span>
            <span className="text-xs font-medium text-muted-foreground text-center">Email</span>
            <span className="text-xs font-medium text-muted-foreground text-center">In‑app</span>
          </div>

          {NOTIFICATION_GROUPS.map((group) => (
            <div key={group.label} className="space-y-2">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">{group.label}</p>
              {group.types.map(({ key, label }) => {
                const pref = prefs[key] ?? {}
                const emailOn = pref.email !== false
                const inAppOn = pref.inApp !== false
                return (
                  <div key={key} className="grid grid-cols-[1fr_56px_56px] items-center gap-2">
                    <span className="text-sm">{label}</span>
                    <div className="flex justify-center">
                      <Toggle checked={emailOn} onChange={(v) => handleToggle(key, 'email', v)} />
                    </div>
                    <div className="flex justify-center">
                      <Toggle checked={inAppOn} onChange={(v) => handleToggle(key, 'inApp', v)} />
                    </div>
                  </div>
                )
              })}
            </div>
          ))}

          {localPrefs && (
            <div className="flex gap-2 pt-2">
              <Button
                size="sm"
                onClick={() => updatePreferences.mutate(localPrefs)}
                disabled={updatePreferences.isPending}
              >
                {updatePreferences.isPending ? 'Saving…' : 'Save preferences'}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setLocalPrefs(null)}
                disabled={updatePreferences.isPending}
              >
                Cancel
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Floor notification subscriptions */}
      {subscriptions && subscriptions.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <Bell className="h-4 w-4 text-muted-foreground" />
              <CardTitle className="text-base">Floor notifications</CardTitle>
            </div>
            <CardDescription>Floors you'll be emailed about when a desk becomes available</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {subscriptions.map((sub) => (
              <div key={sub.id} className="flex items-center justify-between rounded-md border px-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium truncate">
                    {sub.floor.building.name} — {sub.floor.name}
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {sub.zones.length === 0
                      ? 'All zones'
                      : sub.zones.map((z) => z.zone.name).join(', ')
                    }
                  </p>
                </div>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7 shrink-0 ml-2 hover:text-destructive"
                  title="Unsubscribe"
                  onClick={() => unsubscribe.mutate(sub.id)}
                  disabled={unsubscribe.isPending}
                >
                  <BellOff className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Floor manager access requests */}
      {managerRequests && managerRequests.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <Shield className="h-4 w-4 text-muted-foreground" />
              <CardTitle className="text-base">Manager access requests</CardTitle>
            </div>
            <CardDescription>Your requests for floor manager access</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {managerRequests.map((r) => {
              const statusClass: Record<ManagerRequestStatus, string> = {
                PENDING: 'bg-yellow-100 text-yellow-800 border-yellow-200',
                APPROVED: 'bg-green-100 text-green-800 border-green-200',
                REJECTED: 'bg-red-100 text-red-700 border-red-200',
                CANCELLED: 'bg-slate-100 text-slate-600 border-slate-200',
                EXPIRED: 'bg-slate-100 text-slate-500 border-slate-200',
              }
              return (
                <div key={r.id} className="flex items-center justify-between rounded-md border px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium truncate">
                      {r.floor?.building.name} — {r.floor?.name}
                    </p>
                    <div className="flex items-center gap-2 mt-0.5">
                      <Badge variant="outline" className={`text-xs border ${statusClass[r.status]}`}>
                        {r.status === 'REJECTED' ? 'Declined' : r.status === 'CANCELLED' ? 'Withdrawn' : r.status.charAt(0) + r.status.slice(1).toLowerCase()}
                      </Badge>
                      {r.status === 'REJECTED' && r.reviewNote && (
                        <span className="text-xs text-muted-foreground truncate">{r.reviewNote}</span>
                      )}
                    </div>
                  </div>
                  {r.status === 'PENDING' && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="shrink-0 ml-2 text-muted-foreground hover:text-destructive"
                      onClick={() => withdrawManagerRequest.mutate(r.id)}
                      disabled={withdrawManagerRequest.isPending}
                    >
                      Withdraw
                    </Button>
                  )}
                </div>
              )
            })}
          </CardContent>
        </Card>
      )}

      {/* Resource role assignments */}
      {hasResourceRoles && (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <Shield className="h-4 w-4 text-muted-foreground" />
              <CardTitle className="text-base">Assigned roles</CardTitle>
            </div>
            <CardDescription>Spaces you have management access to</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {floorManagerRoles.length > 0 && (
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-2 flex items-center gap-1.5">
                  <Layers className="h-3.5 w-3.5" />
                  Floor manager
                </p>
                <div className="flex flex-wrap gap-2">
                  {floorManagerRoles.map((r) => (
                    <div key={r.id} className="flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm">
                      <span className="font-medium">{r.floor?.name ?? 'Unknown floor'}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {buildingAdminRoles.length > 0 && (
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-2 flex items-center gap-1.5">
                  <Building2 className="h-3.5 w-3.5" />
                  Building admin
                </p>
                <div className="flex flex-wrap gap-2">
                  {buildingAdminRoles.map((r) => (
                    <div key={r.id} className="flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm">
                      <span className="font-medium">{r.building?.name ?? 'Unknown building'}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  )
}
