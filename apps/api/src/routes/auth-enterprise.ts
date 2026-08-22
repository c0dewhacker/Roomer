import type { FastifyInstance, FastifyReply } from 'fastify'
import { prisma } from '../lib/prisma.js'
import { env } from '../env.js'
import { getOidcClientConfig, getOidcConfig, generateState, generateNonce } from '../lib/oidc.js'
import { buildAuthorizationUrl, authorizationCodeGrant, fetchUserInfo, skipSubjectCheck } from 'openid-client'
import { getSamlConfig, buildSaml, extractEmailFromProfile, extractDisplayNameFromProfile, extractGroupsFromProfile, extractDepartmentFromProfile, extractManagerFromProfile, type SamlProfile } from '../lib/saml.js'
import { applyGroupMappings, recordLastIdpGroups } from '../lib/group-mapping.js'
import { recordManagerRef, resolveManagerForUser } from '../lib/manager.js'
import { signAccessToken, TOKEN_COOKIE, TOKEN_COOKIE_OPTS, TOKEN_MAX_AGE } from '../lib/jwt.js'
import type { User } from '@prisma/client'
import { recordAuditLog } from '../lib/audit.js'

// ─── Helpers ──────────────────────────────────────────────────────────────────

type SsoUserResult =
  | { ok: true; user: User }
  | { ok: false; error: 'blocked' | 'local_password_conflict' | 'identity_mismatch' }

async function findOrCreateSsoUser(
  email: string,
  displayName: string,
  provider: 'OIDC' | 'SAML',
  externalId?: string,
  ipAddress?: string,
): Promise<SsoUserResult> {
  // Case-insensitive lookup, same reasoning as the local-login and LDAP paths
  // in auth.ts: the IdP-provided email claim isn't guaranteed to match the
  // case of an existing account (e.g. one created by an admin, or synced via
  // LDAP, which does lowercase). upsert()'s where must be an exact unique
  // match, so it can't do this directly — find first, then update or create.
  const existing = await prisma.user.findFirst({ where: { email: { equals: email, mode: 'insensitive' } } })

  // A local-password account is never silently linked to an SSO identity —
  // mirrors the `if (!user?.passwordHash)` guard auth.ts's LDAP path already
  // applies. Without this, an IdP asserting the email of an existing local
  // account (e.g. one created before SSO was enabled, or by an admin) would
  // log the caller in AS that account — inheriting its role — with no
  // password ever checked.
  if (existing?.passwordHash) {
    return { ok: false, error: 'local_password_conflict' }
  }

  // An account already linked to a DIFFERENT external identity is never
  // silently re-pointed by a login asserting the same email — otherwise a
  // reprovisioned IdP identity (e.g. an email address recycled to a new
  // employee after the previous one left) would quietly inherit the
  // previous person's entire account, role, and booking history.
  if (existing?.externalId && externalId && existing.externalId !== externalId) {
    return { ok: false, error: 'identity_mismatch' }
  }

  const user = existing
    ? await prisma.user.update({
        where: { id: existing.id },
        data: {
          displayName,
          ...(externalId ? { externalId } : {}),
        },
      })
    : await prisma.user.create({
        data: {
          email,
          displayName,
          provider,
          externalId: externalId ?? null,
          passwordHash: null,
        },
      })
  // actorId: null — IdP-driven JIT provisioning triggered by the user's own
  // login, not a human admin action, same reasoning as SCIM/LDAP JIT (Batch A,
  // auth.ts). A provider-specific action name lets a reviewer tell provenance
  // (and which IdP) apart at a glance.
  await recordAuditLog(prisma, {
    actorId: null,
    action: existing ? `user.${provider.toLowerCase()}_updated` : `user.${provider.toLowerCase()}_created`,
    resourceType: 'User',
    resourceId: user.id,
    after: { email: user.email, displayName: user.displayName, externalId: user.externalId },
    ipAddress,
  })
  if (user.accountStatus === 'BLOCKED') return { ok: false, error: 'blocked' }
  return { ok: true, user }
}

/**
 * Issue a signed JWT cookie for an SSO-authenticated user and redirect to the
 * app. Used by both OIDC and SAML callback handlers.
 */
function issueSsoToken(reply: FastifyReply, user: User, redirectPath = '/bookings'): void {
  const token = signAccessToken({
    sub: user.id,
    role: user.globalRole,
    email: user.email,
    displayName: user.displayName,
    // Record the original SSO login time so the 24-hour session ceiling applies
    // from first authentication, not from each individual token issuance.
    sessionStart: Math.floor(Date.now() / 1000),
  })
  reply.setCookie(TOKEN_COOKIE, token, {
    ...TOKEN_COOKIE_OPTS,
    maxAge: TOKEN_MAX_AGE,
  })
  reply.redirect(`${env.APP_URL}${redirectPath}`)
}

// ─── Routes ───────────────────────────────────────────────────────────────────

export async function enterpriseAuthRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.addHook('onRoute', (route) => { route.schema = { tags: ['Auth'], ...route.schema } })

  // GET /auth/providers — public: which providers are enabled + login display settings
  fastify.get('/providers', async (_request, reply) => {
    const [configs, org] = await Promise.all([
      prisma.authConfig.findMany(),
      prisma.organisation.findFirst({ select: { branding: true } }),
    ])
    const byProvider = Object.fromEntries(configs.map((c) => [c.provider, c]))
    const branding = (org?.branding ?? {}) as Record<string, unknown>

    const oidcCfg = byProvider['OIDC']
    const samlCfg = byProvider['SAML']
    const ldapCfg = byProvider['LDAP']

    return reply.status(200).send({
      data: {
        oidc: {
          enabled: oidcCfg?.enabled ?? false,
          label: ((oidcCfg?.config as Record<string, string> | null)?.label) ?? 'Sign in with SSO',
        },
        saml: {
          enabled: samlCfg?.enabled ?? false,
          label: ((samlCfg?.config as Record<string, string> | null)?.label) ?? 'Sign in with SAML SSO',
        },
        ldap: { enabled: ldapCfg?.enabled ?? false },
        local: { enabled: true },
        defaultProvider: (branding.defaultLoginProvider as string) ?? null,
        showProviderSelector: branding.showLoginProviderSelector !== false,
      },
    })
  })

  // ─── OIDC ──────────────────────────────────────────────────────────────────

  // GET /auth/oidc/authorize — redirect to IdP
  // The session is used exclusively to store the short-lived OIDC state/nonce
  // parameters needed to validate the callback. It is NOT used for user auth.
  fastify.get('/oidc/authorize', { config: { rateLimit: { max: 20, timeWindow: '15 minutes' } } }, async (request, reply) => {
    const config = await getOidcClientConfig()
    if (!config) {
      return reply.redirect(`${env.APP_URL}/login?error=oidc_not_configured`)
    }

    const cfg = await getOidcConfig()
    const state = generateState()
    const nonce = generateNonce()

    // Regenerate the session before writing OIDC state to prevent session fixation.
    // If an attacker has pre-set the victim's session ID (via cookie injection or
    // a shared device), regenerating here ensures the state/nonce are bound to a
    // fresh session ID that the attacker does not know.
    await request.session.regenerate()
    request.session.oidcState = state
    request.session.oidcNonce = nonce
    await request.session.save()

    const authUrl = buildAuthorizationUrl(config, {
      scope: cfg?.scope ?? 'openid profile email',
      state,
      nonce,
    })

    return reply.redirect(authUrl.href)
  })

  // GET /auth/oidc/callback — receive code from IdP, issue JWT
  fastify.get('/oidc/callback', { config: { rateLimit: { max: 20, timeWindow: '15 minutes' } } }, async (request, reply) => {
    const config = await getOidcClientConfig()
    const cfg = await getOidcConfig()

    if (!config || !cfg) {
      return reply.redirect(`${env.APP_URL}/login?error=oidc_not_configured`)
    }

    try {
      const storedState = request.session.oidcState
      const storedNonce = request.session.oidcNonce

      // Clear OIDC state from session immediately — it served its one-time purpose
      request.session.oidcState = undefined
      request.session.oidcNonce = undefined
      await request.session.save()

      const callbackUrl = new URL(request.raw.url!, `${request.protocol}://${request.hostname}`)
      const tokenSet = await authorizationCodeGrant(config, callbackUrl, {
        expectedState: storedState,
        expectedNonce: storedNonce,
      })

      const userinfo = await fetchUserInfo(config, tokenSet.access_token!, skipSubjectCheck)
      const email = userinfo.email
      const fullName = ((userinfo.given_name ?? '') + ' ' + (userinfo.family_name ?? '')).trim()
      const displayName = userinfo.name ?? (fullName || userinfo.preferred_username) ?? email

      if (!email) {
        return reply.redirect(`${env.APP_URL}/login?error=oidc_no_email`)
      }

      // Refuse explicitly-unverified emails. Because SSO users are matched/linked
      // by email, accepting an unverified address would let a malicious or
      // misconfigured IdP take over an existing account by asserting its email.
      if (userinfo.email_verified === false) {
        fastify.log.warn({ email }, 'OIDC login rejected: email not verified')
        return reply.redirect(`${env.APP_URL}/login?error=oidc_email_unverified`)
      }

      const ssoResult = await findOrCreateSsoUser(email, displayName ?? email, 'OIDC', userinfo.sub, request.ip)
      if (!ssoResult.ok) {
        const errorCode = ssoResult.error === 'blocked' ? 'account_blocked' : `oidc_${ssoResult.error}`
        return reply.redirect(`${env.APP_URL}/login?error=${errorCode}`)
      }
      const user = ssoResult.user

      const groupsClaimName = cfg.groupsClaimName ?? 'groups'
      const rawGroups = (userinfo as Record<string, unknown>)[groupsClaimName]
      const idpGroups = Array.isArray(rawGroups) ? rawGroups.map(String) : []
      await recordLastIdpGroups(user.id, idpGroups)
      // Deliberately does NOT require idpGroups.length here: an empty array is
      // exactly the "user was removed from every mapped group" signal that must
      // reach applyGroupMappings so its sync=true eviction/demotion logic can
      // run — gating this on a non-empty claim silently skipped revocation for
      // a fully-deprovisioned user on every subsequent login.
      if (cfg.groupMappings?.length) {
        await applyGroupMappings(user.id, idpGroups, cfg.groupMappings, true)
      }

      // Department mapping — opt-in via a configured claim name (blank = disabled).
      // Mirrors the SAML/LDAP department-attribute behaviour.
      if (cfg.departmentClaimName) {
        const rawDept = (userinfo as Record<string, unknown>)[cfg.departmentClaimName]
        const deptName = typeof rawDept === 'string' ? rawDept.trim() : undefined
        if (deptName) {
          const org = await prisma.organisation.findFirst({ select: { id: true } })
          if (org) {
            const dept = await prisma.department.upsert({
              where: { organisationId_name: { organisationId: org.id, name: deptName } },
              create: { organisationId: org.id, name: deptName },
              update: {},
            })
            await prisma.user.update({ where: { id: user.id }, data: { departmentId: dept.id } })
          }
        }
      }

      // Manager mapping — opt-in via a configured claim (blank = disabled).
      if (cfg.managerClaimName) {
        const rawMgr = (userinfo as Record<string, unknown>)[cfg.managerClaimName]
        await recordManagerRef(user.id, typeof rawMgr === 'string' ? rawMgr : null)
      }
      await resolveManagerForUser(user.id)

      // Issue JWT cookie — OIDC session state is no longer needed
      issueSsoToken(reply, user)
    } catch (err) {
      fastify.log.error({ err }, 'OIDC callback error')
      return reply.redirect(`${env.APP_URL}/login?error=oidc_callback_failed`)
    }
  })

  // ─── SAML ──────────────────────────────────────────────────────────────────

  // GET /auth/saml/authorize — redirect to IdP (HTTP-Redirect binding)
  fastify.get('/saml/authorize', { config: { rateLimit: { max: 20, timeWindow: '15 minutes' } } }, async (request, reply) => {
    const cfg = await getSamlConfig()
    if (!cfg) {
      return reply.redirect(`${env.APP_URL}/login?error=saml_not_configured`)
    }

    try {
      const saml = buildSaml(cfg)
      const relayState = `${env.APP_URL}/bookings`
      const loginUrl = await saml.getAuthorizeUrlAsync(relayState, request.hostname, {})
      return reply.redirect(loginUrl)
    } catch (err) {
      fastify.log.error({ err }, 'SAML authorize error')
      return reply.redirect(`${env.APP_URL}/login?error=saml_authorize_failed`)
    }
  })

  // POST /auth/saml/callback — receive assertion from IdP, issue JWT
  fastify.post('/saml/callback', { config: { rateLimit: { max: 20, timeWindow: '15 minutes' } } }, async (request, reply) => {
    const cfg = await getSamlConfig()
    if (!cfg) {
      return reply.redirect(`${env.APP_URL}/login?error=saml_not_configured`)
    }

    try {
      const saml = buildSaml(cfg)
      const body = request.body as Record<string, string>
      const { profile } = await saml.validatePostResponseAsync(body)

      if (!profile) {
        return reply.redirect(`${env.APP_URL}/login?error=saml_no_profile`)
      }

      const samlProfile = profile as SamlProfile
      const email = extractEmailFromProfile(samlProfile)
      const displayName = extractDisplayNameFromProfile(samlProfile)

      if (!email) {
        return reply.redirect(`${env.APP_URL}/login?error=saml_no_email`)
      }

      const ssoResult = await findOrCreateSsoUser(email, displayName, 'SAML', profile.nameID, request.ip)
      if (!ssoResult.ok) {
        const errorCode = ssoResult.error === 'blocked' ? 'account_blocked' : `saml_${ssoResult.error}`
        return reply.redirect(`${env.APP_URL}/login?error=${errorCode}`)
      }
      const user = ssoResult.user

      const idpGroups = extractGroupsFromProfile(samlProfile, cfg.groupAttribute)
      await recordLastIdpGroups(user.id, idpGroups)
      // Deliberately does NOT require idpGroups.length here: an empty array is
      // exactly the "user was removed from every mapped group" signal that must
      // reach applyGroupMappings so its sync=true eviction/demotion logic can
      // run — gating this on a non-empty claim silently skipped revocation for
      // a fully-deprovisioned user on every subsequent login.
      if (cfg.groupMappings?.length) {
        await applyGroupMappings(user.id, idpGroups, cfg.groupMappings, true)
      }

      const deptName = extractDepartmentFromProfile(samlProfile, cfg.departmentAttribute)
      if (deptName) {
        const org = await prisma.organisation.findFirst({ select: { id: true } })
        if (org) {
          const dept = await prisma.department.upsert({
            where: { organisationId_name: { organisationId: org.id, name: deptName } },
            create: { organisationId: org.id, name: deptName },
            update: {},
          })
          await prisma.user.update({ where: { id: user.id }, data: { departmentId: dept.id } })
        }
      }

      // Manager mapping (opt-in via configured attribute; blank = disabled).
      const mgrRef = extractManagerFromProfile(samlProfile, cfg.managerAttribute)
      if (cfg.managerAttribute || mgrRef) await recordManagerRef(user.id, mgrRef)
      await resolveManagerForUser(user.id)

      // Issue JWT cookie
      issueSsoToken(reply, user)
    } catch (err) {
      fastify.log.error({ err }, 'SAML callback error')
      return reply.redirect(`${env.APP_URL}/login?error=saml_callback_failed`)
    }
  })
}
