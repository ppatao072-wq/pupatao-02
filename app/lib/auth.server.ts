import crypto from 'node:crypto'
import bcrypt from 'bcryptjs'
import { redirect } from 'react-router'
import type { User } from '@prisma/client'
import { prisma } from './prisma.server'

const SESSION_COOKIE = 'pupatao_session'
const SESSION_TTL_DAYS = 30
const SESSION_TTL_SECONDS = SESSION_TTL_DAYS * 86_400

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex')
}

function buildSetCookie(value: string, maxAgeSeconds: number): string {
  const attrs = [
    `${SESSION_COOKIE}=${value}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ]
  if (process.env.NODE_ENV === 'production') attrs.push('Secure')
  return attrs.join('; ')
}

function parseCookies(header: string | null): Record<string, string> {
  if (!header) return {}
  const out: Record<string, string> = {}
  for (const raw of header.split(';')) {
    const eq = raw.indexOf('=')
    if (eq < 0) continue
    const k = raw.slice(0, eq).trim()
    const v = raw.slice(eq + 1).trim()
    if (k) out[k] = decodeURIComponent(v)
  }
  return out
}

// Issue a session + Set-Cookie and redirect the browser.
export async function createUserSession(userId: string, request: Request, redirectTo = '/') {
  const rawToken = crypto.randomBytes(32).toString('hex')
  const tokenHash = hashToken(rawToken)
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000)

  await prisma.session.create({
    data: {
      userId,
      tokenHash,
      expiresAt,
      userAgent: request.headers.get('user-agent') ?? undefined,
      ip: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || undefined,
    },
  })

  return redirect(redirectTo, {
    headers: { 'Set-Cookie': buildSetCookie(rawToken, SESSION_TTL_SECONDS) },
  })
}

// Read the cookie, look up the matching (non-revoked, non-expired) session,
// and return the associated user + that session's id. The session id changes
// on every fresh login (createUserSession always inserts a new Session row),
// so callers that want "show this once per login, not per page-refresh"
// (e.g. the referral campaign modal) can key their dismissal state to it.
export async function getCurrentUserWithSession(request: Request): Promise<{ user: User; sessionId: string } | null> {
  const cookies = parseCookies(request.headers.get('cookie'))
  const raw = cookies[SESSION_COOKIE]
  if (!raw) return null

  const tokenHash = hashToken(raw)
  // Fail CLOSED on a transient DB hiccup (treat as anonymous) rather than
  // letting it throw. This is called directly, unguarded by their own
  // try/catch, from many page loaders (history, profile, wallet, login,
  // register, competition, most api/* routes) — a raw throw here used to
  // crash the entire page/request into the generic error boundary. Never
  // grants access on uncertainty; worst case a logged-in user is treated as
  // signed out for one request.
  const session = await prisma.session.findUnique({
    where: { tokenHash },
    include: { user: true },
  }).catch(err => {
    console.error('[getCurrentUserWithSession] session lookup failed:', err)
    return null
  })
  if (!session || session.revokedAt) return null
  if (session.expiresAt.getTime() < Date.now()) return null
  if (session.user.status !== 'ACTIVE') return null

  // Best-effort `lastUsedAt` bump, throttled to once every 5 minutes per session.
  // The DB `lt` guard alone isn't enough: a BURST of concurrent requests from the
  // same session (e.g. a reconnection herd) all read the old timestamp, all fire
  // the update on the SAME document, and MongoDB returns WriteConflicts that the
  // driver retries — holding connections and worsening the pileup. The in-memory
  // guard below collapses that burst to a single DB write per session per window
  // (per instance), so concurrent requests never collide on the row.
  const STALE_MS = 5 * 60 * 1000
  if (Date.now() - session.lastUsedAt.getTime() > STALE_MS && claimSessionTouch(session.id)) {
    prisma.session
      .updateMany({
        where: {
          id: session.id,
          lastUsedAt: { lt: new Date(Date.now() - STALE_MS) },
        },
        data: { lastUsedAt: new Date() },
      })
      .catch(() => { /* ignore */ })
  }

  return { user: session.user, sessionId: session.id }
}

// Returns null for anonymous visitors.
export async function getCurrentUser(request: Request): Promise<User | null> {
  const result = await getCurrentUserWithSession(request)
  return result?.user ?? null
}

// In-memory (per-instance) throttle for the session `lastUsedAt` touch. Returns
// true at most once per 5 minutes per session id, so concurrent requests from the
// same session don't all issue the DB write (which caused WriteConflict storms).
const _sessionTouchAt = new Map<string, number>()
function claimSessionTouch(id: string): boolean {
  const now = Date.now()
  const last = _sessionTouchAt.get(id)
  if (last && now - last < 5 * 60 * 1000) return false
  _sessionTouchAt.set(id, now)
  // Bound memory: occasionally drop entries older than the window.
  if (_sessionTouchAt.size > 5000) {
    const cutoff = now - 5 * 60 * 1000
    for (const [k, t] of _sessionTouchAt) if (t < cutoff) _sessionTouchAt.delete(k)
  }
  return true
}

// Use in protected-route loaders. Throws a redirect to /login if anonymous.
export async function requireUser(request: Request): Promise<User> {
  const user = await getCurrentUser(request)
  if (!user) {
    const url = new URL(request.url)
    const next = encodeURIComponent(url.pathname + url.search)
    throw redirect(`/login?next=${next}`)
  }
  return user
}

// Revoke the current session + clear the cookie.
export async function logout(request: Request, redirectTo = '/login') {
  const cookies = parseCookies(request.headers.get('cookie'))
  const raw = cookies[SESSION_COOKIE]
  if (raw) {
    const tokenHash = hashToken(raw)
    // Best-effort — the cookie gets cleared below regardless, so the
    // browser is logged out either way. A DB hiccup here shouldn't crash
    // the logout action; worst case the token just outlives this request
    // until its own TTL expiry.
    await prisma.session.updateMany({
      where: { tokenHash, revokedAt: null },
      data: { revokedAt: new Date() },
    }).catch(err => console.error('[logout] session revoke failed:', err))
  }
  return redirect(redirectTo, {
    headers: { 'Set-Cookie': buildSetCookie('', 0) },
  })
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash)
}

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 10)
}
