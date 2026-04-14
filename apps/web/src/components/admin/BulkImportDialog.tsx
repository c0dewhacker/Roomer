import { useCallback, useRef, useState } from 'react'
import { Upload, Download, CheckCircle2, AlertCircle, ChevronRight, ChevronDown, X } from 'lucide-react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { importApi, type ImportRow, type ImportResult } from '@/lib/api'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog'
import { Badge } from '@/components/ui/badge'

// ─── CSV template ─────────────────────────────────────────────────────────────

const CSV_HEADERS = 'building_name,building_address,floor_name,floor_level,zone_name,zone_colour,desk_name,desk_status,desk_amenities'
const CSV_EXAMPLE = [
  CSV_HEADERS,
  'Head Office,123 Main Street,Ground Floor,0,Open Plan,#6366f1,A-01,OPEN,standing;monitor',
  'Head Office,123 Main Street,Ground Floor,0,Open Plan,#6366f1,A-02,OPEN,',
  'Head Office,123 Main Street,Ground Floor,0,Quiet Zone,#10b981,B-01,RESTRICTED,',
  'Head Office,123 Main Street,First Floor,1,Hot Desks,#f59e0b,C-01,OPEN,dual-monitor',
].join('\n')

function downloadTemplate() {
  const blob = new Blob([CSV_EXAMPLE], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'roomer-import-template.csv'
  a.click()
  URL.revokeObjectURL(url)
}

// ─── CSV parser (handles quoted fields) ──────────────────────────────────────

function parseCSVRow(line: string): string[] {
  const fields: string[] = []
  let i = 0
  while (i <= line.length) {
    if (i === line.length) { fields.push(''); break }
    if (line[i] === '"') {
      let field = ''; i++
      while (i < line.length) {
        if (line[i] === '"' && line[i + 1] === '"') { field += '"'; i += 2 }
        else if (line[i] === '"') { i++; break }
        else { field += line[i++] }
      }
      fields.push(field)
      if (line[i] === ',') i++
    } else {
      const end = line.indexOf(',', i)
      if (end === -1) { fields.push(line.slice(i)); break }
      fields.push(line.slice(i, end)); i = end + 1
    }
  }
  return fields
}

function parseCSV(text: string): Record<string, string>[] {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim().split('\n').filter(Boolean)
  if (lines.length < 2) return []
  const headers = parseCSVRow(lines[0]).map((h) => h.trim().toLowerCase())
  return lines.slice(1).map((line) => {
    const values = parseCSVRow(line)
    return Object.fromEntries(headers.map((h, idx) => [h, (values[idx] ?? '').trim()]))
  })
}

// ─── Preview tree ─────────────────────────────────────────────────────────────

interface PreviewDesk { name: string; status: string; amenities: string }
interface PreviewZone { name: string; colour: string; desks: PreviewDesk[] }
interface PreviewFloor { name: string; level: string; zones: Map<string, PreviewZone> }
interface PreviewBuilding { name: string; address: string; floors: Map<string, PreviewFloor> }

function buildPreview(rows: ImportRow[]): Map<string, PreviewBuilding> {
  const buildings = new Map<string, PreviewBuilding>()
  let zoneIndex = 0
  const PALETTE = ['#6366f1','#10b981','#f59e0b','#ef4444','#8b5cf6','#06b6d4','#f97316','#84cc16','#ec4899','#14b8a6']

  for (const row of rows) {
    const bKey = row.building_name.trim()
    if (!buildings.has(bKey)) {
      buildings.set(bKey, { name: bKey, address: row.building_address ?? '', floors: new Map() })
    }
    const building = buildings.get(bKey)!

    const fKey = row.floor_name.trim()
    if (!building.floors.has(fKey)) {
      building.floors.set(fKey, { name: fKey, level: row.floor_level ?? '0', zones: new Map() })
    }
    const floor = building.floors.get(fKey)!

    const zKey = row.zone_name.trim()
    if (!floor.zones.has(zKey)) {
      const colour = row.zone_colour?.trim() || PALETTE[zoneIndex++ % PALETTE.length]
      floor.zones.set(zKey, { name: zKey, colour, desks: [] })
    }
    const zone = floor.zones.get(zKey)!
    zone.desks.push({ name: row.desk_name, status: row.desk_status ?? 'OPEN', amenities: row.desk_amenities ?? '' })
  }
  return buildings
}

function PreviewTree({ buildings }: { buildings: Map<string, PreviewBuilding> }) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set([...buildings.keys()]))

  const toggle = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })

  return (
    <div className="space-y-2 text-sm">
      {[...buildings.values()].map((b) => {
        const floorList = [...b.floors.values()]
        const totalDesks = floorList.reduce((s, f) => s + [...f.zones.values()].reduce((zs, z) => zs + z.desks.length, 0), 0)
        const isOpen = expanded.has(b.name)
        return (
          <div key={b.name} className="rounded-lg border">
            <button
              type="button"
              onClick={() => toggle(b.name)}
              className="flex w-full items-center gap-2 px-3 py-2.5 text-left hover:bg-muted/40 transition-colors"
            >
              {isOpen ? <ChevronDown className="h-3.5 w-3.5 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0" />}
              <span className="font-semibold">{b.name}</span>
              {b.address && <span className="text-muted-foreground text-xs truncate">{b.address}</span>}
              <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                {floorList.length} floor{floorList.length !== 1 ? 's' : ''} · {totalDesks} desk{totalDesks !== 1 ? 's' : ''}
              </span>
            </button>

            {isOpen && (
              <div className="border-t divide-y">
                {floorList.map((f) => {
                  const zoneList = [...f.zones.values()]
                  const floorDesks = zoneList.reduce((s, z) => s + z.desks.length, 0)
                  return (
                    <div key={f.name} className="px-4 py-2">
                      <div className="flex items-center gap-2 mb-1.5">
                        <span className="font-medium">{f.name}</span>
                        <Badge variant="outline" className="text-xs">Level {f.level || '0'}</Badge>
                        <span className="text-xs text-muted-foreground ml-auto">{floorDesks} desks</span>
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {zoneList.map((z) => (
                          <span
                            key={z.name}
                            className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs"
                          >
                            <span className="h-2 w-2 rounded-full shrink-0" style={{ backgroundColor: z.colour }} />
                            {z.name}
                            <span className="text-muted-foreground">({z.desks.length})</span>
                          </span>
                        ))}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ─── Main dialog ──────────────────────────────────────────────────────────────

type Step = 'upload' | 'preview' | 'result'

interface Props {
  open: boolean
  onClose: () => void
}

export function BulkImportDialog({ open, onClose }: Props) {
  const qc = useQueryClient()
  const fileRef = useRef<HTMLInputElement>(null)
  const [step, setStep] = useState<Step>('upload')
  const [rows, setRows] = useState<ImportRow[]>([])
  const [parseErrors, setParseErrors] = useState<string[]>([])
  const [result, setResult] = useState<ImportResult | null>(null)
  const [dragOver, setDragOver] = useState(false)

  const reset = () => {
    setStep('upload'); setRows([]); setParseErrors([]); setResult(null)
    if (fileRef.current) fileRef.current.value = ''
  }

  const handleClose = () => { reset(); onClose() }

  const processFile = useCallback((text: string) => {
    const parsed = parseCSV(text)
    if (parsed.length === 0) {
      setParseErrors(['The file appears to be empty or has no data rows.'])
      return
    }

    const errs: string[] = []
    const required = ['building_name', 'floor_name', 'zone_name', 'desk_name']
    const missing = required.filter((h) => !(h in parsed[0]))
    if (missing.length > 0) {
      errs.push(`Missing required columns: ${missing.join(', ')}`)
      setParseErrors(errs)
      return
    }

    // Basic row validation
    parsed.forEach((row, i) => {
      required.forEach((col) => {
        if (!row[col]) errs.push(`Row ${i + 2}: ${col} is empty`)
      })
    })

    setRows(parsed as ImportRow[])
    setParseErrors(errs)
    setStep('preview')
  }, [])

  const handleFile = useCallback((file: File) => {
    const reader = new FileReader()
    reader.onload = (e) => processFile(e.target?.result as string)
    reader.readAsText(file)
  }, [processFile])

  const importMutation = useMutation({
    mutationFn: () => importApi.bulk(rows),
    onSuccess: (res) => {
      setResult(res.data)
      setStep('result')
      qc.invalidateQueries({ queryKey: ['buildings'] })
      if (res.data.errors.length === 0) {
        toast.success(`Imported ${res.data.created.desks} desks successfully`)
      } else {
        toast.warning(`Import completed with ${res.data.errors.length} error(s)`)
      }
    },
    onError: () => toast.error('Import failed — please try again'),
  })

  const validRows = rows.filter((_, i) => !parseErrors.some((e) => e.startsWith(`Row ${i + 2}:`)))
  const preview = buildPreview(validRows)

  return (
    <Dialog open={open} onOpenChange={(o) => !o && handleClose()}>
      <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col gap-0 p-0">
        <DialogHeader className="px-6 pt-6 pb-4 border-b shrink-0">
          <DialogTitle>Bulk Import</DialogTitle>
          <p className="text-sm text-muted-foreground mt-1">
            Import buildings, floors, zones and desks from a CSV file. Existing buildings, floors
            and zones are matched by name — only desks are always created as new entries.
          </p>
        </DialogHeader>

        {/* Step indicators */}
        <div className="flex items-center gap-2 px-6 py-3 border-b shrink-0 text-xs text-muted-foreground">
          {(['upload', 'preview', 'result'] as Step[]).map((s, idx) => (
            <span key={s} className="flex items-center gap-2">
              {idx > 0 && <ChevronRight className="h-3 w-3" />}
              <span className={step === s ? 'text-foreground font-medium' : ''}>
                {idx + 1}. {s.charAt(0).toUpperCase() + s.slice(1)}
              </span>
            </span>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">

          {/* ── Upload step ─────────────────────────────────────────────────── */}
          {step === 'upload' && (
            <>
              <div
                className={`border-2 border-dashed rounded-lg p-8 text-center transition-colors ${dragOver ? 'border-primary bg-primary/5' : 'border-border'}`}
                onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(e) => {
                  e.preventDefault(); setDragOver(false)
                  const f = e.dataTransfer.files[0]
                  if (f) handleFile(f)
                }}
              >
                <Upload className="mx-auto h-10 w-10 text-muted-foreground/50 mb-3" />
                <p className="font-medium text-sm mb-1">Drop your CSV file here</p>
                <p className="text-xs text-muted-foreground mb-4">or click to browse</p>
                <Button size="sm" variant="outline" onClick={() => fileRef.current?.click()}>
                  Choose file
                </Button>
                <input
                  ref={fileRef}
                  type="file"
                  accept=".csv,text/csv"
                  className="hidden"
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f) }}
                />
              </div>

              <div className="rounded-lg bg-muted/40 p-4 space-y-2">
                <p className="text-xs font-medium">CSV format</p>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  One row per desk. Separate multiple amenities with <code className="bg-muted px-1 rounded">;</code> e.g.{' '}
                  <code className="bg-muted px-1 rounded">standing;monitor</code>. Zone colour is optional — a colour
                  will be auto-assigned if left blank. Download the template to get started.
                </p>
                <div className="text-xs font-mono text-muted-foreground bg-muted rounded px-2 py-1.5 overflow-x-auto whitespace-nowrap">
                  {CSV_HEADERS}
                </div>
                <Button size="sm" variant="ghost" className="h-7 text-xs gap-1.5 px-2" onClick={downloadTemplate}>
                  <Download className="h-3.5 w-3.5" /> Download template
                </Button>
              </div>
            </>
          )}

          {/* ── Preview step ─────────────────────────────────────────────────── */}
          {step === 'preview' && (
            <>
              {parseErrors.length > 0 && (
                <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 space-y-1">
                  <p className="text-xs font-medium text-destructive flex items-center gap-1.5">
                    <AlertCircle className="h-3.5 w-3.5" />
                    {parseErrors.length} validation issue{parseErrors.length !== 1 ? 's' : ''} — affected rows will be skipped
                  </p>
                  <ul className="text-xs text-destructive/80 space-y-0.5 max-h-24 overflow-y-auto">
                    {parseErrors.map((e, i) => <li key={i}>· {e}</li>)}
                  </ul>
                </div>
              )}

              <div className="rounded-lg bg-muted/40 p-3 grid grid-cols-4 gap-3 text-center text-sm">
                {[
                  ['Buildings', preview.size],
                  ['Floors', [...preview.values()].reduce((s, b) => s + b.floors.size, 0)],
                  ['Zones', [...preview.values()].reduce((s, b) => s + [...b.floors.values()].reduce((fs, f) => fs + f.zones.size, 0), 0)],
                  ['Desks', validRows.length],
                ].map(([label, count]) => (
                  <div key={label as string}>
                    <div className="text-xl font-bold">{count}</div>
                    <div className="text-xs text-muted-foreground">{label}</div>
                  </div>
                ))}
              </div>

              {preview.size > 0 && <PreviewTree buildings={preview} />}

              <p className="text-xs text-muted-foreground">
                All desks will be placed at the centre of their floor plan — you can drag them into
                position afterwards using the Layout editor.
              </p>
            </>
          )}

          {/* ── Result step ─────────────────────────────────────────────────── */}
          {step === 'result' && result && (
            <>
              <div className="flex flex-col items-center py-4 text-center gap-3">
                <CheckCircle2 className="h-12 w-12 text-green-500" />
                <div>
                  <p className="font-semibold">Import complete</p>
                  <p className="text-sm text-muted-foreground mt-0.5">
                    {result.created.desks} desk{result.created.desks !== 1 ? 's' : ''} imported successfully
                  </p>
                </div>
              </div>

              <div className="rounded-lg bg-muted/40 p-3 grid grid-cols-4 gap-3 text-center text-sm">
                {[
                  ['Buildings', result.created.buildings],
                  ['Floors', result.created.floors],
                  ['Zones', result.created.zones],
                  ['Desks', result.created.desks],
                ].map(([label, count]) => (
                  <div key={label as string}>
                    <div className="text-xl font-bold">{count}</div>
                    <div className="text-xs text-muted-foreground">new {label}</div>
                  </div>
                ))}
              </div>

              {result.errors.length > 0 && (
                <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 space-y-1">
                  <p className="text-xs font-medium text-destructive flex items-center gap-1.5">
                    <AlertCircle className="h-3.5 w-3.5" />
                    {result.errors.length} row{result.errors.length !== 1 ? 's' : ''} skipped
                  </p>
                  <ul className="text-xs text-destructive/80 space-y-0.5 max-h-32 overflow-y-auto">
                    {result.errors.map((e, i) => <li key={i}>· Row {e.row}: {e.message}</li>)}
                  </ul>
                </div>
              )}
            </>
          )}
        </div>

        <DialogFooter className="px-6 py-4 border-t shrink-0">
          {step === 'upload' && (
            <Button variant="ghost" onClick={handleClose}>Cancel</Button>
          )}
          {step === 'preview' && (
            <>
              <Button variant="ghost" onClick={reset} className="mr-auto">
                <X className="h-3.5 w-3.5 mr-1.5" /> Start over
              </Button>
              <Button variant="ghost" onClick={handleClose}>Cancel</Button>
              <Button
                onClick={() => importMutation.mutate()}
                disabled={validRows.length === 0 || importMutation.isPending}
              >
                {importMutation.isPending ? 'Importing…' : `Import ${validRows.length} desk${validRows.length !== 1 ? 's' : ''}`}
              </Button>
            </>
          )}
          {step === 'result' && (
            <>
              <Button variant="outline" onClick={reset}>Import another file</Button>
              <Button onClick={handleClose}>Done</Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
