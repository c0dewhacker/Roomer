import fs from 'fs'
import path from 'path'
import type { Readable } from 'stream'
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3'

/**
 * Where uploaded files (floor plans, thumbnails, branding, category icons,
 * lease documents) live. Callers always address files by the same relative
 * path that is stored in the database (e.g. `floor-plans/plan_123.png`), so
 * switching backends never needs a data migration — the local path under
 * FILE_STORAGE_PATH and the S3 object key are the same string.
 */
export interface StorageBackend {
  readonly name: 'local' | 's3'
  /** Prepare the backend; throws if it can't be used (missing bucket, bad credentials). */
  init(): Promise<void>
  write(relativePath: string, data: Buffer | string, contentType?: string): Promise<void>
  /** A stream of the file, or null if it doesn't exist. */
  open(relativePath: string): Promise<Readable | null>
  /** The whole file, or null if it doesn't exist. */
  read(relativePath: string): Promise<Buffer | null>
  /** Removes the file; a missing file is not an error. */
  delete(relativePath: string): Promise<void>
}

/**
 * Normalise a stored relative path to a forward-slash key and reject anything
 * that escapes the storage root (`../`, absolute paths, NUL bytes). All paths
 * in the DB come from sanitising code paths, so this is defence-in-depth: it
 * stops a write-side compromise (SQL injection, malicious admin) turning into
 * an arbitrary file or object read/write.
 */
export function toStorageKey(relativePath: string): string {
  const key = path.posix.normalize(relativePath.replace(/\\/g, '/'))
  if (
    key === '.' ||
    key === '..' ||
    key.startsWith('../') ||
    path.posix.isAbsolute(key) ||
    key.includes('\0')
  ) {
    throw new Error(`Path escapes storage root: ${relativePath}`)
  }
  return key
}

function isNotFound(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

// ─── Local filesystem ─────────────────────────────────────────────────────────

export class LocalStorageBackend implements StorageBackend {
  readonly name = 'local' as const
  private readonly root: string

  constructor(root: string, private readonly initialDirs: string[] = []) {
    this.root = path.resolve(root)
  }

  /** Absolute path for a stored relative path, guaranteed to be inside the root. */
  resolve(relativePath: string): string {
    const resolved = path.resolve(this.root, toStorageKey(relativePath))
    if (resolved !== this.root && !resolved.startsWith(this.root + path.sep)) {
      throw new Error(`Path escapes storage root: ${relativePath}`)
    }
    return resolved
  }

  async init(): Promise<void> {
    await fs.promises.mkdir(this.root, { recursive: true })
    for (const dir of this.initialDirs) {
      await fs.promises.mkdir(this.resolve(dir), { recursive: true })
    }
  }

  async write(relativePath: string, data: Buffer | string): Promise<void> {
    const absPath = this.resolve(relativePath)
    await fs.promises.mkdir(path.dirname(absPath), { recursive: true })
    await fs.promises.writeFile(absPath, data)
  }

  async open(relativePath: string): Promise<Readable | null> {
    try {
      const handle = await fs.promises.open(this.resolve(relativePath), 'r')
      return handle.createReadStream()
    } catch (err) {
      if (isNotFound(err)) return null
      throw err
    }
  }

  async read(relativePath: string): Promise<Buffer | null> {
    try {
      return await fs.promises.readFile(this.resolve(relativePath))
    } catch (err) {
      if (isNotFound(err)) return null
      throw err
    }
  }

  async delete(relativePath: string): Promise<void> {
    try {
      await fs.promises.unlink(this.resolve(relativePath))
    } catch (err) {
      if (!isNotFound(err)) throw err
    }
  }
}

// ─── S3-compatible object storage ─────────────────────────────────────────────

export interface S3StorageConfig {
  bucket: string
  region: string
  /** Custom endpoint for S3-compatible services (MinIO, Ceph RGW, Garage, R2, ...). */
  endpoint?: string
  /** Bucket in the path rather than the hostname — most self-hosted services need this. */
  forcePathStyle?: boolean
  /** Static credentials. When omitted the AWS default chain is used (env, IRSA, instance role). */
  accessKeyId?: string
  secretAccessKey?: string
  /** Optional key prefix, so one bucket can hold several installs. */
  prefix?: string
}

export class S3StorageBackend implements StorageBackend {
  readonly name = 's3' as const
  private readonly client: S3Client
  private readonly bucket: string
  private readonly prefix: string

  constructor(config: S3StorageConfig) {
    this.bucket = config.bucket
    const prefix = (config.prefix ?? '').replace(/^\/+|\/+$/g, '')
    this.prefix = prefix ? `${toStorageKey(prefix)}/` : ''
    this.client = new S3Client({
      region: config.region,
      endpoint: config.endpoint,
      forcePathStyle: config.forcePathStyle ?? false,
      credentials: config.accessKeyId && config.secretAccessKey
        ? { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey }
        : undefined,
      // The SDK's default "always add CRC checksums" behaviour is rejected by
      // many S3-compatible services; only send them when an operation needs one.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    })
  }

  private key(relativePath: string): string {
    return this.prefix + toStorageKey(relativePath)
  }

  async init(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }))
    } catch (err) {
      const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode
      const reason = status === 404 ? 'bucket does not exist'
        : status === 403 ? 'access denied — check the credentials and bucket policy'
        : (err as Error).message
      throw new Error(`S3 bucket "${this.bucket}" is not usable: ${reason}`, { cause: err })
    }
  }

  async write(relativePath: string, data: Buffer | string, contentType?: string): Promise<void> {
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: this.key(relativePath),
      Body: data,
      ContentType: contentType,
    }))
  }

  async open(relativePath: string): Promise<Readable | null> {
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.key(relativePath) }))
      return (res.Body as Readable | undefined) ?? null
    } catch (err) {
      const e = err as { name?: string; $metadata?: { httpStatusCode?: number } }
      if (e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404) return null
      throw err
    }
  }

  async read(relativePath: string): Promise<Buffer | null> {
    const stream = await this.open(relativePath)
    if (!stream) return null
    const chunks: Buffer[] = []
    for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array))
    return Buffer.concat(chunks)
  }

  /** Size in bytes, or null if the object doesn't exist. */
  async size(relativePath: string): Promise<number | null> {
    try {
      const res = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: this.key(relativePath) }))
      return res.ContentLength ?? null
    } catch (err) {
      const e = err as { name?: string; $metadata?: { httpStatusCode?: number } }
      if (e.name === 'NotFound' || e.$metadata?.httpStatusCode === 404) return null
      throw err
    }
  }

  async delete(relativePath: string): Promise<void> {
    // DeleteObject succeeds for keys that don't exist.
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: this.key(relativePath) }))
  }
}
