import { useCallback, useRef, useState } from 'react'
import { Upload, Download, CheckCircle2, AlertCircle, ChevronRight, X } from 'lucide-react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { assetsApi } from '@/lib/api'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog'

const TEMPLATE_HEADERS = 'ASSET_ID,USER_EMAIL,IS_PRIMARY'
const TEMPLATE_EXAMPLE = [
  TEMPLATE_HEADERS,
  'asset-id-here,jane.smith@example.com,true',
  'asset-id-here,john.doe@example.com,false',
].join('\n')

function downloadBlob(content: string, filename: string) {
  const blob = new Blob([content], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

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
    const vals = parseCSVRow(line)
    return Object.fromEntries(headers.map((h, i) => [h, (vals[i] ?? '').trim()]))
  })
}

interface ParsedRow {
  assetId: string
  userEmail: string
  isPrimary: boolean
  rowError?: string
}

function validateRows(raw: Record<string, string>[]): ParsedRow[] {
  return raw.map((r) => {
    const assetId = r['asset_id'] ?? r['assetid'] ?? ''
    const userEmail = r['user_email'] ?? r['useremail'] ?? r['email'] ?? ''
    const isPrimaryRaw = (r['is_primary'] ?? r['isprimary'] ?? '').toLowerCase()
    const isPrimary = isPrimaryRaw === 'true' || isPrimaryRaw === '1' || isPrimaryRaw === 'yes'
    let rowError: string | undefined
    if (!assetId) rowError = 'ASSET_ID is required'
    else if (!userEmail) rowError = 'USER_EMAIL is required'
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(userEmail)) rowError = 'USER_EMAIL is invalid'
    return { assetId, userEmail, isPrimary, rowError }
  })
}

type Step = 'upload' | 'preview' | 'result'

interface ResultSummary {
  assigned: number
  errors: Array<{ row: number; assetId: string; userEmail: string; error: string }>
}

export default function AssignmentImportDialog({
  open,
  onClose,
  buildingId,
  buildingName,
}: {
  open: boolean
  onClose: () => void
  buildingId?: string
  buildingName?: string
}) {
  const qc = useQueryClient()
  const fileRef = useRef<HTMLInputElement>(null)
  const [step, setStep] = useState<Step>('upload')
  const [rows, setRows] = useState<ParsedRow[]>([])
  const [result, setResult] = useState<ResultSummary | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [downloadingExport, setDownloadingExport] = useState(false)

  const submit = useMutation({
    mutationFn: (validRows: ParsedRow[]) =>
      assetsApi.bulkAssignments(validRows.map((r) => ({ assetId: r.assetId, userEmail: r.userEmail, isPrimary: r.isPrimary }))),
    onSuccess: (res) => {
      setResult(res.data)
      setStep('result')
      qc.invalidateQueries({ queryKey: ['assets'] })
      qc.invalidateQueries({ queryKey: ['floors'] })
    },
    onError: () => toast.error('Failed to submit assignments'),
  })

  function reset() {
    setStep('upload')
    setRows([])
    setResult(null)
    if (fileRef.current) fileRef.current.value = ''
  }

  function handleClose() {
    reset()
    onClose()
  }

  function processFile(file: File) {
    const reader = new FileReader()
    reader.onload = (e) => {
      const text = e.target?.result as string
      const parsed = parseCSV(text)
      if (parsed.length === 0) {
        toast.error('No data rows found. Make sure the file has a header row and at least one data row.')
        return
      }
      setRows(validateRows(parsed))
      setStep('preview')
    }
    reader.readAsText(file)
  }

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    const file = e.dataTransfer.files?.[0]
    if (file) processFile(file)
  }, [])

  async function downloadExport() {
    setDownloadingExport(true)
    try {
      const res = await assetsApi.exportAssignments(buildingId)
      const header = 'ASSET_ID,USER_EMAIL,IS_PRIMARY'
      const csvRows = res.data.map(
        (r) => `${r.assetId},${r.userEmail},${r.isPrimary}`,
      )
      const csv = [header, ...csvRows].join('\n')
      const filename = buildingName
        ? `${buildingName.replace(/[^a-z0-9]/gi, '_')}-assignments.csv`
        : 'assignments.csv'
      downloadBlob(csv, filename)
    } catch {
      toast.error('Failed to download assignments')
    } finally {
      setDownloadingExport(false)
    }
  }

  const validRows = rows.filter((r) => !r.rowError)
  const invalidRows = rows.filter((r) => !!r.rowError)

  return (
    <Dialog open={open} onOpenChange={(o) => !o && handleClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {buildingName ? `Bulk assign users — ${buildingName}` : 'Bulk assign users'}
          </DialogTitle>
        </DialogHeader>

        {/* Step indicator */}
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-2">
          {(['upload', 'preview', 'result'] as Step[]).map((s, i) => (
            <span key={s} className="flex items-center gap-1.5">
              {i > 0 && <ChevronRight className="h-3 w-3" />}
              <span className={step === s ? 'text-foreground font-medium' : ''}>
                {s === 'upload' ? '1. Upload' : s === 'preview' ? '2. Preview' : '3. Result'}
              </span>
            </span>
          ))}
        </div>

        {/* ── Step 1: Upload ── */}
        {step === 'upload' && (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Upload a CSV with columns <code className="text-xs bg-muted px-1 py-0.5 rounded">ASSET_ID</code>,{' '}
              <code className="text-xs bg-muted px-1 py-0.5 rounded">USER_EMAIL</code>, and optionally{' '}
              <code className="text-xs bg-muted px-1 py-0.5 rounded">IS_PRIMARY</code>.
              Only ASSET_ID and USER_EMAIL are required.
            </p>

            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={() => downloadBlob(TEMPLATE_EXAMPLE, 'assignment-template.csv')}>
                <Download className="mr-1.5 h-3.5 w-3.5" />
                Download blank template
              </Button>
              {buildingId && (
                <Button variant="outline" size="sm" onClick={downloadExport} disabled={downloadingExport}>
                  <Download className="mr-1.5 h-3.5 w-3.5" />
                  {downloadingExport ? 'Downloading…' : `Download ${buildingName ?? 'building'} assets`}
                </Button>
              )}
            </div>

            <div
              className={`relative border-2 border-dashed rounded-lg p-8 flex flex-col items-center justify-center gap-3 transition-colors cursor-pointer ${dragOver ? 'border-primary bg-primary/5' : 'border-muted-foreground/30 hover:border-muted-foreground/60'}`}
              onClick={() => fileRef.current?.click()}
              onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
              onDragLeave={() => setDragOver(false)}
              onDrop={onDrop}
            >
              <Upload className="h-8 w-8 text-muted-foreground/50" />
              <div className="text-center">
                <p className="text-sm font-medium">Drop your CSV here or click to browse</p>
                <p className="text-xs text-muted-foreground mt-1">CSV files only</p>
              </div>
              <input
                ref={fileRef}
                type="file"
                accept=".csv,text/csv"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0]
                  if (file) processFile(file)
                }}
              />
            </div>
          </div>
        )}

        {/* ── Step 2: Preview ── */}
        {step === 'preview' && (
          <div className="space-y-3">
            <div className="flex items-center gap-3">
              <p className="text-sm text-muted-foreground flex-1">
                {validRows.length} valid row{validRows.length !== 1 ? 's' : ''}
                {invalidRows.length > 0 && ` · ${invalidRows.length} error${invalidRows.length !== 1 ? 's' : ''} (will be skipped)`}
              </p>
              <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={reset}>
                <X className="mr-1 h-3 w-3" /> Change file
              </Button>
            </div>

            <div className="max-h-64 overflow-y-auto rounded-md border text-xs">
              <table className="w-full">
                <thead className="bg-muted/50 sticky top-0">
                  <tr>
                    <th className="text-left px-3 py-2 font-medium text-muted-foreground w-8">#</th>
                    <th className="text-left px-3 py-2 font-medium text-muted-foreground">Asset ID</th>
                    <th className="text-left px-3 py-2 font-medium text-muted-foreground">User email</th>
                    <th className="text-left px-3 py-2 font-medium text-muted-foreground">Primary</th>
                    <th className="text-left px-3 py-2 font-medium text-muted-foreground">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {rows.map((r, i) => (
                    <tr key={i} className={r.rowError ? 'bg-destructive/5' : ''}>
                      <td className="px-3 py-1.5 text-muted-foreground">{i + 1}</td>
                      <td className="px-3 py-1.5 font-mono">{r.assetId || <span className="text-muted-foreground italic">—</span>}</td>
                      <td className="px-3 py-1.5">{r.userEmail || <span className="text-muted-foreground italic">—</span>}</td>
                      <td className="px-3 py-1.5">{r.isPrimary ? 'Yes' : 'No'}</td>
                      <td className="px-3 py-1.5">
                        {r.rowError
                          ? <Badge variant="destructive" className="text-[10px]">{r.rowError}</Badge>
                          : <CheckCircle2 className="h-3.5 w-3.5 text-green-600" />}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {validRows.length === 0 && (
              <p className="text-sm text-destructive flex items-center gap-1.5">
                <AlertCircle className="h-4 w-4" /> No valid rows to import.
              </p>
            )}
          </div>
        )}

        {/* ── Step 3: Result ── */}
        {step === 'result' && result && (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-sm">
              <CheckCircle2 className="h-5 w-5 text-green-600 shrink-0" />
              <span>
                <strong>{result.assigned}</strong> assignment{result.assigned !== 1 ? 's' : ''} saved successfully.
                {result.errors.length > 0 && (
                  <span className="text-destructive ml-1">{result.errors.length} failed.</span>
                )}
              </span>
            </div>

            {result.errors.length > 0 && (
              <div className="max-h-48 overflow-y-auto rounded-md border text-xs">
                <table className="w-full">
                  <thead className="bg-muted/50 sticky top-0">
                    <tr>
                      <th className="text-left px-3 py-2 font-medium text-muted-foreground w-8">Row</th>
                      <th className="text-left px-3 py-2 font-medium text-muted-foreground">Asset ID</th>
                      <th className="text-left px-3 py-2 font-medium text-muted-foreground">Email</th>
                      <th className="text-left px-3 py-2 font-medium text-muted-foreground">Error</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {result.errors.map((e, i) => (
                      <tr key={i} className="bg-destructive/5">
                        <td className="px-3 py-1.5 text-muted-foreground">{e.row}</td>
                        <td className="px-3 py-1.5 font-mono">{e.assetId}</td>
                        <td className="px-3 py-1.5">{e.userEmail}</td>
                        <td className="px-3 py-1.5 text-destructive">{e.error}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          {step === 'upload' && (
            <Button variant="ghost" onClick={handleClose}>Cancel</Button>
          )}
          {step === 'preview' && (
            <>
              <Button variant="ghost" onClick={reset}>Back</Button>
              <Button
                onClick={() => submit.mutate(validRows)}
                disabled={validRows.length === 0 || submit.isPending}
              >
                {submit.isPending ? 'Importing…' : `Import ${validRows.length} row${validRows.length !== 1 ? 's' : ''}`}
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
