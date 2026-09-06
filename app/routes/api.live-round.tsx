import { prisma } from '~/lib/prisma.server'

// Lightweight current-live-round probe. Polled by iOS clients in live mode as a
// fallback for iOS Safari, which throttles the Pusher WebSocket while the live
// video decodes — so `round:started` can arrive late and the betting board never
// appears. One indexed query; returns just what livePhase needs.
//
// EDGE-CACHED: the round state is identical for every viewer, so we cache it at
// Vercel's CDN for a few seconds. No matter how many clients poll, the function
// + DB run ~once per `s-maxage` window instead of once per request — this is
// what stops the request/DB flood while keeping the poll functional.
export async function loader() {
  const round = await prisma.gameRound.findFirst({
    where: { mode: 'LIVE', status: { in: ['BETTING', 'LOCKED', 'AWAITING_RESULT'] } },
    orderBy: { createdAt: 'desc' },
    select: { id: true, status: true, bettingClosesAt: true, dice1: true, dice2: true, dice3: true },
  })
  return Response.json(
    {
      round: round
        ? {
            id: round.id,
            status: round.status,
            bettingClosesAt: round.bettingClosesAt?.toISOString() ?? null,
            dice: [round.dice1, round.dice2, round.dice3] as (string | null)[],
          }
        : null,
    },
    {
      headers: {
        // Browser always revalidates (max-age=0); the Vercel CDN serves a cached
        // copy for 3s (s-maxage) and can serve slightly-stale during refresh.
        'Cache-Control': 'public, max-age=0, s-maxage=3, stale-while-revalidate=3',
      },
    },
  )
}
