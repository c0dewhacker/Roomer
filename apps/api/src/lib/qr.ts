import { QrCheckInMode } from '@prisma/client'
import { prisma } from './prisma.js'

/**
 * Resolve the effective QR check-in mode for an asset: floor override →
 * building override → org default. Same resolution order as no-show
 * release (see handleReleaseNoShows in queue.ts) — kept as a single-asset
 * helper here since callers needing this (the QR scan-landing endpoint) look
 * up one asset at a time, unlike the no-show job's bulk pass.
 */
export async function resolveQrCheckInMode(assetId: string): Promise<QrCheckInMode> {
  const asset = await prisma.asset.findUnique({
    where: { id: assetId },
    select: {
      floor: {
        select: {
          qrCheckInMode: true,
          building: {
            select: {
              qrCheckInMode: true,
              organisation: { select: { qrCheckInMode: true } },
            },
          },
        },
      },
    },
  })
  if (!asset) return QrCheckInMode.DISABLED
  return (
    asset.floor?.qrCheckInMode ??
    asset.floor?.building?.qrCheckInMode ??
    asset.floor?.building?.organisation?.qrCheckInMode ??
    QrCheckInMode.DISABLED
  )
}
