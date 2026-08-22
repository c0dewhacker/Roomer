/**
 * Offline key rotation script for every encrypted-at-rest secret in the
 * database: AuthConfig.config (OIDC/SAML/LDAP settings — already
 * individually field-encrypted, then the whole JSON blob is encrypted again
 * as one envelope by encryptJson, so it's rotated as a single whole-column
 * value), WebhookEndpoint.secret (a plain column, same whole-value pattern),
 * and Organisation.emailConfig.password (the SMTP password — unlike the
 * other two, this is one field nested inside an otherwise-plaintext JSON
 * column, not the whole column, so it needs parsing rather than a raw
 * whole-value swap).
 *
 * Originally this script only covered AuthConfig — following its own
 * runbook exactly (rotate, update ROOMER_ENCRYPTION_KEY, restart) left
 * webhook signing secrets and the SMTP password still encrypted under the
 * *old* key, with no error at rotation time. The first symptom was every
 * webhook delivery and every outbound email failing at send/decrypt time
 * after the restart — silently defeating the entire point of rotating
 * (the standard response to a suspected DB compromise) for exactly the two
 * secret categories most likely to matter.
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

/**
 * Rotates a whole-column value that is itself one enc:v1 envelope
 * (AuthConfig.config, WebhookEndpoint.secret). `isJsonColumn` must be true
 * for AuthConfig.config — it's a Postgres json column, so the re-encrypted
 * string has to be written back as a JSON string literal (JSON.stringify'd,
 * i.e. wrapped in real double quotes) or Postgres rejects it with
 * "invalid input syntax for type json" (a bare enc:v1:... value isn't valid
 * JSON on its own). WebhookEndpoint.secret is a plain text column and must
 * NOT be JSON-encoded.
 */
async function rotateWholeColumn(pool: Pool, table: string, column: string, isJsonColumn: boolean): Promise<{ rotated: number; skipped: number }> {
  const { rows } = await pool.query<{ id: string; value: unknown }>(
    `SELECT id, "${column}" AS value FROM "${table}"`,
  )
  console.log(`Found ${rows.length} ${table} row(s)`)
  let rotated = 0
  let skipped = 0

  for (const row of rows) {
    const raw = typeof row.value === 'string' ? row.value : row.value == null ? '' : JSON.stringify(row.value)

    if (!raw.startsWith('enc:v1:')) {
      console.log(`  [${row.id}] plaintext/empty — skipping`)
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
    const writeValue = isJsonColumn ? JSON.stringify(reEncrypted) : reEncrypted
    await pool.query(`UPDATE "${table}" SET "${column}" = $1 WHERE id = $2`, [writeValue, row.id])
    console.log(`  [${row.id}] rotated`)
    rotated++
  }

  return { rotated, skipped }
}

/** Rotates Organisation.emailConfig.password — a single field nested inside an otherwise-plaintext JSON column, not the whole column. */
async function rotateEmailConfigPassword(pool: Pool): Promise<{ rotated: number; skipped: number }> {
  const { rows } = await pool.query<{ id: string; emailConfig: Record<string, unknown> | null }>(
    'SELECT id, "emailConfig" FROM "Organisation"',
  )
  console.log(`Found ${rows.length} Organisation row(s)`)
  let rotated = 0
  let skipped = 0

  for (const row of rows) {
    const config = row.emailConfig ?? {}
    const password = config.password
    if (typeof password !== 'string' || !password.startsWith('enc:v1:')) {
      console.log(`  [${row.id}] no encrypted SMTP password — skipping`)
      skipped++
      continue
    }

    let plaintext: string
    try {
      plaintext = decryptWithKey(password, OLD_KEY)
    } catch {
      console.error(`  [${row.id}] failed to decrypt SMTP password with old key — skipping`)
      skipped++
      continue
    }

    const updatedConfig = { ...config, password: encryptWithKey(plaintext, NEW_KEY) }
    await pool.query('UPDATE "Organisation" SET "emailConfig" = $1 WHERE id = $2', [
      JSON.stringify(updatedConfig),
      row.id,
    ])
    console.log(`  [${row.id}] rotated`)
    rotated++
  }

  return { rotated, skipped }
}

async function main() {
  const pool = new Pool({ connectionString: DB_URL })

  try {
    const authConfig = await rotateWholeColumn(pool, 'AuthConfig', 'config', true)
    const webhooks = await rotateWholeColumn(pool, 'WebhookEndpoint', 'secret', false)
    const email = await rotateEmailConfigPassword(pool)

    const rotated = authConfig.rotated + webhooks.rotated + email.rotated
    const skipped = authConfig.skipped + webhooks.skipped + email.skipped
    console.log(`\nDone. Rotated: ${rotated}, skipped: ${skipped}`)
  } finally {
    await pool.end()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
