import { reactRouter } from "@react-router/dev/vite"
import tailwindcss from "@tailwindcss/vite"
import { defineConfig } from "vite"
import tsconfigPaths from "vite-tsconfig-paths"
import { VitePWA } from "vite-plugin-pwa"

export default defineConfig({
  // Allow tunneling the dev server through ngrok (host check off for these).
  // NOTE: push notifications still require the production build (`npm run
  // start:local`) — the service worker is disabled in dev.
  server: { allowedHosts: ['.ngrok-free.app', '.ngrok-free.dev', '.ngrok.io'] },
  plugins: [
    tailwindcss(),
    reactRouter(),
    tsconfigPaths(),
    VitePWA({
      registerType: "autoUpdate",
      injectRegister: null,
      includeAssets: ["favicon.png", "apple-icon.png", "icon-192.png", "icon-512.png", "symbols/*.jpg"],
      manifest: {
        name: "Fish Prawn Crab Game",
        short_name: "Pupatao",
        description: "Traditional Asian dice betting game",
        theme_color: "#1e0040",
        background_color: "#3b0764",
        display: "standalone",
        orientation: "portrait",
        start_url: "/",
        scope: "/",
        icons: [
          { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
          { src: "/apple-icon.png", sizes: "180x180", type: "image/png", purpose: "any" },
        ],
      },
      workbox: {
        // Precache static assets only — never HTML. HTML is server-rendered
        // per-request with the auth user baked in (root loader), so caching
        // it would replay a stale "anonymous" page on refresh and silently
        // log the user out from the UI's perspective.
        globPatterns: ["**/*.{js,css,svg,png,jpg,ico,webmanifest}"],
        // Purge previous builds' precached assets when the SW updates, so old
        // clients don't cling to dead asset hashes after a redeploy.
        cleanupOutdatedCaches: true,
        // No navigateFallback — let every navigation hit the network so the
        // SSR payload (user, wallet) is always fresh.
        //
        // Pull our push-notification handlers (push / notificationclick) into
        // the generated service worker. The file lives in /public.
        importScripts: ["/push-sw.js"],
      },
      // SW disabled in dev. Re-enable later only after we have a strategy
      // that doesn't cache authed HTML.
      devOptions: { enabled: false },
    }),
  ],
  ssr: { external: ['@prisma/client', '.prisma/client', 'bcryptjs', 'pusher', 'web-push'] },
})
