import Fastify, { type FastifyInstance, type FastifyError } from 'fastify'
import helmet from '@fastify/helmet'
import cors from '@fastify/cors'
import formbody from '@fastify/formbody'
import multipart from '@fastify/multipart'
import rateLimit from '@fastify/rate-limit'
import swagger from '@fastify/swagger'
import swaggerUi from '@fastify/swagger-ui'
import { env } from './env.js'
import authPlugin from './plugins/auth.js'
import { authRoutes } from './routes/auth.js'
import { buildingRoutes } from './routes/buildings.js'
import { floorRoutes } from './routes/floors.js'
import { zoneRoutes, zoneGroupRoutes } from './routes/zones.js'
import { bookingRoutes } from './routes/bookings.js'
import { queueRoutes } from './routes/queue.js'
import { userRoutes } from './routes/users.js'
import { notificationRoutes } from './routes/notifications.js'
import { assetRoutes } from './routes/assets.js'
import { analyticsRoutes } from './routes/analytics.js'
import { leaseRoutes } from './routes/leases.js'
import { groupRoutes } from './routes/groups.js'
import { settingsRoutes } from './routes/settings.js'
import { enterpriseAuthRoutes } from './routes/auth-enterprise.js'
import { importRoutes } from './routes/import.js'
import { scimRoutes } from './routes/scim.js'
import { departmentRoutes } from './routes/departments.js'
import { subscriptionRoutes } from './routes/subscriptions.js'
import { recurringBookingRoutes } from './routes/recurring.js'
import { webhookRoutes } from './routes/webhooks.js'
import { directoryRoutes } from './routes/directory.js'
import { orgRoutes } from './routes/org.js'
import { getBoss } from './lib/queue.js'
import { prisma } from './lib/prisma.js'
import { register, httpRequestDuration, setupMetrics } from './lib/metrics.js'
import { randomUUID } from 'crypto'

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

  // ─── Global error handler ──────────────────────────────────────────────────
  // Registered before any route plugin so every encapsulated child context
  // (each route file is registered via fastify.register(), which creates a
  // new encapsulation boundary) resolves to this handler rather than
  // Fastify's own default, which echoes the raw error message — including
  // internal details like DB engine errors — straight back to the client.
  fastify.setErrorHandler((error: FastifyError | Error, _request, reply) => {
    fastify.log.error(error)
    const fastifyError = error as FastifyError

    if (fastifyError.validation) {
      return reply.status(400).send({
        error: { message: 'Validation error', code: 'VALIDATION_ERROR', details: fastifyError.validation },
      })
    }

    if (fastifyError.statusCode) {
      // Only surface the original message for 4xx client errors.
      // For 5xx, use a generic message to avoid leaking internal details.
      const message = fastifyError.statusCode < 500 ? fastifyError.message : 'Internal server error'
      return reply.status(fastifyError.statusCode).send({
        error: { message, code: 'REQUEST_ERROR' },
      })
    }

    return reply.status(500).send({
      error: { message: 'Internal server error', code: 'INTERNAL_ERROR' },
    })
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
          { name: 'Subscriptions', description: 'Floor availability subscriptions and notifications' },
          { name: 'Recurring Bookings', description: 'Weekly recurring booking rules and series management' },
          { name: 'Departments', description: 'Department hierarchy and user membership (admin only)' },
          { name: 'Webhooks', description: 'Webhook endpoint management and delivery log (super admin only)' },
          { name: 'Directory', description: 'Colleague finder / "who is in" whereabouts lookup' },
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
    // Key by source IP only. This previously keyed authenticated requests by
    // their raw auth-token string instead, on the theory that binding the
    // budget to the credential stops one compromised token from exhausting
    // the IP budget shared by other users behind a NAT — but the token is
    // never validated at this point in the request lifecycle (that only
    // happens once a route's own requireAuth preHandler runs, well after
    // rate-limit accounting), so a client could send a fresh/random
    // Authorization or cookie value on every request and get a brand-new
    // bucket each time. Verified live: 5 requests with 5 different bogus
    // bearer tokens each returned a fresh x-ratelimit-remaining: 299,
    // completely defeating the limiter. IP-only keying can't be evaded by
    // varying a header; per-credential granularity for the truly sensitive
    // routes (login, refresh, SSO callbacks) is already handled by the
    // separate, tighter, IP-keyed limiter on the auth sub-context below.
    keyGenerator: (req) => req.ip,
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

  // ─── x-request-id propagation ─────────────────────────────────────────────
  fastify.addHook('onRequest', (_request, reply, done) => {
    const existing = _request.headers['x-request-id']
    const id = (typeof existing === 'string' && existing.length > 0) ? existing : randomUUID()
    reply.header('x-request-id', id)
    done()
  })

  // ─── Metrics instrumentation ───────────────────────────────────────────────
  if (env.METRICS_ENABLED) {
    setupMetrics()
    fastify.addHook('onRequest', (request, _reply, done) => {
      ;(request as unknown as Record<string, unknown>)['_metricsTimer'] = httpRequestDuration.startTimer()
      done()
    })
    fastify.addHook('onResponse', (request, reply, done) => {
      const timer = (request as unknown as Record<string, unknown>)['_metricsTimer'] as ((labels: Record<string, string>) => void) | undefined
      timer?.({ method: request.method, route: request.routeOptions?.url ?? request.url, status_code: String(reply.statusCode) })
      done()
    })
  }

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
  await fastify.register(recurringBookingRoutes, { prefix: '/api/v1/recurring-bookings' })
  await fastify.register(scimRoutes, { prefix: '/scim/v2' })
  await fastify.register(departmentRoutes, { prefix: '/api/v1/departments' })
  await fastify.register(orgRoutes, { prefix: '/api/v1/org' })
  await fastify.register(webhookRoutes, { prefix: '/api/v1/webhooks' })
  await fastify.register(directoryRoutes, { prefix: '/api/v1/directory' })

  // ─── Health checks ─────────────────────────────────────────────────────────
  // /health/live — process is running (Kubernetes liveness probe)
  fastify.get('/health/live', { config: { rateLimit: false } }, async (_request, reply) => {
    return reply.status(200).send({ status: 'ok' })
  })

  // /health/ready — DB is reachable (Kubernetes readiness probe)
  fastify.get('/health/ready', { config: { rateLimit: false } }, async (_request, reply) => {
    try {
      await prisma.$queryRaw`SELECT 1`
      return reply.status(200).send({ status: 'ok', db: 'ok' })
    } catch (err) {
      fastify.log.error(err, 'health/ready check failed')
      return reply.status(503).send({ status: 'error', db: 'error' })
    }
  })

  // /health — alias for /health/ready (backwards compatibility)
  fastify.get('/health', { config: { rateLimit: false } }, async (_request, reply) => {
    try {
      await prisma.$queryRaw`SELECT 1`
      return reply.status(200).send({ status: 'ok', timestamp: new Date().toISOString() })
    } catch {
      return reply.status(503).send({ status: 'error' })
    }
  })

  // ─── Prometheus metrics ────────────────────────────────────────────────────
  if (env.METRICS_ENABLED) {
    fastify.get('/metrics', { config: { rateLimit: false } }, async (request, reply) => {
      // Optional bearer-token protection. When METRICS_TOKEN is unset the endpoint
      // is unauthenticated and must be protected at the network/ingress level.
      if (env.METRICS_TOKEN) {
        const auth = request.headers.authorization
        if (auth !== `Bearer ${env.METRICS_TOKEN}`) {
          return reply.status(401).header('WWW-Authenticate', 'Bearer').send({
            error: { message: 'Unauthorized', code: 'UNAUTHENTICATED' },
          })
        }
      }
      const content = await register.metrics()
      return reply.status(200).header('Content-Type', register.contentType).send(content)
    })
  }

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
