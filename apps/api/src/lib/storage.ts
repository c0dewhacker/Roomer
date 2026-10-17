import path from 'path'
import { randomBytes } from 'crypto'
import type { Readable } from 'stream'
import type { MultipartFile } from '@fastify/multipart'
import sharp from 'sharp'
import { env } from '../env.js'
import { FloorPlanFileType } from '@roomer/shared'
import { LocalStorageBackend, S3StorageBackend, type StorageBackend } from './storage-backend.js'

import dxfParser from 'dxf-parser'

// dxf-parser's types declare a named `DxfParser` export, but under Node's ESM
// loader its CommonJS build only exposes the constructor as the default
// export — the named import was undefined at runtime, so every DXF upload
// failed conversion and was served as raw DXF instead of SVG.
const DxfParser = ((dxfParser as unknown as { DxfParser?: unknown }).DxfParser ?? dxfParser) as unknown as new () => unknown

const FLOOR_PLANS_DIR = 'floor-plans'
const THUMBNAILS_DIR = 'floor-plans/thumbnails'
const BRANDING_DIR = 'branding'
const CATEGORY_ICONS_DIR = 'category-icons'

// Selected once from STORAGE_BACKEND; see storage-backend.ts.
const storage: StorageBackend = env.STORAGE_BACKEND === 's3'
  ? new S3StorageBackend({
      bucket: env.S3_BUCKET!,
      region: env.S3_REGION,
      endpoint: env.S3_ENDPOINT,
      forcePathStyle: env.S3_FORCE_PATH_STYLE,
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
      prefix: env.S3_PREFIX,
    })
  : new LocalStorageBackend(env.FILE_STORAGE_PATH, [FLOOR_PLANS_DIR, THUMBNAILS_DIR, BRANDING_DIR, CATEGORY_ICONS_DIR])

/** Creates the upload directories, or checks the S3 bucket is reachable. Throws if storage is unusable. */
export async function initStorage(): Promise<string> {
  await storage.init()
  return storage.name === 's3'
    ? `S3 bucket "${env.S3_BUCKET}"${env.S3_ENDPOINT ? ` at ${env.S3_ENDPOINT}` : ''}`
    : path.resolve(env.FILE_STORAGE_PATH)
}

/** A stream of a stored file, or null if it doesn't exist. */
export function openStoredFile(relativePath: string): Promise<Readable | null> {
  return storage.open(relativePath)
}

/** The whole stored file, or null if it doesn't exist. */
export function readStoredFile(relativePath: string): Promise<Buffer | null> {
  return storage.read(relativePath)
}

export function writeStoredFile(relativePath: string, data: Buffer | string, contentType?: string): Promise<void> {
  return storage.write(relativePath, data, contentType)
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

  await writeStoredFile(originalRelPath, buffer, file.mimetype)

  // Everything past this point can still fail (a PNG with valid magic bytes
  // but corrupt/truncated pixel data throws in sharp's metadata() call, for
  // instance) — without this try/catch, the file written above is orphaned
  // on disk with no FloorPlan row ever created and nothing to clean it up,
  // while the route handler sees an unrecognised error and 500s instead of
  // reporting a normal validation failure. DXF failures don't hit this path
  // (saveDxfFloorPlan already catches its own parse errors and degrades
  // gracefully instead of throwing), so only IMAGE/PDF land here today.
  try {
    if (fileType === FloorPlanFileType.IMAGE) {
      return await saveImageFloorPlan(buffer, originalRelPath, filename)
    }
    if (fileType === FloorPlanFileType.PDF) {
      return await savePdfFloorPlan(originalRelPath)
    }
    // DXF — convert to SVG for rendering
    return await saveDxfFloorPlan(buffer, originalRelPath, filename)
  } catch (err) {
    await deleteFile(originalRelPath).catch(() => {})
    throw Object.assign(new Error('File could not be processed as the declared type'), { code: 'INVALID_MAGIC', cause: err })
  }
}

async function saveImageFloorPlan(
  buffer: Buffer,
  originalRelPath: string,
  filename: string,
): Promise<FloorPlanSaveResult> {
  const metadata = await sharp(buffer).metadata()
  const width = metadata.width ?? 1200
  const height = metadata.height ?? 900

  // Generate thumbnail (max 400×300, webp)
  const thumbFilename = `thumb_${path.basename(filename, path.extname(filename))}.webp`
  const thumbRelPath = path.join(FLOOR_PLANS_DIR, 'thumbnails', thumbFilename)

  const thumbnail = await sharp(buffer)
    .resize(400, 300, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 75 })
    .toBuffer()
  await writeStoredFile(thumbRelPath, thumbnail, 'image/webp')

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
  buffer: Buffer,
  originalRelPath: string,
  filename: string,
): Promise<FloorPlanSaveResult> {
  try {
    const content = buffer.toString('utf-8')
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
          const largeArc = sweep > Math.PI ? 1 : 0
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
    await writeStoredFile(svgRelPath, svg, 'image/svg+xml')

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
  // Unique per upload (not a fixed `${slot}.png`) so the stored logoPath/
  // faviconPath value actually changes on replace — every <img>/<link> in
  // the app cache-busts with `?t=${branding.logoPath}`, which is a no-op
  // when the path never varies. Combined with the 5-minute Cache-Control on
  // the serving route, a replaced logo/favicon kept showing the old image
  // for up to 5 minutes (indefinitely in an already-open tab) with no error.
  const relPath = path.join(BRANDING_DIR, `${slot}-${Date.now()}-${randomBytes(4).toString('hex')}.png`)

  const buffer = await file.toBuffer()
  if (!checkFileMagic(buffer, file.mimetype)) {
    throw Object.assign(new Error('File content does not match the declared MIME type'), { code: 'INVALID_MAGIC' })
  }
  const png = slot === 'favicon'
    ? await sharp(buffer).resize(64, 64, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer()
    // logo: max 512 wide, max 128 tall, preserve aspect ratio
    : await sharp(buffer).resize(512, 128, { fit: 'inside', withoutEnlargement: true }).png().toBuffer()
  await writeStoredFile(relPath, png, 'image/png')
  return relPath
}

// ─── Category icon storage ────────────────────────────────────────────────────

export async function saveCategoryIcon(file: MultipartFile, categoryId: string): Promise<string> {
  const buffer = await file.toBuffer()
  if (!checkFileMagic(buffer, file.mimetype)) {
    throw Object.assign(new Error('File content does not match the declared MIME type'), { code: 'INVALID_MAGIC' })
  }
  const relPath = path.join(CATEGORY_ICONS_DIR, `${categoryId}.png`)
  // Normalise to 64×64 PNG so the canvas can render it at a consistent size
  const png = await sharp(buffer).resize(64, 64, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer()
  await writeStoredFile(relPath, png, 'image/png')
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
 * Returns false for unknown MIME types (fail-closed) and when the buffer does
 * not match any known signature alternative for the given type.
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

/** Removes a stored file; a missing file is not an error. */
export function deleteFile(relativePath: string): Promise<void> {
  return storage.delete(relativePath)
}
