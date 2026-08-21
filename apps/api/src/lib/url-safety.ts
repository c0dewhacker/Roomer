import dnsPromises from 'dns/promises'
import net from 'net'

/** True for loopback / link-local / unspecified addresses — always blocked, no override. */
function isAlwaysBlockedIp(ip: string): boolean {
  const v = ip.startsWith('::ffff:') ? ip.slice(7) : ip // unwrap IPv4-mapped IPv6
  if (net.isIPv4(v)) {
    const o = v.split('.').map(Number)
    if (o[0] === 127) return true                    // 127.0.0.0/8 loopback
    if (o[0] === 169 && o[1] === 254) return true    // 169.254.0.0/16 link-local (cloud metadata)
    if (o[0] === 0) return true                      // 0.0.0.0/8
    return false
  }
  const lower = ip.toLowerCase()
  if (lower === '::1' || lower === '::') return true  // loopback / unspecified
  if (lower.startsWith('fe80')) return true           // link-local
  return false
}

/** True for RFC1918 / ULA / CGNAT ranges — blocked unless the caller opts in. */
function isPrivateIp(ip: string): boolean {
  const v = ip.startsWith('::ffff:') ? ip.slice(7) : ip
  if (net.isIPv4(v)) {
    const o = v.split('.').map(Number)
    if (o[0] === 10) return true                                   // 10.0.0.0/8
    if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true      // 172.16.0.0/12
    if (o[0] === 192 && o[1] === 168) return true                  // 192.168.0.0/16
    if (o[0] === 100 && o[1] >= 64 && o[1] <= 127) return true     // 100.64.0.0/10 CGNAT
    return false
  }
  const lower = ip.toLowerCase()
  return lower.startsWith('fc') || lower.startsWith('fd')          // fc00::/7 ULA
}

function ipIsBlocked(ip: string, allowPrivate: boolean): boolean {
  if (isAlwaysBlockedIp(ip)) return true
  if (!allowPrivate && isPrivateIp(ip)) return true
  return false
}

export interface ValidatedHost {
  address: string
  family: 4 | 6
}

/**
 * Resolve `rawUrl`'s host and reject internal/reserved addresses (SSRF guard).
 * Shared by both webhook delivery (lib/webhook.ts) and push-subscription
 * endpoints (routes/push.ts) — loopback/link-local/metadata addresses are
 * always blocked; RFC1918/ULA/CGNAT ranges are blocked unless the caller
 * explicitly opts in via `allowPrivate` (webhook.ts does, gated on
 * ROOMER_WEBHOOK_ALLOW_PRIVATE for internal integrations; push
 * subscriptions never do — a browser's push endpoint has no legitimate
 * reason to be an internal address).
 */
export async function resolveValidatedHost(rawUrl: string, allowedProtocols: readonly string[], allowPrivate: boolean): Promise<ValidatedHost> {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new Error('Invalid URL')
  }
  if (!allowedProtocols.includes(url.protocol)) {
    throw new Error(`URL must use ${allowedProtocols.join(' or ')}`)
  }
  const host = url.hostname
  if (host === 'localhost') throw new Error('URL host is not allowed')

  const literalFamily = net.isIP(host)
  if (literalFamily) {
    if (ipIsBlocked(host, allowPrivate)) throw new Error('URL resolves to a disallowed address')
    return { address: host, family: literalFamily as 4 | 6 }
  }

  // A hung/slow DNS resolver for the target host would otherwise block this
  // lookup indefinitely — callers doing a live fetch afterward should still
  // apply their own request timeout on top of this.
  const records = await Promise.race([
    dnsPromises.lookup(host, { all: true }),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('DNS lookup for URL timed out')), 5000)),
  ])
  if (records.length === 0) throw new Error('URL host could not be resolved')
  for (const { address } of records) {
    if (ipIsBlocked(address, allowPrivate)) throw new Error('URL resolves to a disallowed address')
  }
  return { address: records[0].address, family: records[0].family as 4 | 6 }
}
