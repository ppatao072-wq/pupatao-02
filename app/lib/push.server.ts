// Web Push (PWA notifications) — server side.
//
// Env vars required (set these in Vercel + .env):
//   VAPID_PUBLIC_KEY   — VAPID public key  (also handed to the client to subscribe)
//   VAPID_PRIVATE_KEY  — VAPID private key (server secret)
//   VAPID_SUBJECT      — a mailto: or https: contact URL, e.g. "mailto:you@example.com"
//
// Generate a key pair once with:  npx web-push generate-vapid-keys
import webpush from 'web-push'
import { prisma } from './prisma.server'

const PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY ?? ''
const PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY ?? ''
const SUBJECT = process.env.VAPID_SUBJECT ?? 'mailto:admin@pupatao.app'

let configured = false
function ensureConfigured(): boolean {
  if (configured) return true
  if (!PUBLIC_KEY || !PRIVATE_KEY) {
    console.warn('[push] VAPID keys missing — push disabled. Set VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY.')
    return false
  }
  webpush.setVapidDetails(SUBJECT, PUBLIC_KEY, PRIVATE_KEY)
  configured = true
  return true
}

// The client needs the public key to create a subscription.
export function getVapidPublicKey(): string {
  return PUBLIC_KEY
}

export type PushPayload = {
  title: string
  body: string
  url?: string
  icon?: string
  tag?: string
}

export type PushSendResult = { sent: number; failed: number; pruned: number }

// One subscription + its own (possibly personalized) payload.
export type PushMessage = {
  endpoint: string
  p256dh: string
  auth: string
  payload: PushPayload
}

// Core sender: each message carries its own payload, so campaigns can
// personalize per recipient. Dead endpoints (404/410) are pruned by endpoint.
export async function sendPushBatch(messages: PushMessage[]): Promise<PushSendResult> {
  if (!ensureConfigured() || messages.length === 0) return { sent: 0, failed: 0, pruned: 0 }

  const deadEndpoints: string[] = []
  let sent = 0
  let failed = 0

  const results = await Promise.allSettled(
    messages.map(m =>
      webpush.sendNotification(
        { endpoint: m.endpoint, keys: { p256dh: m.p256dh, auth: m.auth } },
        JSON.stringify(m.payload),
      ),
    ),
  )

  results.forEach((res, i) => {
    if (res.status === 'fulfilled') {
      sent++
    } else {
      failed++
      const code = (res.reason as { statusCode?: number })?.statusCode
      if (code === 404 || code === 410) deadEndpoints.push(messages[i].endpoint)
    }
  })

  if (deadEndpoints.length) {
    await prisma.pushSubscription
      .deleteMany({ where: { endpoint: { in: deadEndpoints } } })
      .catch(() => { /* best effort */ })
  }

  return { sent, failed, pruned: deadEndpoints.length }
}

// Send the SAME payload to every stored subscription (e.g. the "we're live" blast).
export async function sendPushToAll(payload: PushPayload): Promise<PushSendResult> {
  if (!ensureConfigured()) return { sent: 0, failed: 0, pruned: 0 }
  const subs = await prisma.pushSubscription.findMany()
  return sendPushBatch(subs.map(s => ({ endpoint: s.endpoint, p256dh: s.p256dh, auth: s.auth, payload })))
}
