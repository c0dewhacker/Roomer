import { prisma } from './prisma.js'
import { decryptStringMaybe } from './encryption.js'

// ── Startup env snapshot ──────────────────────────────────────────────────────
// Read the raw SMTP env vars ONCE at startup. A value being present (even empty)
// means the operator set it via the environment, so it overrides the UI/DB value.
// (We read process.env directly rather than the parsed `env` object, because that
// object applies defaults and would hide whether a var was actually set.)
function rawEnv(name: string): string | undefined {
  return process.env[`ROOMER_${name}`] ?? process.env[name]
}

const ENV = {
  host: rawEnv('SMTP_HOST'),
  port: rawEnv('SMTP_PORT'),
  secure: rawEnv('SMTP_SECURE'),
  user: rawEnv('SMTP_USER'),
  pass: rawEnv('SMTP_PASS'),
  from: rawEnv('EMAIL_FROM'),
} as const

/** Which fields are pinned by an environment variable (and therefore locked in the UI). */
export const ENV_SMTP_OVERRIDES = {
  host: ENV.host !== undefined,
  port: ENV.port !== undefined,
  secure: ENV.secure !== undefined,
  user: ENV.user !== undefined,
  pass: ENV.pass !== undefined,
  from: ENV.from !== undefined,
}

const DEFAULTS = { host: 'localhost', port: 1025, secure: false, from: 'noreply@roomer.local' }

export interface StoredEmailConfig {
  host?: string
  port?: number
  secure?: boolean
  user?: string
  from?: string
  /** Encrypted (enc:v1:…) at rest. */
  password?: string
}

export interface EffectiveSmtp {
  host: string
  port: number
  secure: boolean
  user?: string
  pass?: string
  from: string
}

/** Read the admin-configured email settings from the DB (password decrypted). */
export async function getStoredEmailConfig(): Promise<StoredEmailConfig> {
  const org = await prisma.organisation.findFirst({ select: { emailConfig: true } })
  return ((org?.emailConfig ?? {}) as StoredEmailConfig)
}

/**
 * Resolve the SMTP settings actually used to send mail.
 * Precedence per field: environment variable (if set at startup) → DB/UI value → default.
 */
export async function getEffectiveSmtp(): Promise<EffectiveSmtp> {
  const db = await getStoredEmailConfig()
  const dbPass = typeof db.password === 'string' && db.password ? decryptStringMaybe(db.password) : undefined

  return {
    host: ENV.host ?? db.host ?? DEFAULTS.host,
    port: ENV.port !== undefined ? Number(ENV.port) : (db.port ?? DEFAULTS.port),
    secure: ENV.secure !== undefined ? ENV.secure === 'true' : (db.secure ?? DEFAULTS.secure),
    user: ENV.user ?? db.user ?? undefined,
    pass: ENV.pass ?? dbPass ?? undefined,
    from: ENV.from ?? db.from ?? DEFAULTS.from,
  }
}

/** Effective values safe to show in the UI for env-overridden fields (no password). */
export async function getEffectiveSmtpForDisplay(): Promise<Omit<EffectiveSmtp, 'pass'>> {
  const { pass: _pass, ...rest } = await getEffectiveSmtp()
  return rest
}
