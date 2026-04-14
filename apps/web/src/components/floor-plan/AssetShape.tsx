import { useState } from 'react'
import { Group, Circle, Text, Arc } from 'react-konva'
import type { KonvaEventObject } from 'konva/lib/Node'
import type { AssetWithStatus } from '@/types'

const CATEGORY_ICONS: Record<string, string> = {
  monitor: '\uD83D\uDDA5',
  desk: '\uD83D\uDCBA',
  phone: '\uD83D\uDCDE',
  'phone-booth': '\u260E',
  locker: '\uD83D\uDD12',
  printer: '\uD83D\uDDA8',
  whiteboard: '\uD83D\uDCCB',
  room: '\uD83D\uDEAA',
  chair: '\uD83E\uDE91',
  coffee: '\u2615',
  wifi: '\uD83D\uDCF6',
  default: '\u25C6',
}

const STATUS_COLOURS: Record<string, string> = {
  available: '#22c55e',
  mine: '#3b82f6',
  booked: '#f87171',
  restricted: '#fb923c',
  assigned: '#8b5cf6',
  disabled: '#d1d5db',
  queued: '#facc15',
  promoted: '#10b981',
  zone_conflict: '#f97316',
}

const STATUS_HOVER: Record<string, string> = {
  available: '#16a34a',
  mine: '#2563eb',
  booked: '#ef4444',
  restricted: '#ea580c',
  assigned: '#7c3aed',
  disabled: '#9ca3af',
  queued: '#eab308',
  promoted: '#059669',
  zone_conflict: '#ea580c',
}

// Slightly lighter inner highlight colour
const STATUS_LIGHT: Record<string, string> = {
  available: '#4ade80',
  mine: '#60a5fa',
  booked: '#fca5a5',
  restricted: '#fdba74',
  assigned: '#c4b5fd',
  disabled: '#e5e7eb',
  queued: '#fde047',
  promoted: '#34d399',
  zone_conflict: '#fb923c',
}

const NON_BOOKABLE_FILL = '#9ca3af'
const NON_BOOKABLE_RING = '#6b7280'

interface AssetShapeProps {
  asset: AssetWithStatus
  stageWidth: number
  stageHeight: number
  editMode?: boolean
  onClick?: () => void
  onDragEnd?: (x: number, y: number) => void
}

export function AssetShape({
  asset,
  stageWidth,
  stageHeight,
  editMode = false,
  onClick,
  onDragEnd,
}: AssetShapeProps) {
  const [hovered, setHovered] = useState(false)

  const x = asset.x ?? 50
  const y = asset.y ?? 50
  const width = asset.width ?? 5
  const height = asset.height ?? 5
  const rotation = asset.rotation ?? 0

  const pixelX = (x / 100) * stageWidth
  const pixelY = (y / 100) * stageHeight
  const pixelW = (width / 100) * stageWidth
  const pixelH = (height / 100) * stageHeight

  // Circle is inscribed in the bounding box
  const radius = (Math.min(pixelW, pixelH) / 2) * 1.5
  const cx = pixelW / 2
  const cy = pixelH / 2

  const isBookable = asset.isBookable !== false

  // Non-bookable assets: always grey, never clickable
  const baseColour = isBookable ? (STATUS_COLOURS[asset.bookingStatus] ?? '#94a3b8') : NON_BOOKABLE_FILL
  const hoverColour = isBookable ? (STATUS_HOVER[asset.bookingStatus] ?? '#64748b') : NON_BOOKABLE_FILL
  const lightColour = isBookable ? (STATUS_LIGHT[asset.bookingStatus] ?? '#cbd5e1') : '#d1d5db'
  const ringColour = isBookable ? (asset.zoneColour ?? '#94a3b8') : NON_BOOKABLE_RING
  const fillColour = (hovered && isBookable) ? hoverColour : baseColour

  const fontSize = Math.max(7, Math.min(11, radius * 0.45))
  const labelText = asset.name.length > 7 ? asset.name.slice(0, 6) + '\u2026' : asset.name

  // Category icon
  const iconSlug = asset.category?.defaultIcon
  const iconChar = iconSlug ? (CATEGORY_ICONS[iconSlug] ?? asset.category?.name?.[0] ?? CATEGORY_ICONS.default) : undefined
  const iconFontSize = Math.max(10, Math.min(18, radius * 0.6))

  // Dot sizes for indicator dots
  const dotRadius = Math.max(3.5, radius * 0.22)
  const dotOffset = radius * 0.68

  const handleDragEnd = (e: KonvaEventObject<DragEvent>) => {
    e.cancelBubble = true
    if (!onDragEnd) return
    const node = e.target
    onDragEnd((node.x() / stageWidth) * 100, (node.y() / stageHeight) * 100)
  }

  const isClickable = isBookable || editMode

  return (
    <Group
      x={pixelX}
      y={pixelY}
      rotation={rotation}
      draggable={editMode}
      onClick={isClickable ? (editMode ? undefined : onClick) : undefined}
      onTap={isClickable ? (editMode ? undefined : onClick) : undefined}
      onDragEnd={handleDragEnd}
      onMouseEnter={() => {
        if (!isBookable && !editMode) return
        setHovered(true)
        if (typeof window !== 'undefined') {
          document.body.style.cursor = editMode ? 'grab' : 'pointer'
        }
      }}
      onMouseLeave={() => {
        setHovered(false)
        if (typeof window !== 'undefined') {
          document.body.style.cursor = 'default'
        }
      }}
    >
      {/* Drop shadow */}
      <Circle
        x={cx}
        y={cy + (hovered ? 3 : 2)}
        radius={radius + 5}
        fill="rgba(0,0,0,0.18)"
        listening={false}
      />

      {/* Zone colour ring (or muted ring for non-bookable) */}
      <Circle
        x={cx}
        y={cy}
        radius={radius + 5}
        fill={ringColour}
        listening={false}
      />

      {/* Main circle */}
      <Circle
        x={cx}
        y={cy}
        radius={radius}
        fill={fillColour}
        stroke={hovered ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.45)'}
        strokeWidth={hovered ? 2.5 : 1.5}
      />

      {/* Inner highlight arc (top-left quadrant) — only for bookable */}
      {isBookable && (
        <Arc
          x={cx}
          y={cy}
          innerRadius={radius * 0.55}
          outerRadius={radius * 0.88}
          angle={160}
          rotation={-130}
          fill={lightColour}
          opacity={0.25}
          listening={false}
        />
      )}

      {/* Category icon (if available), otherwise asset name label */}
      {iconChar ? (
        <Text
          x={cx - radius}
          y={cy - iconFontSize / 2}
          width={radius * 2}
          align="center"
          text={iconChar}
          fontSize={iconFontSize}
          fill="#fff"
          shadowColor="rgba(0,0,0,0.4)"
          shadowBlur={2}
          shadowOffsetX={0}
          shadowOffsetY={1}
          listening={false}
        />
      ) : (
        <Text
          x={cx - radius}
          y={cy - fontSize / 2 - 1}
          width={radius * 2}
          align="center"
          text={labelText}
          fontSize={fontSize}
          fill="#fff"
          fontStyle="bold"
          shadowColor="rgba(0,0,0,0.4)"
          shadowBlur={2}
          shadowOffsetX={0}
          shadowOffsetY={1}
          listening={false}
        />
      )}

      {/* Assigned user indicator — blue dot at top-left (bookable assets only) */}
      {isBookable && asset.assignedUsers && asset.assignedUsers.length > 0 && (
        <Circle
          x={cx - dotOffset}
          y={cy - dotOffset}
          radius={dotRadius}
          fill="#3b82f6"
          stroke="#fff"
          strokeWidth={1.5}
          listening={false}
        />
      )}
    </Group>
  )
}
