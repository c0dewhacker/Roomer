import fs from 'fs'
import type { FastifyInstance } from 'fastify'
import { GlobalRole, QrCheckInMode } from '@roomer/shared'
import { requireAuth } from '../middleware/requireAuth.js'
import { requireGlobalRole } from '../middleware/requireRole.js'
import { env } from '../env.js'
import { prisma } from '../lib/prisma.js'
import { Prisma } from '@prisma/client'
import { invalidateOidcCache } from '../lib/oidc.js'
import { syncLdapUsers, getLdapConfig } from '../lib/ldap.js'
import { hashScimToken, generateScimToken } from '../lib/scim-helpers.js'
import { findAuthConfig, listAuthConfigs, upsertAuthConfig } from '../lib/prisma.js'
import { idpGroupMatchesAny } from '../lib/group-mapping.js'
import { saveBrandingImage, resolveStoragePath, deleteFile } from '../lib/storage.js'
import { DEFAULT_TEMPLATE_STRINGS, interpolateTemplate, stripHtmlToText, formatDate, sendEmail, resetMailer } from '../lib/mailer.js'
import { encrypt } from '../lib/encryption.js'
import { ENV_SMTP_OVERRIDES, getStoredEmailConfig, getEffectiveSmtpForDisplay, type StoredEmailConfig } from '../lib/smtp-config.js'
import { recordAuditLog } from '../lib/audit.js'
import { z } from 'zod'

// Distinct from lib/booking.ts's lock classes (4242-4245) and
// lib/group-mapping.ts's SUPER_ADMIN_GUARD_LOCK_CLASS (4246).
const ORG_SETTINGS_LOCK_CLASS = 4247

/**
 * Every settings route that mutates a JSON column on the single Organisation
 * row (branding, emailConfig, emailTemplates) or an AuthConfig row follows a
 * read → merge in JS → write-the-whole-blob-back pattern with no
 * transaction, version check, or lock — two concurrent admin edits (e.g. one
 * uploading a logo while another edits branding colours, or two edits to the
 * same auth provider) silently lose one of the two updates, since the second
 * writer's update() replaces the whole column based on a stale in-memory
 * read. One fixed-key lock for all of it is enough — these are rare,
 * sequential, admin-only actions; there's no meaningful concurrency to
 * preserve between e.g. a branding edit and an auth-config edit, only a race
 * to close.
 */
async function lockOrgSettings(tx: Prisma.TransactionClient): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ORG_SETTINGS_LOCK_CLASS})`
}

const emailConfigSchema = z.object({
  host: z.string().max(255).optional(),
  port: z.coerce.number().int().min(1).max(65535).optional(),
  secure: z.boolean().optional(),
  user: z.string().max(255).optional(),
  from: z.string().max(320).optional(),
  // Omit/blank = keep existing stored password; a value sets a new one.
  password: z.string().max(1024).optional(),
})

const ALLOWED_PROVIDERS = ['OIDC', 'SAML', 'LDAP'] as const
type ProviderKey = (typeof ALLOWED_PROVIDERS)[number]

const bannerSchema = z.object({
  enabled: z.boolean(),
  text: z.string().max(500),
  bgColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  textColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
})

const brandingSchema = z.object({
  // Nullable, not just optional: the admin form sends null (not omits the
  // field) when clearing a text field back to its default — omitting it
  // entirely, as a plain .optional() would require, gets dropped by
  // JSON.stringify before the request even leaves the browser, so a
  // "cleared" field silently kept whatever value was already saved (same
  // gap already fixed for lease endDate).
  appName: z.string().max(100).nullable().optional(),
  sidebarTitle: z.string().max(100).nullable().optional(),
  sidebarSubtitle: z.string().max(100).nullable().optional(),
  primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().nullable(),
  primaryColorDark: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().nullable(),
  borderRadius: z.enum(['sharp', 'medium', 'large']).optional().nullable(),
  navStyle: z.enum(['sidebar', 'topbar', 'floating', 'rail']).optional().nullable(),
  headerBanner: bannerSchema.optional(),
  footerBanner: bannerSchema.optional(),
})

const loginSettingsSchema = z.object({
  defaultProvider: z.enum(['local', 'ldap', 'oidc', 'saml']).nullable().optional(),
  showProviderSelector: z.boolean().optional(),
})

const ALLOWED_DATE_FORMATS = [
  'dd/MM/yyyy', 'dd-MM-yyyy', 'dd.MM.yyyy',
  'MM/dd/yyyy', 'yyyy-MM-dd', 'd MMM yyyy', 'MMMM d, yyyy',
] as const

const updateOrgSchema = z.object({
  // .trim() before .min(1) — see schemas/department.ts for why.
  name: z.string().trim().min(1).max(255).optional(),
  defaultBookingDurationHours: z.number().int().min(1).max(24).optional(),
  maxAdvanceBookingDays: z.number().int().min(1).max(365).optional(),
  maxBookingsPerUser: z.number().int().min(1).max(100).optional(),
  queueClaimWindowHours: z.number().int().min(1).max(48).optional(),
  dateFormat: z.enum(ALLOWED_DATE_FORMATS).optional(),
  // Check-in / no-show release (global default; buildings & floors can override).
  noShowReleaseEnabled: z.boolean().optional(),
  checkInGraceMinutes: z.number().int().min(5).max(240).optional(),
  // QR desk check-in (global default; buildings & floors can override).
  qrCheckInMode: z.nativeEnum(QrCheckInMode).optional(),
  weeklyReportEnabled: z.boolean().optional(),
  // Booking approval workflow (global default; buildings & zones can
  // override — see #74). Zone is the most granular override level, unlike
  // noShowReleaseEnabled/qrCheckInMode which stop at floor.
  requiresApproval: z.boolean().optional(),
  approvalWindowHours: z.number().int().min(1).max(168).optional(),
  // Org-wide fallback timezone + working hours (buildings can override —
  // see #72). enforceWorkingHours is a single org-wide on/off switch: the
  // hours themselves can be configured ahead of actually enforcing them.
  // 'UTC' is a valid, functional Intl/date-fns-tz timezone identifier (the
  // Organisation schema's own default, and every fallback throughout this
  // codebase) but Intl.supportedValuesOf('timeZone') only enumerates
  // canonical IANA "Zone" entries, not the "UTC" link — it's absent from
  // that list even though `new Intl.DateTimeFormat('en', { timeZone: 'UTC'
  // })` works fine. Without the explicit allowance, saving ANY org setting
  // 400'd the moment the form round-tripped the untouched default back.
  defaultTimezone: z.string().refine((v) => v === 'UTC' || Intl.supportedValuesOf('timeZone').includes(v), 'Not a recognised IANA timezone').optional(),
  workingHoursStart: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  workingHoursEnd: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  enforceWorkingHours: z.boolean().optional(),
  // Weighted-ballot priority (see #270) — off by default, purely additive to
  // the existing uniform-random draw when disabled.
  ballotWeightingEnabled: z.boolean().optional(),
  ballotWeightIncrement: z.number().min(0).max(5).optional(),
  ballotWeightCapStreak: z.number().int().min(1).max(50).optional(),
  ballotWeightScope: z.enum(['PER_BALLOT', 'GLOBAL']).optional(),
})

// The "Direct role" grant option in GroupMappingsEditor sends
// roomerGroupId/targetGlobalRole as empty strings for whichever field isn't
// the active mode (see updateGrant in GroupMappingsEditor.tsx), not omitted —
// z.string().min(1).optional() rejects '' the same as it would reject a
// missing field, so every "Direct role → Super Admin/Standard user" mapping
// (a fully-built, advertised UI option) failed to save with a 400. The
// runtime GroupMapping type (lib/group-mapping.ts) already treats both
// fields as optional and truthy-checks them, so '' → undefined here matches
// how they're actually consumed.
const emptyToUndefined = (v: unknown) => (v === '' ? undefined : v)

const groupMappingSchema = z.object({
  idpGroup: z.string().min(1),
  roomerGroupId: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  targetGlobalRole: z.preprocess(emptyToUndefined, z.enum(['SUPER_ADMIN', 'USER']).optional()),
}).refine(
  (m) => !!m.roomerGroupId || !!m.targetGlobalRole,
  { message: 'Each mapping must grant either a Roomer group or a direct role' },
)

const oidcConfigSchema = z.object({
  issuerUrl: z.string().url(),
  clientId: z.string().min(1),
  // Required here (not .optional()) so a config that's never had a secret set
  // fails the merged-config and enable-time schema checks below — the OIDC
  // client builder (lib/oidc.ts) already hard-requires it at runtime, so an
  // "enabled" provider with none silently 302s every real login attempt to
  // "oidc_not_configured" with no signal to the admin who enabled it. This
  // stays compatible with "leave blank to keep existing on update": the
  // merge logic below carries the prior encrypted value forward into
  // mergedConfig whenever the request doesn't resend clientSecret, so this
  // only actually fires when no secret has ever been set for the provider.
  clientSecret: z.string().min(1),
  redirectUri: z.string().url().refine(
    (uri) => uri.startsWith(env.APP_URL),
    { message: 'redirectUri must originate from the application URL' },
  ),
  scope: z.string().optional(),
  label: z.string().optional(),
  groupsClaimName: z.string().optional(),
  // nullish (not just optional) so the UI can explicitly clear a
  // previously-set mapping — see the merge logic below (null → delete the
  // key, '' → skip, matching ldapConfigSchema's syncBase/syncFilter, the
  // one pair that already got this right).
  departmentClaimName: z.string().nullish(),
  managerClaimName: z.string().nullish(),
  groupMappings: z.array(groupMappingSchema).optional(),
})

const samlConfigSchema = z.object({
  entryPoint: z.string().url(),
  issuer: z.string().optional(),
  cert: z.string().min(1),
  callbackUrl: z.string().url(),
  signatureAlgorithm: z.enum(['sha256', 'sha512']).optional(),
  label: z.string().optional(),
  groupAttribute: z.string().optional(),
  groupMappings: z.array(groupMappingSchema).optional(),
  // nullish so the UI can explicitly clear a previously-set mapping — same
  // fix as oidcConfigSchema's departmentClaimName/managerClaimName above.
  departmentAttribute: z.string().nullish(),
  managerAttribute: z.string().nullish(),
  // Refuse to disable signature verification in production — disabling either flag
  // turns SAML into an unauthenticated identity assertion (signature-stripping attack).
  wantAuthnResponseSigned: z.boolean()
    .refine((v) => env.NODE_ENV !== 'production' || v !== false, {
      message: 'SAML response signing cannot be disabled in production',
    })
    .optional(),
  wantAssertionsSigned: z.boolean()
    .refine((v) => env.NODE_ENV !== 'production' || v !== false, {
      message: 'SAML assertion signing cannot be disabled in production',
    })
    .optional(),
  allowClockSkewMs: z.number().int().min(0).max(300000).optional(),
})

const ldapConfigSchema = z.object({
  url: z.string().regex(/^ldaps?:\/\//, 'Must be a valid LDAP URL (ldap:// or ldaps://)'),
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
  // nullish so the UI can explicitly clear a previously-set mapping — same
  // fix as oidcConfigSchema/samlConfigSchema's department/manager fields.
  managerAttribute: z.string().nullish(),
  // Directory sync settings — nullish so the UI can explicitly clear them
  syncBase: z.string().nullish(),
  syncFilter: z.string().nullish(),
  syncScope: z.enum(['sub', 'one']).optional(),
  deactivateMissing: z.boolean().optional(),
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

async function serveUploadedFile(
  reply: import('fastify').FastifyReply,
  relativePath: string,
  notFoundMessage: string,
): Promise<void> {
  const absPath = resolveStoragePath(relativePath)
  try {
    await fs.promises.access(absPath, fs.constants.R_OK)
  } catch {
    reply.status(404).send({ error: { message: notFoundMessage, code: 'FILE_NOT_FOUND' } })
    return
  }
  reply.header('Content-Type', 'image/png')
  reply.header('Cache-Control', 'public, max-age=300')
  reply.send(fs.createReadStream(absPath))
}

export async function settingsRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.addHook('onRoute', (route) => { route.schema = { tags: ['Settings'], ...route.schema } })

  // Deliberately excludes emailConfig (host/port/user/from + the SMTP
  // password — encrypted, but legacy rows written before encryption-at-rest
  // was introduced can hold it in the clear per lib/encryption.ts) — GET
  // /settings/email already exists specifically to expose SMTP settings to
  // the admin UI and is careful to redact the password down to a
  // `hasPassword` boolean. Returning the full org row here shipped that
  // field (ciphertext, or a legacy plaintext password) to any SUPER_ADMIN
  // response body for no reason — the org-settings form only ever reads the
  // fields selected below (see OrgSettingsCard.tsx/DeskPanel.tsx).
  const orgSettingsSelect = {
    id: true,
    name: true,
    slug: true,
    defaultBookingDurationHours: true,
    maxAdvanceBookingDays: true,
    maxBookingsPerUser: true,
    queueClaimWindowHours: true,
    dateFormat: true,
    emailTemplates: true,
    branding: true,
    bookingReminderHours: true,
    maxRecurringBookingWeeks: true,
    noShowReleaseEnabled: true,
    checkInGraceMinutes: true,
    qrCheckInMode: true,
    weeklyReportEnabled: true,
    requiresApproval: true,
    approvalWindowHours: true,
    defaultTimezone: true,
    workingHoursStart: true,
    workingHoursEnd: true,
    enforceWorkingHours: true,
    ballotWeightingEnabled: true,
    ballotWeightIncrement: true,
    ballotWeightCapStreak: true,
    ballotWeightScope: true,
    createdAt: true,
    updatedAt: true,
  } satisfies Prisma.OrganisationSelect

  // GET /settings/organisation — return org settings
  fastify.get(
    '/organisation',
    { preHandler: [requireAuth, requireGlobalRole(GlobalRole.SUPER_ADMIN)] },
    async (_request, reply) => {
      const org = await prisma.organisation.findFirst({ select: orgSettingsSelect })
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
      const org = await prisma.organisation.findFirst({ select: orgSettingsSelect })
      if (!org) {
        return reply.status(404).send({ error: { message: 'Organisation not found', code: 'NOT_FOUND' } })
      }
      const updated = await prisma.organisation.update({ where: { id: org.id }, data: result.data, select: orgSettingsSelect })
      await recordAuditLog(prisma, {
        actorId: request.user.id,
        action: 'organisation_settings.updated',
        resourceType: 'Organisation',
        resourceId: org.id,
        before: org,
        after: updated,
        ipAddress: request.ip,
      }, request.log)
      return reply.status(200).send({ data: updated })
    },
  )

  // GET /settings/email — SMTP settings for the admin UI.
  // Returns the stored (editable) values, which fields are env-locked, and the
  // effective (env-wins) values for display.
  fastify.get(
    '/email',
    { preHandler: [requireAuth, requireGlobalRole(GlobalRole.SUPER_ADMIN)] },
    async (_request, reply) => {
      const stored = await getStoredEmailConfig()
      const effective = await getEffectiveSmtpForDisplay()
      return reply.status(200).send({
        data: {
          host: stored.host ?? '',
          port: stored.port ?? null,
          secure: stored.secure ?? false,
          user: stored.user ?? '',
          from: stored.from ?? '',
          hasPassword: !!stored.password,
          envOverrides: ENV_SMTP_OVERRIDES,
          effective, // { host, port, secure, user, from } — what is actually used
        },
      })
    },
  )

  // PUT /settings/email — update the stored SMTP settings (env vars still override).
  fastify.put(
    '/email',
    { preHandler: [requireAuth, requireGlobalRole(GlobalRole.SUPER_ADMIN)] },
    async (request, reply) => {
      const result = emailConfigSchema.safeParse(request.body)
      if (!result.success) {
        return reply.status(400).send({ error: { message: 'Validation failed', code: 'VALIDATION_ERROR', details: result.error.flatten() } })
      }
      const { password, ...rest } = result.data
      const next = await prisma.$transaction(async (tx) => {
        await lockOrgSettings(tx)
        const org = await tx.organisation.findFirst()
        if (!org) throw Object.assign(new Error('NOT_FOUND'), { code: 'NOT_FOUND' })
        const existing = (org.emailConfig ?? {}) as StoredEmailConfig
        const merged: StoredEmailConfig = {
          ...existing,
          host: rest.host ?? undefined,
          port: rest.port ?? undefined,
          secure: rest.secure ?? undefined,
          user: rest.user ?? undefined,
          from: rest.from ?? undefined,
          // Keep the existing encrypted password unless a new non-empty one is provided.
          password: password ? encrypt(password) : existing.password,
        }
        await tx.organisation.update({ where: { id: org.id }, data: { emailConfig: merged as Prisma.InputJsonValue } })
        // Password (even encrypted) is never logged — only whether it changed.
        await recordAuditLog(tx, {
          actorId: request.user.id,
          action: 'email_config.updated',
          resourceType: 'Organisation',
          resourceId: org.id,
          before: { host: existing.host, port: existing.port, secure: existing.secure, user: existing.user, from: existing.from },
          after: { host: merged.host, port: merged.port, secure: merged.secure, user: merged.user, from: merged.from, passwordChanged: !!password },
          ipAddress: request.ip,
        }, request.log)
        return merged
      }).catch((err: unknown) => {
        if ((err as { code?: string })?.code === 'NOT_FOUND') return null
        throw err
      })
      if (!next) return reply.status(404).send({ error: { message: 'Organisation not found', code: 'NOT_FOUND' } })
      resetMailer() // re-resolve transporter on next send

      const effective = await getEffectiveSmtpForDisplay()
      return reply.status(200).send({
        data: {
          host: next.host ?? '', port: next.port ?? null, secure: next.secure ?? false,
          user: next.user ?? '', from: next.from ?? '', hasPassword: !!next.password,
          envOverrides: ENV_SMTP_OVERRIDES, effective,
        },
      })
    },
  )

  // POST /settings/test-email — send a test email to verify SMTP config
  fastify.post(
    '/test-email',
    { preHandler: [requireAuth, requireGlobalRole(GlobalRole.SUPER_ADMIN)] },
    async (request, reply) => {
      const recipient = request.user.email
      const smtp = await getEffectiveSmtpForDisplay()

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
      Host: ${smtp.host}:${smtp.port}<br/>
      From: ${smtp.from}
    </p>
    <div class="footer">Roomer — Desk &amp; Asset Management</div>
  </div>
</body>
</html>`,
          text: `Roomer test email\n\nYour SMTP configuration is working correctly.\n\nHost: ${smtp.host}:${smtp.port}\nFrom: ${smtp.from}`,
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

  // GET /settings/public — public non-sensitive settings (dateFormat etc.)
  //
  // maxAdvanceBookingDays lives here too: booking UI (DeskPanel, FloorPage)
  // needs it to compute date-picker bounds for every user, not just admins,
  // but GET /organisation above is SUPER_ADMIN-gated. Before this, those
  // components queried the admin endpoint, got a silent 403 for every
  // non-admin user, and fell back to a hardcoded default that only happened
  // to match reality when the org hadn't changed it from 14.
  fastify.get('/public', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (_request, reply) => {
    const org = await prisma.organisation.findFirst({
      select: { dateFormat: true, maxAdvanceBookingDays: true, maxRecurringBookingWeeks: true },
    })
    return reply.status(200).send({
      data: {
        dateFormat: org?.dateFormat ?? 'dd/MM/yyyy',
        maxAdvanceBookingDays: org?.maxAdvanceBookingDays ?? 14,
        // Same reasoning as maxAdvanceBookingDays above — the recurring-
        // booking creation form needs this to bound its "repeat until"
        // picker for every user, not just admins, and the default here must
        // match recurring.ts's own ?? 12 fallback exactly.
        maxRecurringBookingWeeks: org?.maxRecurringBookingWeeks ?? 12,
      },
    })
  })

  // GET /settings/branding — public (needed for login page theming)
  fastify.get('/branding', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (_request, reply) => {
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
      const merged = await prisma.$transaction(async (tx) => {
        await lockOrgSettings(tx)
        const org = await tx.organisation.findFirst()
        if (!org) return null
        const current = (org.branding ?? {}) as Record<string, unknown>
        const next = { ...current, ...result.data }
        const updated = await tx.organisation.update({ where: { id: org.id }, data: { branding: next } })
        await recordAuditLog(tx, {
          actorId: request.user.id,
          action: 'branding.updated',
          resourceType: 'Organisation',
          resourceId: org.id,
          before: current as Prisma.InputJsonValue,
          after: next as Prisma.InputJsonValue,
          ipAddress: request.ip,
        }, request.log)
        return updated.branding
      })
      if (!merged) {
        return reply.status(404).send({ error: { message: 'Organisation not found', code: 'NOT_FOUND' } })
      }
      return reply.status(200).send({ data: merged })
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
      // The file save (disk I/O) stays outside the transaction below — only
      // the read-merge-write of the branding JSON column needs the lock.
      const relPath = await saveBrandingImage(file, 'logo')
      let previousLogoPath: string | undefined
      try {
        previousLogoPath = await prisma.$transaction(async (tx) => {
          await lockOrgSettings(tx)
          const org = await tx.organisation.findFirst()
          if (!org) throw Object.assign(new Error('NOT_FOUND'), { code: 'NOT_FOUND' })
          const current = (org.branding ?? {}) as Record<string, unknown>
          const prev = current.logoPath as string | undefined
          await tx.organisation.update({ where: { id: org.id }, data: { branding: { ...current, logoPath: relPath } } })
          await recordAuditLog(tx, {
            actorId: request.user.id,
            action: 'branding.logo_uploaded',
            resourceType: 'Organisation',
            resourceId: org.id,
            ipAddress: request.ip,
          }, request.log)
          return prev
        })
      } catch (err) {
        await deleteFile(relPath).catch(() => {}) // don't leave an orphaned upload if the org row vanished mid-request
        if ((err as { code?: string })?.code === 'NOT_FOUND') {
          return reply.status(404).send({ error: { message: 'Organisation not found', code: 'NOT_FOUND' } })
        }
        throw err
      }
      // Now a genuinely different path each upload (see saveBrandingImage),
      // so it's safe to clean up the old one — unlike the fixed-path
      // category-icon case, this never targets the file just written.
      if (previousLogoPath && previousLogoPath !== relPath) await deleteFile(previousLogoPath).catch(() => {})
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
      let previousFaviconPath: string | undefined
      try {
        previousFaviconPath = await prisma.$transaction(async (tx) => {
          await lockOrgSettings(tx)
          const org = await tx.organisation.findFirst()
          if (!org) throw Object.assign(new Error('NOT_FOUND'), { code: 'NOT_FOUND' })
          const current = (org.branding ?? {}) as Record<string, unknown>
          const prev = current.faviconPath as string | undefined
          await tx.organisation.update({ where: { id: org.id }, data: { branding: { ...current, faviconPath: relPath } } })
          await recordAuditLog(tx, {
            actorId: request.user.id,
            action: 'branding.favicon_uploaded',
            resourceType: 'Organisation',
            resourceId: org.id,
            ipAddress: request.ip,
          }, request.log)
          return prev
        })
      } catch (err) {
        await deleteFile(relPath).catch(() => {})
        if ((err as { code?: string })?.code === 'NOT_FOUND') {
          return reply.status(404).send({ error: { message: 'Organisation not found', code: 'NOT_FOUND' } })
        }
        throw err
      }
      if (previousFaviconPath && previousFaviconPath !== relPath) await deleteFile(previousFaviconPath).catch(() => {})
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
    return serveUploadedFile(reply, branding.logoPath as string, 'Logo file not found')
  })

  // GET /settings/branding/favicon/image — serve favicon file (public)
  fastify.get('/branding/favicon/image', async (_request, reply) => {
    const org = await prisma.organisation.findFirst({ select: { branding: true } })
    const branding = (org?.branding ?? {}) as Record<string, unknown>
    if (!branding.faviconPath) {
      return reply.status(404).send({ error: { message: 'Favicon not set', code: 'NOT_FOUND' } })
    }
    return serveUploadedFile(reply, branding.faviconPath as string, 'Favicon file not found')
  })

  // GET /settings/auth-config — list all provider configs (secrets redacted)
  fastify.get(
    '/auth-config',
    { preHandler: [requireAuth, requireGlobalRole(GlobalRole.SUPER_ADMIN)], config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (_request, reply) => {
      const rows = await listAuthConfigs()
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
    { preHandler: [requireAuth, requireGlobalRole(GlobalRole.SUPER_ADMIN)], config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
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

      // The read (existing config, for merging or the enable-completeness
      // check) and the write must all happen under the same lock, in the same
      // transaction — reading outside a transaction like this route
      // previously did meant two concurrent PUTs to the *same* provider (e.g.
      // one setting clientId, another rotating clientSecret moments later)
      // could each merge onto the same stale snapshot and the second upsert
      // would silently discard the first one's change.
      type AuthConfigWriteResult = { provider: string; enabled: boolean; config: unknown }
      type AuthConfigResult =
        | { ok: true; row: AuthConfigWriteResult }
        | { ok: false; status: number; body: { error: { message: string; code: string; details?: unknown } } }

      const result: AuthConfigResult = await prisma.$transaction(async (tx) => {
        await lockOrgSettings(tx) // AuthConfig is a separate model from Organisation, but sharing one lock class keeps this simple — see lockOrgSettings.

        // Fetched once, up front, purely for the audit "before" snapshot below
        // — redacted the same way the GET endpoint redacts secrets, so an
        // OIDC clientSecret/LDAP bindCredentials never lands in the audit log
        // even encrypted (defeats the whole point of encrypting it at rest).
        const beforeRow = await findAuthConfig(upperProvider, tx)
        const beforeRedacted = redactSecrets(upperProvider, (beforeRow?.config ?? {}) as Record<string, unknown>)

        let mergedConfig: Record<string, unknown> = {}

        if (body.config) {
          // Merge with existing config to support partial updates (keep secrets if not provided)
          const existing = beforeRow
          const existingConfig = (existing?.config ?? {}) as Record<string, unknown>
          mergedConfig = { ...existingConfig }

          // Validate only the provided fields (partial validation)
          const parsed = (schema as z.ZodObject<z.ZodRawShape>).partial().safeParse(body.config)
          if (!parsed.success) {
            return { ok: false, status: 400, body: { error: { message: 'Invalid config', code: 'VALIDATION_ERROR', details: parsed.error.flatten() } } }
          }

          // Apply provided values:
          //   null   → explicitly clear the field (e.g. unsetting syncBase)
          //   ''     → skip (secrets omit their value rather than send empty)
          //   other  → set the value
          // bindCredentials (LDAP) and clientSecret (OIDC) are encrypted at rest,
          // same as the SMTP password and webhook signing secrets — only when a
          // *new* value is submitted this request. Values merely carried over
          // from existingConfig are already an enc:v1: envelope (or, for rows
          // written before this fix, legacy plaintext handled transparently by
          // decryptStringMaybe at read time) and must not be re-encrypted here.
          const secretFieldsByProvider: Partial<Record<ProviderKey, string>> = {
            LDAP: 'bindCredentials',
            OIDC: 'clientSecret',
          }
          const secretField = secretFieldsByProvider[upperProvider]
          for (const [key, val] of Object.entries(body.config)) {
            if (val === null) {
              delete mergedConfig[key]
            } else if (val !== undefined && val !== '') {
              mergedConfig[key] = key === secretField ? encrypt(String(val)) : val
            }
          }

          // Validate merged result against the full (non-partial) schema. Using
          // .partial() here (as before) meant a request that only sets a few
          // fields — e.g. a first-ever OIDC config with issuerUrl but no
          // clientId/redirectUri — passed both checks and got persisted
          // (optionally enabled) as an unusable half-configured provider,
          // failing only much later and cryptically at actual login time.
          const mergedParsed = schema.safeParse(mergedConfig)
          if (!mergedParsed.success) {
            return { ok: false, status: 400, body: { error: { message: 'Merged config is invalid', code: 'VALIDATION_ERROR', details: mergedParsed.error.flatten() } } }
          }
        }

        // Enabling a provider must never succeed unless a complete, schema-valid
        // config backs it — including via a bare {enabled:true} toggle with no
        // config in this same request (the "Enable" switch sends exactly that).
        // When body.config was provided above, mergedConfig is already
        // guaranteed valid by the full-schema check above; this only does real
        // work for the toggle-only path, which previously bypassed that check
        // entirely and could flip on a provider with an empty or partial
        // config — for OIDC/SAML, that hides the local login form (see
        // LoginPage's showCredentialForm) with no way back in except a small
        // "sign in with a local account" link.
        if (body.enabled === true && !body.config) {
          const enableCheck = schema.safeParse(beforeRow?.config ?? {})
          if (!enableCheck.success) {
            return {
              ok: false, status: 400,
              body: { error: { message: 'Cannot enable: provider configuration is incomplete', code: 'INCOMPLETE_CONFIG', details: enableCheck.error.flatten() } },
            }
          }
        }

        const row = await upsertAuthConfig(upperProvider, {
          enabled: body.enabled,
          config: body.config ? mergedConfig : undefined,
        }, tx)
        await recordAuditLog(tx, {
          actorId: request.user.id,
          action: 'auth_config.updated',
          resourceType: 'AuthConfig',
          resourceId: upperProvider,
          before: { enabled: beforeRow?.enabled ?? false, config: beforeRedacted } as Prisma.InputJsonValue,
          after: { enabled: row.enabled, config: redactSecrets(upperProvider, row.config as Record<string, unknown>) } as Prisma.InputJsonValue,
          ipAddress: request.ip,
        }, request.log)
        return { ok: true, row }
      })

      if (!result.ok) {
        return reply.status(result.status).send(result.body)
      }

      // Invalidate OIDC client cache when OIDC config changes
      if (upperProvider === 'OIDC') invalidateOidcCache()

      return reply.status(200).send({
        data: {
          provider: result.row.provider,
          enabled: result.row.enabled,
          config: redactSecrets(upperProvider, result.row.config as Record<string, unknown>),
        },
      })
    },
  )

  // PATCH /settings/login-settings — update login display preferences (SUPER_ADMIN)
  fastify.patch(
    '/login-settings',
    { preHandler: [requireAuth, requireGlobalRole(GlobalRole.SUPER_ADMIN)] },
    async (request, reply) => {
      const result = loginSettingsSchema.safeParse(request.body)
      if (!result.success) {
        return reply.status(400).send({
          error: { message: 'Validation failed', code: 'VALIDATION_ERROR', details: result.error.flatten() },
        })
      }
      const patch: Record<string, unknown> = {}
      if ('defaultProvider' in result.data) patch.defaultLoginProvider = result.data.defaultProvider
      if ('showProviderSelector' in result.data) patch.showLoginProviderSelector = result.data.showProviderSelector

      const org = await prisma.$transaction(async (tx) => {
        await lockOrgSettings(tx)
        const found = await tx.organisation.findFirst()
        if (!found) return null
        const current = (found.branding ?? {}) as Record<string, unknown>
        await tx.organisation.update({ where: { id: found.id }, data: { branding: { ...current, ...patch } as Record<string, string | boolean | null> } })
        await recordAuditLog(tx, {
          actorId: request.user.id,
          action: 'login_settings.updated',
          resourceType: 'Organisation',
          resourceId: found.id,
          before: { defaultLoginProvider: current.defaultLoginProvider ?? null, showLoginProviderSelector: current.showLoginProviderSelector ?? true } as Prisma.InputJsonValue,
          after: patch as Prisma.InputJsonValue,
          ipAddress: request.ip,
        }, request.log)
        return found
      })
      if (!org) {
        return reply.status(404).send({ error: { message: 'Organisation not found', code: 'NOT_FOUND' } })
      }
      return reply.status(200).send({ data: { ok: true } })
    },
  )

  // POST /settings/auth-config/ldap/sync — run LDAP directory sync (SUPER_ADMIN)
  fastify.post(
    '/auth-config/ldap/sync',
    { preHandler: [requireAuth, requireGlobalRole(GlobalRole.SUPER_ADMIN)] },
    async (request, reply) => {
      const cfg = await getLdapConfig()
      if (!cfg) {
        return reply.status(400).send({ error: { message: 'LDAP is not configured or not enabled', code: 'LDAP_NOT_CONFIGURED' } })
      }
      try {
        const result = await syncLdapUsers(cfg)
        // One summary row for the whole sync, not one per synced user — a
        // single run can touch the entire directory.
        await recordAuditLog(prisma, {
          actorId: request.user.id,
          action: 'ldap_sync.triggered',
          resourceType: 'AuthConfig',
          resourceId: 'LDAP',
          after: result as unknown as Prisma.InputJsonValue,
          ipAddress: request.ip,
        }, request.log)
        return reply.status(200).send({ data: result })
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error'
        if (message === 'LDAP_SYNC_IN_PROGRESS') {
          return reply.status(409).send({ error: { message: 'A directory sync is already in progress', code: 'LDAP_SYNC_IN_PROGRESS' } })
        }
        return reply.status(502).send({ error: { message: `LDAP sync failed: ${message}`, code: 'LDAP_SYNC_ERROR' } })
      }
    },
  )

  // POST /settings/auth-config/:provider/test-mapping — dry-run IdP group → Roomer
  // resolution. Evaluate against provided groups, a specific user's last-seen IdP
  // groups, or the union of all users' last-seen groups (to flag dead mappings).
  fastify.post(
    '/auth-config/:provider/test-mapping',
    { preHandler: [requireAuth, requireGlobalRole(GlobalRole.SUPER_ADMIN)], config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const { provider } = request.params as { provider: string }
      const upperProvider = provider.toUpperCase() as ProviderKey
      if (!ALLOWED_PROVIDERS.includes(upperProvider)) {
        return reply.status(400).send({ error: { message: `Unknown provider: ${provider}`, code: 'VALIDATION_ERROR' } })
      }

      const parsed = z.object({
        groups: z.array(z.string()).optional(),
        userId: z.string().optional(),
      }).safeParse(request.body ?? {})
      if (!parsed.success) {
        return reply.status(400).send({ error: { message: 'Validation failed', code: 'VALIDATION_ERROR', details: parsed.error.flatten() } })
      }

      const cfg = await findAuthConfig(upperProvider)
      const mappings = (((cfg?.config as Record<string, unknown> | undefined)?.groupMappings) ?? []) as Array<{ idpGroup: string; roomerGroupId?: string; targetGlobalRole?: string }>

      let inputGroups: string[]
      let evaluatedAgainst: 'provided' | 'user' | 'all-known'
      if (parsed.data.groups && parsed.data.groups.length > 0) {
        inputGroups = parsed.data.groups
        evaluatedAgainst = 'provided'
      } else if (parsed.data.userId) {
        const u = await prisma.user.findUnique({ where: { id: parsed.data.userId }, select: { lastIdpGroups: true } })
        inputGroups = u?.lastIdpGroups ?? []
        evaluatedAgainst = 'user'
      } else {
        const all = await prisma.user.findMany({ where: { lastIdpGroups: { isEmpty: false } }, select: { lastIdpGroups: true } })
        inputGroups = [...new Set(all.flatMap((u) => u.lastIdpGroups))]
        evaluatedAgainst = 'all-known'
      }

      const groupIds = mappings.map((m) => m.roomerGroupId).filter((x): x is string => !!x)
      const groups = groupIds.length
        ? await prisma.userGroup.findMany({ where: { id: { in: groupIds } }, select: { id: true, name: true, globalRole: true } })
        : []
      const byId = new Map(groups.map((g) => [g.id, g]))

      const perMapping = mappings.map((m) => {
        const matched = idpGroupMatchesAny(inputGroups, m.idpGroup)
        const rg = m.roomerGroupId ? byId.get(m.roomerGroupId) : undefined
        const confersAdmin = m.targetGlobalRole === 'SUPER_ADMIN' || rg?.globalRole === 'SUPER_ADMIN'
        return {
          idpGroup: m.idpGroup,
          matched,
          roomerGroup: rg ? { id: rg.id, name: rg.name } : null,
          confersAdmin,
        }
      })

      return reply.status(200).send({
        data: {
          evaluatedAgainst,
          inputGroups,
          mappings: perMapping,
          resolvedGroups: perMapping.filter((p) => p.matched && p.roomerGroup).map((p) => p.roomerGroup),
          resolvedGlobalRole: perMapping.some((p) => p.matched && p.confersAdmin) ? 'SUPER_ADMIN' : 'USER',
          // Configured mappings that did not match any evaluated group — likely typos / dead rules.
          unmatchedMappings: perMapping.filter((p) => !p.matched).map((p) => p.idpGroup),
        },
      })
    },
  )

  // GET /settings/scim — get SCIM provisioning status (SUPER_ADMIN)
  fastify.get(
    '/scim',
    { preHandler: [requireAuth, requireGlobalRole(GlobalRole.SUPER_ADMIN)] },
    async (_request, reply) => {
      const cfg = await prisma.scimConfig.findFirst()
      return reply.status(200).send({
        data: {
          enabled: cfg?.enabled ?? false,
          hasToken: !!cfg?.tokenHash,
          endpointUrl: `${env.API_PUBLIC_URL}/scim/v2`,
        },
      })
    },
  )

  // PATCH /settings/scim — enable or disable SCIM (SUPER_ADMIN)
  fastify.patch(
    '/scim',
    { preHandler: [requireAuth, requireGlobalRole(GlobalRole.SUPER_ADMIN)] },
    async (request, reply) => {
      const patchResult = z.object({ enabled: z.boolean() }).safeParse(request.body)
      if (!patchResult.success) {
        return reply.status(400).send({ error: { message: 'enabled (boolean) is required', code: 'VALIDATION_ERROR' } })
      }
      const { enabled } = patchResult.data
      // ScimConfig is meant to be a singleton with no DB-level constraint
      // enforcing that — a bare findFirst()-then-create() here let two
      // concurrent requests (e.g. two admins both toggling SCIM on for the
      // first time) both take the create() branch, leaving two rows with no
      // defined "active" one (every reader is a plain findFirst() with no
      // orderBy). Reusing lockOrgSettings — the same fixed-key lock this
      // file already uses for the read-merge-write races on Organisation/
      // AuthConfig — closes it the same way: only one request at a time can
      // be inside the read-then-create-or-update critical section.
      const [cfg, updated] = await prisma.$transaction(async (tx) => {
        await lockOrgSettings(tx)
        const cfg = await tx.scimConfig.findFirst()
        const updated = cfg
          ? await tx.scimConfig.update({ where: { id: cfg.id }, data: { enabled } })
          : await tx.scimConfig.create({ data: { enabled } })
        return [cfg, updated] as const
      })
      await recordAuditLog(prisma, {
        actorId: request.user.id,
        action: 'scim_config.updated',
        resourceType: 'ScimConfig',
        resourceId: updated.id,
        before: { enabled: cfg?.enabled ?? false },
        after: { enabled: updated.enabled },
        ipAddress: request.ip,
      }, request.log)
      return reply.status(200).send({ data: { enabled: updated.enabled, hasToken: !!updated.tokenHash } })
    },
  )

  // POST /settings/scim/token — generate a new bearer token (SUPER_ADMIN, returns plaintext once)
  fastify.post(
    '/scim/token',
    { preHandler: [requireAuth, requireGlobalRole(GlobalRole.SUPER_ADMIN)] },
    async (request, reply) => {
      const token = generateScimToken()
      const tokenHash = hashScimToken(token)
      // Same singleton race as PATCH /scim above — lock before read-or-create.
      const updated = await prisma.$transaction(async (tx) => {
        await lockOrgSettings(tx)
        const cfg = await tx.scimConfig.findFirst()
        return cfg
          ? tx.scimConfig.update({ where: { id: cfg.id }, data: { tokenHash, enabled: true } })
          : tx.scimConfig.create({ data: { tokenHash, enabled: true } })
      })
      // Never log the token itself (plaintext or hash) — only that one was
      // rotated, same as SCIM's own "shown once" contract to the admin.
      await recordAuditLog(prisma, {
        actorId: request.user.id,
        action: 'scim_token.rotated',
        resourceType: 'ScimConfig',
        resourceId: updated.id,
        ipAddress: request.ip,
      }, request.log)
      return reply.status(201).send({
        data: {
          token,
          note: 'Store this token now — it will not be shown again.',
        },
      })
    },
  )

  // DELETE /settings/scim/token — revoke the current bearer token (SUPER_ADMIN)
  fastify.delete(
    '/scim/token',
    { preHandler: [requireAuth, requireGlobalRole(GlobalRole.SUPER_ADMIN)] },
    async (request, reply) => {
      // Same singleton race as PATCH /scim above — lock before read-then-update.
      const cfg = await prisma.$transaction(async (tx) => {
        await lockOrgSettings(tx)
        const cfg = await tx.scimConfig.findFirst()
        if (cfg) {
          await tx.scimConfig.update({ where: { id: cfg.id }, data: { tokenHash: null, enabled: false } })
        }
        return cfg
      })
      if (cfg) {
        await recordAuditLog(prisma, {
          actorId: request.user.id,
          action: 'scim_token.revoked',
          resourceType: 'ScimConfig',
          resourceId: cfg.id,
          ipAddress: request.ip,
        }, request.log)
      }
      return reply.status(200).send({ data: { ok: true } })
    },
  )

  // ─── Email template endpoints ─────────────────────────────────────────────

  const ALLOWED_TEMPLATE_TYPES = [
    'BOOKING_CONFIRMED', 'BOOKING_CANCELLED', 'BOOKING_CANCELLED_BY_ADMIN', 'BOOKING_NO_SHOW',
    'QUEUE_JOINED', 'QUEUE_PROMOTED', 'QUEUE_EXPIRED', 'QUEUE_CLAIM_EXPIRING',
    'FLOOR_AVAILABLE', 'WELCOME',
  ] as const
  type TemplateType = (typeof ALLOWED_TEMPLATE_TYPES)[number]

  function buildTestVars(_type: TemplateType): Record<string, string> {
    const now = new Date()
    const later = new Date(now.getTime() + 8 * 60 * 60 * 1000)
    const claimDeadline = new Date(now.getTime() + 2 * 60 * 60 * 1000)
    return {
      userName: 'Test User',
      userEmail: 'test@example.com',
      assetName: 'Desk 1',
      zoneName: 'Zone A',
      floorName: 'Floor 2',
      startsAt: formatDate(now),
      endsAt: formatDate(later),
      notes: 'Example booking notes',
      bookingUrl: `${env.APP_URL}/bookings/example-id`,
      bookingsUrl: `${env.APP_URL}/bookings`,
      queueUrl: `${env.APP_URL}/queue`,
      position: '3',
      wantedStartsAt: formatDate(now),
      wantedEndsAt: formatDate(later),
      claimDeadline: formatDate(claimDeadline),
      claimUrl: `${env.APP_URL}/queue/claim?token=example-token`,
      floorUrl: `${env.APP_URL}/floors/example-floor-id?date=${now.toISOString().slice(0, 10)}`,
      slotDate: now.toISOString().slice(0, 10),
      appUrl: env.APP_URL,
    }
  }

  // GET /settings/email-templates/:type — get current template (custom or default)
  fastify.get(
    '/email-templates/:type',
    { preHandler: [requireAuth, requireGlobalRole(GlobalRole.SUPER_ADMIN)] },
    async (request, reply) => {
      const { type } = request.params as { type: string }
      const upperType = type.toUpperCase() as TemplateType
      if (!ALLOWED_TEMPLATE_TYPES.includes(upperType)) {
        return reply.status(400).send({ error: { message: `Unknown template type: ${type}`, code: 'VALIDATION_ERROR' } })
      }
      const org = await prisma.organisation.findFirst({ select: { emailTemplates: true } })
      const stored = ((org?.emailTemplates ?? {}) as Record<string, { subject: string; html: string } | undefined>)[upperType]
      const defaults = DEFAULT_TEMPLATE_STRINGS[upperType]
      return reply.status(200).send({
        data: {
          subject: stored?.subject ?? defaults.subject,
          html: stored?.html ?? defaults.html,
          isCustom: !!stored,
        },
      })
    },
  )

  // PUT /settings/email-templates/:type — save a custom template
  fastify.put(
    '/email-templates/:type',
    { preHandler: [requireAuth, requireGlobalRole(GlobalRole.SUPER_ADMIN)] },
    async (request, reply) => {
      const { type } = request.params as { type: string }
      const upperType = type.toUpperCase() as TemplateType
      if (!ALLOWED_TEMPLATE_TYPES.includes(upperType)) {
        return reply.status(400).send({ error: { message: `Unknown template type: ${type}`, code: 'VALIDATION_ERROR' } })
      }
      const bodyResult = z.object({
        subject: z.string().min(1).max(500),
        html: z.string().min(1).max(200_000),
      }).safeParse(request.body)
      if (!bodyResult.success) {
        return reply.status(400).send({ error: { message: 'Validation failed', code: 'VALIDATION_ERROR', details: bodyResult.error.flatten() } })
      }
      const org = await prisma.$transaction(async (tx) => {
        await lockOrgSettings(tx)
        const found = await tx.organisation.findFirst()
        if (!found) return null
        const current = (found.emailTemplates ?? {}) as Record<string, unknown>
        const updated = { ...current, [upperType]: bodyResult.data } as Prisma.InputJsonValue
        await tx.organisation.update({ where: { id: found.id }, data: { emailTemplates: updated } })
        await recordAuditLog(tx, {
          actorId: request.user.id,
          action: 'email_template.updated',
          resourceType: 'Organisation',
          resourceId: found.id,
          before: (current[upperType] ?? null) as Prisma.InputJsonValue,
          after: bodyResult.data,
          ipAddress: request.ip,
        }, request.log)
        return found
      })
      if (!org) return reply.status(404).send({ error: { message: 'Organisation not found', code: 'NOT_FOUND' } })
      return reply.status(200).send({ data: { type: upperType, ...bodyResult.data, isCustom: true } })
    },
  )

  // DELETE /settings/email-templates/:type — reset to default
  fastify.delete(
    '/email-templates/:type',
    { preHandler: [requireAuth, requireGlobalRole(GlobalRole.SUPER_ADMIN)] },
    async (request, reply) => {
      const { type } = request.params as { type: string }
      const upperType = type.toUpperCase() as TemplateType
      if (!ALLOWED_TEMPLATE_TYPES.includes(upperType)) {
        return reply.status(400).send({ error: { message: `Unknown template type: ${type}`, code: 'VALIDATION_ERROR' } })
      }
      const org = await prisma.$transaction(async (tx) => {
        await lockOrgSettings(tx)
        const found = await tx.organisation.findFirst()
        if (!found) return null
        const current = (found.emailTemplates ?? {}) as Record<string, unknown>
        const { [upperType]: removed, ...rest } = current
        await tx.organisation.update({ where: { id: found.id }, data: { emailTemplates: rest as Prisma.InputJsonValue } })
        await recordAuditLog(tx, {
          actorId: request.user.id,
          action: 'email_template.reset',
          resourceType: 'Organisation',
          resourceId: found.id,
          before: (removed ?? null) as Prisma.InputJsonValue,
          ipAddress: request.ip,
        }, request.log)
        return found
      })
      if (!org) return reply.status(404).send({ error: { message: 'Organisation not found', code: 'NOT_FOUND' } })
      const defaults = DEFAULT_TEMPLATE_STRINGS[upperType]
      return reply.status(200).send({ data: { type: upperType, ...defaults, isCustom: false } })
    },
  )

  // POST /settings/email-templates/:type/test — send a test email (uses current editor content or saved custom)
  fastify.post(
    '/email-templates/:type/test',
    { preHandler: [requireAuth, requireGlobalRole(GlobalRole.SUPER_ADMIN)] },
    async (request, reply) => {
      const { type } = request.params as { type: string }
      const upperType = type.toUpperCase() as TemplateType
      if (!ALLOWED_TEMPLATE_TYPES.includes(upperType)) {
        return reply.status(400).send({ error: { message: `Unknown template type: ${type}`, code: 'VALIDATION_ERROR' } })
      }
      const bodyResult = z.object({
        subject: z.string().min(1).max(500).optional(),
        html: z.string().min(1).max(200_000).optional(),
      }).safeParse(request.body)
      if (!bodyResult.success) {
        return reply.status(400).send({ error: { message: 'Validation failed', code: 'VALIDATION_ERROR', details: bodyResult.error.flatten() } })
      }

      // Resolve subject + html: request body → saved custom → built-in default
      let subject: string
      let html: string
      if (bodyResult.data.subject && bodyResult.data.html) {
        subject = bodyResult.data.subject
        html = bodyResult.data.html
      } else {
        const org = await prisma.organisation.findFirst({ select: { emailTemplates: true } })
        const stored = ((org?.emailTemplates ?? {}) as Record<string, { subject: string; html: string } | undefined>)[upperType]
        const defaults = DEFAULT_TEMPLATE_STRINGS[upperType]
        subject = stored?.subject ?? defaults.subject
        html = stored?.html ?? defaults.html
      }

      const vars = buildTestVars(upperType)
      const renderedSubject = interpolateTemplate(subject, vars)
      const renderedHtml = interpolateTemplate(html, vars)
      const renderedText = stripHtmlToText(renderedHtml)

      try {
        await sendEmail({
          to: request.user.email,
          subject: `[TEST] ${renderedSubject}`,
          html: renderedHtml,
          text: renderedText,
        })
        return reply.status(200).send({ data: { ok: true, sentTo: request.user.email } })
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error'
        return reply.status(502).send({ error: { message: `Failed to send test email: ${message}`, code: 'SMTP_ERROR' } })
      }
    },
  )
}
