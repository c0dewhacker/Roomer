import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { brandingApi, type Branding } from '@/lib/api'
import { useThemeStore } from '@/stores/theme'

function hexToHsl(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16) / 255
  const g = parseInt(hex.slice(3, 5), 16) / 255
  const b = parseInt(hex.slice(5, 7), 16) / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  let h = 0, s = 0
  const l = (max + min) / 2
  if (max !== min) {
    const d = max - min
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break
      case g: h = (b - r) / d + 2; break
      case b: h = (r - g) / d + 4; break
    }
    h /= 6
  }
  return `${Math.round(h * 360)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%`
}

function applyBrandingCssVars(branding: Branding, isDark: boolean): void {
  const root = document.documentElement
  const color = (isDark ? branding.primaryColorDark : branding.primaryColor) ?? branding.primaryColor
  if (color && /^#[0-9a-fA-F]{6}$/.test(color)) {
    const hsl = hexToHsl(color)
    root.style.setProperty('--primary', hsl)
    root.style.setProperty('--ring', hsl)
  } else if (!color) {
    root.style.removeProperty('--primary')
    root.style.removeProperty('--ring')
  }

  const radiusMap = { sharp: '0.125rem', medium: '0.5rem', large: '0.75rem' }
  if (branding.borderRadius) {
    root.style.setProperty('--radius', radiusMap[branding.borderRadius])
  } else {
    root.style.removeProperty('--radius')
  }
}

export function useBranding(): Branding | undefined {
  const { theme } = useThemeStore()
  const isDark =
    theme === 'dark' ||
    (theme === 'system' && typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches)

  const { data } = useQuery({
    queryKey: ['branding'],
    queryFn: () => brandingApi.get(),
    select: (r) => r.data,
    staleTime: 5 * 60 * 1000,
  })

  useEffect(() => {
    if (data) applyBrandingCssVars(data, isDark)
  }, [data, isDark])

  useEffect(() => {
    if (!data?.faviconPath) return
    const link = document.querySelector("link[rel='icon']") as HTMLLinkElement | null
    if (link) {
      link.href = `${brandingApi.getFaviconUrl()}?t=${Date.now()}`
    }
  }, [data?.faviconPath])

  return data
}
