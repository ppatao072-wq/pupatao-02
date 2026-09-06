import type { Route } from './+types/api.push-subscribe'
import { prisma } from '~/lib/prisma.server'
import { getVapidPublicKey } from '~/lib/push.server'

// GET → hand the client the VAPID public key it needs to create a subscription.
export function loader() {
  return Response.json({ vapidPublicKey: getVapidPublicKey() })
}

// POST → store (or refresh) a browser's push subscription.
//   body: { subscription: PushSubscriptionJSON, unsubscribe?: boolean }
export async function action({ request }: Route.ActionArgs) {
  const { getCurrentUser } = await import('~/lib/auth.server')
  const user = await getCurrentUser(request)

  let payload: { subscription?: PushSubscriptionJSON; unsubscribe?: boolean }
  try {
    payload = await request.json()
  } catch {
    return Response.json({ error: 'Bad request' }, { status: 400 })
  }

  const sub = payload.subscription
  const endpoint = sub?.endpoint
  const p256dh = sub?.keys?.p256dh
  const auth = sub?.keys?.auth
  if (!endpoint) return Response.json({ error: 'Missing endpoint' }, { status: 400 })

  try {
    // Unsubscribe: remove this endpoint.
    if (payload.unsubscribe) {
      await prisma.pushSubscription.deleteMany({ where: { endpoint } })
      return Response.json({ ok: true, unsubscribed: true })
    }

    if (!p256dh || !auth) return Response.json({ error: 'Missing keys' }, { status: 400 })

    const userAgent = request.headers.get('user-agent') ?? undefined
    // Upsert by endpoint — one row per browser; refresh keys/owner if it changes.
    await prisma.pushSubscription.upsert({
      where: { endpoint },
      create: { endpoint, p256dh, auth, userId: user?.id ?? null, userAgent },
      update: { p256dh, auth, userId: user?.id ?? null, userAgent },
    })
    return Response.json({ ok: true })
  } catch (err) {
    console.error('[api/push-subscribe]', err)
    return Response.json({ error: 'Failed to save subscription' }, { status: 500 })
  }
}
