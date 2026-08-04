import { NavLink, Outlet } from 'react-router-dom'
import { cn } from '@/lib/utils'

const TABS = [
  { to: '/admin/settings/organisation', label: 'Organisation' },
  { to: '/admin/settings/email', label: 'Email' },
  { to: '/admin/settings/sso', label: 'Single Sign-On' },
  { to: '/admin/settings/provisioning', label: 'Provisioning' },
  { to: '/admin/settings/branding', label: 'Branding' },
]

export default function SettingsLayout() {
  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Settings</h1>
        <p className="text-muted-foreground text-sm mt-1">Configure your Roomer workspace</p>
      </div>

      <nav className="flex flex-wrap gap-1 border-b">
        {TABS.map((tab) => (
          <NavLink
            key={tab.to}
            to={tab.to}
            className={({ isActive }) =>
              cn(
                'px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors',
                isActive
                  ? 'border-primary text-primary'
                  : 'border-transparent text-muted-foreground hover:text-foreground hover:border-border',
              )
            }
          >
            {tab.label}
          </NavLink>
        ))}
      </nav>

      <Outlet />
    </div>
  )
}
