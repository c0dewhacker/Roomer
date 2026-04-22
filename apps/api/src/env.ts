import { z } from 'zod'

const envSchema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  // Minimum 32 characters. For maximum security use 64 hex characters (32 random bytes).
  // Generate with: openssl rand -hex 32
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters. Generate with: openssl rand -hex 32'),
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
    .default(process.env.NODE_ENV === 'production' ? 'true' : 'false')
    .transform((v) => v === 'true'),
  // Set to "true" only in production/staging behind a trusted reverse proxy.
  // When false, X-Forwarded-For headers are ignored (prevents rate-limit bypass).
  TRUST_PROXY: z.string()
    .default(process.env.NODE_ENV === 'production' ? 'true' : 'false')
    .transform((v) => v === 'true'),
  // Set to "true" to allow Authorization: Bearer <token> in addition to cookies.
  // Disabled by default in production — opt-in only for programmatic API clients
  // that cannot use cookies (e.g. server-to-server, CI, mobile native apps).
  ALLOW_BEARER_AUTH: z.string()
    .default(process.env.NODE_ENV === 'production' ? 'false' : 'true')
    .transform((v) => v === 'true'),
  // Set to "true" to expose the Swagger UI and OpenAPI schema endpoint.
  // Defaults to enabled in development/test and disabled in production.
  // Override with SWAGGER_ENABLED=true to enable in production (e.g. for internal tooling).
  SWAGGER_ENABLED: z.string()
    .default(process.env.NODE_ENV === 'production' ? 'false' : 'true')
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
})

const parsed = envSchema.safeParse(process.env)

if (!parsed.success) {
  console.error('Invalid environment variables:')
  console.error(parsed.error.flatten().fieldErrors)
  process.exit(1)
}

export const env = parsed.data
