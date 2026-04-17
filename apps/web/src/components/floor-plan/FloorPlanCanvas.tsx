import { useRef, useState, useEffect, useCallback } from 'react'
import { Stage, Layer, Image as KonvaImage } from 'react-konva'
import useImage from 'use-image'
import * as pdfjs from 'pdfjs-dist'
import pdfjsWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import type { KonvaEventObject } from 'konva/lib/Node'
import { Plus, Minus, Maximize2, ZoomIn, ZoomOut } from 'lucide-react'
import { AssetShape } from './AssetShape'
import { DeskMarker } from './DeskMarker'
import { useFloorData, useFloorAvailability } from '@/hooks/useFloor'
import { Skeleton } from '@/components/ui/skeleton'
import type { AssetWithStatus } from '@/types'

// Use the bundled worker from pdfjs-dist
pdfjs.GlobalWorkerOptions.workerSrc = pdfjsWorkerUrl

const MIN_SCALE = 0.05
const MAX_SCALE = 10
const MIN_DISPLAY_SCALE = 0.1
const MAX_DISPLAY_SCALE = 10

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
  /** Called when the user adjusts the floor plan display scale in edit mode. */
  onDisplayScaleChange?: (scale: number) => void
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
  onDisplayScaleChange,
}: FloorPlanCanvasProps) {
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

  // Display scale: how large the floor plan image is rendered in the coordinate
  // space. Initialized from the server value; updated locally as the slider moves.
  const serverDisplayScale = floorData?.floorPlan?.displayScale ?? 1
  const [displayScale, setDisplayScale] = useState(serverDisplayScale)

  // Sync if server value changes (e.g. after a save or fresh load)
  useEffect(() => {
    setDisplayScale(serverDisplayScale)
  }, [serverDisplayScale])

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

  // Effective canvas coordinate space — scaled version of the native image.
  // Use naturalWidth/naturalHeight (intrinsic SVG/image dimensions) rather than
  // .width/.height, which can be 0 for SVGs that haven't been laid out in the DOM.
  const imgNativeW = bgImage ? (bgImage.naturalWidth  || bgImage.width)  : 0
  const imgNativeH = bgImage ? (bgImage.naturalHeight || bgImage.height) : 0
  const effectiveWidth  = imgNativeW > 0 ? imgNativeW * displayScale : dimensions.width
  const effectiveHeight = imgNativeH > 0 ? imgNativeH * displayScale : dimensions.height

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

  // Fit the floor plan to fill the canvas when the image (or display scale) loads/changes.
  // No artificial 1× cap — small images scale up, large images scale down.
  const fitToCanvas = useCallback(() => {
    if (!bgImage || !dimensions.width || !dimensions.height) return
    const scaleX = dimensions.width  / effectiveWidth
    const scaleY = dimensions.height / effectiveHeight
    const fitScale = Math.min(scaleX, scaleY)
    const centreX = (dimensions.width  - effectiveWidth  * fitScale) / 2
    const centreY = (dimensions.height - effectiveHeight * fitScale) / 2
    setScale(fitScale)
    setPosition({ x: centreX, y: centreY })
  }, [bgImage, dimensions.width, dimensions.height, effectiveWidth, effectiveHeight])

  useEffect(() => {
    fitToCanvas()
  // Only auto-fit when the image first loads or displayScale changes — not on every pan/zoom
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bgImage, effectiveWidth, effectiveHeight, dimensions.width, dimensions.height])

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
      const cx = dimensions.width  / 2
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

  const handleDisplayScaleChange = useCallback((newDs: number) => {
    const clamped = Math.min(Math.max(newDs, MIN_DISPLAY_SCALE), MAX_DISPLAY_SCALE)
    setDisplayScale(clamped)
    onDisplayScaleChange?.(clamped)
  }, [onDisplayScaleChange])

  // Build merged asset list
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

  // NOTE: do NOT early-return for isLoading here. The containerRef div must
  // always be mounted so the ResizeObserver fires and `dimensions` gets set to
  // the actual container size. If we return a different element tree while
  // loading, containerRef.current is null when the effect runs ([] deps) and
  // dimensions stays stuck at the initial { 800, 600 } default.
  return (
    <div className="relative h-full w-full" ref={containerRef} style={{ cursor: isLoading ? 'default' : 'grab' }}>
      {isLoading && (
        <div className="absolute inset-0 z-20 flex items-center justify-center">
          <Skeleton className="h-full w-full" />
        </div>
      )}
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
          if (e.target === e.target.getStage() && containerRef.current) {
            containerRef.current.style.cursor = 'grabbing'
          }
        }}
        onDragMove={(e) => {
          if (e.target === e.target.getStage()) {
            setPosition({ x: e.target.x(), y: e.target.y() })
          }
        }}
        onDragEnd={(e) => {
          if (containerRef.current) containerRef.current.style.cursor = 'grab'
          if (e.target === e.target.getStage()) {
            setPosition({ x: e.target.x(), y: e.target.y() })
          }
        }}
      >
        {/* Background layer: floor plan image scaled by displayScale */}
        <Layer>
          {bgImage && bgStatus === 'loaded' && (
            <KonvaImage
              image={bgImage}
              x={0}
              y={0}
              width={effectiveWidth}
              height={effectiveHeight}
            />
          )}
        </Layer>

        {/* Asset layer — edit mode only */}
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
                  stageWidth={effectiveWidth}
                  stageHeight={effectiveHeight}
                  editMode={editMode}
                  onClick={() => handleAssetClick?.(asset)}
                  onDragEnd={(x, y) => handleDeskDragEnd(asset.id, x, y)}
                />
              )
            })}
          </Layer>
        )}
      </Stage>

      {/* HTML overlay: asset markers in view mode */}
      {!editMode && (
        <div className="absolute inset-0 pointer-events-none overflow-hidden">
          {assets.map((asset) => (
            <DeskMarker
              key={asset.id}
              desk={asset}
              bgWidth={effectiveWidth}
              bgHeight={effectiveHeight}
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

      {/* ── Floor plan scale controls — edit mode only ──────────────────────── */}
      {editMode && hasFloorPlan && bgStatus === 'loaded' && (
        <div className="absolute bottom-4 left-4 z-10 flex flex-col gap-1 rounded-lg bg-background/90 border border-border shadow-sm p-2">
          <p className="text-[10px] font-medium text-muted-foreground text-center px-1 leading-tight">
            Image scale
          </p>
          <div className="flex items-center gap-1.5">
            <button
              title="Decrease image scale"
              onClick={() => handleDisplayScaleChange(displayScale / 1.25)}
              style={{ cursor: 'default' }}
              className="w-6 h-6 rounded flex items-center justify-center hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
            >
              <ZoomOut className="h-3.5 w-3.5" />
            </button>
            <input
              type="range"
              min={Math.log(MIN_DISPLAY_SCALE)}
              max={Math.log(MAX_DISPLAY_SCALE)}
              step={0.01}
              value={Math.log(displayScale)}
              onChange={(e) => handleDisplayScaleChange(Math.exp(parseFloat(e.target.value)))}
              className="w-24 accent-primary"
              style={{ cursor: 'default' }}
              title={`Image scale: ${displayScale.toFixed(2)}×`}
            />
            <button
              title="Increase image scale"
              onClick={() => handleDisplayScaleChange(displayScale * 1.25)}
              style={{ cursor: 'default' }}
              className="w-6 h-6 rounded flex items-center justify-center hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
            >
              <ZoomIn className="h-3.5 w-3.5" />
            </button>
          </div>
          <p className="text-[10px] text-muted-foreground text-center tabular-nums">
            {displayScale.toFixed(2)}×
          </p>
        </div>
      )}

      {/* ── View controls ─────────────────────────────────────────────────────── */}
      <div className="absolute bottom-4 right-4 z-10 flex flex-col gap-1">
        <button
          onClick={fitToCanvas}
          title="Fit to screen"
          style={{ cursor: 'default' }}
          className="w-8 h-8 rounded-lg bg-background/90 border border-border shadow-sm flex items-center justify-center hover:bg-muted transition-colors"
        >
          <Maximize2 className="h-3.5 w-3.5" />
        </button>
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
