import Fastify, { type FastifyInstance } from 'fastify'
import helmet from '@fastify/helmet'
import cors from '@fastify/cors'
import formbody from '@fastify/formbody'
import multipart from '@fastify/multipart'
import rateLimit from '@fastify/rate-limit'
import swagger from '@fastify/swagger'
import swaggerUi from '@fastify/swagger-ui'
import { env } from './env'
import authPlugin from './plugins/auth'
import { authRoutes } from './routes/auth'
import { buildingRoutes } from './routes/buildings'
import { floorRoutes } from './routes/floors'
import { zoneRoutes, zoneGroupRoutes } from './routes/zones'
import { bookingRoutes } from './routes/bookings'
import { queueRoutes } from './routes/queue'
import { userRoutes } from './routes/users'
import { notificationRoutes } from './routes/notifications'
import { assetRoutes } from './routes/assets'
import { analyticsRoutes } from './routes/analytics'
import { leaseRoutes } from './routes/leases'
import { groupRoutes } from './routes/groups'
import { settingsRoutes } from './routes/settings'
import { enterpriseAuthRoutes } from './routes/auth-enterprise'
import { importRoutes } from './routes/import'
import { scimRoutes } from './routes/scim'
import { subscriptionRoutes } from './routes/subscriptions'
import { getBoss } from './lib/queue'

export async function buildApp(): Promise<FastifyInstance> {
  const fastify = Fastify({
    logger:
      env.NODE_ENV === 'development'
        ? { level: 'info', transport: { target: 'pino-pretty' } }
        : { level: 'warn' },
    // Only trust X-Forwarded-For when explicitly enabled via TRUST_PROXY=true.
    // Without this, an attacker can spoof X-Forwarded-For to bypass IP-keyed rate limits.
    trustProxy: env.TRUST_PROXY,
    // Explicit body size cap. Fastify's default is 1 MiB; we set it explicitly
    // so future changes to route-level limits are deliberate rather than implicit.
    bodyLimit: 1_048_576,
  })

  // ─── Security ──────────────────────────────────────────────────────────────
  await fastify.register(helmet, {
    // CSP is enabled in production. It is disabled in development only to allow
    // the Swagger UI (which requires inline scripts/styles) to function without
    // complex nonce configuration. Do NOT disable in staging or production.
    contentSecurityPolicy: env.NODE_ENV === 'production' ? {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        // 'unsafe-inline' is only needed when the Swagger UI is enabled (it injects inline styles).
        // When Swagger is disabled (production default), we tighten to 'self' only.
        styleSrc: env.SWAGGER_ENABLED ? ["'self'", "'unsafe-inline'"] : ["'self'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
      },
    } : false,
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  })

  await fastify.register(cors, {
    origin: env.CORS_ORIGIN,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  })

  // ─── Form body (needed for SAML POST binding) ─────────────────────────────
  await fastify.register(formbody)

  // ─── File uploads ──────────────────────────────────────────────────────────
  await fastify.register(multipart, {
    limits: {
      fileSize: env.MAX_FILE_SIZE_MB * 1024 * 1024,
      files: 1,
    },
  })

  // ─── Auth (session) ────────────────────────────────────────────────────────
  await fastify.register(authPlugin)

  // ─── Swagger / OpenAPI ─────────────────────────────────────────────────────
  // Disabled in production by default to avoid leaking API surface.
  // Enable in any environment by setting SWAGGER_ENABLED=true.
  if (env.SWAGGER_ENABLED) {
    await fastify.register(swagger, {
      openapi: {
        info: {
          title: 'Roomer API',
          description: 'Desk allocation, hot-desking & asset management',
          version: '1.0.0',
        },
        servers: [{ url: `http://${env.HOST}:${env.PORT}` }],
        tags: [
          { name: 'Auth', description: 'Authentication — login, logout, token refresh, SSO (OIDC / SAML / LDAP)' },
          { name: 'Buildings', description: 'Building management and building-level access control' },
          { name: 'Floors', description: 'Floor management, floor plans, and desk availability' },
          { name: 'Zones', description: 'Zone and zone group management' },
          { name: 'Assets', description: 'Desk and equipment asset management' },
          { name: 'Bookings', description: 'Desk booking lifecycle' },
          { name: 'Queue', description: 'Waitlist queue for booked assets' },
          { name: 'Users', description: 'User management and resource roles' },
          { name: 'Groups', description: 'Access-control groups and floor/building permissions' },
          { name: 'Notifications', description: 'In-app notifications' },
          { name: 'Analytics', description: 'Utilisation and booking analytics (admin only)' },
          { name: 'Leases', description: 'Building lease management (admin only)' },
          { name: 'Settings', description: 'System configuration — branding, SSO, email (admin only)' },
          { name: 'Import', description: 'Bulk data import (admin only)' },
        ],
        components: {
          securitySchemes: {
            bearerAuth: {
              type: 'http',
              scheme: 'bearer',
              bearerFormat: 'JWT',
              description: 'HS256-signed JWT. Issued as an httpOnly cookie on login; also accepted as Authorization: Bearer <token>.',
            },
            cookieAuth: {
              type: 'apiKey',
              in: 'cookie',
              name: 'access_token',
              description: 'httpOnly JWT cookie set by POST /auth/login.',
            },
          },
        },
      },
    })
    await fastify.register(swaggerUi, {
      routePrefix: '/docs',
      uiConfig: { docExpansion: 'list', deepLinking: true },
    })
  }

  // ─── Global rate limiting ──────────────────────────────────────────────────
  // Apply a broad limit to all routes to protect against scraping and DoS.
  // The auth sub-context below imposes a tighter limit (20 req/15 min) on
  // credential-accepting endpoints, which takes precedence for those routes.
  await fastify.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: '1 minute',
    errorResponseBuilder: () => ({
      error: { message: 'Too many requests, please try again later', code: 'RATE_LIMITED' },
    }),
  })

  // ─── Rate limiting on auth endpoints ───────────────────────────────────────
  // /me and /providers are read-only endpoints hit on every page load — exempt
  // them from rate limiting. Only credential-accepting routes (login, refresh,
  // OIDC/SAML callbacks) need the brute-force protection.
  await fastify.register(
    async (authFastify) => {
      await authFastify.register(rateLimit, {
        max: 20,
        timeWindow: '15 minutes',
        // Exempt read-only informational endpoints that are polled on every page load
        allowList: (request) => {
          const path = request.url.replace(/\?.*$/, '')
          return path.endsWith('/me') || path.endsWith('/providers')
        },
        errorResponseBuilder: () => ({
          error: { message: 'Too many requests, please try again later', code: 'RATE_LIMITED' },
        }),
      })
      await authFastify.register(authRoutes)
      await authFastify.register(enterpriseAuthRoutes)
    },
    { prefix: '/api/v1/auth' },
  )

  // ─── Routes ────────────────────────────────────────────────────────────────
  await fastify.register(buildingRoutes, { prefix: '/api/v1/buildings' })
  await fastify.register(floorRoutes, { prefix: '/api/v1/floors' })
  await fastify.register(zoneRoutes, { prefix: '/api/v1/zones' })
  await fastify.register(zoneGroupRoutes, { prefix: '/api/v1/zone-groups' })
  await fastify.register(bookingRoutes, { prefix: '/api/v1/bookings' })
  await fastify.register(queueRoutes, { prefix: '/api/v1/queue' })
  await fastify.register(userRoutes, { prefix: '/api/v1/users' })
  await fastify.register(notificationRoutes, { prefix: '/api/v1/notifications' })
  await fastify.register(assetRoutes, { prefix: '/api/v1/assets' })
  await fastify.register(analyticsRoutes, { prefix: '/api/v1/analytics' })
  await fastify.register(leaseRoutes, { prefix: '/api/v1/leases' })
  await fastify.register(groupRoutes, { prefix: '/api/v1/groups' })
  await fastify.register(settingsRoutes, { prefix: '/api/v1/settings' })
  await fastify.register(importRoutes, { prefix: '/api/v1/import' })
  await fastify.register(subscriptionRoutes, { prefix: '/api/v1/subscriptions' })
  await fastify.register(scimRoutes, { prefix: '/scim/v2' })

  // ─── Health check ──────────────────────────────────────────────────────────
  fastify.get('/health', async (_request, reply) => {
    return reply.status(200).send({ status: 'ok', timestamp: new Date().toISOString() })
  })

  // ─── Global error handler ──────────────────────────────────────────────────
  fastify.setErrorHandler((error, _request, reply) => {
    fastify.log.error(error)

    if (error.validation) {
      return reply.status(400).send({
        error: { message: 'Validation error', code: 'VALIDATION_ERROR', details: error.validation },
      })
    }

    if (error.statusCode) {
      // Only surface the original message for 4xx client errors.
      // For 5xx, use a generic message to avoid leaking internal details.
      const message = error.statusCode < 500 ? error.message : 'Internal server error'
      return reply.status(error.statusCode).send({
        error: { message, code: 'REQUEST_ERROR' },
      })
    }

    return reply.status(500).send({
      error: { message: 'Internal server error', code: 'INTERNAL_ERROR' },
    })
  })

  // ─── Graceful shutdown hook ────────────────────────────────────────────────
  fastify.addHook('onClose', async () => {
    const boss = getBoss()
    try {
      await boss.stop()
      fastify.log.info('pg-boss stopped')
    } catch (err) {
      fastify.log.warn({ err }, 'pg-boss stop error')
    }
  })

  return fastify
}
