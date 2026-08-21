import type { Prisma, PrismaClient } from '@prisma/client'
import type { FastifyBaseLogger } from 'fastify'

type AuditClient = PrismaClient | Prisma.TransactionClient

export interface AuditEntryInput {
  /** Null for a system/cron/SCIM-driven change with no requesting human actor. */
  actorId: string | null
  /** Lowercase dot notation, matching the WebhookEvent naming convention (e.g. 'asset.updated'). */
  action: string
  /** Prisma model name, PascalCase (e.g. 'Asset'). */
  resourceType: string
  resourceId: string
  before?: Prisma.InputJsonValue | null
  after?: Prisma.InputJsonValue | null
  ipAddress?: string | null
}

/**
 * Records one audit-log row. Accepts either the singleton PrismaClient or a
 * transaction's `tx` client — pass `tx` from inside `prisma.$transaction(async
 * (tx) => {...})` so the audit row commits (or rolls back) atomically with the
 * mutation it describes; pass the singleton otherwise.
 *
 * Deliberately never throws — an audit-write failure must never fail the
 * parent mutation (same non-blocking philosophy as dispatchWebhook), but
 * unlike webhook delivery this logs failures loudly rather than swallowing
 * them, since a missing audit row is a compliance gap, not a missed
 * integration event.
 */
export async function recordAuditLog(
  client: AuditClient,
  entry: AuditEntryInput,
  logger?: Pick<FastifyBaseLogger, 'error'>,
): Promise<void> {
  try {
    await client.auditLog.create({
      data: {
        actorId: entry.actorId,
        action: entry.action,
        resourceType: entry.resourceType,
        resourceId: entry.resourceId,
        before: entry.before ?? undefined,
        after: entry.after ?? undefined,
        ipAddress: entry.ipAddress ?? undefined,
      },
    })
  } catch (err) {
    ;(logger ?? console).error({ err, entry }, 'audit log write failed')
  }
}
