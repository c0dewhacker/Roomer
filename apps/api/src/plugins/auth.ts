import fp from 'fastify-plugin'
import type { FastifyInstance } from 'fastify'
import fastifyCookie from '@fastify/cookie'
import fastifySession from '@fastify/session'
import ConnectPgSimple from 'connect-pg-simple'
import { env } from '../env.js'

// Session is kept exclusively for OIDC redirect-flow state storage
// (nonce + state parameters that must survive the browser round-trip).
// User identity is carried in signed JWT cookies, not in session data.
declare module 'fastify' {
  interface Session {
    oidcState?: string
    oidcNonce?: string
  }
}

async function authPlugin(fastify: FastifyInstance): Promise<void> {
  // Cookie plugin is required by @fastify/session and also used by requireAuth
  // to read the access_token JWT cookie.
  await fastify.register(fastifyCookie)

  const PgSession = ConnectPgSimple(fastifySession as unknown as Parameters<typeof ConnectPgSimple>[0])

  const store = new PgSession({
    conString: env.DATABASE_URL,
    tableName: 'sessions',
    createTableIfMissing: true,
    pruneSessionInterval: 15 * 60,
  })

  await fastify.register(fastifySession, {
    // Separate from the JWT-signing secret when COOKIE_SESSION_SECRET is set
    // (falls back to SESSION_SECRET otherwise, matching every existing
    // deployment's current behaviour) — see env.ts's comment for why sharing
    // one secret across two independent signing schemes is worth avoiding.
    secret: env.COOKIE_SESSION_SECRET ?? env.SESSION_SECRET,
    saveUninitialized: false,
    cookie: {
      // OIDC state sessions are short-lived (just the redirect round-trip)
      secure: env.COOKIE_SECURE,
      httpOnly: true,
      // Must be 'lax', not 'strict' — the whole point of this cookie is to
      // survive the browser round-trip through the IdP: /oidc/authorize sets
      // oidcState/oidcNonce, the IdP redirects the browser straight back to
      // /oidc/callback as a cross-site top-level GET. Browsers never send a
      // Strict cookie on a cross-site navigation (Lax is the documented
      // minimum for exactly this OAuth/OIDC redirect pattern), so with
      // 'strict' the callback always saw an empty session and every OIDC
      // login attempt failed. The state/nonce values themselves are already
      // the CSRF protection for this flow — Lax adds no new exposure.
      sameSite: 'lax',
      maxAge: 10 * 60 * 1000, // 10 minutes — only needs to survive the IdP redirect
    },
    // connect-pg-simple uses express-session's Store interface; @fastify/session expects a
    // slightly different shape — no shared type exists, so the double-cast is necessary.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    store: store as unknown as any,
  })
}

export default fp(authPlugin, {
  name: 'auth-plugin',
  fastify: '5.x',
})
