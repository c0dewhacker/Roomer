import { useMemo } from 'react'
import { useAuthStore } from '@/stores/auth'
import { useQuery } from '@tanstack/react-query'
import { buildingsApi } from '@/lib/api'
import { Calendar, Clock, Building2, Users, Settings, Package, BarChart3, FileText, Shield, Layers, Network, Webhook, MapPin } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

export interface NavItem {
  to: string
  icon: LucideIcon
  label: string
}

export interface NavSection {
  id: string
  label?: string
  items: NavItem[]
}

export interface BuildingEntry {
  id: string
  name: string
}

export function useNavConfig() {
  const user = useAuthStore((s) => s.user)
  const isSuperAdmin = user?.globalRole === 'SUPER_ADMIN'

  const managedFloors = useMemo(() => {
    if (!user || isSuperAdmin) return []
    const direct = (user.resourceRoles ?? [])
      .filter((r) => r.role === 'FLOOR_MANAGER' && r.floorId && r.floor)
      .map((r) => ({ id: r.floorId!, name: r.floor!.name }))
    const viaGroup = (user.groupMemberships ?? []).flatMap((m) =>
      (m.group.groupResourceRoles ?? [])
        .filter((r) => r.role === 'FLOOR_MANAGER' && r.floorId && r.floor)
        .map((r) => ({ id: r.floorId!, name: r.floor!.name })),
    )
    const byId = new Map<string, { id: string; name: string }>()
    ;[...direct, ...viaGroup].forEach((f) => byId.set(f.id, f))
    return [...byId.values()]
  }, [user, isSuperAdmin])

  const managedBuildings = useMemo(() => {
    if (!user || isSuperAdmin) return []
    const direct = (user.resourceRoles ?? [])
      .filter((r) => r.role === 'BUILDING_ADMIN' && r.buildingId && r.building)
      .map((r) => ({ id: r.buildingId!, name: r.building!.name }))
    const viaGroup = (user.groupMemberships ?? []).flatMap((m) =>
      (m.group.groupResourceRoles ?? [])
        .filter((r) => r.role === 'BUILDING_ADMIN' && r.buildingId && r.building)
        .map((r) => ({ id: r.buildingId!, name: r.building!.name })),
    )
    const byId = new Map<string, { id: string; name: string }>()
    ;[...direct, ...viaGroup].forEach((b) => byId.set(b.id, b))
    return [...byId.values()]
  }, [user, isSuperAdmin])

  const isFloorManager = managedFloors.length > 0
  const isBuildingAdmin = managedBuildings.length > 0

  const { data: buildingsData } = useQuery({
    queryKey: ['buildings'],
    queryFn: () => buildingsApi.list(),
    select: (res) => res.data,
  })

  const sections: NavSection[] = useMemo(() => {
    const result: NavSection[] = [
      {
        id: 'personal',
        items: [
          { to: '/bookings', icon: Calendar, label: 'My Bookings' },
          { to: '/queue', icon: Clock, label: 'My Queue' },
          { to: '/assets', icon: Package, label: 'My Assets' },
          { to: '/whos-in', icon: MapPin, label: "Who's In" },
        ],
      },
    ]

    if (isSuperAdmin) {
      result.push({
        id: 'admin',
        label: 'Admin',
        items: [
          { to: '/admin/buildings', icon: Building2, label: 'Buildings' },
          { to: '/admin/users', icon: Users, label: 'Users' },
          { to: '/admin/departments', icon: Network, label: 'Departments' },
          { to: '/admin/org-chart', icon: Network, label: 'Org Chart' },
          { to: '/admin/assets', icon: Package, label: 'Assets' },
          { to: '/admin/leases', icon: FileText, label: 'Leases' },
          { to: '/admin/groups', icon: Shield, label: 'Access Groups' },
          { to: '/admin/reports', icon: BarChart3, label: 'Reports' },
          { to: '/admin/webhooks', icon: Webhook, label: 'Webhooks' },
          { to: '/admin/settings', icon: Settings, label: 'Settings' },
        ],
      })
    } else if (isBuildingAdmin) {
      result.push({
        id: 'building-admin',
        label: 'My Buildings',
        items: [
          ...managedBuildings.map((b) => ({ to: `/admin/buildings/${b.id}`, icon: Building2, label: b.name })),
          { to: '/admin/assets', icon: Package, label: 'Assets' },
          { to: '/admin/leases', icon: FileText, label: 'Leases' },
          { to: '/admin/reports', icon: BarChart3, label: 'Reports' },
        ],
      })
    } else if (isFloorManager) {
      result.push({
        id: 'manager',
        label: 'Floor Manager',
        items: [
          { to: '/admin/assets', icon: Package, label: 'Assets' },
          ...managedFloors.map((f) => ({ to: `/admin/floors/${f.id}`, icon: Layers, label: f.name })),
        ],
      })
    }

    return result
  }, [isSuperAdmin, isBuildingAdmin, isFloorManager, managedBuildings, managedFloors])

  return { sections, buildingsData: buildingsData ?? [], isSuperAdmin, isBuildingAdmin, isFloorManager, managedFloors, managedBuildings }
}
