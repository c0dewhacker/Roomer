import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { QueryClientProvider } from '@tanstack/react-query'
import { Toaster } from 'sonner'
import { registerSW } from 'virtual:pwa-register'
import App from './App'
import { queryClient } from './lib/queryClient'
import { ThemeProvider } from './components/ThemeProvider'
import { ErrorBoundary } from './components/ErrorBoundary'
import './index.css'

// vite.config.ts's registerType: 'autoUpdate' has no effect unless something
// actually asks the browser to look for a new service worker — its own
// native check is infrequent (roughly once a day, or on a hard navigation),
// so a tab left open across a deploy (a kiosk-style shared desk-booking
// screen is exactly the case this app has to support) could otherwise run a
// stale build for a long time. Polling here is what makes "ship updates ASAP"
// actually true; onNeedReload's default (a full page reload once the new SW
// takes over) is fine for a tool like this — better than staying stale.
registerSW({
  immediate: true,
  onRegisteredSW(_url, registration) {
    if (!registration) return
    setInterval(() => registration.update(), 30 * 60 * 1000)
  },
})

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <ThemeProvider>
            <App />
          </ThemeProvider>
          <Toaster position="top-right" richColors />
        </BrowserRouter>
      </QueryClientProvider>
    </ErrorBoundary>
  </React.StrictMode>,
)
