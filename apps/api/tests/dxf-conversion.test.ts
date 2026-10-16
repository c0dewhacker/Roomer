import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import type { MultipartFile } from '@fastify/multipart'

// storage.ts reads env at import time, so configure it before importing.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'roomer-dxf-'))
process.env['ROOMER_FILE_STORAGE_PATH'] = root
process.env['ROOMER_DATABASE_URL'] ??= 'postgresql://unused:unused@localhost:5432/unused'
process.env['ROOMER_SESSION_SECRET'] ??= randomBytes(32).toString('hex')
process.env['ROOMER_ENCRYPTION_KEY'] ??= randomBytes(32).toString('hex')
const { saveFloorPlan, ensureUploadDirs } = await import('../src/lib/storage.js')
await ensureUploadDirs()

// One LINE from (0,0) to (100,50), with matching drawing extents.
const DXF = [
  '0', 'SECTION', '2', 'HEADER',
  '9', '$EXTMIN', '10', '0', '20', '0',
  '9', '$EXTMAX', '10', '100', '20', '50',
  '0', 'ENDSEC',
  '0', 'SECTION', '2', 'ENTITIES',
  '0', 'LINE', '8', '0', '10', '0', '20', '0', '11', '100', '21', '50',
  '0', 'ENDSEC', '0', 'EOF', '',
].join('\n')

function upload(filename: string, mimetype: string, content: string): MultipartFile {
  return { filename, mimetype, toBuffer: async () => Buffer.from(content) } as unknown as MultipartFile
}

test.after(() => fs.rmSync(root, { recursive: true, force: true }))

test('DXF floor plans are converted to SVG', async () => {
  const saved = await saveFloorPlan(upload('office.dxf', 'application/dxf', DXF))
  assert.equal(saved.fileType, 'DXF')
  assert.match(saved.renderedPath, /\.svg$/, 'rendered path should be the converted SVG, not the raw DXF')
  assert.notEqual(saved.renderedPath, saved.originalPath)

  const svg = fs.readFileSync(path.join(root, saved.renderedPath), 'utf-8')
  assert.match(svg, /<svg[^>]+viewBox="0 0 \d+ \d+"/)
  assert.match(svg, /<line /)
})
