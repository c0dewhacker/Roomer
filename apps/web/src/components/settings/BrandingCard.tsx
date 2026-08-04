import { useState, useEffect } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { brandingApi, type Branding, type BrandingBanner } from '@/lib/api'
import { CollapsibleCard } from './CollapsibleCard'
import { ColorPicker } from './ColorPicker'
import { ImageUpload } from './ImageUpload'
import { BannerSection } from './BannerSection'

export function BrandingCard() {
  const qc = useQueryClient()

  const { data: brandingData } = useQuery({
    queryKey: ['branding'],
    queryFn: () => brandingApi.get(),
    select: (r) => r.data,
  })

  // Local form state
  const [appName, setAppName] = useState('')
  const [sidebarTitle, setSidebarTitle] = useState('')
  const [sidebarSubtitle, setSidebarSubtitle] = useState('')
  const [primaryColor, setPrimaryColor] = useState('#6366f1')
  const [primaryColorDark, setPrimaryColorDark] = useState('#818cf8')
  const [borderRadius, setBorderRadius] = useState<Branding['borderRadius']>('medium')
  const [navStyle, setNavStyle] = useState<Branding['navStyle']>('sidebar')
  const [headerBanner, setHeaderBanner] = useState<BrandingBanner>({
    enabled: false, text: '', bgColor: '#f59e0b', textColor: '#ffffff',
  })
  const [footerBanner, setFooterBanner] = useState<BrandingBanner>({
    enabled: false, text: '', bgColor: '#6366f1', textColor: '#ffffff',
  })

  useEffect(() => {
    if (!brandingData) return
    setAppName(brandingData.appName ?? '')
    setSidebarTitle(brandingData.sidebarTitle ?? '')
    setSidebarSubtitle(brandingData.sidebarSubtitle ?? '')
    setPrimaryColor(brandingData.primaryColor ?? '#6366f1')
    setPrimaryColorDark(brandingData.primaryColorDark ?? '#818cf8')
    setBorderRadius(brandingData.borderRadius ?? 'medium')
    setNavStyle(brandingData.navStyle ?? 'sidebar')
    if (brandingData.headerBanner) setHeaderBanner(brandingData.headerBanner)
    if (brandingData.footerBanner) setFooterBanner(brandingData.footerBanner)
  }, [brandingData])

  const save = useMutation({
    mutationFn: () =>
      brandingApi.update({
        appName: appName || undefined,
        sidebarTitle: sidebarTitle || undefined,
        sidebarSubtitle: sidebarSubtitle || undefined,
        primaryColor,
        primaryColorDark,
        borderRadius,
        navStyle,
        headerBanner,
        footerBanner,
      }),
    onSuccess: () => {
      toast.success('Branding saved')
      qc.invalidateQueries({ queryKey: ['branding'] })
    },
    onError: () => toast.error('Failed to save branding'),
  })

  const uploadLogo = useMutation({
    mutationFn: (file: File) => brandingApi.uploadLogo(file),
    onSuccess: () => {
      toast.success('Logo uploaded')
      qc.invalidateQueries({ queryKey: ['branding'] })
    },
    onError: () => toast.error('Failed to upload logo'),
  })

  const uploadFavicon = useMutation({
    mutationFn: (file: File) => brandingApi.uploadFavicon(file),
    onSuccess: () => {
      toast.success('Favicon uploaded')
      qc.invalidateQueries({ queryKey: ['branding'] })
    },
    onError: () => toast.error('Failed to upload favicon'),
  })

  const radiusOptions: { value: Branding['borderRadius']; label: string; preview: string }[] = [
    { value: 'sharp', label: 'Sharp', preview: '2px' },
    { value: 'medium', label: 'Medium', preview: '8px' },
    { value: 'large', label: 'Large', preview: '12px' },
  ]

  return (
    <CollapsibleCard title="Branding & Theme" description="Customise the look and feel of your workspace">
      <div className="space-y-6">

        {/* App Identity */}
        <div className="space-y-4">
          <p className="text-sm font-semibold">App Identity</p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <Label htmlFor="appName" className="text-xs">App name</Label>
              <Input
                id="appName"
                value={appName}
                onChange={(e) => setAppName(e.target.value)}
                placeholder="Roomer"
                className="mt-1.5"
              />
              <p className="mt-1 text-[11px] text-muted-foreground">Shown in the top bar</p>
            </div>
            <div>
              <Label htmlFor="sidebarTitle" className="text-xs">Sidebar title</Label>
              <Input
                id="sidebarTitle"
                value={sidebarTitle}
                onChange={(e) => setSidebarTitle(e.target.value)}
                placeholder="Roomer"
                className="mt-1.5"
              />
            </div>
            <div>
              <Label htmlFor="sidebarSubtitle" className="text-xs">Sidebar subtitle</Label>
              <Input
                id="sidebarSubtitle"
                value={sidebarSubtitle}
                onChange={(e) => setSidebarSubtitle(e.target.value)}
                placeholder="Desk Booking"
                className="mt-1.5"
              />
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
            <ImageUpload
              label="Logo"
              hint="PNG, JPG or SVG · max 512×128 px"
              hasImage={!!brandingData?.logoPath}
              imageUrl={brandingApi.getLogoUrl()}
              onUpload={(f) => uploadLogo.mutate(f)}
              uploading={uploadLogo.isPending}
            />
            <ImageUpload
              label="Favicon"
              hint="PNG or ICO · displayed as 64×64 px"
              hasImage={!!brandingData?.faviconPath}
              imageUrl={brandingApi.getFaviconUrl()}
              onUpload={(f) => uploadFavicon.mutate(f)}
              uploading={uploadFavicon.isPending}
            />
          </div>
        </div>

        <Separator />

        {/* Colors */}
        <div className="space-y-4">
          <p className="text-sm font-semibold">Theme Colors</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <ColorPicker label="Primary color (light mode)" value={primaryColor} onChange={setPrimaryColor} />
            <ColorPicker label="Primary color (dark mode)" value={primaryColorDark} onChange={setPrimaryColorDark} />
          </div>
        </div>

        <Separator />

        {/* Border radius */}
        <div className="space-y-3">
          <p className="text-sm font-semibold">Shape</p>
          <div className="flex gap-3">
            {radiusOptions.map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => setBorderRadius(opt.value)}
                className={`flex flex-col items-center gap-1.5 rounded-lg border px-4 py-3 text-xs transition-colors ${
                  borderRadius === opt.value
                    ? 'border-primary bg-primary/5 text-primary font-medium'
                    : 'border-input text-muted-foreground hover:border-muted-foreground'
                }`}
              >
                <div
                  className="h-8 w-14 border-2 border-current bg-muted/50"
                  style={{ borderRadius: opt.preview }}
                />
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        <Separator />

        {/* Navigation Style */}
        <div className="space-y-4">
          <div>
            <p className="text-sm font-semibold">Navigation Style</p>
            <p className="text-xs text-muted-foreground mt-0.5">Choose how navigation is presented to all users</p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {([
              {
                value: 'sidebar' as const,
                label: 'Enhanced Sidebar',
                description: 'Collapsible & pinnable side panel',
                preview: (
                  <div className="flex h-10 w-full overflow-hidden rounded border border-current/20">
                    <div className="w-5 border-r border-current/20 bg-current/10 flex flex-col gap-0.5 p-0.5">
                      {[...Array(4)].map((_, i) => <div key={i} className="h-1 rounded-sm bg-current/40" />)}
                    </div>
                    <div className="flex-1 bg-current/5 p-1 space-y-0.5">
                      {[...Array(3)].map((_, i) => <div key={i} className="h-1.5 rounded bg-current/20" />)}
                    </div>
                  </div>
                ),
              },
              {
                value: 'topbar' as const,
                label: 'Top Navigation',
                description: 'Horizontal bar across the top',
                preview: (
                  <div className="flex h-10 w-full flex-col overflow-hidden rounded border border-current/20">
                    <div className="flex h-4 items-center gap-1 border-b border-current/20 bg-current/10 px-1">
                      {[...Array(4)].map((_, i) => <div key={i} className="h-1 w-4 rounded-sm bg-current/40" />)}
                    </div>
                    <div className="flex-1 bg-current/5 p-1 space-y-0.5">
                      {[...Array(2)].map((_, i) => <div key={i} className="h-1.5 rounded bg-current/20" />)}
                    </div>
                  </div>
                ),
              },
              {
                value: 'floating' as const,
                label: 'Floating Island',
                description: 'Glass-morphism pill floating at the bottom',
                preview: (
                  <div className="relative flex h-10 w-full overflow-hidden rounded border border-current/20 bg-current/5">
                    <div className="absolute bottom-1 left-1/2 -translate-x-1/2 flex gap-1 rounded-lg border border-current/30 bg-current/15 px-2 py-0.5 backdrop-blur-sm">
                      {[...Array(4)].map((_, i) => <div key={i} className="h-2 w-2 rounded-sm bg-current/50" />)}
                    </div>
                    <div className="p-1 space-y-0.5 w-full">
                      {[...Array(2)].map((_, i) => <div key={i} className="h-1.5 rounded bg-current/20" />)}
                    </div>
                  </div>
                ),
              },
              {
                value: 'rail' as const,
                label: 'Icon Rail',
                description: 'Narrow icon strip with slide-out flyout',
                preview: (
                  <div className="flex h-10 w-full overflow-hidden rounded border border-current/20">
                    <div className="w-3 border-r border-current/20 bg-current/10 flex flex-col items-center gap-0.5 py-0.5">
                      {[...Array(4)].map((_, i) => <div key={i} className="h-1.5 w-1.5 rounded-sm bg-current/40" />)}
                    </div>
                    <div className="flex-1 bg-current/5 p-1 space-y-0.5">
                      {[...Array(3)].map((_, i) => <div key={i} className="h-1.5 rounded bg-current/20" />)}
                    </div>
                  </div>
                ),
              },
            ] as const).map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => setNavStyle(opt.value)}
                className={cn(
                  'flex flex-col gap-2 rounded-lg border p-3 text-left text-xs transition-colors',
                  navStyle === opt.value
                    ? 'border-primary bg-primary/5 text-primary'
                    : 'border-input text-muted-foreground hover:border-muted-foreground',
                )}
              >
                {opt.preview}
                <div>
                  <p className="font-medium">{opt.label}</p>
                  <p className="text-[11px] opacity-70 mt-0.5">{opt.description}</p>
                </div>
              </button>
            ))}
          </div>
        </div>

        <Separator />

        {/* Banners */}
        <div className="space-y-4">
          <p className="text-sm font-semibold">Banners</p>
          <BannerSection title="Header banner" value={headerBanner} onChange={setHeaderBanner} />
          <BannerSection title="Footer banner" value={footerBanner} onChange={setFooterBanner} />
        </div>

        <Button size="sm" disabled={save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? 'Saving…' : 'Save branding'}
        </Button>
      </div>
    </CollapsibleCard>
  )
}
