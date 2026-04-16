import fs from 'fs'
import type { FastifyInstance } from 'fastify'
import { GlobalRole } from '@roomer/shared'
import { requireAuth } from '../middleware/requireAuth'
import { requireGlobalRole } from '../middleware/requireRole'
import { sendEmail } from '../lib/mailer'
import { env } from '../env'
import { prisma } from '../lib/prisma'
import { invalidateOidcCache } from '../lib/oidc'
import { saveBrandingImage, resolveStoragePath } from '../lib/storage'
import { z } from 'zod'

const ALLOWED_PROVIDERS = ['OIDC', 'SAML', 'LDAP'] as const
type ProviderKey = (typeof ALLOWED_PROVIDERS)[number]

const bannerSchema = z.object({
  enabled: z.boolean(),
  text: z.string().max(500),
  bgColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  textColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
})

const brandingSchema = z.object({
  appName: z.string().max(100).optional(),
  sidebarTitle: z.string().max(100).optional(),
  sidebarSubtitle: z.string().max(100).optional(),
  primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().nullable(),
  primaryColorDark: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().nullable(),
  borderRadius: z.enum(['sharp', 'medium', 'large']).optional().nullable(),
  headerBanner: bannerSchema.optional(),
  footerBanner: bannerSchema.optional(),
})

const updateOrgSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  defaultBookingDurationHours: z.number().int().min(1).max(24).optional(),
  maxAdvanceBookingDays: z.number().int().min(1).max(365).optional(),
  maxBookingsPerUser: z.number().int().min(1).max(100).optional(),
})

const groupMappingSchema = z.object({
  idpGroup: z.string().min(1),
  roomerGroupId: z.string().min(1),
})

const oidcConfigSchema = z.object({
  issuerUrl: z.string().url(),
  clientId: z.string().min(1),
  clientSecret: z.string().min(1).optional(),
  redirectUri: z.string().url().refine(
    (uri) => uri.startsWith(env.APP_URL),
    { message: 'redirectUri must originate from the application URL' },
  ),
  scope: z.string().optional(),
  label: z.string().optional(),
  groupsClaimName: z.string().optional(),
  groupMappings: z.array(groupMappingSchema).optional(),
})

const samlConfigSchema = z.object({
  entryPoint: z.string().url(),
  issuer: z.string().optional(),
  cert: z.string().min(1),
  callbackUrl: z.string().url(),
  signatureAlgorithm: z.enum(['sha1', 'sha256', 'sha512']).optional(),
  label: z.string().optional(),
  groupAttribute: z.string().optional(),
  groupMappings: z.array(groupMappingSchema).optional(),
  wantAuthnResponseSigned: z.boolean().optional(),
  wantAssertionsSigned: z.boolean().optional(),
  allowClockSkewMs: z.number().int().min(0).max(300000).optional(),
})

const ldapConfigSchema = z.object({
  url: z.string().min(1),
  bindDN: z.string().min(1),
  bindCredentials: z.string().min(1).optional(),
  searchBase: z.string().min(1),
  searchFilter: z.string().optional(),
  displayNameAttribute: z.string().optional(),
  emailAttribute: z.string().optional(),
  tlsEnabled: z.boolean().optional(),
  tlsRejectUnauthorized: z.boolean().optional(),
  groupAttribute: z.string().optional(),
  groupMappings: z.array(groupMappingSchema).optional(),
})

const configSchemas: Record<ProviderKey, z.ZodTypeAny> = {
  OIDC: oidcConfigSchema,
  SAML: samlConfigSchema,
  LDAP: ldapConfigSchema,
}

function redactSecrets(provider: ProviderKey, config: Record<string, unknown>): Record<string, unknown> {
  const redacted = { ...config }
  if (provider === 'OIDC' && redacted.clientSecret) redacted.clientSecret = '**redacted**'
  if (provider === 'LDAP' && redacted.bindCredentials) redacted.bindCredentials = '**redacted**'
  return redacted
}

export async function settingsRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.addHook('onRoute', (route) => { route.schema = { tags: ['Settings'], ...route.schema } })

  // GET /settings/organisation — return org settings
  fastify.get(
    '/organisation',
    { preHandler: [requireAuth, requireGlobalRole(GlobalRole.SUPER_ADMIN)] },
    async (_request, reply) => {
      const org = await prisma.organisation.findFirst()
      if (!org) {
        return reply.status(404).send({ error: { message: 'Organisation not found', code: 'NOT_FOUND' } })
      }
      return reply.status(200).send({ data: org })
    },
  )

  // PATCH /settings/organisation — update org settings
  fastify.patch(
    '/organisation',
    { preHandler: [requireAuth, requireGlobalRole(GlobalRole.SUPER_ADMIN)] },
    async (request, reply) => {
      const result = updateOrgSchema.safeParse(request.body)
      if (!result.success) {
        return reply.status(400).send({
          error: { message: 'Validation failed', code: 'VALIDATION_ERROR', details: result.error.flatten() },
        })
      }
      const org = await prisma.organisation.findFirst()
      if (!org) {
        return reply.status(404).send({ error: { message: 'Organisation not found', code: 'NOT_FOUND' } })
      }
      const updated = await prisma.organisation.update({ where: { id: org.id }, data: result.data })
      return reply.status(200).send({ data: updated })
    },
  )

  // POST /settings/test-email — send a test email to verify SMTP config
  fastify.post(
    '/test-email',
    { preHandler: [requireAuth, requireGlobalRole(GlobalRole.SUPER_ADMIN)] },
    async (request, reply) => {
      const recipient = request.user.email

      try {
        await sendEmail({
          to: recipient,
          subject: 'Roomer — Test Email',
          html: `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f4f4f5; margin: 0; padding: 20px; }
    .card { background: #fff; border-radius: 8px; max-width: 560px; margin: 0 auto; padding: 32px; }
    h1 { font-size: 22px; color: #18181b; margin-top: 0; }
    p { color: #52525b; line-height: 1.6; }
    .badge { display: inline-block; background: #dcfce7; color: #16a34a; border-radius: 4px; padding: 2px 8px; font-size: 13px; font-weight: 600; }
    .footer { text-align: center; color: #a1a1aa; font-size: 12px; margin-top: 24px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Test email</h1>
    <p><span class="badge">✓ Success</span></p>
    <p>Your SMTP configuration is working correctly. Roomer can send email notifications.</p>
    <p style="color:#71717a; font-size:13px;">
      Host: ${env.SMTP_HOST}:${env.SMTP_PORT}<br/>
      From: ${env.EMAIL_FROM}
    </p>
    <div class="footer">Roomer — Desk &amp; Asset Management</div>
  </div>
</body>
</html>`,
          text: `Roomer test email\n\nYour SMTP configuration is working correctly.\n\nHost: ${env.SMTP_HOST}:${env.SMTP_PORT}\nFrom: ${env.EMAIL_FROM}`,
        })

        return reply.status(200).send({
          data: { ok: true, message: `Test email sent to ${recipient}` },
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error'
        return reply.status(502).send({
          error: { message: `Failed to send email: ${message}`, code: 'SMTP_ERROR' },
        })
      }
    },
  )

  // GET /settings/branding — public (needed for login page theming)
  fastify.get('/branding', async (_request, reply) => {
    const org = await prisma.organisation.findFirst({ select: { branding: true } })
    return reply.status(200).send({ data: (org?.branding ?? {}) as object })
  })

  // PATCH /settings/branding — update branding config (SUPER_ADMIN)
  fastify.patch(
    '/branding',
    { preHandler: [requireAuth, requireGlobalRole(GlobalRole.SUPER_ADMIN)] },
    async (request, reply) => {
      const result = brandingSchema.safeParse(request.body)
      if (!result.success) {
        return reply.status(400).send({
          error: { message: 'Validation failed', code: 'VALIDATION_ERROR', details: result.error.flatten() },
        })
      }
      const org = await prisma.organisation.findFirst()
      if (!org) {
        return reply.status(404).send({ error: { message: 'Organisation not found', code: 'NOT_FOUND' } })
      }
      const current = (org.branding ?? {}) as Record<string, unknown>
      const merged = { ...current, ...result.data }
      const updated = await prisma.organisation.update({ where: { id: org.id }, data: { branding: merged } })
      return reply.status(200).send({ data: updated.branding })
    },
  )

  // POST /settings/branding/logo — upload logo image (SUPER_ADMIN)
  fastify.post(
    '/branding/logo',
    { preHandler: [requireAuth, requireGlobalRole(GlobalRole.SUPER_ADMIN)] },
    async (request, reply) => {
      const file = await request.file()
      if (!file) {
        return reply.status(400).send({ error: { message: 'No file uploaded', code: 'NO_FILE' } })
      }
      const relPath = await saveBrandingImage(file, 'logo')
      const org = await prisma.organisation.findFirst()
      if (!org) {
        return reply.status(404).send({ error: { message: 'Organisation not found', code: 'NOT_FOUND' } })
      }
      const current = (org.branding ?? {}) as Record<string, unknown>
      await prisma.organisation.update({ where: { id: org.id }, data: { branding: { ...current, logoPath: relPath } } })
      return reply.status(200).send({ data: { logoPath: relPath } })
    },
  )

  // POST /settings/branding/favicon — upload favicon image (SUPER_ADMIN)
  fastify.post(
    '/branding/favicon',
    { preHandler: [requireAuth, requireGlobalRole(GlobalRole.SUPER_ADMIN)] },
    async (request, reply) => {
      const file = await request.file()
      if (!file) {
        return reply.status(400).send({ error: { message: 'No file uploaded', code: 'NO_FILE' } })
      }
      const relPath = await saveBrandingImage(file, 'favicon')
      const org = await prisma.organisation.findFirst()
      if (!org) {
        return reply.status(404).send({ error: { message: 'Organisation not found', code: 'NOT_FOUND' } })
      }
      const current = (org.branding ?? {}) as Record<string, unknown>
      await prisma.organisation.update({ where: { id: org.id }, data: { branding: { ...current, faviconPath: relPath } } })
      return reply.status(200).send({ data: { faviconPath: relPath } })
    },
  )

  // GET /settings/branding/logo/image — serve logo file (public)
  fastify.get('/branding/logo/image', async (_request, reply) => {
    const org = await prisma.organisation.findFirst({ select: { branding: true } })
    const branding = (org?.branding ?? {}) as Record<string, unknown>
    if (!branding.logoPath) {
      return reply.status(404).send({ error: { message: 'Logo not set', code: 'NOT_FOUND' } })
    }
    const absPath = resolveStoragePath(branding.logoPath as string)
    try {
      await fs.promises.access(absPath, fs.constants.R_OK)
    } catch {
      return reply.status(404).send({ error: { message: 'Logo file not found', code: 'FILE_NOT_FOUND' } })
    }
    reply.header('Content-Type', 'image/png')
    reply.header('Cache-Control', 'public, max-age=300')
    return reply.send(fs.createReadStream(absPath))
  })

  // GET /settings/branding/favicon/image — serve favicon file (public)
  fastify.get('/branding/favicon/image', async (_request, reply) => {
    const org = await prisma.organisation.findFirst({ select: { branding: true } })
    const branding = (org?.branding ?? {}) as Record<string, unknown>
    if (!branding.faviconPath) {
      return reply.status(404).send({ error: { message: 'Favicon not set', code: 'NOT_FOUND' } })
    }
    const absPath = resolveStoragePath(branding.faviconPath as string)
    try {
      await fs.promises.access(absPath, fs.constants.R_OK)
    } catch {
      return reply.status(404).send({ error: { message: 'Favicon file not found', code: 'FILE_NOT_FOUND' } })
    }
    reply.header('Content-Type', 'image/png')
    reply.header('Cache-Control', 'public, max-age=300')
    return reply.send(fs.createReadStream(absPath))
  })

  // GET /settings/auth-config — list all provider configs (secrets redacted)
  fastify.get(
    '/auth-config',
    { preHandler: [requireAuth, requireGlobalRole(GlobalRole.SUPER_ADMIN)] },
    async (_request, reply) => {
      const rows = await prisma.authConfig.findMany()
      const result: Record<string, unknown> = {}
      for (const row of rows) {
        result[row.provider] = {
          enabled: row.enabled,
          config: redactSecrets(row.provider as ProviderKey, row.config as Record<string, unknown>),
        }
      }
      return reply.status(200).send({ data: result })
    },
  )

  // PUT /settings/auth-config/:provider — upsert provider config
  fastify.put(
    '/auth-config/:provider',
    { preHandler: [requireAuth, requireGlobalRole(GlobalRole.SUPER_ADMIN)] },
    async (request, reply) => {
      const { provider } = request.params as { provider: string }
      const upperProvider = provider.toUpperCase() as ProviderKey

      if (!ALLOWED_PROVIDERS.includes(upperProvider)) {
        return reply.status(400).send({
          error: { message: `Unknown provider: ${provider}`, code: 'VALIDATION_ERROR' },
        })
      }

      const body = request.body as { enabled?: boolean; config?: Record<string, unknown> }
      const schema = configSchemas[upperProvider]

      let mergedConfig: Record<string, unknown> = {}

      if (body.config) {
        // Merge with existing config to support partial updates (keep secrets if not provided)
        const existing = await prisma.authConfig.findUnique({ where: { provider: upperProvider } })
        const existingConfig = (existing?.config ?? {}) as Record<string, unknown>
        mergedConfig = { ...existingConfig }

        // Validate only the provided fields (partial validation)
        const parsed = (schema as z.ZodObject<z.ZodRawShape>).partial().safeParse(body.config)
        if (!parsed.success) {
          return reply.status(400).send({
            error: { message: 'Invalid config', code: 'VALIDATION_ERROR', details: parsed.error.flatten() },
          })
        }

        // Apply provided values; skip null/undefined secrets (means "keep existing")
        for (const [key, val] of Object.entries(body.config)) {
          if (val !== null && val !== undefined && val !== '') {
            mergedConfig[key] = val
          }
        }
      }

      const row = await prisma.authConfig.upsert({
        where: { provider: upperProvider },
        update: {
          ...(typeof body.enabled === 'boolean' ? { enabled: body.enabled } : {}),
          ...(body.config ? { config: mergedConfig as Record<string, string> } : {}),
        },
        create: {
          provider: upperProvider,
          enabled: body.enabled ?? false,
          config: mergedConfig as Record<string, string>,
        },
      })

      // Invalidate OIDC client cache when OIDC config changes
      if (upperProvider === 'OIDC') invalidateOidcCache()

      return reply.status(200).send({
        data: {
          provider: row.provider,
          enabled: row.enabled,
          config: redactSecrets(upperProvider, row.config as Record<string, unknown>),
        },
      })
    },
  )
}
