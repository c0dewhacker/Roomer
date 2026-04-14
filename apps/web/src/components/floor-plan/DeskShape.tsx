import { useState } from 'react'
import { Group, Circle, Text, Arc } from 'react-konva'
import type { KonvaEventObject } from 'konva/lib/Node'
import type { DeskWithStatus } from '@/types'

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

interface DeskShapeProps {
  desk: DeskWithStatus
  stageWidth: number
  stageHeight: number
  editMode?: boolean
  onClick?: () => void
  onDragEnd?: (x: number, y: number) => void
}

export function DeskShape({
  desk,
  stageWidth,
  stageHeight,
  editMode = false,
  onClick,
  onDragEnd,
}: DeskShapeProps) {
  const [hovered, setHovered] = useState(false)

  const pixelX = ((desk.x ?? 50) / 100) * stageWidth
  const pixelY = ((desk.y ?? 50) / 100) * stageHeight
  const pixelW = ((desk.width ?? 5) / 100) * stageWidth
  const pixelH = ((desk.height ?? 5) / 100) * stageHeight

  // Circle is inscribed in the bounding box
  const radius = (Math.min(pixelW, pixelH) / 2) * 1.5
  const cx = pixelW / 2
  const cy = pixelH / 2

  const baseColour = STATUS_COLOURS[desk.bookingStatus] ?? '#94a3b8'
  const hoverColour = STATUS_HOVER[desk.bookingStatus] ?? '#64748b'
  const lightColour = STATUS_LIGHT[desk.bookingStatus] ?? '#cbd5e1'
  const fillColour = hovered ? hoverColour : baseColour

  const fontSize = Math.max(7, Math.min(11, radius * 0.45))
  const labelText = desk.name.length > 7 ? desk.name.slice(0, 6) + '…' : desk.name

  // Asset + assigned-user indicator dot sizes
  const dotRadius = Math.max(3.5, radius * 0.22)
  const dotOffset = radius * 0.68

  const handleDragEnd = (e: KonvaEventObject<DragEvent>) => {
    e.cancelBubble = true
    if (!onDragEnd) return
    const node = e.target
    onDragEnd((node.x() / stageWidth) * 100, (node.y() / stageHeight) * 100)
  }

  return (
    <Group
      x={pixelX}
      y={pixelY}
      rotation={desk.rotation ?? 0}
      draggable={editMode}
      onClick={editMode ? undefined : onClick}
      onTap={editMode ? undefined : onClick}
      onDragEnd={handleDragEnd}
      onMouseEnter={() => {
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

      {/* Zone colour ring */}
      <Circle
        x={cx}
        y={cy}
        radius={radius + 5}
        fill={desk.zoneColour ?? '#94a3b8'}
        listening={false}
      />

      {/* Main circle — listening={true} (default) so the Group receives mouse/drag events */}
      <Circle
        x={cx}
        y={cy}
        radius={radius}
        fill={fillColour}
        stroke={hovered ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.45)'}
        strokeWidth={hovered ? 2.5 : 1.5}
      />

      {/* Inner highlight arc (top-left quadrant) — gives a subtle 3-D sheen */}
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

      {/* Desk name label */}
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

      {/* Assigned user indicator — blue dot at top-left */}
      {desk.assignedUsers && desk.assignedUsers.length > 0 && (
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
