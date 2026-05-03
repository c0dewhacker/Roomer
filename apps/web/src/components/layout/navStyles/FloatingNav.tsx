/**
 * FloatingNav — fixed logo + two draggable glass-morphism floats.
 *
 * 1. Logo           — fixed top-left, pointer-events-none (non-blocking)
 * 2. Utility float  — notifications, theme, user menu (draggable)
 * 3. Nav island     — primary navigation (draggable + rotatable via scroll-during-drag)
 *
 * Panel positioning uses getBoundingClientRect on the pill element so the
 * panel always appears adjacent to the pill's visual bounds, even when rotated.
 * Panel direction adapts based on rotation:
 *   near-horizontal → above / below   (based on y position)
 *   near-vertical   → right / left    (based on x position)
 */
import { useState, useRef, useEffect } from 'react'
import { NavLink, useNavigate, useLocation } from 'react-router-dom'
import {
  ChevronDown, ChevronRight, Building2, GripHorizontal,
  LogOut, Settings, User, Sun, Moon, Info, ExternalLink, X,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useNavConfig } from '@/hooks/useNavConfig'
import { useAuth } from '@/hooks/useAuth'
import { useThemeStore } from '@/stores/theme'
import { useBranding } from '@/hooks/useBranding'
import { brandingApi, buildingsApi } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { NotificationBell } from '../NotificationBell'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useQuery } from '@tanstack/react-query'

const APP_VERSION = import.meta.env.VITE_APP_VERSION || 'dev'
const APP_REPO_URL = import.meta.env.VITE_APP_REPO_URL || ''

const UTIL_KEY = 'roomer-floating-util-pos'
const NAV_KEY  = 'roomer-floating-nav-pos'
const ROT_KEY  = 'roomer-floating-nav-rot'

type PanelId  = 'buildings' | 'admin' | 'manager' | null
type PanelDir = 'above' | 'below' | 'right' | 'left'
type Pos = { x: number; y: number }

// ── Shared drag hook ──────────────────────────────────────────────────────────

function useDraggable(storageKey: string, getDefault: () => Pos) {
  const [pos, setPos] = useState<Pos>(() => {
    try {
      const p = JSON.parse(localStorage.getItem(storageKey) ?? '') as Pos
      if (typeof p.x === 'number' && typeof p.y === 'number') return p
    } catch {}
    return getDefault()
  })

  const elRef = useRef<HTMLDivElement>(null)
  const drag = useRef({ active: false, startX: 0, startY: 0, origX: 0, origY: 0 })

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    drag.current = { active: true, startX: e.clientX, startY: e.clientY, origX: pos.x, origY: pos.y }
    e.currentTarget.setPointerCapture(e.pointerId)
    e.preventDefault()
  }

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!drag.current.active) return
    const { startX, startY, origX, origY } = drag.current
    setPos({ x: origX + e.clientX - startX, y: origY + e.clientY - startY })
  }

  const onPointerUp = () => {
    if (!drag.current.active) return
    drag.current.active = false
    setPos((p) => {
      const rect = elRef.current?.getBoundingClientRect()
      const clamped: Pos = {
        x: Math.max(8, Math.min(p.x, window.innerWidth  - (rect?.width  ?? 140) - 8)),
        y: Math.max(8, Math.min(p.y, window.innerHeight - (rect?.height ?? 44)  - 8)),
      }
      localStorage.setItem(storageKey, JSON.stringify(clamped))
      return clamped
    })
  }

  useEffect(() => {
    const onResize = () => setPos((p) => {
      const rect = elRef.current?.getBoundingClientRect()
      return {
        x: Math.max(8, Math.min(p.x, window.innerWidth  - (rect?.width  ?? 140) - 8)),
        y: Math.max(8, Math.min(p.y, window.innerHeight - (rect?.height ?? 44)  - 8)),
      }
    })
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  return { pos, elRef, gripProps: { onPointerDown, onPointerMove, onPointerUp } as const }
}

// ── Panel direction + positioning ─────────────────────────────────────────────

function getPanelDir(rotation: number, pos: Pos): PanelDir {
  const norm = ((rotation % 360) + 360) % 360
  const nearVertical = (norm > 45 && norm < 135) || (norm > 225 && norm < 315)
  if (nearVertical) return pos.x < window.innerWidth / 2 ? 'right' : 'left'
  return pos.y > window.innerHeight * 0.5 ? 'above' : 'below'
}

// CSS transform so the panel's anchor corner sits at (left, top) of the fixed element
const panelTransform: Record<PanelDir, string> = {
  above: 'translate(-50%, -100%)',
  below: 'translate(-50%, 0)',
  right: 'translate(0, -50%)',
  left:  'translate(-100%, -50%)',
}

const panelSlide: Record<PanelDir, string> = {
  above: 'animate-in slide-in-from-bottom-2',
  below: 'animate-in slide-in-from-top-2',
  right: 'animate-in slide-in-from-left-2',
  left:  'animate-in slide-in-from-right-2',
}

// Compute the fixed anchor point for a panel given the pill's getBoundingClientRect
function computeAnchor(dir: PanelDir, rect: DOMRect, gap = 8): Pos {
  switch (dir) {
    case 'above': return { x: rect.left + rect.width  / 2, y: rect.top    - gap }
    case 'below': return { x: rect.left + rect.width  / 2, y: rect.bottom + gap }
    case 'right': return { x: rect.right  + gap,           y: rect.top    + rect.height / 2 }
    case 'left':  return { x: rect.left   - gap,           y: rect.top    + rect.height / 2 }
  }
}

// ── Main component ────────────────────────────────────────────────────────────

export function FloatingNav() {
  const { sections, buildingsData } = useNavConfig()
  const { user, logout } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const branding = useBranding()
  const { theme, setTheme } = useThemeStore()
  const [openPanel, setOpenPanel] = useState<PanelId>(null)
  const [panelState, setPanelState] = useState<{ anchor: Pos; dir: PanelDir } | null>(null)
  const [aboutOpen, setAboutOpen] = useState(false)

  const isDark = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  const initials = user?.displayName?.split(' ').slice(0, 2).map((n) => n[0]).join('').toUpperCase()
  const personalSection  = sections.find((s) => s.id === 'personal')
  const secondarySection = sections.find((s) => s.id !== 'personal')

  // ── Utility float ─────────────────────────────────────────────────────────

  const util = useDraggable(UTIL_KEY, () => ({ x: Math.max(8, window.innerWidth - 200), y: 16 }))

  // ── Nav float — drag + wheel rotation ────────────────────────────────────

  const [navPos, setNavPos] = useState<Pos>(() => {
    try {
      const p = JSON.parse(localStorage.getItem(NAV_KEY) ?? '') as Pos
      if (typeof p.x === 'number' && typeof p.y === 'number') return p
    } catch {}
    return { x: Math.max(8, Math.round(window.innerWidth / 2) - 160), y: window.innerHeight - 80 }
  })

  const [rotation, setRotation] = useState<number>(() => {
    try { return Number(localStorage.getItem(ROT_KEY)) || 0 } catch { return 0 }
  })

  const navRef    = useRef<HTMLDivElement>(null)
  const pillRef   = useRef<HTMLDivElement>(null)   // tracks visual pill bounds after rotation
  const panelElRef = useRef<HTMLDivElement | null>(null)
  const navDrag = useRef({ active: false, startX: 0, startY: 0, origX: 0, origY: 0 })

  const wheelHandler = useRef((e: WheelEvent) => {
    if (!navDrag.current.active) return
    e.preventDefault()
    setRotation((r) => {
      const next = ((r + (e.deltaY < 0 ? 5 : -5)) % 360 + 360) % 360
      localStorage.setItem(ROT_KEY, String(next))
      return next
    })
  })

  const closePanel = () => { setOpenPanel(null); setPanelState(null) }

  const onNavGripDown = (e: React.PointerEvent<HTMLDivElement>) => {
    navDrag.current = { active: true, startX: e.clientX, startY: e.clientY, origX: navPos.x, origY: navPos.y }
    e.currentTarget.setPointerCapture(e.pointerId)
    e.preventDefault()
    closePanel()  // dismiss any open panel when dragging starts
    window.addEventListener('wheel', wheelHandler.current, { passive: false })
  }

  const onNavGripMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!navDrag.current.active) return
    const { startX, startY, origX, origY } = navDrag.current
    setNavPos({ x: origX + e.clientX - startX, y: origY + e.clientY - startY })
  }

  const onNavGripUp = () => {
    if (!navDrag.current.active) return
    navDrag.current.active = false
    window.removeEventListener('wheel', wheelHandler.current)
    setNavPos((p) => {
      const rect = navRef.current?.getBoundingClientRect()
      const clamped: Pos = {
        x: Math.max(8, Math.min(p.x, window.innerWidth  - (rect?.width  ?? 320) - 8)),
        y: Math.max(8, Math.min(p.y, window.innerHeight - (rect?.height ?? 56)  - 8)),
      }
      localStorage.setItem(NAV_KEY, JSON.stringify(clamped))
      return clamped
    })
  }

  useEffect(() => {
    const wh = wheelHandler.current
    const onResize = () => setNavPos((p) => {
      const rect = navRef.current?.getBoundingClientRect()
      return {
        x: Math.max(8, Math.min(p.x, window.innerWidth  - (rect?.width  ?? 320) - 8)),
        y: Math.max(8, Math.min(p.y, window.innerHeight - (rect?.height ?? 56)  - 8)),
      }
    })
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      window.removeEventListener('wheel', wh)
    }
  }, [])

  // ── Panel toggle ──────────────────────────────────────────────────────────

  const togglePanel = (id: PanelId) => {
    if (openPanel === id) { closePanel(); return }
    const rect = pillRef.current?.getBoundingClientRect()
    if (!rect) return
    const dir = getPanelDir(rotation, navPos)
    setPanelState({ anchor: computeAnchor(dir, rect), dir })
    setOpenPanel(id)
  }

  // Close panel on navigation
  useEffect(() => { closePanel() }, [location.pathname])

  // Close panel on outside click (checks both nav and panel elements)
  useEffect(() => {
    if (!openPanel) return
    const handler = (e: MouseEvent) => {
      const inNav   = navRef.current?.contains(e.target as Node)
      const inPanel = panelElRef.current?.contains(e.target as Node)
      if (!inNav && !inPanel) closePanel()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [openPanel])

  const gripClass = 'cursor-grab active:cursor-grabbing select-none touch-none text-muted-foreground/30 hover:text-muted-foreground/60 transition-colors'
  const SecIcon = secondarySection?.items[0]?.icon

  return (
    <>
      {/* ── Logo — fixed top-left, non-blocking ───────────────────────────── */}
      <div style={{ position: 'fixed', top: 16, left: 16, zIndex: 10, pointerEvents: 'none' }}>
        {branding?.logoPath ? (
          <img
            src={`${brandingApi.getLogoUrl()}?t=${branding.logoPath}`}
            alt={branding.appName ?? 'Logo'}
            className="h-6 max-w-[100px] object-contain opacity-70"
          />
        ) : (
          <span className="text-sm font-bold text-foreground/70 select-none">
            {branding?.appName ?? 'Roomer'}
          </span>
        )}
      </div>

      {/* ── Utility float ─────────────────────────────────────────────────── */}
      {/* eslint-disable-next-line react-hooks/refs -- util.elRef is passed to ref=, not read; util.pos is useState not a ref */}
      <div ref={util.elRef} style={{ position: 'fixed', left: util.pos.x, top: util.pos.y, zIndex: 50 }}>
        <div className="flex items-center gap-1 rounded-xl border border-border/60 bg-background/80 px-2 py-1.5 shadow-lg backdrop-blur-xl">
          {/* eslint-disable-next-line react-hooks/refs -- gripProps contains event handlers, not ref values */}
          <div {...util.gripProps} className={`${gripClass} px-0.5`} title="Drag to reposition">
            <GripHorizontal className="h-3 w-3" />
          </div>
          <div className="mx-0.5 h-5 w-px bg-border/40" />
          <NotificationBell />
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setTheme(isDark ? 'light' : 'dark')}>
            {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" className="h-8 w-8 rounded-full p-0">
                <Avatar className="h-8 w-8">
                  <AvatarFallback className="bg-primary text-primary-foreground text-xs">{initials ?? 'U'}</AvatarFallback>
                </Avatar>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
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
      </div>

      {/* ── Nav island ────────────────────────────────────────────────────── */}
      <div ref={navRef} style={{ position: 'fixed', left: navPos.x, top: navPos.y, zIndex: 50 }}>
        {/* Pill — rotates; each item counter-rotates to stay upright */}
        <div
          ref={pillRef}
          style={{ transform: `rotate(${rotation}deg)` }}
          className="flex items-center gap-1 rounded-2xl border border-border/60 bg-background/80 px-3 py-2 shadow-2xl backdrop-blur-xl"
        >
          {/* Drag + rotate handle */}
          <div
            onPointerDown={onNavGripDown}
            onPointerMove={onNavGripMove}
            onPointerUp={onNavGripUp}
            style={{ transform: `rotate(${-rotation}deg)` }}
            className={`${gripClass} px-1`}
            title="Drag to move · Scroll to rotate"
          >
            <GripHorizontal className="h-3.5 w-3.5" />
          </div>

          <div style={{ transform: `rotate(${-rotation}deg)` }} className="mx-0.5 h-6 w-px bg-border/40" />

          {/* Personal nav items */}
          {personalSection?.items.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                cn(
                  'flex items-center justify-center rounded-xl p-2 transition-all duration-150',
                  isActive
                    ? 'bg-primary text-primary-foreground shadow-sm'
                    : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                )
              }
            >
              <div style={{ transform: `rotate(${-rotation}deg)` }} className="flex flex-col items-center gap-0.5">
                <item.icon className="h-5 w-5" />
                <span className="text-[10px] font-medium leading-none">{item.label.replace('My ', '')}</span>
              </div>
            </NavLink>
          ))}

          <div style={{ transform: `rotate(${-rotation}deg)` }} className="mx-1 h-8 w-px bg-border/60" />

          {/* Buildings trigger */}
          <button
            onClick={() => togglePanel('buildings')}
            className={cn(
              'flex items-center justify-center rounded-xl p-2 transition-all duration-150',
              openPanel === 'buildings'
                ? 'bg-primary text-primary-foreground shadow-sm'
                : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
            )}
          >
            <div style={{ transform: `rotate(${-rotation}deg)` }} className="flex flex-col items-center gap-0.5">
              <Building2 className="h-5 w-5" />
              <span className="text-[10px] font-medium leading-none">Buildings</span>
            </div>
          </button>

          {/* Secondary section trigger (Admin / Manager) */}
          {secondarySection && SecIcon && (
            <>
              <div style={{ transform: `rotate(${-rotation}deg)` }} className="mx-1 h-8 w-px bg-border/60" />
              <button
                onClick={() => togglePanel(secondarySection.id as PanelId)}
                className={cn(
                  'flex items-center justify-center rounded-xl p-2 transition-all duration-150',
                  openPanel === secondarySection.id
                    ? 'bg-primary text-primary-foreground shadow-sm'
                    : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                )}
              >
                <div style={{ transform: `rotate(${-rotation}deg)` }} className="flex flex-col items-center gap-0.5">
                  <SecIcon className="h-5 w-5" />
                  <span className="text-[10px] font-medium leading-none">{secondarySection.label}</span>
                </div>
              </button>
            </>
          )}
        </div>
      </div>

      {/* ── Panel — fixed, positioned via getBoundingClientRect ───────────── */}
      {openPanel && panelState && (
        <div
          ref={(el) => { panelElRef.current = el }}
          style={{
            position: 'fixed',
            left: panelState.anchor.x,
            top: panelState.anchor.y,
            transform: panelTransform[panelState.dir],
            zIndex: 51,
          }}
        >
          {openPanel === 'buildings' && (
            <BuildingsPanel buildingsData={buildingsData} onClose={closePanel} dir={panelState.dir} />
          )}
          {openPanel === (secondarySection?.id as PanelId) && secondarySection && (
            <SectionPanel
              label={secondarySection.label ?? ''}
              items={secondarySection.items}
              onClose={closePanel}
              dir={panelState.dir}
            />
          )}
        </div>
      )}

      {/* About dialog */}
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

// ── Sub-panels ────────────────────────────────────────────────────────────────

function BuildingsPanel({
  buildingsData,
  onClose,
  dir,
}: {
  buildingsData: Array<{ id: string; name: string }>
  onClose: () => void
  dir: PanelDir
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
    <div className={cn(
      'w-56 rounded-2xl border border-border/60 bg-background/90 p-2 shadow-2xl backdrop-blur-xl duration-150',
      panelSlide[dir],
    )}>
      <div className="flex items-center justify-between px-2 py-1 mb-1">
        <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Buildings</span>
        <button onClick={onClose} className="rounded p-0.5 text-muted-foreground hover:text-foreground">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      {buildingsData.map((b) => (
        <div key={b.id}>
          <button
            onClick={() => setOpenBuilding(openBuilding === b.id ? null : b.id)}
            className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-foreground hover:bg-accent transition-colors"
          >
            <Building2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="flex-1 text-left">{b.name}</span>
            {openBuilding === b.id
              ? <ChevronDown className="h-3 w-3 text-muted-foreground" />
              : <ChevronRight className="h-3 w-3 text-muted-foreground" />}
          </button>
          {openBuilding === b.id && data?.floors?.map((floor) => (
            <button
              key={floor.id}
              onClick={() => { navigate(`/floors/${floor.id}`); onClose() }}
              className="flex w-full items-center pl-8 pr-2 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-accent rounded-lg transition-colors"
            >
              {floor.name}
            </button>
          ))}
        </div>
      ))}
      {buildingsData.length === 0 && <p className="px-2 py-2 text-xs text-muted-foreground">No buildings</p>}
    </div>
  )
}

function SectionPanel({
  label,
  items,
  onClose,
  dir,
}: {
  label: string
  items: Array<{ to: string; icon: React.ElementType; label: string }>
  onClose: () => void
  dir: PanelDir
}) {
  const navigate = useNavigate()
  return (
    <div className={cn(
      'w-52 rounded-2xl border border-border/60 bg-background/90 p-2 shadow-2xl backdrop-blur-xl duration-150',
      panelSlide[dir],
    )}>
      <div className="flex items-center justify-between px-2 py-1 mb-1">
        <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">{label}</span>
        <button onClick={onClose} className="rounded p-0.5 text-muted-foreground hover:text-foreground">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      {items.map((item) => (
        <button
          key={item.to}
          onClick={() => { navigate(item.to); onClose() }}
          className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm text-foreground hover:bg-accent transition-colors"
        >
          <item.icon className="h-4 w-4 shrink-0 text-muted-foreground" />
          {item.label}
        </button>
      ))}
    </div>
  )
}
