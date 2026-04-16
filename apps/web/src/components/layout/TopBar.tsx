import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { User, LogOut, Settings, Menu, Sun, Moon, Info, ExternalLink } from 'lucide-react'
import { useAuth } from '@/hooks/useAuth'
import { useThemeStore } from '@/stores/theme'
import { useBranding } from '@/hooks/useBranding'
import { brandingApi } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { NotificationBell } from './NotificationBell'

const APP_VERSION = import.meta.env.VITE_APP_VERSION || 'dev'
const APP_REPO_URL = import.meta.env.VITE_APP_REPO_URL || ''

interface TopBarProps {
  onMenuClick?: () => void
}

export function TopBar({ onMenuClick }: TopBarProps) {
  const { user, logout } = useAuth()
  const navigate = useNavigate()
  const [aboutOpen, setAboutOpen] = useState(false)
  const { theme, setTheme } = useThemeStore()
  const branding = useBranding()
  const isDark =
    theme === 'dark' ||
    (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)

  const initials = user?.displayName
    ?.split(' ')
    .slice(0, 2)
    .map((n) => n[0])
    .join('')
    .toUpperCase()

  return (
    <header className="flex h-14 items-center justify-between border-b bg-background px-4">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" className="md:hidden" onClick={onMenuClick}>
          <Menu className="h-5 w-5" />
        </Button>
        {branding?.logoPath ? (
          <img
            src={`${brandingApi.getLogoUrl()}?t=${branding.logoPath}`}
            alt={branding.appName ?? 'Logo'}
            className="hidden md:block h-7 max-w-[120px] object-contain"
          />
        ) : (
          <span className="hidden text-sm font-semibold text-muted-foreground md:block">
            {branding?.appName ?? 'Roomer'}
          </span>
        )}
      </div>

      <div className="flex items-center gap-2">
        <NotificationBell />

        <Button
          variant="ghost"
          size="icon"
          className="h-9 w-9"
          title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
          onClick={() => setTheme(isDark ? 'light' : 'dark')}
        >
          {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
        </Button>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" className="relative h-9 w-9 rounded-full p-0">
              <Avatar className="h-9 w-9">
                <AvatarFallback className="bg-primary text-primary-foreground text-sm">
                  {initials ?? 'U'}
                </AvatarFallback>
              </Avatar>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel>
              <div className="flex flex-col space-y-1">
                <p className="text-sm font-medium">{user?.displayName}</p>
                <p className="text-xs text-muted-foreground">{user?.email}</p>
              </div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => navigate('/profile')}>
              <User className="mr-2 h-4 w-4" />
              Profile
            </DropdownMenuItem>
            {user?.globalRole === 'SUPER_ADMIN' && (
              <DropdownMenuItem onClick={() => navigate('/admin/settings')}>
                <Settings className="mr-2 h-4 w-4" />
                Settings
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => setAboutOpen(true)}>
              <Info className="mr-2 h-4 w-4" />
              About
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={logout} className="text-destructive">
              <LogOut className="mr-2 h-4 w-4" />
              Log out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <Dialog open={aboutOpen} onOpenChange={setAboutOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>About Roomer</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Version</span>
              <span className="font-mono font-medium">{APP_VERSION}</span>
            </div>
            {APP_REPO_URL && (
              <div className="flex justify-between items-center">
                <span className="text-muted-foreground">Source</span>
                <a
                  href={APP_REPO_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1 text-primary hover:underline"
                >
                  GitHub
                  <ExternalLink className="h-3 w-3" />
                </a>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </header>
  )
}
