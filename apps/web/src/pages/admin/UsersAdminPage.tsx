import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Search, Shield, UserX, UserCheck, ChevronDown, UserPlus, Upload, KeyRound } from 'lucide-react'
import { usersApi } from '@/lib/api'
import { UserImportDialog } from '@/components/admin/UserImportDialog'
import { toast } from 'sonner'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import type { User } from '@/types'

function InviteUserDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const [email, setEmail] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [password, setPassword] = useState('')

  const create = useMutation({
    mutationFn: () => usersApi.create({ email, displayName, password }),
    onSuccess: () => {
      toast.success('User created — a welcome email has been queued')
      onCreated()
      onClose()
      setEmail('')
      setDisplayName('')
      setPassword('')
    },
    onError: (err: Error) => toast.error(err.message),
  })

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Create user</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div>
            <Label htmlFor="inv-name">Full name *</Label>
            <Input id="inv-name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} className="mt-1.5" placeholder="Jane Smith" />
          </div>
          <div>
            <Label htmlFor="inv-email">Email *</Label>
            <Input id="inv-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} className="mt-1.5" placeholder="jane@example.com" />
          </div>
          <div>
            <Label htmlFor="inv-pass">Password *</Label>
            <Input id="inv-pass" type="password" value={password} onChange={(e) => setPassword(e.target.value)} className="mt-1.5" placeholder="Min. 12 characters" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={create.isPending}>Cancel</Button>
          <Button onClick={() => create.mutate()} disabled={!email || !displayName || password.length < 12 || create.isPending}>
            {create.isPending ? 'Creating…' : 'Create user'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ResetPasswordDialog({ open, user, onClose }: { open: boolean; user: User; onClose: () => void }) {
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')

  const resetPw = useMutation({
    mutationFn: () => usersApi.resetPassword(user.id, { password }),
    onSuccess: () => {
      toast.success(`Password reset for ${user.displayName}`)
      setPassword('')
      setConfirm('')
      onClose()
    },
    onError: (err: Error) => toast.error(err.message ?? 'Failed to reset password'),
  })

  const mismatch = confirm.length > 0 && password !== confirm
  const valid = password.length >= 12 && password === confirm

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) { setPassword(''); setConfirm(''); onClose() } }}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Reset password</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground -mt-2">
          Set a new password for <span className="font-medium text-foreground">{user.displayName}</span>.
        </p>
        <div className="space-y-4 py-2">
          <div>
            <Label htmlFor="rp-pass">New password</Label>
            <Input
              id="rp-pass"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="mt-1.5"
              placeholder="Min. 12 characters"
              autoComplete="new-password"
            />
          </div>
          <div>
            <Label htmlFor="rp-conf">Confirm new password</Label>
            <Input
              id="rp-conf"
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              className="mt-1.5"
              placeholder="Repeat password"
              autoComplete="new-password"
            />
            {mismatch && <p className="text-xs text-destructive mt-1">Passwords do not match</p>}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => { setPassword(''); setConfirm(''); onClose() }} disabled={resetPw.isPending}>
            Cancel
          </Button>
          <Button onClick={() => resetPw.mutate()} disabled={!valid || resetPw.isPending}>
            {resetPw.isPending ? 'Resetting…' : 'Reset password'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

const roleLabels: Record<string, string> = {
  SUPER_ADMIN: 'Administrator',
  USER: 'User',
}

const statusConfig: Record<string, { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' }> = {
  ACTIVE: { label: 'Active', variant: 'secondary' },
  SUSPENDED: { label: 'Suspended', variant: 'destructive' },
  PENDING: { label: 'Pending', variant: 'outline' },
}

function UserRow({ user, onRefresh }: { user: User; onRefresh: () => void }) {
  const [resetPasswordOpen, setResetPasswordOpen] = useState(false)

  const updateStatus = useMutation({
    mutationFn: (accountStatus: string) => usersApi.update(user.id, { accountStatus } as any),
    onSuccess: () => { toast.success('User updated'); onRefresh() },
    onError: () => toast.error('Failed to update user'),
  })

  const updateRole = useMutation({
    mutationFn: (globalRole: string) => usersApi.update(user.id, { globalRole } as any),
    onSuccess: () => { toast.success('Role updated'); onRefresh() },
    onError: () => toast.error('Failed to update role'),
  })

  const initials = user.displayName
    .split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2)

  const statusCfg = statusConfig[user.accountStatus] ?? { label: user.accountStatus, variant: 'outline' as const }
  const isLocalUser = !user.provider || user.provider === 'LOCAL'

  return (
    <>
      {isLocalUser && (
        <ResetPasswordDialog
          open={resetPasswordOpen}
          user={user}
          onClose={() => setResetPasswordOpen(false)}
        />
      )}
      <Card>
        <CardContent className="p-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0">
              <Avatar className="h-9 w-9 shrink-0">
                <AvatarFallback className="text-sm bg-primary text-primary-foreground">
                  {initials}
                </AvatarFallback>
              </Avatar>
              <div className="min-w-0">
                <p className="font-medium text-sm truncate">{user.displayName}</p>
                <p className="text-xs text-muted-foreground truncate">{user.email}</p>
              </div>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <Badge variant={user.globalRole === 'SUPER_ADMIN' ? 'default' : 'secondary'} className="text-xs hidden sm:inline-flex">
                {roleLabels[user.globalRole] ?? user.globalRole}
              </Badge>
              <Badge variant={statusCfg.variant} className="text-xs hidden sm:inline-flex">
                {statusCfg.label}
              </Badge>

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="sm" className="h-8 gap-1 text-xs">
                    Actions <ChevronDown className="h-3 w-3" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {user.globalRole !== 'SUPER_ADMIN' ? (
                    <DropdownMenuItem onClick={() => updateRole.mutate('SUPER_ADMIN')}>
                      <Shield className="mr-2 h-3.5 w-3.5" />
                      Make Administrator
                    </DropdownMenuItem>
                  ) : (
                    <DropdownMenuItem onClick={() => updateRole.mutate('USER')}>
                      <Shield className="mr-2 h-3.5 w-3.5" />
                      Remove Administrator
                    </DropdownMenuItem>
                  )}
                  {isLocalUser && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem onSelect={(e) => e.preventDefault()} onClick={() => setResetPasswordOpen(true)}>
                        <KeyRound className="mr-2 h-3.5 w-3.5" />
                        Reset password
                      </DropdownMenuItem>
                    </>
                  )}
                  <DropdownMenuSeparator />
                  {user.accountStatus === 'ACTIVE' ? (
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <DropdownMenuItem onSelect={(e) => e.preventDefault()} className="text-destructive focus:text-destructive">
                          <UserX className="mr-2 h-3.5 w-3.5" />
                          Suspend user
                        </DropdownMenuItem>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>Suspend {user.displayName}?</AlertDialogTitle>
                          <AlertDialogDescription>
                            The user will not be able to log in until their account is reactivated.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancel</AlertDialogCancel>
                          <AlertDialogAction
                            onClick={() => updateStatus.mutate('SUSPENDED')}
                            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                          >
                            Suspend
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  ) : (
                    <DropdownMenuItem onClick={() => updateStatus.mutate('ACTIVE')}>
                      <UserCheck className="mr-2 h-3.5 w-3.5" />
                      Reactivate user
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        </CardContent>
      </Card>
    </>
  )
}

export default function UsersAdminPage() {
  const qc = useQueryClient()
  const [search, setSearch] = useState('')
  const [inviteOpen, setInviteOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)

  const { data: users, isLoading } = useQuery({
    queryKey: ['admin', 'users'],
    queryFn: () => usersApi.list(),
    select: (r) => r.data,
  })

  const refresh = () => qc.invalidateQueries({ queryKey: ['admin', 'users'] })

  const filtered = (users ?? []).filter((u) =>
    u.displayName.toLowerCase().includes(search.toLowerCase()) ||
    u.email.toLowerCase().includes(search.toLowerCase())
  )

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">Users</h1>
          <p className="text-muted-foreground text-sm mt-1">Manage user accounts and roles</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setImportOpen(true)}>
            <Upload className="mr-2 h-4 w-4" />
            Import CSV
          </Button>
          <Button onClick={() => setInviteOpen(true)} size="sm">
            <UserPlus className="mr-2 h-4 w-4" />
            Create user
          </Button>
        </div>
      </div>

      <InviteUserDialog
        open={inviteOpen}
        onClose={() => setInviteOpen(false)}
        onCreated={refresh}
      />
      <UserImportDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
      />

      <div className="relative mb-4">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search by name or email…"
          className="pl-9"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => <Skeleton key={i} className="h-20" />)}
        </div>
      ) : filtered.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12 text-center">
            <p className="text-sm text-muted-foreground">
              {search ? 'No users match your search' : 'No users found'}
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {filtered.map((u) => (
            <UserRow key={u.id} user={u} onRefresh={refresh} />
          ))}
        </div>
      )}
    </div>
  )
}
