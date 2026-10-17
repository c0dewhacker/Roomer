import { openStoredFile } from '../lib/storage.js'

export function redactSecrets(provider: 'OIDC' | 'SAML' | 'LDAP', config: Record<string, unknown>): Record<string, unknown> {
  const redacted = { ...config }
  if (provider === 'OIDC' && redacted.clientSecret) redacted.clientSecret = '**redacted**'
  if (provider === 'LDAP' && redacted.bindCredentials) redacted.bindCredentials = '**redacted**'
  return redacted
}

// Returns the reply so async route handlers can `return` it: resolving to
// undefined while a stream is still being piped lets Fastify finish the
// response a second time ("write after end").
export async function serveUploadedFile(reply: import('fastify').FastifyReply, relativePath: string, notFoundMessage: string): Promise<import('fastify').FastifyReply> {
  const stream = await openStoredFile(relativePath)
  if (!stream) {
    return reply.status(404).send({ error: { message: notFoundMessage, code: 'FILE_NOT_FOUND' } })
  }
  reply.header('Content-Type', 'image/png')
  reply.header('Cache-Control', 'public, max-age=300')
  return reply.send(stream)
}
