import { HydratedRouter } from "react-router/dom"
import { startTransition, StrictMode } from "react"
import { hydrateRoot } from "react-dom/client"
import { registerSW } from "virtual:pwa-register"

// beforeinstallprompt fires early in page load — before React hydrates and
// before useEffect can attach a listener. Capture it globally here so the
// PWAInstallPrompt component can read it after mount.
if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault()
    ;(window as any).__pwaInstallPrompt = e
  }, { once: true })
}

startTransition(() => {
  hydrateRoot(
    document,
    <StrictMode>
      <HydratedRouter />
    </StrictMode>,
  )
})

if (typeof window !== "undefined") {
  if (import.meta.env.DEV) {
    // Don't run a service worker in dev. Also unregister any leftover dev SW
    // from a previous config — the older `navigateFallback: "/"` setup
    // cached the SSR HTML and replayed an "anonymous" page on every refresh,
    // which silently logged the authed user out from the UI's perspective.
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.getRegistrations().then(regs => {
        regs.forEach(r => r.unregister())
      }).catch(() => { /* ignore */ })
    }
  } else {
    // Force-check for a new service worker regularly. Without this, an
    // already-open PWA session (common on mobile — the app stays resident in
    // the background instead of fully closing) can go a long time relying
    // only on the browser's own update heuristic (next navigation, or once
    // every 24h), so stale clients keep running old bundles — e.g. still
    // showing removed/old bet-limit options — long after a deploy. Once an
    // update is found, registerSW's own "activated" handler (registerType:
    // autoUpdate) reloads the page automatically.
    registerSW({
      immediate: true,
      onRegisteredSW(_url, registration) {
        if (!registration) return
        registration.update().catch(() => { /* ignore */ })
        setInterval(() => {
          registration.update().catch(() => { /* ignore */ })
        }, 60_000)
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible') {
            registration.update().catch(() => { /* ignore */ })
          }
        })
      },
    })
  }
}
