import { useState, useEffect } from 'react'
import { NavLink } from 'react-router-dom'
import { ChevronDown, ChevronRight, Pin, PinOff, Building2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useNavConfig } from '@/hooks/useNavConfig'
import { useQuery } from '@tanstack/react-query'
import { buildingsApi } from '@/lib/api'
import { useBranding } from '@/hooks/useBranding'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

const PINNED_KEY = 'roomer-sidebar-pinned'

interface SidebarNavProps {
  onNavigate?: () => void
}

export function SidebarNav({ onNavigate }: SidebarNavProps) {
  const { sections, buildingsData } = useNavConfig()
  const branding = useBranding()
  const [collapsed, setCollapsed] = useState(false)
  const [pinned, setPinned] = useState(() => localStorage.getItem(PINNED_KEY) !== 'false')

  useEffect(() => {
    localStorage.setItem(PINNED_KEY, String(pinned))
    if (!pinned) setCollapsed(true)
    else setCollapsed(false)
  }, [pinned])

  const togglePin = () => setPinned((p) => !p)

  const width = collapsed ? 'w-14' : 'w-60'

  return (
    <TooltipProvider delayDuration={200}>
      <div
        className={cn(
          'flex h-full flex-col border-r bg-background transition-all duration-200 overflow-hidden shrink-0',
          width,
        )}
        onMouseEnter={() => { if (!pinned) setCollapsed(false) }}
        onMouseLeave={() => { if (!pinned) setCollapsed(true) }}
      >
        {/* Header */}
        <div className="flex h-14 items-center justify-between px-3 border-b shrink-0">
          {!collapsed && (
            <div className="min-w-0">
              <h2 className="text-sm font-bold text-foreground truncate">{branding?.sidebarTitle ?? 'Roomer'}</h2>
              <p className="text-xs text-muted-foreground truncate">{branding?.sidebarSubtitle ?? 'Desk Booking'}</p>
            </div>
          )}
          <button
            onClick={togglePin}
            className="ml-auto rounded p-1 text-muted-foreground hover:text-foreground hover:bg-accent transition-colors shrink-0"
            title={pinned ? 'Unpin sidebar' : 'Pin sidebar open'}
          >
            {pinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
          </button>
        </div>

        {/* Nav */}
        <nav className="flex-1 overflow-y-auto overflow-x-hidden py-3 px-2 space-y-0.5">
          {sections.map((section) => (
            <div key={section.id}>
              {section.label && !collapsed && (
                <p className="px-3 py-1.5 text-xs font-semibold uppercase text-muted-foreground tracking-wider">
                  {section.label}
                </p>
              )}
              {section.label && collapsed && <div className="my-1 mx-2 border-t" />}
              {section.items.map((item) => (
                <NavItemLink key={item.to} item={item} collapsed={collapsed} onNavigate={onNavigate} />
              ))}
            </div>
          ))}

          {/* Buildings tree */}
          {!collapsed ? (
            <BuildingsTree buildingsData={buildingsData} onNavigate={onNavigate} />
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={() => setCollapsed(false)}
                  className="flex w-full items-center justify-center rounded-lg p-2 text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
                >
                  <Building2 className="h-4 w-4 shrink-0" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="right">Buildings</TooltipContent>
            </Tooltip>
          )}
        </nav>
      </div>
    </TooltipProvider>
  )
}

function NavItemLink({
  item,
  collapsed,
  onNavigate,
}: {
  item: { to: string; icon: React.ElementType; label: string }
  collapsed: boolean
  onNavigate?: () => void
}) {
  if (collapsed) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <NavLink
            to={item.to}
            onClick={onNavigate}
            className={({ isActive }) =>
              cn(
                'flex items-center justify-center rounded-lg p-2 transition-colors',
                isActive
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
              )
            }
          >
            <item.icon className="h-4 w-4 shrink-0" />
          </NavLink>
        </TooltipTrigger>
        <TooltipContent side="right">{item.label}</TooltipContent>
      </Tooltip>
    )
  }

  return (
    <NavLink
      to={item.to}
      onClick={onNavigate}
      className={({ isActive }) =>
        cn(
          'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
          isActive
            ? 'bg-primary text-primary-foreground'
            : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
        )
      }
    >
      <item.icon className="h-4 w-4 shrink-0" />
      <span className="truncate">{item.label}</span>
    </NavLink>
  )
}

function BuildingsTree({
  buildingsData,
  onNavigate,
}: {
  buildingsData: Array<{ id: string; name: string }>
  onNavigate?: () => void
}) {
  const [open, setOpen] = useState(false)

  return (
    <div>
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
      >
        <Building2 className="h-4 w-4 shrink-0" />
        <span className="flex-1 text-left">Buildings</span>
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
      </button>

      {open && (
        <div className="ml-7 mt-0.5 space-y-0.5">
          {buildingsData.map((b) => (
            <BuildingItem key={b.id} buildingId={b.id} buildingName={b.name} onNavigate={onNavigate} />
          ))}
          {buildingsData.length === 0 && (
            <p className="px-3 py-1 text-xs text-muted-foreground">No buildings</p>
          )}
        </div>
      )}
    </div>
  )
}

function BuildingItem({
  buildingId,
  buildingName,
  onNavigate,
}: {
  buildingId: string
  buildingName: string
  onNavigate?: () => void
}) {
  const [open, setOpen] = useState(false)
  const { data } = useQuery({
    queryKey: ['buildings', buildingId],
    queryFn: () => buildingsApi.get(buildingId),
    select: (res) => res.data,
    enabled: open,
  })

  return (
    <div>
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground"
      >
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        {buildingName}
      </button>
      {open && data && (
        <div className="ml-5 space-y-0.5">
          {data.floors?.map((floor) => (
            <NavLink
              key={floor.id}
              to={`/floors/${floor.id}`}
              onClick={onNavigate}
              className={({ isActive }) =>
                cn(
                  'block rounded px-2 py-1 text-xs transition-colors',
                  isActive ? 'bg-primary/10 text-primary font-medium' : 'text-muted-foreground hover:text-foreground',
                )
              }
            >
              {floor.name}
            </NavLink>
          ))}
        </div>
      )}
    </div>
  )
}
