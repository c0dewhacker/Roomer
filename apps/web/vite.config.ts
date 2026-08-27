import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import path from 'path'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      // Ship SW updates as soon as they're available rather than waiting for
      // every tab to close — for a daily-use internal tool, a stale JS
      // bundle silently drifting from the API's current shape is worse than
      // a client refresh landing mid-session.
      registerType: 'autoUpdate',
      // Registered manually in main.tsx via virtual:pwa-register instead —
      // 'auto' injected a bare navigator.serviceWorker.register() with no
      // periodic update check and no reload-on-activate, so registerType:
      // 'autoUpdate' above had nothing wiring it up: the browser's own
      // (rarely-triggered) native check was the only thing that ever
      // noticed a new SW existed, so a kiosk tab left open indefinitely
      // could run a stale build for a long time despite this setting's own
      // stated intent below. main.tsx's manual registration polls for
      // updates and reloads once a new version actually takes over.
      injectRegister: false,
      // Hand-written service worker (src/sw.ts) instead of the default
      // auto-generated one — phase 2 needs push/notificationclick event
      // listeners, which generateSW's workbox config has no hook for.
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      manifest: {
        name: 'Roomer',
        short_name: 'Roomer',
        description: 'Desk and room booking',
        start_url: '/',
        display: 'standalone',
        background_color: '#ffffff',
        theme_color: '#6366f1',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icons/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      injectManifest: {
        // Same app-shell-only precache scope as phase 1 — src/sw.ts's own
        // NavigationRoute denylist keeps /api/** out of the SPA fallback too.
        globPatterns: ['**/*.{js,css,html,png,svg,webmanifest}'],
        // globPatterns above is unscoped by directory, so without this it
        // also precached every lazy ROUTE chunk (router.tsx's lazy() calls),
        // not just the shared shell — contradicting the comment above.  Most
        // of those are small enough not to matter, but two are not:
        // ReportsAdminPage (~430KB, a SUPER_ADMIN/BUILDING_ADMIN-only
        // sustainability/analytics report) and pdf.worker.min (~1.26MB,
        // pdfjs-dist's worker — only ever fetched, even for a regular user,
        // at the moment a floor plan happens to be uploaded as a PDF rather
        // than an image; see FloorPlanCanvas.tsx's `?url` import). Forcing
        // ~1.7MB of admin/edge-case code into every visitor's SW install
        // meant install could fail/retry on a slow connection for exactly
        // the users who'd most benefit from a working precache, and
        // defeated the route-based code-splitting the app already does.
        // Deliberately NOT excluding FloorPlanCanvas/ReactKonva here even
        // though they're also large — every regular user views a floor plan
        // (the app's core action), so those genuinely belong in the
        // app-shell-equivalent precache; only add a chunk here if it's both
        // large AND narrowly-used, re-checking against a real `npm run
        // build` chunk-size list before assuming that of a new one.
        globIgnores: ['**/ReportsAdminPage-*.js', '**/pdf.worker.min-*.js'],
      },
      devOptions: {
        // Keep the SW out of `vite dev` entirely — this session's dev-proxy
        // workflow (see server.proxy in this file) has no need for it, and
        // a SW intercepting requests during local development is a common
        // source of "why is this stale" confusion.
        enabled: false,
      },
    }),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
  build: {
    rollupOptions: {
      output: {
        // Emit .mjs assets (e.g. the pdfjs worker) with a .js extension so
        // nginx serves them as application/javascript from its built-in
        // mime.types. Browsers load module scripts based on Content-Type,
        // not extension, so renaming is safe.
        assetFileNames: (assetInfo) => {
          const name = assetInfo.names?.[0] ?? ''
          if (name.endsWith('.mjs')) {
            return 'assets/[name]-[hash].js'
          }
          return 'assets/[name]-[hash][extname]'
        },
      },
    },
  },
})
