import { PrismaClient } from '@prisma/client'

// ── Connection-pool cap (critical for Vercel serverless) ─────────────────────
// Each serverless instance opens its OWN Mongo connection pool. With no cap,
// Prisma defaults to (num_cpus * 2 + 1) connections per instance, and Vercel
// spins up many instances under load — so total connections explode past the
// Atlas limit (we saw 198%+ of the configured limit). When Atlas hits the cap
// it CLEARS pools, which surfaces as the "connection pool cleared …
// RetryableWriteError" crash on every query.
//
// Fix: force a small pool per instance and reap idle connections quickly so
// scaled-down instances release them. Applied here in code (not just the env
// var) so the cap ships with the deploy and can't be forgotten. Any params
// already present in DATABASE_URL win.
function buildDatabaseUrl(): string | undefined {
  const raw = process.env.DATABASE_URL
  if (!raw) return undefined

  // Work on the string directly — running a mongodb+srv URL through the URL
  // class and re-serializing can mangle encoding. We only touch the query part.
  let s = raw.trim()

  // Heal an accidental double "?" (e.g. a param block pasted after the string
  // already had one): every "?" after the first must be "&". Passwords in the
  // URL are percent-encoded, so a literal "?" here is always a query separator.
  const firstQ = s.indexOf('?')
  if (firstQ !== -1) {
    s = s.slice(0, firstQ + 1) + s.slice(firstQ + 1).replace(/\?/g, '&')
  }

  const hasParam = (k: string) =>
    new RegExp(`[?&]${k}=`, 'i').test(s) // already present (any case) → leave it
  const append = (k: string, v: string) => {
    if (hasParam(k)) return
    s += (s.includes('?') ? '&' : '?') + `${k}=${v}`
  }

  // Pool size depends ENTIRELY on the deployment model:
  //   • Single always-on server (Docker/VPS): ONE process serves ALL traffic,
  //     so it needs a LARGE pool (20-50) or requests starve each other.
  //   • Serverless (Vercel): MANY instances, each with its own pool, so each
  //     must be SMALL (e.g. 3) to stay under the Atlas connection limit.
  // Set DB_MAX_POOL_SIZE per deployment. Default suits a single server; a
  // serverless deploy should set DB_MAX_POOL_SIZE=3.
  append('maxPoolSize', process.env.DB_MAX_POOL_SIZE || '20')
  // Keep a connection alive through normal click-to-click pauses so we don't
  // re-do the TLS handshake to Atlas on every navigation.
  append('maxIdleTimeMS', '60000')
  // Wait a reasonable time for a free connection before erroring, so brief
  // bursts don't surface to users as "site busy" errors.
  append('waitQueueTimeoutMS', '15000')

  return s
}

// Single Prisma instance per process. Prevents "too many connections" during
// dev HMR (Vite re-evaluates modules on change, which would re-instantiate).
const globalForPrisma = globalThis as unknown as { __prisma?: PrismaClient }

export const prisma = globalForPrisma.__prisma ?? new PrismaClient({
  log: process.env.NODE_ENV === 'production' ? ['warn', 'error'] : ['warn', 'error'],
  datasourceUrl: buildDatabaseUrl(),
})

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.__prisma = prisma
}
