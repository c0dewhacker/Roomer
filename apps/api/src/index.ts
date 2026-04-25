import './env' // Validate env vars on startup — exits process if invalid
import { ensureUploadDirs } from './lib/storage'
import { startQueue } from './lib/queue'
import { buildApp } from './app'
import { env } from './env'
async function main(): Promise<void> {
  // 1. Ensure upload directories exist
  await ensureUploadDirs()
  console.log('[startup] Upload directories ready')

  // 2. Start pg-boss queue workers
  await startQueue()
  console.log('[startup] Queue workers started')

  // 3. Build Fastify app
  const app = await buildApp()

  // 4. Graceful shutdown handler
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

  // 5. Listen
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
