import { z } from 'zod'

export const createQueueEntrySchema = z.object({
  assetId: z.string().min(1, 'Invalid asset ID'),
  wantedStartsAt: z.string().datetime('wantedStartsAt must be a valid ISO 8601 datetime'),
  wantedEndsAt: z.string().datetime('wantedEndsAt must be a valid ISO 8601 datetime'),
  expiresAt: z.string().datetime('expiresAt must be a valid ISO 8601 datetime'),
}).refine(
  (data) => new Date(data.wantedStartsAt) < new Date(data.wantedEndsAt),
  { message: 'wantedStartsAt must be before wantedEndsAt', path: ['wantedStartsAt'] },
).refine(
  (data) => new Date(data.expiresAt) > new Date(),
  { message: 'expiresAt must be in the future', path: ['expiresAt'] },
)

export type CreateQueueEntryInput = z.infer<typeof createQueueEntrySchema>
