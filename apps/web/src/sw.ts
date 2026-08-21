/// <reference lib="webworker" />
import { precacheAndRoute, createHandlerBoundToURL } from 'workbox-precaching'
import { registerRoute, NavigationRoute } from 'workbox-routing'

declare const self: ServiceWorkerGlobalScope

// injectManifest mode: vite-plugin-pwa replaces this with the actual build's
// precache list (content-hashed per file, so a new deploy naturally
// invalidates only what changed) — same app-shell-only precaching as phase 1,
// just hand-written instead of workbox's auto-generated NavigationRoute.
precacheAndRoute(self.__WB_MANIFEST)

// SPA fallback: any navigation not matching a precached file (i.e. every
// client-side route, /bookings/123 etc.) serves the precached index.html so
// deep links still load the shell offline. /api/** is excluded — it's never
// a navigation request anyway (fetch, not a page load), but excluding it
// explicitly keeps this in sync with phase 1's intent: API responses are
// never served from a cache, online or off.
const navigationHandler = createHandlerBoundToURL('index.html')
registerRoute(new NavigationRoute(navigationHandler, { denylist: [/^\/api\//] }))

self.skipWaiting()
self.clients.claim()

interface PushPayload {
  title: string
  body: string
  url?: string
}

self.addEventListener('push', (event) => {
  if (!event.data) return
  let payload: PushPayload
  try {
    payload = event.data.json() as PushPayload
  } catch {
    return
  }
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      data: { url: payload.url ?? '/' },
    }),
  )
})

// Clicking the notification focuses an already-open tab on the target URL if
// one exists, rather than always opening a new one — a user who already has
// the app open shouldn't end up with two tabs.
self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = (event.notification.data as { url?: string } | undefined)?.url ?? '/'
  event.waitUntil(
    (async () => {
      const clientsList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      const target = new URL(url, self.location.origin).href
      for (const client of clientsList) {
        if (client.url === target && 'focus' in client) {
          await (client as WindowClient).focus()
          return
        }
      }
      await self.clients.openWindow(url)
    })(),
  )
})
