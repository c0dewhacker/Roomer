import { Registry, collectDefaultMetrics, Counter, Histogram } from 'prom-client'

export const register = new Registry()

export const httpRequestDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [register],
})

/**
 * Outcome of every attempted web-push delivery (#341).
 *
 * Push delivery is deliberately best-effort — the same philosophy as email —
 * so an individual failure is not retried and has no per-notification audit
 * trail. That is a reasonable trade for a convenience channel, but it left a
 * *systemic* failure completely invisible: a mistyped VAPID key or a push
 * service outage silently dropped every notification for every user, and
 * nothing surfaced it. A counter (rather than a log line alone) is what makes
 * that alertable, since the useful signal is a sustained *rate*, e.g.
 *
 *   rate(roomer_push_delivery_total{outcome="failed"}[15m])
 *     / rate(roomer_push_delivery_total[15m]) > 0.5
 *
 * `expired` is tracked separately from `failed` on purpose: a 404/410 means
 * the browser dropped the subscription and we prune it, which is routine
 * churn, not a fault — folding it into `failed` would put a permanent
 * non-zero floor under exactly the ratio above and make it useless to alert on.
 */
export const pushDeliveryTotal = new Counter({
  name: 'roomer_push_delivery_total',
  help: 'Web-push delivery attempts by outcome (sent, failed, expired)',
  labelNames: ['outcome'],
  registers: [register],
})

export function setupMetrics(): void {
  collectDefaultMetrics({ register })
}
