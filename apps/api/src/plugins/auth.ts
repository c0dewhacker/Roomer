import fp from 'fastify-plugin'
import type { FastifyInstance } from 'fastify'
import fastifyCookie from '@fastify/cookie'
import fastifySession from '@fastify/session'
import ConnectPgSimple from 'connect-pg-simple'
import { env } from '../env'

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
    secret: env.SESSION_SECRET,
    saveUninitialized: false,
    cookie: {
      // OIDC state sessions are short-lived (just the redirect round-trip)
      secure: env.COOKIE_SECURE,
      httpOnly: true,
      sameSite: 'strict',
      maxAge: 10 * 60 * 1000, // 10 minutes — only needs to survive the IdP redirect
    },
    store: store as any,
  })
}

export default fp(authPlugin, {
  name: 'auth-plugin',
  fastify: '5.x',
})
