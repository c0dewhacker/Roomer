import { NotificationType } from '@roomer/shared'

export const PUSH_ELIGIBLE_TYPES = new Set<NotificationType>([
  NotificationType.QUEUE_PROMOTED,
  NotificationType.BOOKING_REMINDER,
  NotificationType.FLOOR_AVAILABLE,
  NotificationType.BOOKING_TRANSFER_REQUESTED,
  NotificationType.BOOKING_SWAP_REQUESTED,
  NotificationType.QUEUE_CLAIM_EXPIRING,
  NotificationType.BOOKING_PENDING_APPROVAL,
])

export const PUSH_URL_KEYS = ['claimUrl', 'bookingUrl', 'floorUrl', 'queueUrl', 'bookingsUrl'] as const
export const CLAIM_DEADLINE_MS = 2 * 60 * 60 * 1000
export const CLAIM_WARNING_WINDOW_MS = 30 * 60 * 1000
export const FLOOR_NOTIFICATION_LOCK_CLASS = 4244
