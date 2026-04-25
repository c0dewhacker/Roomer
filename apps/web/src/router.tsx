import { lazy, Suspense } from 'react'
import { Routes, Route, Navigate, Outlet } from 'react-router-dom'
import { useAuth } from './hooks/useAuth'
import Layout from './components/layout/Layout'
import LoginPage from './pages/LoginPage'
import BookingsPage from './pages/BookingsPage'
import QueuePage from './pages/QueuePage'
import QueueClaimPage from './pages/QueueClaimPage'
import ProfilePage from './pages/ProfilePage'
import BuildingsAdminPage from './pages/admin/BuildingsAdminPage'
import BuildingDetailAdminPage from './pages/admin/BuildingDetailAdminPage'
import UsersAdminPage from './pages/admin/UsersAdminPage'
import SettingsAdminPage from './pages/admin/SettingsAdminPage'
import AssetsPage from './pages/AssetsPage'
import BuildingsPage from './pages/BuildingsPage'
import BuildingPage from './pages/BuildingPage'
import AssetsAdminPage from './pages/admin/AssetsAdminPage'
import LeasesAdminPage from './pages/admin/LeasesAdminPage'
import GroupsAdminPage from './pages/admin/GroupsAdminPage'
import { Loader2 } from 'lucide-react'

// Lazy-load pages that pull in large dependencies (pdfjs-dist, react-konva, recharts)
// so they are excluded from the initial bundle.
const FloorPage = lazy(() => import('./pages/FloorPage'))
const FloorAdminPage = lazy(() => import('./pages/admin/FloorAdminPage'))
const ReportsAdminPage = lazy(() => import('./pages/admin/ReportsAdminPage'))

function PageLoader() {
  return (
    <div className="flex h-64 items-center justify-center">
      <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
    </div>
  )
}

function ProtectedRoute() {
  const { isLoading, isAuthenticated } = useAuth()

  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    )
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />
  }

  return <Outlet />
}

function AdminRoute() {
  const { isLoading, user } = useAuth()

  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    )
  }

  if (user?.globalRole !== 'SUPER_ADMIN') {
    return <Navigate to="/bookings" replace />
  }

  return <Outlet />
}

// Admits SUPER_ADMIN or any user with at least one FLOOR_MANAGER resource role
// (direct or via group). Used for routes floor managers should be able to access.
function FloorManagerOrAdminRoute() {
  const { isLoading, user } = useAuth()

  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    )
  }

  const isSuperAdmin = user?.globalRole === 'SUPER_ADMIN'
  const isFloorManager =
    (user?.resourceRoles ?? []).some((r) => r.role === 'FLOOR_MANAGER') ||
    (user?.groupMemberships ?? []).some((m) =>
      (m.group.groupResourceRoles ?? []).some((r) => r.role === 'FLOOR_MANAGER'),
    )

  if (!isSuperAdmin && !isFloorManager) {
    return <Navigate to="/bookings" replace />
  }

  return <Outlet />
}

function RootRedirect() {
  const { isLoading, isAuthenticated } = useAuth()

  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    )
  }

  return <Navigate to={isAuthenticated ? '/bookings' : '/login'} replace />
}

export function AppRouter() {
  return (
    <Routes>
      <Route path="/" element={<RootRedirect />} />
      <Route path="/login" element={<LoginPage />} />
      <Route path="/queue/claim" element={<QueueClaimPage />} />

      <Route element={<ProtectedRoute />}>
        <Route element={<Layout />}>
          <Route path="/floors/:floorId" element={<Suspense fallback={<PageLoader />}><FloorPage /></Suspense>} />
          <Route path="/bookings" element={<BookingsPage />} />
          <Route path="/queue" element={<QueuePage />} />
          <Route path="/profile" element={<ProfilePage />} />
          <Route path="/assets" element={<AssetsPage />} />
          <Route path="/buildings" element={<BuildingsPage />} />
          <Route path="/buildings/:buildingId" element={<BuildingPage />} />

          {/* Strictly SUPER_ADMIN routes */}
          <Route element={<AdminRoute />}>
            <Route path="/admin/buildings" element={<BuildingsAdminPage />} />
            <Route path="/admin/buildings/:buildingId" element={<BuildingDetailAdminPage />} />
            <Route path="/admin/users" element={<UsersAdminPage />} />
            <Route path="/admin/settings" element={<SettingsAdminPage />} />
            <Route path="/admin/reports" element={<Suspense fallback={<PageLoader />}><ReportsAdminPage /></Suspense>} />
            <Route path="/admin/leases" element={<LeasesAdminPage />} />
            <Route path="/admin/groups" element={<GroupsAdminPage />} />
          </Route>

          {/* SUPER_ADMIN or FLOOR_MANAGER routes */}
          <Route element={<FloorManagerOrAdminRoute />}>
            <Route path="/admin/floors/:floorId" element={<Suspense fallback={<PageLoader />}><FloorAdminPage /></Suspense>} />
            <Route path="/admin/assets" element={<AssetsAdminPage />} />
          </Route>
        </Route>
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
