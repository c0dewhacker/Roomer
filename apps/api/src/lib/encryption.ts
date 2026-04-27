import { createCipheriv, createDecipheriv, randomBytes } from 'crypto'
import { env } from '../env'

const ALGORITHM = 'aes-256-gcm'
const IV_BYTES = 12   // 96-bit IV — recommended for GCM
const TAG_BYTES = 16  // 128-bit auth tag

const KEY = Buffer.from(env.ROOMER_ENCRYPTION_KEY, 'hex')

export function encrypt(plaintext: string): string {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, KEY, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `enc:v1:${Buffer.concat([iv, ciphertext, tag]).toString('base64')}`
}

export function decrypt(envelope: string): string {
  if (!envelope.startsWith('enc:v1:')) throw new Error('Not an encrypted envelope')
  const payload = Buffer.from(envelope.slice(7), 'base64')
  if (payload.length < IV_BYTES + TAG_BYTES) throw new Error('Malformed encrypted envelope')
  const iv = payload.subarray(0, IV_BYTES)
  const tag = payload.subarray(payload.length - TAG_BYTES)
  const ciphertext = payload.subarray(IV_BYTES, payload.length - TAG_BYTES)
  const decipher = createDecipheriv(ALGORITHM, KEY, iv)
  decipher.setAuthTag(tag)
  return decipher.update(ciphertext) + decipher.final('utf8')
}

// Serialize an object to JSON, encrypt, and return the enc:v1: envelope string.
// Store the result directly in a Prisma Json field — Postgres stores it as a JSON string.
export function encryptJson(value: unknown): string {
  return encrypt(JSON.stringify(value))
}

// Decrypt a value from a Prisma Json field.
// - If it's a string starting with enc:v1: → decrypt and JSON.parse.
// - Otherwise pass through as-is (legacy plaintext rows before backfill).
export function decryptJson<T = unknown>(value: unknown): T {
  if (typeof value === 'string' && value.startsWith('enc:v1:')) {
    return JSON.parse(decrypt(value)) as T
  }
  return value as T
}
