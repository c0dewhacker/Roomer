import type { FastifyInstance, FastifyReply } from 'fastify'
import { prisma } from '../lib/prisma'
import { env } from '../env'
import { getOidcClient, getOidcConfig, generateState, generateNonce, invalidateOidcCache } from '../lib/oidc'
import { getSamlConfig, buildSaml, extractEmailFromProfile, extractDisplayNameFromProfile, extractGroupsFromProfile, type SamlProfile } from '../lib/saml'
import { applyGroupMappings } from '../lib/group-mapping'
import { signAccessToken, TOKEN_COOKIE, TOKEN_COOKIE_OPTS, TOKEN_MAX_AGE } from '../lib/jwt'
import type { User } from '@prisma/client'

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function findOrCreateSsoUser(
  email: string,
  displayName: string,
  provider: 'OIDC' | 'SAML',
  externalId?: string,
) {
  const user = await prisma.user.upsert({
    where: { email },
    update: {
      displayName,
      ...(externalId ? { externalId } : {}),
    },
    create: {
      email,
      displayName,
      provider,
      externalId: externalId ?? null,
      passwordHash: null,
    },
  })
  if (user.accountStatus === 'BLOCKED') return null
  return user
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

  // GET /auth/providers — public: which SSO providers are enabled
  fastify.get('/providers', async (_request, reply) => {
    const configs = await prisma.authConfig.findMany()
    const byProvider = Object.fromEntries(configs.map((c) => [c.provider, c]))

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
      },
    })
  })

  // ─── OIDC ──────────────────────────────────────────────────────────────────

  // GET /auth/oidc/authorize — redirect to IdP
  // The session is used exclusively to store the short-lived OIDC state/nonce
  // parameters needed to validate the callback. It is NOT used for user auth.
  fastify.get('/oidc/authorize', async (request, reply) => {
    const client = await getOidcClient()
    if (!client) {
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

    const authUrl = client.authorizationUrl({
      scope: cfg?.scope ?? 'openid profile email',
      state,
      nonce,
    })

    return reply.redirect(authUrl)
  })

  // GET /auth/oidc/callback — receive code from IdP, issue JWT
  fastify.get('/oidc/callback', async (request, reply) => {
    const client = await getOidcClient()
    const cfg = await getOidcConfig()

    if (!client || !cfg) {
      return reply.redirect(`${env.APP_URL}/login?error=oidc_not_configured`)
    }

    try {
      const storedState = request.session.oidcState
      const storedNonce = request.session.oidcNonce

      // Clear OIDC state from session immediately — it served its one-time purpose
      request.session.oidcState = undefined
      request.session.oidcNonce = undefined
      await request.session.save()

      const params = client.callbackParams(request.raw)
      const tokenSet = await client.callback(cfg.redirectUri, params, {
        state: storedState,
        nonce: storedNonce,
      })

      const userinfo = await client.userinfo(tokenSet)
      const email = userinfo.email
      const fullName = ((userinfo.given_name ?? '') + ' ' + (userinfo.family_name ?? '')).trim()
      const displayName = userinfo.name ?? (fullName || userinfo.preferred_username) ?? email

      if (!email) {
        return reply.redirect(`${env.APP_URL}/login?error=oidc_no_email`)
      }

      const user = await findOrCreateSsoUser(email, displayName ?? email, 'OIDC', userinfo.sub)
      if (!user) {
        return reply.redirect(`${env.APP_URL}/login?error=account_blocked`)
      }

      const groupsClaimName = cfg.groupsClaimName ?? 'groups'
      const rawGroups = (userinfo as Record<string, unknown>)[groupsClaimName]
      const idpGroups = Array.isArray(rawGroups) ? rawGroups.map(String) : []
      if (idpGroups.length && cfg.groupMappings?.length) {
        await applyGroupMappings(user.id, idpGroups, cfg.groupMappings, true)
      }

      // Issue JWT cookie — OIDC session state is no longer needed
      issueSsoToken(reply, user)
    } catch (err) {
      fastify.log.error({ err }, 'OIDC callback error')
      return reply.redirect(`${env.APP_URL}/login?error=oidc_callback_failed`)
    }
  })

  // ─── SAML ──────────────────────────────────────────────────────────────────

  // GET /auth/saml/authorize — redirect to IdP (HTTP-Redirect binding)
  fastify.get('/saml/authorize', async (request, reply) => {
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
  fastify.post('/saml/callback', async (request, reply) => {
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

      const user = await findOrCreateSsoUser(email, displayName, 'SAML', profile.nameID)
      if (!user) {
        return reply.redirect(`${env.APP_URL}/login?error=account_blocked`)
      }

      const idpGroups = extractGroupsFromProfile(samlProfile, cfg.groupAttribute)
      if (idpGroups.length && cfg.groupMappings?.length) {
        await applyGroupMappings(user.id, idpGroups, cfg.groupMappings, true)
      }

      // Issue JWT cookie
      issueSsoToken(reply, user)
    } catch (err) {
      fastify.log.error({ err }, 'SAML callback error')
      return reply.redirect(`${env.APP_URL}/login?error=saml_callback_failed`)
    }
  })
}
