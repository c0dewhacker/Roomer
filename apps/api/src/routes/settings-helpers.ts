import fs from 'fs'
import { resolveStoragePath } from '../lib/storage.js'

export function redactSecrets(provider: 'OIDC' | 'SAML' | 'LDAP', config: Record<string, unknown>): Record<string, unknown> {
  const redacted = { ...config }
  if (provider === 'OIDC' && redacted.clientSecret) redacted.clientSecret = '**redacted**'
  if (provider === 'LDAP' && redacted.bindCredentials) redacted.bindCredentials = '**redacted**'
  return redacted
}

export async function serveUploadedFile(reply: import('fastify').FastifyReply, relativePath: string, notFoundMessage: string): Promise<void> {
  const absPath = resolveStoragePath(relativePath)
  try { await fs.promises.access(absPath, fs.constants.R_OK) } catch {
    reply.status(404).send({ error: { message: notFoundMessage, code: 'FILE_NOT_FOUND' } }); return
  }
  reply.header('Content-Type', 'image/png')
  reply.header('Cache-Control', 'public, max-age=300')
  reply.send(fs.createReadStream(absPath))
}
