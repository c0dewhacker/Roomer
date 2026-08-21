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
      injectRegister: 'auto',
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
