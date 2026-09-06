import type { Route } from './+types/api.cron.notifications'

// Fires any campaign that is due — one-time sends whose time has passed, and
// daily sends at their configured GMT+7 time.
//
// NOTE: Vercel Cron was removed (Hobby-plan cron limits). To make scheduled /
// daily campaigns fire automatically, hit this endpoint on an interval from an
// external scheduler (e.g. a free service like cron-job.org, a GitHub Action,
// or any uptime pinger) with the header `Authorization: Bearer <CRON_SECRET>`,
// e.g. every 5 minutes. Without any trigger, only "Send now" works.
//
// Protected by CRON_SECRET when that env var is set.
export async function loader({ request }: Route.LoaderArgs) {
  const secret = process.env.CRON_SECRET
  if (secret) {
    const auth = request.headers.get('authorization')
    if (auth !== `Bearer ${secret}`) return new Response('Unauthorized', { status: 401 })
  }

  const { runDueCampaigns } = await import('~/lib/notifications.server')
  const result = await runDueCampaigns(new Date())
  return Response.json({ ok: true, ...result })
}
