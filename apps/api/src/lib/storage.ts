import fs from 'fs'
import path from 'path'
import { randomBytes } from 'crypto'
import type { MultipartFile } from '@fastify/multipart'
import sharp from 'sharp'
import { env } from '../env'
import { FloorPlanFileType } from '@roomer/shared'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const DxfParser = require('dxf-parser')

const FLOOR_PLANS_DIR = 'floor-plans'
const THUMBNAILS_DIR = 'floor-plans/thumbnails'
const BRANDING_DIR = 'branding'

/**
 * Resolve a path relative to FILE_STORAGE_PATH and reject anything that
 * escapes the root (e.g. `../../etc/passwd`). All paths currently stored in
 * the DB come from sanitising code paths, so this is defence-in-depth: it
 * blocks a write-side compromise (SQL injection, malicious admin) from
 * turning into an arbitrary file read/write.
 */
export function resolveStoragePath(relativePath: string): string {
  const root = path.resolve(env.FILE_STORAGE_PATH)
  const resolved = path.resolve(root, relativePath)
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`Path escapes storage root: ${relativePath}`)
  }
  return resolved
}

export async function ensureUploadDirs(): Promise<void> {
  const dirs = [
    env.FILE_STORAGE_PATH,
    path.join(env.FILE_STORAGE_PATH, FLOOR_PLANS_DIR),
    path.join(env.FILE_STORAGE_PATH, THUMBNAILS_DIR),
    path.join(env.FILE_STORAGE_PATH, BRANDING_DIR),
  ]
  for (const dir of dirs) {
    await fs.promises.mkdir(dir, { recursive: true })
  }
}

function sanitizeFilename(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9_.-]/g, '_')
    .replace(/\.{2,}/g, '_')
    .slice(0, 200)
}

function generateFilename(originalName: string): string {
  const ext = path.extname(originalName).toLowerCase()
  const base = path.basename(originalName, ext)
  const safe = sanitizeFilename(base)
  const timestamp = Date.now()
  const rand = randomBytes(4).toString('hex')
  return `${safe}_${timestamp}_${rand}${ext}`
}

function detectFileType(mimetype: string, filename: string): FloorPlanFileType {
  const ext = path.extname(filename).toLowerCase()

  if (
    mimetype === 'application/pdf' ||
    ext === '.pdf'
  ) {
    return FloorPlanFileType.PDF
  }

  if (
    ext === '.dxf' ||
    mimetype === 'image/vnd.dxf' ||
    mimetype === 'application/dxf'
  ) {
    return FloorPlanFileType.DXF
  }

  return FloorPlanFileType.IMAGE
}

interface FloorPlanSaveResult {
  originalPath: string
  renderedPath: string
  thumbnailPath: string | null
  width: number
  height: number
  fileType: FloorPlanFileType
}

export async function saveFloorPlan(
  file: MultipartFile,
): Promise<FloorPlanSaveResult> {
  const fileType = detectFileType(file.mimetype, file.filename)
  const filename = generateFilename(file.filename)
  const originalRelPath = path.join(FLOOR_PLANS_DIR, filename)
  const originalAbsPath = resolveStoragePath(originalRelPath)

  // Buffer the entire upload so we can validate magic bytes before persisting
  const buffer = await file.toBuffer()

  if (fileType === FloorPlanFileType.DXF) {
    // DXF is plaintext — reject files that contain null bytes (binary indicator)
    if (buffer.includes(0x00)) {
      throw Object.assign(new Error('DXF file contains binary content'), { code: 'INVALID_MAGIC' })
    }
  } else if (!checkFileMagic(buffer, file.mimetype)) {
    throw Object.assign(new Error('File content does not match the declared MIME type'), { code: 'INVALID_MAGIC' })
  }

  await fs.promises.writeFile(originalAbsPath, buffer)

  if (fileType === FloorPlanFileType.IMAGE) {
    return saveImageFloorPlan(originalAbsPath, originalRelPath, filename)
  }

  if (fileType === FloorPlanFileType.PDF) {
    return savePdfFloorPlan(originalRelPath)
  }

  // DXF — convert to SVG for rendering
  return saveDxfFloorPlan(originalAbsPath, originalRelPath, filename)
}

async function saveImageFloorPlan(
  originalAbsPath: string,
  originalRelPath: string,
  filename: string,
): Promise<FloorPlanSaveResult> {
  const image = sharp(originalAbsPath)
  const metadata = await image.metadata()
  const width = metadata.width ?? 1200
  const height = metadata.height ?? 900

  // Generate thumbnail (max 400×300, webp)
  const thumbFilename = `thumb_${path.basename(filename, path.extname(filename))}.webp`
  const thumbRelPath = path.join(FLOOR_PLANS_DIR, 'thumbnails', thumbFilename)
  const thumbAbsPath = resolveStoragePath(thumbRelPath)

  await sharp(originalAbsPath)
    .resize(400, 300, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 75 })
    .toFile(thumbAbsPath)

  return {
    originalPath: originalRelPath,
    renderedPath: originalRelPath,
    thumbnailPath: thumbRelPath,
    width,
    height,
    fileType: FloorPlanFileType.IMAGE,
  }
}

async function savePdfFloorPlan(
  originalRelPath: string,
): Promise<FloorPlanSaveResult> {
  // PDFs are stored as-is and rasterised client-side by pdfjs-dist.
  // Width/height are nominal placeholders; the actual viewport comes from
  // the PDF itself when the browser renders page 1.
  return {
    originalPath: originalRelPath,
    renderedPath: originalRelPath,
    thumbnailPath: null,
    width: 1200,
    height: 900,
    fileType: FloorPlanFileType.PDF,
  }
}

async function saveDxfFloorPlan(
  originalAbsPath: string,
  originalRelPath: string,
  filename: string,
): Promise<FloorPlanSaveResult> {
  try {
    const content = await fs.promises.readFile(originalAbsPath, 'utf-8')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const parser = new DxfParser() as any
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dxf: any = parser.parseSync(content)

    const extMin = dxf?.header?.['$EXTMIN'] ?? { x: 0, y: 0 }
    const extMax = dxf?.header?.['$EXTMAX'] ?? { x: 1000, y: 1000 }
    const dxfWidth = extMax.x - extMin.x
    const dxfHeight = extMax.y - extMin.y

    if (dxfWidth <= 0 || dxfHeight <= 0) {
      return { originalPath: originalRelPath, renderedPath: originalRelPath, thumbnailPath: null, width: 1200, height: 900, fileType: FloorPlanFileType.DXF }
    }

    const MAX_DIM = 4000
    const scale = Math.min(MAX_DIM / dxfWidth, (MAX_DIM * 0.75) / dxfHeight)
    const svgWidth = Math.round(dxfWidth * scale)
    const svgHeight = Math.round(dxfHeight * scale)

    const toX = (x: number) => ((x - extMin.x) * scale).toFixed(2)
    const toY = (y: number) => (svgHeight - (y - extMin.y) * scale).toFixed(2)

    const elems: string[] = []
    for (const entity of dxf?.entities ?? []) {
      try {
        if (entity.type === 'LINE') {
          const [v0, v1] = entity.vertices
          elems.push(`<line x1="${toX(v0.x)}" y1="${toY(v0.y)}" x2="${toX(v1.x)}" y2="${toY(v1.y)}"/>`)
        } else if (entity.type === 'LWPOLYLINE' || entity.type === 'POLYLINE') {
          const pts = (entity.vertices as Array<{ x: number; y: number }>)
            .map((v) => `${toX(v.x)},${toY(v.y)}`)
            .join(' ')
          elems.push(`<polyline points="${pts}"${entity.shape ? ' fill="none"' : ''}/>`)
        } else if (entity.type === 'CIRCLE') {
          elems.push(
            `<circle cx="${toX(entity.center.x)}" cy="${toY(entity.center.y)}" r="${(entity.radius * scale).toFixed(2)}"/>`,
          )
        } else if (entity.type === 'ARC') {
          const cx = (entity.center.x - extMin.x) * scale
          const cy = svgHeight - (entity.center.y - extMin.y) * scale
          const r = entity.radius * scale
          const a1 = (entity.startAngle * Math.PI) / 180
          const a2 = (entity.endAngle * Math.PI) / 180
          const x1 = (cx + r * Math.cos(a1)).toFixed(2)
          const y1 = (cy - r * Math.sin(a1)).toFixed(2)
          const x2 = (cx + r * Math.cos(a2)).toFixed(2)
          const y2 = (cy - r * Math.sin(a2)).toFixed(2)
          let sweep = a2 - a1
          if (sweep < 0) sweep += 2 * Math.PI
          const largeArc = sweep > Math.PI ? 0 : 1
          elems.push(`<path d="M ${x1} ${y1} A ${r.toFixed(2)} ${r.toFixed(2)} 0 ${largeArc} 0 ${x2} ${y2}"/>`)
        }
      } catch {
        // Skip unparseable entities
      }
    }

    const svg = [
      `<?xml version="1.0" encoding="utf-8"?>`,
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${svgWidth} ${svgHeight}" width="${svgWidth}" height="${svgHeight}">`,
      `  <g stroke="#334155" stroke-width="1" fill="none">`,
      ...elems.map((e) => `    ${e}`),
      `  </g>`,
      `</svg>`,
    ].join('\n')

    const svgFilename = path.basename(filename, path.extname(filename)) + '.svg'
    const svgRelPath = path.join(FLOOR_PLANS_DIR, svgFilename)
    await fs.promises.writeFile(resolveStoragePath(svgRelPath), svg, 'utf-8')

    return {
      originalPath: originalRelPath,
      renderedPath: svgRelPath,
      thumbnailPath: null,
      width: svgWidth,
      height: svgHeight,
      fileType: FloorPlanFileType.DXF,
    }
  } catch (err) {
    console.error('DXF conversion failed:', err)
    return {
      originalPath: originalRelPath,
      renderedPath: originalRelPath,
      thumbnailPath: null,
      width: 1200,
      height: 900,
      fileType: FloorPlanFileType.DXF,
    }
  }
}

// ─── Branding image storage ────────────────────────────────────────────────

/**
 * Save a logo or favicon upload, converting it to PNG with appropriate dimensions.
 * Returns the relative storage path.
 */
export async function saveBrandingImage(
  file: MultipartFile,
  slot: 'logo' | 'favicon',
): Promise<string> {
  await fs.promises.mkdir(path.join(env.FILE_STORAGE_PATH, BRANDING_DIR), { recursive: true })
  const relPath = path.join(BRANDING_DIR, `${slot}.png`)
  const absPath = resolveStoragePath(relPath)

  const buffer = await file.toBuffer()
  if (!checkFileMagic(buffer, file.mimetype)) {
    throw Object.assign(new Error('File content does not match the declared MIME type'), { code: 'INVALID_MAGIC' })
  }
  if (slot === 'favicon') {
    await sharp(buffer).resize(64, 64, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toFile(absPath)
  } else {
    // logo: max 512 wide, max 128 tall, preserve aspect ratio
    await sharp(buffer).resize(512, 128, { fit: 'inside', withoutEnlargement: true }).png().toFile(absPath)
  }
  return relPath
}

// ─── Magic byte validation ────────────────────────────────────────────────────

/**
 * Map of MIME types to their expected leading magic bytes.
 * Each entry is an array of alternatives (e.g. JPEG has multiple valid SOI markers).
 */
const MAGIC_SIGNATURES: Record<string, number[][]> = {
  'application/pdf': [[0x25, 0x50, 0x44, 0x46]],                              // %PDF
  'application/msword': [[0xD0, 0xCF, 0x11, 0xE0]],                           // OLE2
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': [
    [0x50, 0x4B, 0x03, 0x04],                                                  // ZIP (DOCX/XLSX/PPTX)
  ],
  'image/png': [[0x89, 0x50, 0x4E, 0x47]],                                     // PNG
  'image/jpeg': [[0xFF, 0xD8, 0xFF]],                                           // JPEG
  'image/jpg': [[0xFF, 0xD8, 0xFF]],                                            // JPEG (alt MIME)
  'image/webp': [[0x52, 0x49, 0x46, 0x46]],                                    // RIFF (WebP container)
  'image/gif': [[0x47, 0x49, 0x46, 0x38]],                                     // GIF8 (GIF87a/GIF89a)
}

/**
 * Validate that `buffer` starts with the expected magic bytes for `mimeType`.
 * Returns true when the MIME type is unknown (no signature on record) to avoid
 * blocking legitimate new types.  Returns false only when a signature IS known
 * but the buffer does not match any of its alternatives.
 */
export function checkFileMagic(buffer: Buffer, mimeType: string): boolean {
  const signatures = MAGIC_SIGNATURES[mimeType]
  if (!signatures) return false
  return signatures.some((sig) => {
    if (buffer.length < sig.length) return false
    return sig.every((byte, i) => buffer[i] === byte)
  })
}

export function getFloorPlanUrl(relativePath: string): string {
  // Returns a URL path suitable for serving via the static files / stream endpoint
  return `/api/v1/files/${encodeURIComponent(relativePath)}`
}

export async function deleteFile(relativePath: string): Promise<void> {
  const absPath = resolveStoragePath(relativePath)
  try {
    await fs.promises.unlink(absPath)
  } catch (err: unknown) {
    // Ignore file-not-found errors
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err
    }
  }
}
