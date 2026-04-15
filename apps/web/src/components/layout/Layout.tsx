import { useState } from 'react'
import { Outlet } from 'react-router-dom'
import { Sidebar } from './Sidebar'
import { TopBar } from './TopBar'
import { cn } from '@/lib/utils'
import { useBranding } from '@/hooks/useBranding'

function Banner({ text, bgColor, textColor }: { text: string; bgColor: string; textColor: string }) {
  if (!text) return null
  return (
    <div
      className="px-4 py-1.5 text-center text-sm font-medium"
      style={{ backgroundColor: bgColor, color: textColor }}
    >
      {text}
    </div>
  )
}

export default function Layout() {
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const branding = useBranding()

  const headerBanner = branding?.headerBanner?.enabled ? branding.headerBanner : null
  const footerBanner = branding?.footerBanner?.enabled ? branding.footerBanner : null

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background">
      {headerBanner && (
        <Banner text={headerBanner.text} bgColor={headerBanner.bgColor} textColor={headerBanner.textColor} />
      )}

      <div className="flex flex-1 overflow-hidden">
        {/* Desktop sidebar */}
        <aside className="hidden w-60 shrink-0 border-r bg-background md:flex md:flex-col">
          <Sidebar />
        </aside>

        {/* Mobile sidebar overlay */}
        {sidebarOpen && (
          <div
            className="fixed inset-0 z-40 bg-black/50 md:hidden"
            onClick={() => setSidebarOpen(false)}
          />
        )}

        {/* Mobile sidebar drawer */}
        <aside
          className={cn(
            'fixed inset-y-0 left-0 z-50 w-60 border-r bg-background transition-transform duration-200 md:hidden',
            sidebarOpen ? 'translate-x-0' : '-translate-x-full',
          )}
        >
          <Sidebar onNavigate={() => setSidebarOpen(false)} />
        </aside>

        {/* Main content */}
        <div className="flex flex-1 flex-col overflow-hidden">
          <TopBar onMenuClick={() => setSidebarOpen((o) => !o)} />
          <main className="flex-1 overflow-auto">
            <Outlet />
          </main>
          {footerBanner && (
            <Banner text={footerBanner.text} bgColor={footerBanner.bgColor} textColor={footerBanner.textColor} />
          )}
        </div>
      </div>
    </div>
  )
}
