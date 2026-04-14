import { useRef, useState, useEffect, useCallback } from 'react'
import { Stage, Layer, Image as KonvaImage } from 'react-konva'
import useImage from 'use-image'
import * as pdfjs from 'pdfjs-dist'
import type { KonvaEventObject } from 'konva/lib/Node'
import { Plus, Minus } from 'lucide-react'
import { AssetShape } from './AssetShape'
import { DeskMarker } from './DeskMarker'
import { useFloorData, useFloorAvailability } from '@/hooks/useFloor'
import { Skeleton } from '@/components/ui/skeleton'
import type { AssetWithStatus } from '@/types'

// Use the bundled worker from pdfjs-dist
pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString()

const MIN_SCALE = 0.3
const MAX_SCALE = 5

interface FloorPlanCanvasProps {
  floorId: string
  date: Date
  editMode?: boolean
  onAssetClick?: (asset: AssetWithStatus) => void
  /** @deprecated Use onAssetClick */
  onDeskClick?: (asset: AssetWithStatus) => void
  onLayoutSave?: (
    positions: Array<{ id: string; x: number; y: number; width: number; height: number; rotation: number }>,
  ) => void
}

// ─── Hook: load a PDF URL and rasterize page 1 to HTMLImageElement ────────────

function usePdfAsImage(
  url: string,
): [HTMLImageElement | undefined, 'loading' | 'loaded' | 'failed'] {
  const [image, setImage] = useState<HTMLImageElement | undefined>(undefined)
  const [status, setStatus] = useState<'loading' | 'loaded' | 'failed'>('loading')

  useEffect(() => {
    let cancelled = false
    setStatus('loading')
    setImage(undefined)

    async function render() {
      try {
        const loadingTask = pdfjs.getDocument({ url, withCredentials: true })
        const pdf = await loadingTask.promise
        const page = await pdf.getPage(1)
        const viewport = page.getViewport({ scale: 2 })

        const canvas = document.createElement('canvas')
        canvas.width = viewport.width
        canvas.height = viewport.height
        const ctx = canvas.getContext('2d')
        if (!ctx) throw new Error('No 2d context')

        await page.render({ canvas, canvasContext: ctx, viewport }).promise

        const img = new Image()
        img.width = viewport.width
        img.height = viewport.height
        img.src = canvas.toDataURL('image/png')

        await new Promise<void>((res, rej) => {
          img.onload = () => res()
          img.onerror = () => rej(new Error('Image load failed'))
        })

        if (!cancelled) {
          setImage(img)
          setStatus('loaded')
        }
      } catch {
        if (!cancelled) setStatus('failed')
      }
    }

    render()
    return () => { cancelled = true }
  }, [url])

  return [image, status]
}

// ─── Hook: load floor plan as image, supporting both raster images and PDFs ──

function useFloorPlanImage(
  url: string,
  fileType: string | undefined,
): [HTMLImageElement | undefined, 'loading' | 'loaded' | 'failed'] {
  const isPdf = fileType === 'PDF'

  // Always call both hooks — conditionally skipping one via the enabled flag equivalent
  const [rasterImage, rasterStatus] = useImage(isPdf ? '' : url, 'anonymous')
  const [pdfImage, pdfStatus] = usePdfAsImage(isPdf ? url : '')

  if (isPdf) return [pdfImage, pdfStatus]

  const status = rasterStatus === 'loaded'
    ? 'loaded'
    : rasterStatus === 'failed'
      ? 'failed'
      : 'loading'

  return [rasterImage as HTMLImageElement | undefined, status]
}

export function FloorPlanCanvas({
  floorId,
  date,
  editMode = false,
  onAssetClick,
  onDeskClick,
  onLayoutSave,
}: FloorPlanCanvasProps) {
  // Support legacy onDeskClick prop
  const handleAssetClick = onAssetClick ?? onDeskClick
  const containerRef = useRef<HTMLDivElement>(null)
  const [dimensions, setDimensions] = useState({ width: 800, height: 600 })
  const [scale, setScale] = useState(1)
  const [position, setPosition] = useState({ x: 0, y: 0 })
  const [localPositions, setLocalPositions] = useState<
    Record<string, { x: number; y: number }>
  >({})

  const { data: floorData, isLoading: floorLoading } = useFloorData(floorId)
  const { data: availabilityData, isLoading: availLoading } = useFloorAvailability(floorId, date)

  const updatedAt = floorData?.floorPlan?.updatedAt
  const floorPlanUrl = updatedAt
    ? `/api/v1/floors/${floorId}/floor-plan/image?v=${encodeURIComponent(updatedAt)}`
    : `/api/v1/floors/${floorId}/floor-plan/image`
  const fileType = floorData?.floorPlan?.fileType
  const hasFloorPlan = Boolean(floorData?.floorPlan)

  const [bgImage, bgStatus] = useFloorPlanImage(
    hasFloorPlan ? floorPlanUrl : '',
    fileType,
  )

  // Track container size via ResizeObserver
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry) {
        setDimensions({
          width: entry.contentRect.width,
          height: entry.contentRect.height,
        })
      }
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Fit floor plan on load
  useEffect(() => {
    if (!bgImage || !dimensions.width || !dimensions.height) return
    const scaleX = dimensions.width / bgImage.width
    const scaleY = dimensions.height / bgImage.height
    const fitScale = Math.min(scaleX, scaleY, 1)
    const centreX = (dimensions.width - bgImage.width * fitScale) / 2
    const centreY = (dimensions.height - bgImage.height * fitScale) / 2
    setScale(fitScale)
    setPosition({ x: centreX, y: centreY })
  }, [bgImage, dimensions.width, dimensions.height])

  const handleWheel = useCallback(
    (e: KonvaEventObject<WheelEvent>) => {
      e.evt.preventDefault()
      const stage = e.target.getStage()
      if (!stage) return

      const oldScale = scale
      const pointer = stage.getPointerPosition()
      if (!pointer) return

      const scaleBy = 1.08
      const newScale = e.evt.deltaY < 0
        ? Math.min(oldScale * scaleBy, MAX_SCALE)
        : Math.max(oldScale / scaleBy, MIN_SCALE)

      const mousePointTo = {
        x: (pointer.x - position.x) / oldScale,
        y: (pointer.y - position.y) / oldScale,
      }

      setScale(newScale)
      setPosition({
        x: pointer.x - mousePointTo.x * newScale,
        y: pointer.y - mousePointTo.y * newScale,
      })
    },
    [scale, position],
  )

  const handleDeskDragEnd = useCallback(
    (deskId: string, newX: number, newY: number) => {
      setLocalPositions((prev) => ({ ...prev, [deskId]: { x: newX, y: newY } }))
    },
    [],
  )

  const zoomToward = useCallback(
    (newScale: number) => {
      // Zoom toward the canvas centre so the view doesn't jump
      const cx = dimensions.width / 2
      const cy = dimensions.height / 2
      const pointTo = {
        x: (cx - position.x) / scale,
        y: (cy - position.y) / scale,
      }
      setScale(newScale)
      setPosition({
        x: cx - pointTo.x * newScale,
        y: cy - pointTo.y * newScale,
      })
    },
    [scale, position, dimensions],
  )

  const handleZoomIn  = useCallback(() => zoomToward(Math.min(scale * 1.3, MAX_SCALE)), [zoomToward, scale])
  const handleZoomOut = useCallback(() => zoomToward(Math.max(scale / 1.3, MIN_SCALE)), [zoomToward, scale])

  // Build merged asset list: availability data takes precedence
  const assets: AssetWithStatus[] = (() => {
    if (availabilityData) return availabilityData
    if (!floorData) return []
    return floorData.zones.flatMap((zone) =>
      zone.assets.map((a) => ({
        ...a,
        bookingStatus: 'available' as const,
        zoneColour: zone.colour,
        zoneName: zone.name,
      })),
    )
  })()

  const isLoading = floorLoading || availLoading

  const handleSave = () => {
    if (!onLayoutSave) return
    const positions = assets.map((a) => {
      const local = localPositions[a.id]
      return {
        id: a.id,
        x: local ? local.x : (a.x ?? 50),
        y: local ? local.y : (a.y ?? 50),
        width: a.width ?? 5,
        height: a.height ?? 5,
        rotation: a.rotation ?? 0,
      }
    })
    onLayoutSave(positions)
  }

  const hasUnsavedChanges = Object.keys(localPositions).length > 0

  if (isLoading) {
    return (
      <div className="flex h-full w-full items-center justify-center">
        <Skeleton className="h-full w-full" />
      </div>
    )
  }

  return (
    <div className="relative h-full w-full" ref={containerRef} style={{ cursor: 'grab' }}>
      {editMode && hasUnsavedChanges && onLayoutSave && (
        <div className="absolute right-4 top-4 z-10">
          <button
            onClick={handleSave}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow hover:bg-primary/90"
          >
            Save Layout
          </button>
        </div>
      )}

      {hasFloorPlan && bgStatus === 'loading' && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-10">
          <div className="rounded-md bg-background/80 px-4 py-2 text-sm text-muted-foreground shadow">
            {fileType === 'PDF' ? 'Rendering PDF…' : 'Loading floor plan…'}
          </div>
        </div>
      )}

      <Stage
        width={dimensions.width}
        height={dimensions.height}
        scaleX={scale}
        scaleY={scale}
        x={position.x}
        y={position.y}
        draggable
        onWheel={handleWheel}
        onDragStart={(e) => {
          // Only show grabbing cursor when the stage itself is being panned
          if (e.target === e.target.getStage() && containerRef.current) {
            containerRef.current.style.cursor = 'grabbing'
          }
        }}
        onDragEnd={(e) => {
          if (containerRef.current) containerRef.current.style.cursor = 'grab'
          // Only update pan position when the stage (not a desk) was dragged
          if (e.target === e.target.getStage()) {
            setPosition({ x: e.target.x(), y: e.target.y() })
          }
        }}
      >
        {/* Background layer: floor plan image */}
        <Layer>
          {bgImage && bgStatus === 'loaded' && (
            <KonvaImage image={bgImage} x={0} y={0} />
          )}
        </Layer>

        {/* Asset layer — rendered in edit mode for all assets (bookable + non-bookable) */}
        {editMode && (
          <Layer>
            {assets.map((asset) => {
              const localPos = localPositions[asset.id]
              const displayAsset = localPos
                ? { ...asset, x: localPos.x, y: localPos.y }
                : asset

              return (
                <AssetShape
                  key={asset.id}
                  asset={displayAsset}
                  stageWidth={bgImage?.width ?? dimensions.width}
                  stageHeight={bgImage?.height ?? dimensions.height}
                  editMode={editMode}
                  onClick={() => handleAssetClick?.(asset)}
                  onDragEnd={(x, y) => handleDeskDragEnd(asset.id, x, y)}
                />
              )
            })}
          </Layer>
        )}
      </Stage>

      {/* HTML overlay: asset markers in view mode — only bookable assets are clickable */}
      {!editMode && (
        <div className="absolute inset-0 pointer-events-none overflow-hidden">
          {assets.map((asset) => (
            <DeskMarker
              key={asset.id}
              desk={asset}
              bgWidth={bgImage?.width ?? dimensions.width}
              bgHeight={bgImage?.height ?? dimensions.height}
              stageX={position.x}
              stageY={position.y}
              scale={scale}
              onClick={asset.isBookable !== false ? () => handleAssetClick?.(asset) : () => {}}
            />
          ))}
        </div>
      )}

      {assets.length === 0 && !isLoading && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="rounded-md bg-background/80 px-4 py-2 text-sm text-muted-foreground shadow">
            No assets configured on this floor
          </div>
        </div>
      )}

      {/* Zoom controls */}
      <div className="absolute bottom-4 right-4 z-10 flex flex-col gap-1">
        <button
          onClick={handleZoomIn}
          title="Zoom in"
          style={{ cursor: 'default' }}
          className="w-8 h-8 rounded-lg bg-background/90 border border-border shadow-sm flex items-center justify-center hover:bg-muted transition-colors"
        >
          <Plus className="h-4 w-4" />
        </button>
        <button
          onClick={handleZoomOut}
          title="Zoom out"
          style={{ cursor: 'default' }}
          className="w-8 h-8 rounded-lg bg-background/90 border border-border shadow-sm flex items-center justify-center hover:bg-muted transition-colors"
        >
          <Minus className="h-4 w-4" />
        </button>
      </div>
    </div>
  )
}
