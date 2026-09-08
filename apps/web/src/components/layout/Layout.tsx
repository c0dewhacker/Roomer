import { useState } from 'react'
import { Outlet } from 'react-router-dom'
import { Sidebar } from './Sidebar'
import { TopBar } from './TopBar'
import { SidebarNav } from './navStyles/SidebarNav'
import { TopNav } from './navStyles/TopNav'
import { FloatingNav } from './navStyles/FloatingNav'
import { RailNav } from './navStyles/RailNav'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import { useBranding } from '@/hooks/useBranding'

function Banner({ text, bgColor, textColor }: { text: string; bgColor: string; textColor: string }) {
  if (!text) return null
  return (
    <div className="px-4 py-1.5 text-center text-sm font-medium" style={{ backgroundColor: bgColor, color: textColor }}>
      {text}
    </div>
  )
}

export default function Layout() {
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const branding = useBranding()

  const navStyle = branding?.navStyle ?? 'sidebar'
  const headerBanner = branding?.headerBanner?.enabled ? branding.headerBanner : null
  const footerBanner = branding?.footerBanner?.enabled ? branding.footerBanner : null

  // Floating nav has its own layout structure (no traditional sidebar/topbar)
  if (navStyle === 'floating') {
    return (
      <div className="flex h-screen flex-col overflow-hidden bg-background">
        {headerBanner && <Banner text={headerBanner.text} bgColor={headerBanner.bgColor} textColor={headerBanner.textColor} />}
        <FloatingNav />
        {/* The utility pill defaults to top:16 and is ~44-48px tall, so it
            spans down to roughly y=60-64 — pt-10 (40px) left its bottom edge
            overlapping the first ~20px of page content (seen covering the
            floor plan's date-nav header) regardless of viewport width. */}
        <main className="flex-1 overflow-auto pt-16">
          <Outlet />
        </main>
        {footerBanner && <Banner text={footerBanner.text} bgColor={footerBanner.bgColor} textColor={footerBanner.textColor} />}
      </div>
    )
  }

  // Top nav has no sidebar
  if (navStyle === 'topbar') {
    return (
      <div className="flex h-screen flex-col overflow-hidden bg-background">
        {headerBanner && <Banner text={headerBanner.text} bgColor={headerBanner.bgColor} textColor={headerBanner.textColor} />}
        <TopNav />
        <main className="flex-1 overflow-auto">
          <Outlet />
        </main>
        {footerBanner && <Banner text={footerBanner.text} bgColor={footerBanner.bgColor} textColor={footerBanner.textColor} />}
      </div>
    )
  }

  // Rail nav — icon rail replaces the aside, no separate TopBar needed (rail has utilities)
  if (navStyle === 'rail') {
    return (
      <div className="flex h-screen flex-col overflow-hidden bg-background">
        {headerBanner && <Banner text={headerBanner.text} bgColor={headerBanner.bgColor} textColor={headerBanner.textColor} />}
        <div className="flex flex-1 overflow-hidden">
          <RailNav />
          <main className="flex-1 overflow-auto">
            <Outlet />
          </main>
        </div>
        {footerBanner && <Banner text={footerBanner.text} bgColor={footerBanner.bgColor} textColor={footerBanner.textColor} />}
      </div>
    )
  }

  // Default: enhanced sidebar
  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background">
      {headerBanner && <Banner text={headerBanner.text} bgColor={headerBanner.bgColor} textColor={headerBanner.textColor} />}

      <div className="flex flex-1 overflow-hidden">
        {/* Desktop enhanced sidebar */}
        <aside className="hidden md:flex">
          <SidebarNav />
        </aside>

        <Sheet open={sidebarOpen} onOpenChange={setSidebarOpen}>
          <SheetContent side="left" className="w-60 p-0" aria-describedby={undefined}
            onCloseAutoFocus={(event) => {
              event.preventDefault()
              document.getElementById('mobile-menu-trigger')?.focus()
            }}>
            <SheetTitle className="sr-only">Navigation</SheetTitle>
            <Sidebar onNavigate={() => setSidebarOpen(false)} />
          </SheetContent>
        </Sheet>

        <div className="flex flex-1 flex-col overflow-hidden">
          <TopBar menuOpen={sidebarOpen} onMenuClick={() => setSidebarOpen((o) => !o)} hideBrand />
          <main className="flex-1 overflow-auto">
            <Outlet />
          </main>
        </div>
      </div>

      {footerBanner && <Banner text={footerBanner.text} bgColor={footerBanner.bgColor} textColor={footerBanner.textColor} />}
    </div>
  )
}
