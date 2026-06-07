import { useEffect, useMemo, useRef, useState } from 'react'
import { Stage, Layer, Group, Rect, Text, Line } from 'react-konva'
import type Konva from 'konva'

export interface OrgNode {
  id: string
  label: string
  sublabel?: string
  parentId: string | null
}

const NODE_W = 168
const NODE_H = 46
const COL_W = 190
const ROW_H = 110

type Positioned = OrgNode & { x: number; y: number }

/** Simple top-down tidy-tree layout. Handles forests (multiple roots) and cycles. */
function layout(nodes: OrgNode[]): { positioned: Positioned[]; width: number; height: number } {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const children = new Map<string, string[]>()
  const roots: string[] = []
  for (const n of nodes) {
    if (n.parentId && byId.has(n.parentId) && n.parentId !== n.id) {
      const arr = children.get(n.parentId) ?? []
      arr.push(n.id)
      children.set(n.parentId, arr)
    } else {
      roots.push(n.id)
    }
  }

  const pos = new Map<string, { x: number; y: number }>()
  const visited = new Set<string>()
  let nextLeaf = 0
  let maxDepth = 0

  const place = (id: string, depth: number) => {
    if (visited.has(id)) return
    visited.add(id)
    maxDepth = Math.max(maxDepth, depth)
    const kids = (children.get(id) ?? []).filter((k) => !visited.has(k))
    if (kids.length === 0) {
      pos.set(id, { x: nextLeaf * COL_W, y: depth * ROW_H })
      nextLeaf++
    } else {
      for (const k of kids) place(k, depth + 1)
      const xs = kids.map((k) => pos.get(k)!.x)
      pos.set(id, { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: depth * ROW_H })
    }
  }
  for (const r of roots) place(r, 0)
  // Any nodes left unvisited (cycles) get appended as extra roots.
  for (const n of nodes) if (!visited.has(n.id)) place(n.id, 0)

  const positioned = nodes.map((n) => ({ ...n, ...(pos.get(n.id) ?? { x: 0, y: 0 }) }))
  const width = Math.max(NODE_W, nextLeaf * COL_W)
  const height = (maxDepth + 1) * ROW_H
  return { positioned, width, height }
}

export function OrgChartCanvas({
  nodes,
  height = 560,
  highlightId,
  onSelect,
  accent = '#6366f1',
}: {
  nodes: OrgNode[]
  height?: number
  highlightId?: string | null
  onSelect?: (id: string) => void
  accent?: string
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(600)
  const [scale, setScale] = useState(1)
  const [stagePos, setStagePos] = useState({ x: 20, y: 20 })

  useEffect(() => {
    if (!containerRef.current) return
    const ro = new ResizeObserver((entries) => setWidth(entries[0].contentRect.width))
    ro.observe(containerRef.current)
    return () => ro.disconnect()
  }, [])

  const { positioned, width: treeW, height: treeH } = useMemo(() => layout(nodes), [nodes])
  const posById = useMemo(() => new Map(positioned.map((p) => [p.id, p])), [positioned])

  // Auto-fit when the tree or viewport changes.
  useEffect(() => {
    if (treeW <= 0 || treeH <= 0) return
    const pad = 40
    const s = Math.min(1.2, (width - pad) / (treeW + NODE_W), (height - pad) / (treeH + NODE_H))
    const fit = Math.max(0.15, Number.isFinite(s) ? s : 1)
    setScale(fit)
    setStagePos({ x: (width - (treeW + NODE_W) * fit) / 2 + (NODE_W / 2) * fit, y: 24 })
  }, [treeW, treeH, width, height])

  function handleWheel(e: Konva.KonvaEventObject<WheelEvent>) {
    e.evt.preventDefault()
    const factor = e.evt.deltaY > 0 ? 0.9 : 1.1
    setScale((s) => Math.min(2.5, Math.max(0.1, s * factor)))
  }

  return (
    <div ref={containerRef} className="w-full rounded-md border bg-muted/20 overflow-hidden" style={{ height }}>
      {nodes.length === 0 ? (
        <div className="flex h-full items-center justify-center text-sm text-muted-foreground">No data to display</div>
      ) : (
        <Stage
          width={width}
          height={height}
          draggable
          x={stagePos.x}
          y={stagePos.y}
          scaleX={scale}
          scaleY={scale}
          onWheel={handleWheel}
          onDragEnd={(e) => setStagePos({ x: e.target.x(), y: e.target.y() })}
        >
          <Layer>
            {/* edges */}
            {positioned.map((n) => {
              if (!n.parentId) return null
              const p = posById.get(n.parentId)
              if (!p || p.id === n.id) return null
              return (
                <Line
                  key={`e-${n.id}`}
                  points={[p.x, p.y + NODE_H, p.x, p.y + NODE_H + ROW_H / 2, n.x, p.y + NODE_H + ROW_H / 2, n.x, n.y]}
                  stroke="#cbd5e1"
                  strokeWidth={1.5}
                />
              )
            })}
            {/* nodes */}
            {positioned.map((n) => {
              const selected = n.id === highlightId
              return (
                <Group key={n.id} x={n.x - NODE_W / 2} y={n.y} onClick={() => onSelect?.(n.id)} onTap={() => onSelect?.(n.id)}>
                  <Rect
                    width={NODE_W}
                    height={NODE_H}
                    cornerRadius={8}
                    fill="#ffffff"
                    stroke={selected ? accent : '#e2e8f0'}
                    strokeWidth={selected ? 3 : 1}
                    shadowColor="#0f172a"
                    shadowOpacity={0.08}
                    shadowBlur={selected ? 10 : 4}
                    shadowOffsetY={2}
                  />
                  <Rect width={4} height={NODE_H} cornerRadius={[8, 0, 0, 8]} fill={accent} />
                  <Text x={12} y={8} width={NODE_W - 20} text={n.label} fontSize={13} fontStyle="600" fill="#0f172a" ellipsis wrap="none" />
                  {n.sublabel && (
                    <Text x={12} y={26} width={NODE_W - 20} text={n.sublabel} fontSize={11} fill="#64748b" ellipsis wrap="none" />
                  )}
                </Group>
              )
            })}
          </Layer>
        </Stage>
      )}
    </div>
  )
}
