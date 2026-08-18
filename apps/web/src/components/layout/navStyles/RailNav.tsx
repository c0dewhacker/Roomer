/**
 * RailNav — 48 px icon rail always visible on the left.
 * Clicking a rail icon slides out a 220 px navigation panel.
 * The panel dismisses on outside click or navigation.
 */
import { useState, useRef, useEffect } from 'react'
import { NavLink, useNavigate, useLocation } from 'react-router-dom'
import { ChevronDown, ChevronRight, Building2, LogOut, Settings, User, Sun, Moon, Info, ExternalLink, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useNavConfig } from '@/hooks/useNavConfig'
import { useAuth } from '@/hooks/useAuth'
import { useThemeStore } from '@/stores/theme'
import { useBranding } from '@/hooks/useBranding'
import { buildingsApi } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { NotificationBell } from '../NotificationBell'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useQuery } from '@tanstack/react-query'

const APP_VERSION = import.meta.env.VITE_APP_VERSION || 'dev'
const APP_REPO_URL = import.meta.env.VITE_APP_REPO_URL || ''

type RailSection = 'personal' | 'buildings' | 'admin' | 'manager' | null

// Keyboard-only focus ring — no lingering outline after a mouse click.
const NAV_FOCUS = 'focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset'

export function RailNav({ onNavigate }: { onNavigate?: () => void }) {
  const { sections, buildingsData } = useNavConfig()
  const { user, logout } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const branding = useBranding()
  const { theme, setTheme } = useThemeStore()
  const [activePanel, setActivePanel] = useState<RailSection>(null)
  const [aboutOpen, setAboutOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  const isDark = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  // A double space, or a leading/trailing space, in displayName produces an
  // empty-string part when split on a literal ' ' — n[0] on that is
  // undefined, and Array.join('') renders it as the literal text "undefined".
  const initials = user?.displayName?.trim().split(/\s+/).slice(0, 2).map((n) => n[0]).join('').toUpperCase()

  const personalSection = sections.find((s) => s.id === 'personal')
  const secondarySections = sections.filter((s) => s.id !== 'personal')
  // All admin groups share one rail entry ('admin'); the flyout shows them as
  // labelled sub-groups. Single-section roles keep their own label.
  const secondaryLabel = secondarySections.length > 1 ? 'Admin' : secondarySections[0]?.label ?? 'More'
  const secondaryIcon = secondarySections[0]?.items[0]?.icon

  useEffect(() => { setActivePanel(null) }, [location.pathname])

  useEffect(() => {
    if (!activePanel) return
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setActivePanel(null)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [activePanel])

  const toggle = (id: RailSection) => setActivePanel((p) => (p === id ? null : id))

  const handleNavigate = () => {
    setActivePanel(null)
    onNavigate?.()
  }

  return (
    <TooltipProvider delayDuration={300}>
      {activePanel && (
        <div className="fixed inset-0 z-40 bg-black/50 md:hidden" onClick={() => setActivePanel(null)} />
      )}
      <div ref={containerRef} className="flex h-full shrink-0">
        {/* Rail */}
        <div className="flex w-12 flex-col items-center border-r bg-background py-3 gap-1 shrink-0">
          {/* Branding mark */}
          <div className="mb-2 flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground text-xs font-bold select-none">
            {(branding?.sidebarTitle ?? 'R')[0].toUpperCase()}
          </div>

          <div className="w-6 border-t mb-1" />

          {/* Personal */}
          {personalSection && (
            <RailIcon
              icon={personalSection.items[0].icon}
              label="Personal"
              active={activePanel === 'personal'}
              onClick={() => toggle('personal')}
            />
          )}

          {/* Buildings */}
          <RailIcon
            icon={Building2}
            label="Buildings"
            active={activePanel === 'buildings'}
            onClick={() => toggle('buildings')}
          />

          {/* Admin / Manager */}
          {secondarySections.length > 0 && secondaryIcon && (
            <RailIcon
              icon={secondaryIcon}
              label={secondaryLabel}
              active={activePanel === 'admin'}
              onClick={() => toggle('admin')}
            />
          )}

          {/* Spacer pushes utilities to bottom */}
          <div className="flex-1" />

          {/* Utilities */}
          <NotificationBell />
          <Button
            variant="ghost" size="icon" className="h-8 w-8"
            title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
            onClick={() => setTheme(isDark ? 'light' : 'dark')}
          >
            {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" className="h-8 w-8 rounded-full p-0" aria-label="Open user menu">
                <Avatar className="h-8 w-8">
                  <AvatarFallback className="bg-primary text-primary-foreground text-xs">{initials ?? 'U'}</AvatarFallback>
                </Avatar>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="right" align="end" className="w-56">
              <DropdownMenuLabel>
                <p className="text-sm font-medium">{user?.displayName}</p>
                <p className="text-xs text-muted-foreground">{user?.email}</p>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => navigate('/profile')}><User className="mr-2 h-4 w-4" />Profile</DropdownMenuItem>
              {user?.globalRole === 'SUPER_ADMIN' && (
                <DropdownMenuItem onClick={() => navigate('/admin/settings')}><Settings className="mr-2 h-4 w-4" />Settings</DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => setAboutOpen(true)}><Info className="mr-2 h-4 w-4" />About</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={logout} className="text-destructive"><LogOut className="mr-2 h-4 w-4" />Log out</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {/* Slide-out panel — on mobile this overlays the content (fixed,
            starting after the 48px rail) rather than sitting inline in the
            flex row, which otherwise squeezed the main content down to a
            sliver (rail + 220px panel leaves ~100px on a phone). md+ keeps
            the original inline layout. */}
        {activePanel && (
          <div className="fixed left-12 inset-y-0 z-50 md:static md:z-auto w-[220px] flex flex-col border-r bg-background shadow-lg animate-in slide-in-from-left-2 duration-150 overflow-y-auto">
            <div className="flex items-center justify-between px-3 py-3 border-b shrink-0">
              <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {activePanel === 'personal' ? 'My Space' :
                 activePanel === 'buildings' ? 'Buildings' :
                 secondaryLabel}
              </span>
              <button onClick={() => setActivePanel(null)} aria-label="Close panel" className="rounded p-0.5 text-muted-foreground hover:text-foreground">
                <X className="h-3.5 w-3.5" />
              </button>
            </div>

            <nav className="flex-1 p-2 space-y-0.5">
              {activePanel === 'personal' && personalSection?.items.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  onClick={handleNavigate}
                  className={({ isActive }) =>
                    cn(
                      'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                      isActive ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                    )
                  }
                >
                  <item.icon className="h-4 w-4 shrink-0" />
                  {item.label}
                </NavLink>
              ))}

              {activePanel === 'buildings' && (
                <BuildingsPanel buildingsData={buildingsData} onNavigate={handleNavigate} />
              )}

              {activePanel === 'admin' && secondarySections.map((section, i) => (
                <div key={section.id} className={cn(i > 0 && 'pt-2')}>
                  {secondarySections.length > 1 && section.label && (
                    <p className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/50">
                      {section.label}
                    </p>
                  )}
                  {section.items.map((item) => (
                    <NavLink
                      key={item.to}
                      to={item.to}
                      onClick={handleNavigate}
                      className={({ isActive }) =>
                        cn(
                          'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                          isActive ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                        )
                      }
                    >
                      <item.icon className="h-4 w-4 shrink-0" />
                      {item.label}
                    </NavLink>
                  ))}
                </div>
              ))}
            </nav>
          </div>
        )}
      </div>

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
    </TooltipProvider>
  )
}

function RailIcon({
  icon: Icon,
  label,
  active,
  onClick,
}: {
  icon: React.ElementType
  label: string
  active: boolean
  onClick: () => void
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          onClick={onClick}
          className={cn(
            'flex h-9 w-9 items-center justify-center rounded-lg transition-colors',
            NAV_FOCUS,
            active ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
          )}
        >
          <Icon className="h-4.5 w-4.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  )
}

function BuildingsPanel({
  buildingsData,
  onNavigate,
}: {
  buildingsData: Array<{ id: string; name: string }>
  onNavigate: () => void
}) {
  const navigate = useNavigate()
  const [openBuilding, setOpenBuilding] = useState<string | null>(null)
  const { data } = useQuery({
    queryKey: ['buildings', openBuilding],
    queryFn: () => buildingsApi.get(openBuilding!),
    select: (res) => res.data,
    enabled: !!openBuilding,
  })

  return (
    <div className="space-y-0.5">
      {buildingsData.map((b) => (
        <div key={b.id}>
          <button
            onClick={() => setOpenBuilding(openBuilding === b.id ? null : b.id)}
            className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
          >
            <Building2 className="h-4 w-4 shrink-0" />
            <span className="flex-1 text-left">{b.name}</span>
            {openBuilding === b.id ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          </button>
          {openBuilding === b.id && data?.floors?.map((floor) => (
            <button
              key={floor.id}
              onClick={() => { navigate(`/floors/${floor.id}`); onNavigate() }}
              className="flex w-full items-center pl-9 pr-3 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-accent rounded-lg transition-colors"
            >
              {floor.name}
            </button>
          ))}
        </div>
      ))}
      {buildingsData.length === 0 && (
        <p className="px-3 py-2 text-xs text-muted-foreground">No buildings</p>
      )}
    </div>
  )
}
