import { lazy, Suspense } from 'react'
import { Routes, Route, Navigate, Outlet } from 'react-router-dom'
import { useAuth } from './hooks/useAuth'
import Layout from './components/layout/Layout'
import LoginPage from './pages/LoginPage'
import BookingsPage from './pages/BookingsPage'
import QueuePage from './pages/QueuePage'
import QueueClaimPage from './pages/QueueClaimPage'
import ProfilePage from './pages/ProfilePage'
import WhosInPage from './pages/WhosInPage'
import BuildingsAdminPage from './pages/admin/BuildingsAdminPage'
import BuildingDetailAdminPage from './pages/admin/BuildingDetailAdminPage'
import UsersAdminPage from './pages/admin/UsersAdminPage'
import SettingsLayout from './pages/admin/settings/SettingsLayout'
import OrganisationSettingsPage from './pages/admin/settings/OrganisationSettingsPage'
import EmailSettingsPage from './pages/admin/settings/EmailSettingsPage'
import SsoSettingsPage from './pages/admin/settings/SsoSettingsPage'
import ProvisioningSettingsPage from './pages/admin/settings/ProvisioningSettingsPage'
import BrandingSettingsPage from './pages/admin/settings/BrandingSettingsPage'
import AssetsPage from './pages/AssetsPage'
import BuildingsPage from './pages/BuildingsPage'
import BuildingPage from './pages/BuildingPage'
import AssetsAdminPage from './pages/admin/AssetsAdminPage'
import LeasesAdminPage from './pages/admin/LeasesAdminPage'
import GroupsAdminPage from './pages/admin/GroupsAdminPage'
import DepartmentsAdminPage from './pages/admin/DepartmentsAdminPage'
import WebhooksAdminPage from './pages/admin/WebhooksAdminPage'
import ManagerRequestsAdminPage from './pages/admin/ManagerRequestsAdminPage'
import { Loader2 } from 'lucide-react'

// Lazy-load pages that pull in large dependencies (pdfjs-dist, react-konva, recharts)
// so they are excluded from the initial bundle.
const FloorPage = lazy(() => import('./pages/FloorPage'))
const OrgChartPage = lazy(() => import('./pages/admin/OrgChartPage'))
const FloorAdminPage = lazy(() => import('./pages/admin/FloorAdminPage'))
const ReportsAdminPage = lazy(() => import('./pages/admin/ReportsAdminPage'))
const BookingsReportPage = lazy(() => import('./pages/admin/BookingsReportPage'))

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

// Admits SUPER_ADMIN, any user with at least one BUILDING_ADMIN resource role
// (direct or via group), or any user with at least one FLOOR_MANAGER resource role.
// Used for admin routes that building admins and floor managers should be able to access.
function BuildingManagerOrAdminRoute() {
  const { isLoading, user } = useAuth()

  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    )
  }

  const isSuperAdmin = user?.globalRole === 'SUPER_ADMIN'
  const isBuildingAdmin =
    (user?.resourceRoles ?? []).some((r) => r.role === 'BUILDING_ADMIN') ||
    (user?.groupMemberships ?? []).some((m) =>
      (m.group.groupResourceRoles ?? []).some((r) => r.role === 'BUILDING_ADMIN'),
    )
  const isFloorManager =
    (user?.resourceRoles ?? []).some((r) => r.role === 'FLOOR_MANAGER') ||
    (user?.groupMemberships ?? []).some((m) =>
      (m.group.groupResourceRoles ?? []).some((r) => r.role === 'FLOOR_MANAGER'),
    )

  if (!isSuperAdmin && !isBuildingAdmin && !isFloorManager) {
    return <Navigate to="/bookings" replace />
  }

  return <Outlet />
}

// Admits SUPER_ADMIN or any user with at least one BUILDING_ADMIN resource
// role (direct or via group) — deliberately NOT floor managers. Unlike
// buildings/floors/assets (which have real floor-scoped backend support via
// isFloorManagerForFloor/getManagedFloorIds), leases and analytics are only
// ever authorized against getManagedBuildingIds/isBuildingManagerForBuilding
// on the backend — a floor-manager-only user let in here would always get a
// 403 on every request, rendering as a permanently blank/broken page with no
// explanation, despite the nav having implied they could use it.
function BuildingAdminOnlyRoute() {
  const { isLoading, user } = useAuth()

  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    )
  }

  const isSuperAdmin = user?.globalRole === 'SUPER_ADMIN'
  const isBuildingAdmin =
    (user?.resourceRoles ?? []).some((r) => r.role === 'BUILDING_ADMIN') ||
    (user?.groupMemberships ?? []).some((m) =>
      (m.group.groupResourceRoles ?? []).some((r) => r.role === 'BUILDING_ADMIN'),
    )

  if (!isSuperAdmin && !isBuildingAdmin) {
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
          <Route path="/whos-in" element={<WhosInPage />} />
          <Route path="/queue" element={<QueuePage />} />
          <Route path="/profile" element={<ProfilePage />} />
          <Route path="/assets" element={<AssetsPage />} />
          <Route path="/buildings" element={<BuildingsPage />} />
          <Route path="/buildings/:buildingId" element={<BuildingPage />} />

          {/* Strictly SUPER_ADMIN routes */}
          <Route element={<AdminRoute />}>
            <Route path="/admin/buildings" element={<BuildingsAdminPage />} />
            <Route path="/admin/users" element={<UsersAdminPage />} />
            <Route path="/admin/settings" element={<SettingsLayout />}>
              <Route index element={<Navigate to="/admin/settings/organisation" replace />} />
              <Route path="organisation" element={<OrganisationSettingsPage />} />
              <Route path="email" element={<EmailSettingsPage />} />
              <Route path="sso" element={<SsoSettingsPage />} />
              <Route path="provisioning" element={<ProvisioningSettingsPage />} />
              <Route path="branding" element={<BrandingSettingsPage />} />
            </Route>
            <Route path="/admin/groups" element={<GroupsAdminPage />} />
            <Route path="/admin/departments" element={<DepartmentsAdminPage />} />
            <Route path="/admin/org-chart" element={<Suspense fallback={<PageLoader />}><OrgChartPage /></Suspense>} />
            <Route path="/admin/webhooks" element={<WebhooksAdminPage />} />
          </Route>

          {/* SUPER_ADMIN, BUILDING_ADMIN, or FLOOR_MANAGER routes — backend has real floor-scoped support */}
          <Route element={<BuildingManagerOrAdminRoute />}>
            <Route path="/admin/buildings/:buildingId" element={<BuildingDetailAdminPage />} />
            <Route path="/admin/floors/:floorId" element={<Suspense fallback={<PageLoader />}><FloorAdminPage /></Suspense>} />
            <Route path="/admin/assets" element={<AssetsAdminPage />} />
            <Route path="/admin/manager-requests" element={<ManagerRequestsAdminPage />} />
          </Route>

          {/* SUPER_ADMIN or BUILDING_ADMIN only — no floor-scoped backend support exists for these */}
          <Route element={<BuildingAdminOnlyRoute />}>
            <Route path="/admin/leases" element={<LeasesAdminPage />} />
            <Route path="/admin/reports" element={<Suspense fallback={<PageLoader />}><ReportsAdminPage /></Suspense>} />
            <Route path="/admin/bookings-report" element={<Suspense fallback={<PageLoader />}><BookingsReportPage /></Suspense>} />
          </Route>
        </Route>
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
