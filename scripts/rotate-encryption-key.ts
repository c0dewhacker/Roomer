/**
 * Offline key rotation script for AuthConfig encrypted fields.
 *
 * Usage:
 *   ROTATE_OLD_KEY=<64-hex> ROTATE_NEW_KEY=<64-hex> \
 *   DATABASE_URL=<url> npx ts-node scripts/rotate-encryption-key.ts
 *
 * Or with ROOMER_ prefix:
 *   ROOMER_ROTATE_OLD_KEY=<64-hex> ROOMER_ROTATE_NEW_KEY=<64-hex> \
 *   ROOMER_DATABASE_URL=<url> npx ts-node scripts/rotate-encryption-key.ts
 *
 * Steps:
 *   1. Stop the API (or ensure no writes happen during rotation).
 *   2. Run this script with the old and new keys.
 *   3. Update ROOMER_ENCRYPTION_KEY in your env to the new key.
 *   4. Restart the API.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'crypto'
import { Pool } from 'pg'

const r = (name: string): string | undefined =>
  process.env[`ROOMER_${name}`] ?? process.env[name]

const OLD_KEY_HEX = r('ROTATE_OLD_KEY')
const NEW_KEY_HEX = r('ROTATE_NEW_KEY')
const DB_URL = r('DATABASE_URL')

if (!OLD_KEY_HEX || !NEW_KEY_HEX || !DB_URL) {
  console.error('Required: ROTATE_OLD_KEY, ROTATE_NEW_KEY, DATABASE_URL (or ROOMER_ prefixed)')
  process.exit(1)
}
if (!/^[0-9a-f]{64}$/.test(OLD_KEY_HEX) || !/^[0-9a-f]{64}$/.test(NEW_KEY_HEX)) {
  console.error('Keys must be exactly 64 lowercase hex characters (32 bytes)')
  process.exit(1)
}

const OLD_KEY = Buffer.from(OLD_KEY_HEX, 'hex')
const NEW_KEY = Buffer.from(NEW_KEY_HEX, 'hex')

const ALGORITHM = 'aes-256-gcm'
const IV_BYTES = 12
const TAG_BYTES = 16

function decryptWithKey(envelope: string, key: Buffer): string {
  if (!envelope.startsWith('enc:v1:')) throw new Error('Not an encrypted envelope')
  const payload = Buffer.from(envelope.slice(7), 'base64')
  const iv = payload.subarray(0, IV_BYTES)
  const tag = payload.subarray(payload.length - TAG_BYTES)
  const ciphertext = payload.subarray(IV_BYTES, payload.length - TAG_BYTES)
  const decipher = createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(tag)
  return decipher.update(ciphertext) + decipher.final('utf8')
}

function encryptWithKey(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `enc:v1:${Buffer.concat([iv, ciphertext, tag]).toString('base64')}`
}

async function main() {
  const pool = new Pool({ connectionString: DB_URL })

  try {
    const { rows } = await pool.query<{ id: string; config: unknown }>(
      'SELECT id, config FROM "AuthConfig"',
    )

    console.log(`Found ${rows.length} AuthConfig row(s)`)
    let rotated = 0
    let skipped = 0

    for (const row of rows) {
      const raw = typeof row.config === 'string' ? row.config : JSON.stringify(row.config)

      if (!raw.startsWith('enc:v1:')) {
        console.log(`  [${row.id}] plaintext — skipping (run backfill first or encrypt manually)`)
        skipped++
        continue
      }

      let plaintext: string
      try {
        plaintext = decryptWithKey(raw, OLD_KEY)
      } catch {
        console.error(`  [${row.id}] failed to decrypt with old key — skipping`)
        skipped++
        continue
      }

      const reEncrypted = encryptWithKey(plaintext, NEW_KEY)

      await pool.query('UPDATE "AuthConfig" SET config = $1 WHERE id = $2', [
        reEncrypted,
        row.id,
      ])
      console.log(`  [${row.id}] rotated`)
      rotated++
    }

    console.log(`\nDone. Rotated: ${rotated}, skipped: ${skipped}`)
  } finally {
    await pool.end()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
