import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { LocalStorageBackend, toStorageKey } from '../src/lib/storage-backend.js'

test('toStorageKey normalises stored paths to forward-slash keys', () => {
  assert.equal(toStorageKey('floor-plans/plan.png'), 'floor-plans/plan.png')
  assert.equal(toStorageKey('floor-plans\\thumbnails\\t.webp'), 'floor-plans/thumbnails/t.webp')
  assert.equal(toStorageKey('leases/abc/./doc.pdf'), 'leases/abc/doc.pdf')
  assert.equal(toStorageKey('a/b/../c.png'), 'a/c.png')
})

for (const bad of ['../etc/passwd', 'a/../../etc/passwd', '..', '.', '/etc/passwd', '\\etc\\passwd', 'a\0b']) {
  test(`toStorageKey rejects ${JSON.stringify(bad)}`, () => {
    assert.throws(() => toStorageKey(bad), /escapes storage root/)
  })
}

async function withLocal(fn: (backend: LocalStorageBackend, root: string) => Promise<void>): Promise<void> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'roomer-storage-'))
  try {
    await fn(new LocalStorageBackend(root, ['floor-plans/thumbnails', 'branding']), root)
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true })
  }
}

test('local backend init creates the configured directories', () => withLocal(async (backend, root) => {
  await backend.init()
  assert.ok(fs.statSync(path.join(root, 'floor-plans/thumbnails')).isDirectory())
  assert.ok(fs.statSync(path.join(root, 'branding')).isDirectory())
}))

test('local backend round-trips a file, creating parent directories', () => withLocal(async (backend, root) => {
  await backend.write('leases/lease-1/doc.pdf', Buffer.from('%PDF-1.7 hello'))
  assert.equal(fs.readFileSync(path.join(root, 'leases/lease-1/doc.pdf'), 'utf-8'), '%PDF-1.7 hello')
  assert.equal((await backend.read('leases/lease-1/doc.pdf'))?.toString(), '%PDF-1.7 hello')

  const stream = await backend.open('leases/lease-1/doc.pdf')
  assert.ok(stream)
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(chunk as Buffer)
  assert.equal(Buffer.concat(chunks).toString(), '%PDF-1.7 hello')

  await backend.delete('leases/lease-1/doc.pdf')
  assert.equal(fs.existsSync(path.join(root, 'leases/lease-1/doc.pdf')), false)
}))

test('local backend reports missing files as null and ignores deleting them', () => withLocal(async (backend) => {
  assert.equal(await backend.open('nope.png'), null)
  assert.equal(await backend.read('floor-plans/nope.png'), null)
  // A path through a regular file (ENOTDIR) is also "not found".
  await backend.write('file.txt', 'x')
  assert.equal(await backend.read('file.txt/child.png'), null)
  await backend.delete('nope.png')
}))

test('local backend refuses paths outside its root', () => withLocal(async (backend) => {
  await assert.rejects(backend.write('../escape.txt', 'x'), /escapes storage root/)
  await assert.rejects(backend.read('../../etc/passwd'), /escapes storage root/)
}))
