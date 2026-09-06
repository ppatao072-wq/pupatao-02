import type { Config } from "@react-router/dev/config"
import { vercelPreset } from "@vercel/react-router/vite"

export default {
  ssr: true,
  // Apply the Vercel preset only on Vercel (VERCEL=1 is set during their build).
  // Locally it's omitted so `react-router build` emits the standard
  // build/server/index.js that `react-router-serve` (bun run start) can run —
  // needed to test the production build + service worker over ngrok.
  presets: process.env.VERCEL ? [vercelPreset()] : [],
  // React Router's built-in CSRF guard rejects every POST action (login,
  // logout, uploads, admin actions — ALL of them, regardless of route) with a
  // generic 400 "Bad Request" whenever the request's Origin header doesn't
  // match the Host header it sees. In the Docker/reverse-proxy deployment
  // (pupatao.com → Cloudflare → proxy → container), the proxy doesn't
  // necessarily forward the original host as-is, so the two never matched —
  // this is what caused every single form submission and fetcher action to
  // fail identically on the production Docker deploy. Vercel wasn't affected
  // because its own edge network sets these headers consistently.
  // "null" is included because some mobile browsers send a literal
  // `Origin: null` header for POST requests made from an installed/standalone
  // PWA (as opposed to a normal browser tab, which sends the real origin) —
  // observed specifically on live betting (/api/play-round) from a
  // home-screen-installed instance of this app. React Router treats that
  // string as a real (mismatching) origin, not as "no origin sent".
  allowedActionOrigins: ["pupatao.com", "www.pupatao.com", "null"],
} satisfies Config
