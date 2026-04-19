import { useCallback, useRef, useState } from 'react'
import { Upload, Download, CheckCircle2, AlertCircle, ChevronRight, X } from 'lucide-react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { usersApi } from '@/lib/api'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog'

// ─── CSV template ─────────────────────────────────────────────────────────────

const CSV_HEADERS = 'email,display_name,password,global_role,access_groups,send_welcome_email'
const CSV_EXAMPLE = [
  CSV_HEADERS,
  'jane.smith@example.com,Jane Smith,,USER,Engineering;All Staff,true',
  'john.doe@example.com,John Doe,TempPass123!,USER,All Staff,true',
  'admin@example.com,Site Admin,,SUPER_ADMIN,,false',
].join('\n')

function downloadTemplate() {
  const blob = new Blob([CSV_EXAMPLE], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'roomer-user-import-template.csv'
  a.click()
  URL.revokeObjectURL(url)
}

// ─── CSV parser ───────────────────────────────────────────────────────────────

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

// ─── Types ────────────────────────────────────────────────────────────────────

type Step = 'upload' | 'preview' | 'result'

interface ImportResult {
  created: number
  updated: number
  errors: Array<{ row: number; message: string }>
}

interface Props {
  open: boolean
  onClose: () => void
}

// ─── Main dialog ──────────────────────────────────────────────────────────────

export function UserImportDialog({ open, onClose }: Props) {
  const qc = useQueryClient()
  const fileRef = useRef<HTMLInputElement>(null)
  const [step, setStep] = useState<Step>('upload')
  const [rows, setRows] = useState<Record<string, string>[]>([])
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
    if (!('email' in parsed[0])) errs.push('Missing required column: email')
    if (!('display_name' in parsed[0])) errs.push('Missing required column: display_name')

    if (errs.length > 0) { setParseErrors(errs); return }

    parsed.forEach((row, i) => {
      if (!row.email) errs.push(`Row ${i + 2}: email is empty`)
      if (!row.display_name) errs.push(`Row ${i + 2}: display_name is empty`)
      if (row.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.email)) errs.push(`Row ${i + 2}: invalid email`)
      if (row.global_role && !['USER', 'SUPER_ADMIN'].includes(row.global_role.toUpperCase())) {
        errs.push(`Row ${i + 2}: global_role must be USER or SUPER_ADMIN`)
      }
    })

    setRows(parsed)
    setParseErrors(errs)
    setStep('preview')
  }, [])

  const handleFile = useCallback((file: File) => {
    const reader = new FileReader()
    reader.onload = (e) => processFile(e.target?.result as string)
    reader.readAsText(file)
  }, [processFile])

  const importMutation = useMutation({
    mutationFn: () => usersApi.bulkImport(rows),
    onSuccess: (res) => {
      setResult(res.data)
      setStep('result')
      qc.invalidateQueries({ queryKey: ['admin', 'users'] })
      if (res.data.errors.length === 0) {
        toast.success(`Import complete — ${res.data.created} created, ${res.data.updated} updated`)
      } else {
        toast.warning(`Import completed with ${res.data.errors.length} error(s)`)
      }
    },
    onError: () => toast.error('Import failed — please try again'),
  })

  const rowErrors = new Set(parseErrors.map((e) => { const m = e.match(/^Row (\d+)/); return m ? Number(m[1]) : 0 }))
  const validRows = rows.filter((_, i) => !rowErrors.has(i + 2))

  return (
    <Dialog open={open} onOpenChange={(o) => !o && handleClose()}>
      <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col gap-0 p-0">
        <DialogHeader className="px-6 pt-6 pb-4 border-b shrink-0">
          <DialogTitle>Import users from CSV</DialogTitle>
          <p className="text-sm text-muted-foreground mt-1">
            Create or update local user accounts in bulk. Existing users (matched by email) will have
            their display name and role updated. New users get a random password if none is provided.
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
                <p className="text-xs font-medium">CSV columns</p>
                <div className="text-xs font-mono text-muted-foreground bg-muted rounded px-2 py-1.5 overflow-x-auto whitespace-nowrap">
                  {CSV_HEADERS}
                </div>
                <ul className="text-xs text-muted-foreground space-y-0.5">
                  <li><strong>email</strong>, <strong>display_name</strong> — required</li>
                  <li><strong>password</strong> — optional; a random password is set if omitted</li>
                  <li><strong>global_role</strong> — USER or SUPER_ADMIN (default: USER)</li>
                  <li><strong>access_groups</strong> — semicolon-separated group names, e.g. <code className="bg-muted px-1 rounded">Engineering;All Staff</code></li>
                  <li><strong>send_welcome_email</strong> — true/false (default: true for new users)</li>
                </ul>
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

              <div className="rounded-lg bg-muted/40 p-3 grid grid-cols-2 gap-3 text-center text-sm">
                <div>
                  <div className="text-2xl font-bold">{validRows.length}</div>
                  <div className="text-xs text-muted-foreground">valid rows</div>
                </div>
                <div>
                  <div className="text-2xl font-bold">{rows.length - validRows.length}</div>
                  <div className="text-xs text-muted-foreground">will be skipped</div>
                </div>
              </div>

              {/* Row preview table */}
              {validRows.length > 0 && (
                <div className="rounded-md border overflow-hidden">
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead className="bg-muted/50">
                        <tr>
                          {['Email', 'Display name', 'Role', 'Groups', 'Welcome email'].map((h) => (
                            <th key={h} className="px-3 py-2 text-left font-medium text-muted-foreground whitespace-nowrap">{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        {validRows.slice(0, 10).map((row, i) => (
                          <tr key={i} className="hover:bg-muted/20">
                            <td className="px-3 py-1.5 truncate max-w-[180px]">{row.email}</td>
                            <td className="px-3 py-1.5 truncate max-w-[140px]">{row.display_name}</td>
                            <td className="px-3 py-1.5">
                              <Badge variant={row.global_role?.toUpperCase() === 'SUPER_ADMIN' ? 'default' : 'secondary'} className="text-[10px]">
                                {row.global_role?.toUpperCase() === 'SUPER_ADMIN' ? 'Admin' : 'User'}
                              </Badge>
                            </td>
                            <td className="px-3 py-1.5 truncate max-w-[120px] text-muted-foreground">{row.access_groups || '—'}</td>
                            <td className="px-3 py-1.5 text-muted-foreground">
                              {row.send_welcome_email === 'false' || row.send_welcome_email === '0' ? 'No' : 'Yes'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {validRows.length > 10 && (
                      <p className="px-3 py-2 text-xs text-muted-foreground border-t">
                        … and {validRows.length - 10} more rows
                      </p>
                    )}
                  </div>
                </div>
              )}
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
                    {result.created} created · {result.updated} updated
                  </p>
                </div>
              </div>

              {result.errors.length > 0 && (
                <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 space-y-1">
                  <p className="text-xs font-medium text-destructive flex items-center gap-1.5">
                    <AlertCircle className="h-3.5 w-3.5" />
                    {result.errors.length} row{result.errors.length !== 1 ? 's' : ''} had errors
                  </p>
                  <ul className="text-xs text-destructive/80 space-y-0.5 max-h-40 overflow-y-auto">
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
                {importMutation.isPending ? 'Importing…' : `Import ${validRows.length} user${validRows.length !== 1 ? 's' : ''}`}
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
