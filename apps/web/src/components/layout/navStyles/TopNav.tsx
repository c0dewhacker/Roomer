import { NavLink, useNavigate } from 'react-router-dom'
import { useState } from 'react'
import { ChevronDown, Building2, LogOut, Settings, User, Sun, Moon, Info, ExternalLink } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useNavConfig } from '@/hooks/useNavConfig'
import { useAuth } from '@/hooks/useAuth'
import { useThemeStore } from '@/stores/theme'
import { useBranding } from '@/hooks/useBranding'
import { brandingApi } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { NotificationBell } from '../NotificationBell'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useQuery } from '@tanstack/react-query'
import { buildingsApi } from '@/lib/api'

const APP_VERSION = import.meta.env.VITE_APP_VERSION || 'dev'
const APP_REPO_URL = import.meta.env.VITE_APP_REPO_URL || ''

// Keyboard-only focus ring — no lingering outline after a mouse click.
const NAV_FOCUS = 'focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset'

export function TopNav() {
  const { sections } = useNavConfig()
  const { user, logout } = useAuth()
  const navigate = useNavigate()
  const branding = useBranding()
  const { theme, setTheme } = useThemeStore()
  const [aboutOpen, setAboutOpen] = useState(false)

  const isDark = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)

  const initials = user?.displayName
    ?.split(' ').slice(0, 2).map((n) => n[0]).join('').toUpperCase()

  const personalSection = sections.find((s) => s.id === 'personal')
  const secondarySections = sections.filter((s) => s.id !== 'personal')
  // Admin is split into several labelled groups; building-admin / floor-manager
  // have a single section. Use a generic trigger when there's more than one group.
  const secondaryTriggerLabel = secondarySections.length > 1 ? 'Admin' : secondarySections[0]?.label

  return (
    <>
      <header className="flex h-14 items-center gap-4 border-b bg-background px-4 shrink-0">
        {/* Logo / App name */}
        <div className="flex items-center gap-3 shrink-0">
          {branding?.logoPath ? (
            <img
              src={`${brandingApi.getLogoUrl()}?t=${branding.logoPath}`}
              alt={branding.appName ?? 'Logo'}
              className="h-7 max-w-[120px] object-contain"
            />
          ) : (
            <span className="text-sm font-bold text-foreground">{branding?.appName ?? 'Roomer'}</span>
          )}
        </div>

        <div className="h-5 w-px bg-border shrink-0" />

        {/* Primary nav items */}
        <nav className="flex items-center gap-1 flex-1 overflow-x-auto">
          {personalSection?.items.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium whitespace-nowrap transition-colors',
                  NAV_FOCUS,
                  isActive
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                )
              }
            >
              <item.icon className="h-3.5 w-3.5" />
              {item.label}
            </NavLink>
          ))}

          {/* Buildings dropdown */}
          <BuildingsDropdown />

          {/* Admin / Manager dropdown — groups rendered as labelled sections */}
          {secondarySections.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className={cn('flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors whitespace-nowrap', NAV_FOCUS)}>
                  {secondaryTriggerLabel}
                  <ChevronDown className="h-3 w-3" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-48">
                {secondarySections.map((section, i) => (
                  <div key={section.id}>
                    {i > 0 && <DropdownMenuSeparator />}
                    {secondarySections.length > 1 && section.label && (
                      <DropdownMenuLabel className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60">
                        {section.label}
                      </DropdownMenuLabel>
                    )}
                    {section.items.map((item) => (
                      <DropdownMenuItem key={item.to} onClick={() => navigate(item.to)}>
                        <item.icon className="mr-2 h-4 w-4" />
                        {item.label}
                      </DropdownMenuItem>
                    ))}
                  </div>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </nav>

        {/* Right side */}
        <div className="flex items-center gap-2 shrink-0">
          <NotificationBell />
          <Button
            variant="ghost" size="icon" className="h-9 w-9"
            title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
            onClick={() => setTheme(isDark ? 'light' : 'dark')}
          >
            {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" className="relative h-9 w-9 rounded-full p-0">
                <Avatar className="h-9 w-9">
                  <AvatarFallback className="bg-primary text-primary-foreground text-sm">{initials ?? 'U'}</AvatarFallback>
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
                <User className="mr-2 h-4 w-4" /> Profile
              </DropdownMenuItem>
              {user?.globalRole === 'SUPER_ADMIN' && (
                <DropdownMenuItem onClick={() => navigate('/admin/settings')}>
                  <Settings className="mr-2 h-4 w-4" /> Settings
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => setAboutOpen(true)}>
                <Info className="mr-2 h-4 w-4" /> About
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={logout} className="text-destructive">
                <LogOut className="mr-2 h-4 w-4" /> Log out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      <Dialog open={aboutOpen} onOpenChange={setAboutOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader><DialogTitle>About Roomer</DialogTitle></DialogHeader>
          <div className="space-y-3 py-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Version</span>
              <span className="font-mono font-medium">{APP_VERSION}</span>
            </div>
            {APP_REPO_URL && (
              <div className="flex justify-between items-center">
                <span className="text-muted-foreground">Source</span>
                <a href={APP_REPO_URL} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 text-primary hover:underline">
                  GitHub <ExternalLink className="h-3 w-3" />
                </a>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}

function BuildingsDropdown() {
  const { buildingsData } = useNavConfig()
  const navigate = useNavigate()
  const [openBuilding, setOpenBuilding] = useState<string | null>(null)

  const { data: buildingDetail } = useQuery({
    queryKey: ['buildings', openBuilding],
    queryFn: () => buildingsApi.get(openBuilding!),
    select: (res) => res.data,
    enabled: !!openBuilding,
  })

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button className={cn('flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors whitespace-nowrap', NAV_FOCUS)}>
          <Building2 className="h-3.5 w-3.5" />
          Buildings
          <ChevronDown className="h-3 w-3" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-52">
        {buildingsData.map((b) => (
          <div key={b.id}>
            <DropdownMenuItem
              className="font-medium"
              onSelect={(e) => {
                e.preventDefault()
                setOpenBuilding(openBuilding === b.id ? null : b.id)
              }}
            >
              <Building2 className="mr-2 h-4 w-4" />
              {b.name}
              <ChevronDown className={cn('ml-auto h-3 w-3 transition-transform', openBuilding === b.id && 'rotate-180')} />
            </DropdownMenuItem>
            {openBuilding === b.id && buildingDetail?.floors?.map((floor) => (
              <DropdownMenuItem
                key={floor.id}
                className="pl-8 text-muted-foreground"
                onClick={() => navigate(`/floors/${floor.id}`)}
              >
                {floor.name}
              </DropdownMenuItem>
            ))}
          </div>
        ))}
        {buildingsData.length === 0 && (
          <DropdownMenuItem disabled>No buildings</DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
