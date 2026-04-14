import { NavLink } from 'react-router-dom'
import {
  Calendar,
  Clock,
  Building2,
  Users,
  Settings,
  ChevronDown,
  ChevronRight,
  Package,
  BarChart3,
  FileText,
  Shield,
} from 'lucide-react'
import { useState } from 'react'
import { cn } from '@/lib/utils'
import { useAuthStore } from '@/stores/auth'
import { useQuery } from '@tanstack/react-query'
import { buildingsApi } from '@/lib/api'

interface SidebarProps {
  onNavigate?: () => void
}

export function Sidebar({ onNavigate }: SidebarProps) {
  const user = useAuthStore((s) => s.user)
  const isAdmin = user?.globalRole === 'SUPER_ADMIN'
  const [buildingsOpen, setBuildingsOpen] = useState(false)

  const { data: buildingsData } = useQuery({
    queryKey: ['buildings'],
    queryFn: () => buildingsApi.list(),
    select: (res) => res.data,
  })

  const navItem = (
    to: string,
    Icon: React.ElementType,
    label: string,
  ) => (
    <NavLink
      to={to}
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
      <Icon className="h-4 w-4 shrink-0" />
      {label}
    </NavLink>
  )

  return (
    <div className="flex h-full flex-col gap-1 px-2 py-4">
      <div className="mb-2 px-3">
        <h2 className="text-lg font-bold text-foreground">Roomer</h2>
        <p className="text-xs text-muted-foreground">Desk Booking</p>
      </div>

      <nav className="flex flex-col gap-1">
        {navItem('/bookings', Calendar, 'My Bookings')}
        {navItem('/queue', Clock, 'My Queue')}
        {navItem('/assets', Package, 'My Assets')}

        {/* Buildings with floor expansion */}
        <div>
          <button
            onClick={() => setBuildingsOpen((o) => !o)}
            className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
          >
            <Building2 className="h-4 w-4 shrink-0" />
            <span className="flex-1 text-left">Buildings</span>
            {buildingsOpen ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
          </button>

          {buildingsOpen && buildingsData && (
            <div className="ml-7 mt-1 flex flex-col gap-1">
              {buildingsData.map((building) => (
                <BuildingFloors
                  key={building.id}
                  buildingId={building.id}
                  buildingName={building.name}
                  onNavigate={onNavigate}
                />
              ))}
              {buildingsData.length === 0 && (
                <p className="px-3 py-1 text-xs text-muted-foreground">No buildings</p>
              )}
            </div>
          )}
        </div>

        {isAdmin && (
          <>
            <div className="my-2 border-t" />
            <p className="px-3 py-1 text-xs font-semibold uppercase text-muted-foreground">
              Admin
            </p>
            {navItem('/admin/buildings', Building2, 'Buildings')}
            {navItem('/admin/users', Users, 'Users')}
            {navItem('/admin/assets', Package, 'Assets')}
            {navItem('/admin/leases', FileText, 'Leases')}
            {navItem('/admin/groups', Shield, 'Access Groups')}
            {navItem('/admin/reports', BarChart3, 'Reports')}
            {navItem('/admin/settings', Settings, 'Settings')}
          </>
        )}
      </nav>
    </div>
  )
}

function BuildingFloors({
  buildingId,
  buildingName,
  onNavigate,
}: {
  buildingId: string
  buildingName: string
  onNavigate?: () => void
}) {
  const [open, setOpen] = useState(false)

  const { data: buildingData } = useQuery({
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

      {open && buildingData && (
        <div className="ml-5 flex flex-col gap-0.5">
          {buildingData.floors?.map((floor) => (
            <NavLink
              key={floor.id}
              to={`/floors/${floor.id}`}
              onClick={onNavigate}
              className={({ isActive }) =>
                cn(
                  'rounded px-2 py-1 text-xs transition-colors',
                  isActive
                    ? 'bg-primary/10 text-primary font-medium'
                    : 'text-muted-foreground hover:text-foreground',
                )
              }
            >
              {floor.name}
            </NavLink>
          ))}
          {(!buildingData.floors || buildingData.floors.length === 0) && (
            <p className="px-2 py-1 text-xs text-muted-foreground">No floors</p>
          )}
        </div>
      )}
    </div>
  )
}
