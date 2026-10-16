import assert from 'node:assert/strict'
import test from 'node:test'
import { randomBytes } from 'node:crypto'
import { S3StorageBackend } from '../../src/lib/storage-backend.js'

// Runs against any S3-compatible endpoint (CI uses adobe/s3mock). Skipped
// when S3_TEST_ENDPOINT isn't set.
const endpoint = process.env['S3_TEST_ENDPOINT']
const bucket = process.env['S3_TEST_BUCKET'] ?? 'roomer-test'
const skip = endpoint ? false : 'S3_TEST_ENDPOINT not set'

function backend(overrides: Partial<ConstructorParameters<typeof S3StorageBackend>[0]> = {}): S3StorageBackend {
  return new S3StorageBackend({
    bucket,
    region: 'us-east-1',
    endpoint,
    forcePathStyle: true,
    accessKeyId: process.env['S3_TEST_ACCESS_KEY_ID'] ?? 'test',
    secretAccessKey: process.env['S3_TEST_SECRET_ACCESS_KEY'] ?? 'test',
    ...overrides,
  })
}

test('S3 backend: init succeeds for an existing bucket', { skip }, async () => {
  await backend().init()
})

test('S3 backend: init fails clearly for a missing bucket', { skip }, async () => {
  await assert.rejects(
    backend({ bucket: `missing-${randomBytes(4).toString('hex')}` }).init(),
    /bucket ".*" is not usable: bucket does not exist/,
  )
})

test('S3 backend: round-trips binary data under a prefix', { skip }, async () => {
  const s3 = backend({ prefix: `/run-${randomBytes(4).toString('hex')}/` })
  const data = randomBytes(256 * 1024)
  await s3.write('floor-plans/thumbnails/t.webp', data, 'image/webp')

  assert.deepEqual(await s3.read('floor-plans/thumbnails/t.webp'), data)
  const stream = await s3.open('floor-plans/thumbnails/t.webp')
  assert.ok(stream)
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array))
  assert.deepEqual(Buffer.concat(chunks), data)

  await s3.delete('floor-plans/thumbnails/t.webp')
  assert.equal(await s3.read('floor-plans/thumbnails/t.webp'), null)
})

test('S3 backend: missing objects are null and deleting them is not an error', { skip }, async () => {
  const s3 = backend()
  assert.equal(await s3.open(`nope-${randomBytes(4).toString('hex')}.png`), null)
  await s3.delete(`nope-${randomBytes(4).toString('hex')}.png`)
})

test('S3 backend: refuses keys outside the root', { skip }, async () => {
  await assert.rejects(backend().write('../escape.txt', 'x'), /escapes storage root/)
})
