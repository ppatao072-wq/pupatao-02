import type { Route } from './+types/api.admin.viewer-balances'
import { requireAdmin } from '~/lib/admin-auth.server'
import { prisma } from '~/lib/prisma.server'

// Returns current REAL balances for a set of user ids, so the admin Live page
// can show each viewer's live balance (refreshed when a round starts/resolves)
// instead of the snapshot captured when they joined the presence channel.
export async function action({ request }: Route.ActionArgs) {
  await requireAdmin(request)

  // Always resolve with 200 + an empty result on a malformed body instead of
  // a 4xx. This route is called via a fetcher (admin.live.tsx) purely to
  // refresh a "nice to have" balance display; with React Router's single-
  // fetch data protocol, an action that RETURNS a Response with a non-2xx
  // status gets treated as an error and bubbles to the nearest error
  // boundary — which, since this component defines none of its own, is the
  // root one. That took down the entire admin panel every time this fired,
  // even though the failure itself is completely harmless to ignore.
  let body: { userIds?: unknown }
  try {
    body = await request.json()
  } catch {
    return Response.json({ balances: {} })
  }
  const userIds = Array.isArray(body.userIds)
    ? body.userIds.filter((x): x is string => typeof x === 'string').slice(0, 300)
    : []
  if (userIds.length === 0) return Response.json({ balances: {} })

  const wallets = await prisma.wallet.findMany({
    where: { userId: { in: userIds }, type: 'REAL' },
    select: { userId: true, balance: true },
  })
  const balances: Record<string, number> = {}
  for (const w of wallets) balances[w.userId] = w.balance
  return Response.json({ balances })
}

export function loader() {
  return new Response('Method Not Allowed', { status: 405 })
}
