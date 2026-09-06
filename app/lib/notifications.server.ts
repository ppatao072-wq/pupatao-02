// Notification campaigns — audience resolution, {{param}} templating, and the
// one-time / daily scheduler. Delivery is Web Push (see push.server.ts).
import type { NotificationAudience, NotificationCampaign } from '@prisma/client'
import { prisma } from './prisma.server'
import { sendPushBatch, type PushMessage, type PushSendResult } from './push.server'

const THRESHOLD = 100_000 // ₭ — the "less/more than 100,000" cutoff
const TIMEZONE = 'Asia/Bangkok' // GMT+7 (Laos)

// ── Audience ────────────────────────────────────────────────────────────────

// Human labels for the admin UI (kept here so the enum + label never drift).
export const AUDIENCE_LABELS: Record<NotificationAudience, { lo: string; en: string }> = {
  ALL: { lo: 'ທຸກຄົນ (ເປີດແຈ້ງເຕືອນ)', en: 'Everyone (opted-in)' },
  NEVER_DEPOSIT: { lo: 'ບໍ່ເຄີຍຝາກ', en: 'Never deposited' },
  NEVER_WITHDRAW: { lo: 'ບໍ່ເຄີຍຖອນ', en: 'Never withdrew' },
  DEPOSIT_LAST_7D: { lo: 'ຝາກໃນ 7 ວັນຜ່ານມາ', en: 'Deposited in last 7 days' },
  DEPOSIT_LT_100K: { lo: 'ຝາກໜ້ອຍກວ່າ 100,000', en: 'Deposit < 100,000' },
  DEPOSIT_GT_100K: { lo: 'ຝາກຫຼາຍກວ່າ 100,000', en: 'Deposit > 100,000' },
  WITHDRAW_LT_100K: { lo: 'ຖອນໜ້ອຍກວ່າ 100,000', en: 'Withdraw < 100,000' },
  WITHDRAW_GT_100K: { lo: 'ຖອນຫຼາຍກວ່າ 100,000', en: 'Withdraw > 100,000' },
}

export const AUDIENCE_VALUES = Object.keys(AUDIENCE_LABELS) as NotificationAudience[]

// distinct userIds that have a matching completed transaction.
async function userIdsWithTx(where: object): Promise<string[]> {
  const rows = await prisma.transaction.findMany({
    where: { status: 'COMPLETED', ...where },
    distinct: ['userId'],
    select: { userId: true },
  })
  return rows.map(r => r.userId)
}

// Resolve an audience to the set of target userIds. `null` means "all devices"
// (including anonymous subscriptions) — handled by the caller.
export async function resolveAudience(audience: NotificationAudience): Promise<string[] | null> {
  switch (audience) {
    case 'ALL':
      return null

    case 'NEVER_DEPOSIT': {
      const depositors = await userIdsWithTx({ type: 'DEPOSIT' })
      const users = await prisma.user.findMany({
        where: { role: 'PLAYER', id: { notIn: depositors } },
        select: { id: true },
      })
      return users.map(u => u.id)
    }
    case 'NEVER_WITHDRAW': {
      const withdrawers = await userIdsWithTx({ type: 'WITHDRAW' })
      const users = await prisma.user.findMany({
        where: { role: 'PLAYER', id: { notIn: withdrawers } },
        select: { id: true },
      })
      return users.map(u => u.id)
    }
    case 'DEPOSIT_LAST_7D': {
      const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
      return userIdsWithTx({ type: 'DEPOSIT', createdAt: { gte: since } })
    }
    case 'DEPOSIT_LT_100K':
      return userIdsWithTx({ type: 'DEPOSIT', amount: { lt: THRESHOLD } })
    case 'DEPOSIT_GT_100K':
      return userIdsWithTx({ type: 'DEPOSIT', amount: { gt: THRESHOLD } })
    case 'WITHDRAW_LT_100K':
      return userIdsWithTx({ type: 'WITHDRAW', amount: { lt: THRESHOLD } })
    case 'WITHDRAW_GT_100K':
      return userIdsWithTx({ type: 'WITHDRAW', amount: { gt: THRESHOLD } })
    default:
      return []
  }
}

// ── Templating ──────────────────────────────────────────────────────────────

type Recipient = { tel: string; firstName: string | null; lastName: string | null }

// Replace {{phone_number}}, {{first_name}}, {{last_name}}, {{name}} (spaces and
// case tolerated). Unknown placeholders are left as-is.
export function renderTemplate(template: string, r: Recipient | null): string {
  const name = [r?.firstName, r?.lastName].filter(Boolean).join(' ').trim()
  const map: Record<string, string> = {
    phone_number: r?.tel ?? '',
    first_name: r?.firstName ?? '',
    last_name: r?.lastName ?? '',
    name: name || r?.tel || '',
  }
  return template.replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (full, key: string) => {
    const v = map[key.toLowerCase()]
    return v !== undefined ? v : full
  })
}

// ── Sending ─────────────────────────────────────────────────────────────────

// Run one campaign now: resolve audience → gather each target's subscriptions →
// personalize → send. Returns a delivery summary.
export async function runCampaign(c: NotificationCampaign): Promise<PushSendResult> {
  const userIds = await resolveAudience(c.audience)

  const subs = await prisma.pushSubscription.findMany({
    where: userIds === null ? {} : { userId: { in: userIds } },
    select: { endpoint: true, p256dh: true, auth: true, userId: true },
  })
  if (subs.length === 0) return { sent: 0, failed: 0, pruned: 0 }

  // Fetch recipient details for personalization (skip if the template has no placeholders).
  const needsUser = /\{\{\s*[a-z_]+\s*\}\}/i.test(c.message)
  const userMap = new Map<string, Recipient>()
  if (needsUser) {
    const ids = [...new Set(subs.map(s => s.userId).filter((x): x is string => !!x))]
    if (ids.length) {
      const users = await prisma.user.findMany({
        where: { id: { in: ids } },
        select: { id: true, tel: true, firstName: true, lastName: true },
      })
      users.forEach(u => userMap.set(u.id, u))
    }
  }

  const title = c.title?.trim() || 'Pupatao'
  const messages: PushMessage[] = subs.map(s => ({
    endpoint: s.endpoint,
    p256dh: s.p256dh,
    auth: s.auth,
    payload: {
      title,
      body: renderTemplate(c.message, s.userId ? userMap.get(s.userId) ?? null : null),
      url: '/',
      tag: `campaign-${c.id}`,
    },
  }))

  const result = await sendPushBatch(messages)

  await prisma.notificationCampaign.update({
    where: { id: c.id },
    data: {
      lastRunAt: new Date(),
      lastSent: result.sent,
      // A one-time campaign is spent after it fires.
      ...(c.mode === 'ONCE' ? { active: false } : {}),
    },
  }).catch(() => { /* best effort */ })

  return result
}

// ── Scheduler ───────────────────────────────────────────────────────────────

// GMT+7 wall-clock parts of a date.
function gmt7Parts(d: Date): { date: string; hm: string } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TIMEZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d)
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? '00'
  return { date: `${get('year')}-${get('month')}-${get('day')}`, hm: `${get('hour')}:${get('minute')}` }
}

// Called by the cron endpoint. Fires every campaign that is due at `now`:
//   · ONCE  — scheduledAt has passed and it hasn't run yet
//   · DAILY — active, and now (GMT+7) is at/after timeOfDay, not already run today
export async function runDueCampaigns(now: Date): Promise<{ ran: number; results: Array<{ id: string; sent: number }> }> {
  const campaigns = await prisma.notificationCampaign.findMany({ where: { active: true } })
  const nowParts = gmt7Parts(now)
  const results: Array<{ id: string; sent: number }> = []

  for (const c of campaigns) {
    let due = false
    if (c.mode === 'ONCE') {
      due = !c.lastRunAt && !!c.scheduledAt && c.scheduledAt <= now
    } else if (c.mode === 'DAILY' && c.timeOfDay) {
      const ranToday = c.lastRunAt && gmt7Parts(c.lastRunAt).date === nowParts.date
      due = !ranToday && nowParts.hm >= c.timeOfDay
    }
    if (!due) continue
    const res = await runCampaign(c)
    results.push({ id: c.id, sent: res.sent })
  }

  return { ran: results.length, results }
}
