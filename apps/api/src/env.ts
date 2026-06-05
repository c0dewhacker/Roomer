import { z } from 'zod'

// Resolve a variable by checking ROOMER_<NAME> first, then <NAME>.
// This lets Docker/Kubernetes deployments use a consistent ROOMER_ namespace
// while preserving backward compatibility with unprefixed names.
function r(name: string): string | undefined {
  return process.env[`ROOMER_${name}`] ?? process.env[name]
}

const isProd = r('NODE_ENV') === 'production'

const envSchema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL (or ROOMER_DATABASE_URL) is required'),
  // Minimum 32 characters. Generate with: openssl rand -hex 32
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters. Generate with: openssl rand -hex 32'),
  // 32-byte hex key for AES-256-GCM encryption of sensitive DB fields (AuthConfig secrets).
  // Generate with: openssl rand -hex 32
  ROOMER_ENCRYPTION_KEY: z.string()
    .regex(/^[0-9a-f]{64}$/, 'ROOMER_ENCRYPTION_KEY must be exactly 64 lowercase hex characters (32 bytes). Generate with: openssl rand -hex 32'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(3001),
  HOST: z.string().default('0.0.0.0'),
  // Must be an exact origin URL (no wildcards). Wildcards with credentials: true are rejected
  // by browsers but are still a misconfiguration risk.
  CORS_ORIGIN: z.string()
    .url('CORS_ORIGIN must be a valid URL (e.g. https://app.example.com)')
    .refine((v) => v !== '*', 'CORS_ORIGIN must not be a wildcard')
    .default('http://localhost:5173'),
  // Set to "true" to require the Secure flag on cookies. Should be "true" in any
  // environment served over HTTPS — including staging. Defaults to true in production.
  COOKIE_SECURE: z.string()
    .default(isProd ? 'true' : 'false')
    .transform((v) => v === 'true'),
  // Set to "true" only in production/staging behind a trusted reverse proxy.
  // When false, X-Forwarded-For headers are ignored (prevents rate-limit bypass).
  TRUST_PROXY: z.string()
    .default(isProd ? 'true' : 'false')
    .transform((v) => v === 'true'),
  // Set to "true" to allow Authorization: Bearer <token> in addition to cookies.
  // Disabled by default in production — opt-in only for programmatic API clients
  // that cannot use cookies (e.g. server-to-server, CI, mobile native apps).
  ALLOW_BEARER_AUTH: z.string()
    .default(isProd ? 'false' : 'true')
    .transform((v) => v === 'true'),
  // Set to "true" to expose the Swagger UI and OpenAPI schema endpoint.
  // Defaults to enabled in development/test and disabled in production.
  SWAGGER_ENABLED: z.string()
    .default(isProd ? 'false' : 'true')
    .transform((v) => v === 'true'),
  // Set to "true" to expose a Prometheus /metrics endpoint.
  // Disabled by default — enable in environments where a scraper is configured.
  // Protect this endpoint at the network/ingress level; it is unauthenticated.
  METRICS_ENABLED: z.string()
    .default('false')
    .transform((v) => v === 'true'),
  // Optional bearer token protecting the /metrics endpoint. When set, scrapers
  // must send `Authorization: Bearer <token>`. When unset, /metrics is
  // unauthenticated (protect at the network/ingress level).
  METRICS_TOKEN: z.string().optional(),
  // Allow webhook delivery to private/RFC1918 targets (internal integrations).
  // Defaults to false (SSRF-safe). Loopback and link-local remain blocked regardless.
  WEBHOOK_ALLOW_PRIVATE: z.string()
    .default('false')
    .transform((v) => v === 'true'),
  FILE_STORAGE_PATH: z.string().default('./uploads'),
  MAX_FILE_SIZE_MB: z.coerce.number().default(20),
  SMTP_HOST: z.string().default('localhost'),
  SMTP_PORT: z.coerce.number().default(1025),
  SMTP_SECURE: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  EMAIL_FROM: z.string().default('noreply@roomer.local'),
  APP_URL: z.string().default('http://localhost:5173'),
  // Public-facing base URL for the API itself (used for SCIM endpoint URLs shown in the admin UI).
  // Defaults to localhost in development; set to e.g. https://api.example.com in production.
  API_PUBLIC_URL: z.string().url().default('http://localhost:3001'),
  // ── Seed variables (used only at first-run / prisma db seed) ─────────────
  SEED_ADMIN_EMAIL: z.string().email().optional(),
  SEED_ADMIN_PASSWORD: z.string().optional(),
  SEED_USER_PASSWORD: z.string().optional(),
  SEED_DEMO_DATA: z.string().default('false').transform((v) => v === 'true'),
})

const parsed = envSchema.safeParse({
  DATABASE_URL:           r('DATABASE_URL'),
  SESSION_SECRET:         r('SESSION_SECRET'),
  ROOMER_ENCRYPTION_KEY:  process.env['ROOMER_ENCRYPTION_KEY'],
  NODE_ENV:               r('NODE_ENV'),
  PORT:                   r('PORT'),
  HOST:                   r('HOST'),
  CORS_ORIGIN:            r('CORS_ORIGIN'),
  COOKIE_SECURE:          r('COOKIE_SECURE'),
  TRUST_PROXY:            r('TRUST_PROXY'),
  ALLOW_BEARER_AUTH:      r('ALLOW_BEARER_AUTH'),
  SWAGGER_ENABLED:        r('SWAGGER_ENABLED'),
  METRICS_ENABLED:        r('METRICS_ENABLED'),
  METRICS_TOKEN:          r('METRICS_TOKEN'),
  WEBHOOK_ALLOW_PRIVATE:  r('WEBHOOK_ALLOW_PRIVATE'),
  FILE_STORAGE_PATH:      r('FILE_STORAGE_PATH'),
  MAX_FILE_SIZE_MB:       r('MAX_FILE_SIZE_MB'),
  SMTP_HOST:              r('SMTP_HOST'),
  SMTP_PORT:              r('SMTP_PORT'),
  SMTP_SECURE:            r('SMTP_SECURE'),
  SMTP_USER:              r('SMTP_USER'),
  SMTP_PASS:              r('SMTP_PASS'),
  EMAIL_FROM:             r('EMAIL_FROM'),
  APP_URL:                r('APP_URL'),
  API_PUBLIC_URL:         r('API_PUBLIC_URL'),
  SEED_ADMIN_EMAIL:       r('SEED_ADMIN_EMAIL'),
  SEED_ADMIN_PASSWORD:    r('SEED_ADMIN_PASSWORD'),
  SEED_USER_PASSWORD:     r('SEED_USER_PASSWORD'),
  SEED_DEMO_DATA:         r('SEED_DEMO_DATA'),
})

if (!parsed.success) {
  console.error('Invalid environment variables:')
  console.error(parsed.error.flatten().fieldErrors)
  process.exit(1)
}

export const env = parsed.data
