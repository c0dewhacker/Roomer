import dnsPromises from 'dns/promises'
import net from 'net'

// Node's address parser handles compressed and IPv4-mapped IPv6 consistently.
const alwaysBlocked = new net.BlockList()
for (const [address, prefix] of [
  ['127.0.0.0', 8], ['169.254.0.0', 16], ['0.0.0.0', 8],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) alwaysBlocked.addSubnet(address, prefix, 'ipv4')
alwaysBlocked.addAddress('::', 'ipv6')
alwaysBlocked.addAddress('::1', 'ipv6')
alwaysBlocked.addSubnet('fe80::', 10, 'ipv6')
alwaysBlocked.addSubnet('ff00::', 8, 'ipv6')
alwaysBlocked.addSubnet('100::', 64, 'ipv6')
alwaysBlocked.addSubnet('2001:db8::', 32, 'ipv6')

const privateAddresses = new net.BlockList()
for (const [address, prefix] of [
  ['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16], ['100.64.0.0', 10],
] as const) privateAddresses.addSubnet(address, prefix, 'ipv4')
privateAddresses.addSubnet('fc00::', 7, 'ipv6')

function ipIsBlocked(ip: string, allowPrivate: boolean): boolean {
  const version = net.isIP(ip)
  if (!version) return true
  const family = version === 4 ? 'ipv4' : 'ipv6'
  return alwaysBlocked.check(ip, family) || (!allowPrivate && privateAddresses.check(ip, family))
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

  // URL.hostname wraps an IPv6 literal in brackets (e.g. "[::1]"), which
  // net.isIP() doesn't recognise as an IP at all — left unstripped, every
  // literal IPv6 host (blocked or legitimately public) fell through to the
  // dns.lookup() branch below with the brackets still attached, which always
  // throws ENOTFOUND. That happened to fail closed (no SSRF bypass), but it
  // meant no IPv6 literal could ever be registered, even a legitimate public
  // one, and surfaced a raw Node DNS error instead of a clean validation
  // message.
  const ipLiteral = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
  const literalFamily = net.isIP(ipLiteral)
  if (literalFamily) {
    if (ipIsBlocked(ipLiteral, allowPrivate)) throw new Error('URL resolves to a disallowed address')
    return { address: ipLiteral, family: literalFamily as 4 | 6 }
  }

  // A hung/slow DNS resolver for the target host would otherwise block this
  // lookup indefinitely — callers doing a live fetch afterward should still
  // apply their own request timeout on top of this.
  let timer: ReturnType<typeof setTimeout> | undefined
  const records = await Promise.race([
    dnsPromises.lookup(host, { all: true }),
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('DNS lookup for URL timed out')), 5000) }),
  ]).finally(() => clearTimeout(timer))
  if (records.length === 0) throw new Error('URL host could not be resolved')
  for (const { address } of records) {
    if (ipIsBlocked(address, allowPrivate)) throw new Error('URL resolves to a disallowed address')
  }
  return { address: records[0].address, family: records[0].family as 4 | 6 }
}
