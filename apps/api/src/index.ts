import './env' // Validate env vars on startup — exits process if invalid
import { ensureUploadDirs } from './lib/storage'
import { startQueue } from './lib/queue'
import { buildApp } from './app'
import { env } from './env'
import { prisma } from './lib/prisma'

async function ensureSessionsTable(): Promise<void> {
  // connect-pg-simple's createTableIfMissing is unreliable — create explicitly
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "sessions" (
      "sid"    varchar        NOT NULL COLLATE "default",
      "sess"   json           NOT NULL,
      "expire" timestamp(6)   NOT NULL,
      CONSTRAINT "session_pkey" PRIMARY KEY ("sid") NOT DEFERRABLE INITIALLY IMMEDIATE
    );
  `)
  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "sessions" ("expire");
  `)
}

async function main(): Promise<void> {
  // 1. Ensure sessions table exists (connect-pg-simple won't do it reliably)
  await ensureSessionsTable()
  console.log('[startup] Sessions table ready')

  // 2. Ensure upload directories exist
  await ensureUploadDirs()
  console.log('[startup] Upload directories ready')

  // 3. Start pg-boss queue workers
  await startQueue()
  console.log('[startup] Queue workers started')

  // 4. Build Fastify app
  const app = await buildApp()

  // 5. Graceful shutdown handler
  const shutdown = async (signal: string): Promise<void> => {
    console.log(`[shutdown] Received ${signal}, shutting down gracefully...`)
    try {
      await app.close()
      console.log('[shutdown] Server closed')
      process.exit(0)
    } catch (err) {
      console.error('[shutdown] Error during shutdown:', err)
      process.exit(1)
    }
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))

  // 6. Listen
  try {
    await app.listen({ host: env.HOST, port: env.PORT })
    app.log.info(`Roomer API listening on http://${env.HOST}:${env.PORT}`)
    app.log.info(`API docs at http://${env.HOST}:${env.PORT}/docs`)
  } catch (err) {
    app.log.error(err)
    process.exit(1)
  }
}

main().catch((err) => {
  console.error('[startup] Fatal error:', err)
  process.exit(1)
})
