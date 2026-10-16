/**
 * Copy existing uploads from FILE_STORAGE_PATH into the configured S3 bucket,
 * for switching an existing install to STORAGE_BACKEND=s3. Object keys are the
 * same relative paths the database already stores, so no data changes.
 *
 *   node dist/scripts/copy-uploads-to-s3.js [--dry-run]
 *
 * Reads the S3_* settings whatever STORAGE_BACKEND is currently set to, so it
 * can run before the switch (from a pod or container still on local storage)
 * and again afterwards to pick up anything uploaded in between. Objects that
 * already exist with the same size are skipped, so re-running is cheap.
 */
import fs from 'fs'
import path from 'path'
import { env } from '../env.js'
import { S3StorageBackend } from '../lib/storage-backend.js'

const CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.dxf': 'application/dxf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
}

async function* walk(dir: string): AsyncGenerator<string> {
  for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(full)
    else if (entry.isFile()) yield full
  }
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run')
  if (!env.S3_BUCKET) {
    throw new Error('Set ROOMER_S3_BUCKET (and the other ROOMER_S3_* settings) to the bucket to copy into')
  }
  const root = path.resolve(env.FILE_STORAGE_PATH)
  const s3 = new S3StorageBackend({
    bucket: env.S3_BUCKET,
    region: env.S3_REGION,
    endpoint: env.S3_ENDPOINT,
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    prefix: env.S3_PREFIX,
  })
  await s3.init()

  const target = `s3://${env.S3_BUCKET}/${env.S3_PREFIX.replace(/^\/+|\/+$/g, '')}`.replace(/\/$/, '')
  console.log(`[copy] ${root} → ${target}${dryRun ? ' (dry run)' : ''}`)

  let copied = 0
  let skipped = 0
  let bytes = 0
  for await (const file of walk(root)) {
    const relativePath = path.relative(root, file).split(path.sep).join('/')
    const { size } = await fs.promises.stat(file)
    if ((await s3.size(relativePath)) === size) {
      skipped++
      continue
    }
    if (!dryRun) {
      const type = CONTENT_TYPES[path.extname(file).toLowerCase()]
      await s3.write(relativePath, await fs.promises.readFile(file), type)
    }
    console.log(`[copy] ${dryRun ? 'would copy' : 'copied'} ${relativePath} (${size} bytes)`)
    copied++
    bytes += size
  }
  console.log(`[copy] done: ${copied} ${dryRun ? 'to copy' : 'copied'} (${bytes} bytes), ${skipped} already present`)
}

main().catch((err) => {
  console.error('[copy] failed:', err instanceof Error ? err.message : err)
  process.exit(1)
})
