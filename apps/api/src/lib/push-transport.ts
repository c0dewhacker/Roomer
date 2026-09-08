import https from 'node:https'
import type { LookupFunction } from 'node:net'
import webpush from 'web-push'
import { resolveValidatedHost, type ValidatedHost } from './url-safety.js'

/** DNS is resolved exactly once; TLS still verifies the original hostname. */
export function pinnedLookup(host: ValidatedHost): LookupFunction {
  return (_hostname, options, callback) => {
    if (typeof options === 'object' && options.all) {
      callback(null, [host])
    } else {
      callback(null, host.address, host.family)
    }
  }
}

export async function sendPinnedPush(subscription: webpush.PushSubscription, body: string): Promise<void> {
  const host = await resolveValidatedHost(subscription.endpoint, ['https:'], false)
  const agent = new https.Agent({ lookup: pinnedLookup(host), maxSockets: 1 })
  // An absolute deadline also bounds peers that keep a socket active forever.
  const deadline = setTimeout(() => agent.destroy(), 15_000)
  try {
    await webpush.sendNotification(subscription, body, { agent, timeout: 10_000 })
  } finally {
    clearTimeout(deadline)
    agent.destroy()
  }
}
