// Global system settings stored in MongoDB via the SystemSetting model.
// Each setting is a key/value pair. Values are always strings; callers
// convert to the correct type.
//
// Current settings:
//   sleepMode — 'true' | 'false'
//     When true, ALL REAL/PROMO self-play rolls are forced to 0 payout.
//     DEMO wallets and LIVE mode are unaffected.
//   liveStreamUrl — URL string (absent = no active live stream)
//     The stream URL currently shown to customers. Set when admin starts a
//     round or updates the stream; cleared when admin clicks "End Live".
//   liveScheduleStart — ISO UTC string (absent = no schedule)
//   liveScheduleEnd   — ISO UTC string (absent = no schedule)
//     Start/end of the next scheduled live broadcast in UTC. Display in GMT+7.
//   referralCommissionEnabled — 'true' | 'false'
//   referralCommissionPercent — integer string, e.g. '10'
//     While enabled, a referrer earns `percent`% of every approved deposit
//     their referred users make, recurring, until admin disables it.

import { prisma } from './prisma.server'

// ── In-memory read cache (per serverless instance) ──────────────────────────
// System settings are read on almost every request (competition config on the
// root loader, sleep mode per roll, stream URL/schedule on the live page) but
// only change when an admin toggles them. Caching them for a few seconds strips
// out the vast majority of `systemSetting` queries — which is what was
// overwhelming the Mongo connection pool under load (the "pool cleared" crash).
// An admin change propagates within at most the TTL (setters also clear it on
// the instance that ran the write).
const _ssCache = new Map<string, { value: unknown; expires: number }>()
function ssCached<T>(key: string, ttlMs: number, fetcher: () => Promise<T>): Promise<T> {
  const now = Date.now()
  const hit = _ssCache.get(key)
  if (hit && hit.expires > now) return Promise.resolve(hit.value as T)
  return fetcher().then(value => {
    _ssCache.set(key, { value, expires: now + ttlMs })
    return value
  })
}
function ssInvalidate(...keys: string[]) { for (const k of keys) _ssCache.delete(k) }

export const SLEEP_MODE_KEY              = 'sleepMode'
export const COMPETITION_ENABLED_KEY     = 'competitionEnabled'
export const COMPETITION_RULES_KEY       = 'competitionRules'
export const COMPETITION_START_KEY       = 'competitionStart'
export const COMPETITION_END_KEY         = 'competitionEnd'
export const COMPETITION_SUMMARY_KEY     = 'competitionSummary'
export const COMPETITION_TYPE_KEY        = 'competitionType'
export const COMPETITION_STARTED_KEY     = 'competitionWasStarted'

// DEMO_LIVE  — ranks by DEMO balance; DEMO hidden from self-play
// REAL_LIVE  — ranks by REAL balance; REAL hidden from self-play (live-only competition)
// REAL_ALL   — ranks by REAL balance; no self-play restrictions
export type CompetitionType = 'DEMO_LIVE' | 'REAL_LIVE' | 'REAL_ALL'

export interface CompetitionWinner {
  rank: number
  userId: string
  name: string | null
  tel: string
  profile: string | null
  demoBalance: number
}
export const REFERRAL_ENABLED_KEY       = 'referralCommissionEnabled'
export const REFERRAL_PERCENT_KEY       = 'referralCommissionPercent'
export const ANNOUNCEMENT_KEY           = 'activeAnnouncement'
export const LIVE_STREAM_URL_KEY        = 'liveStreamUrl'
export const LIVE_SCHEDULE_START_KEY    = 'liveScheduleStart'
export const LIVE_SCHEDULE_END_KEY      = 'liveScheduleEnd'
export const LIVE_SCHEDULE_NOTICE_KEY   = 'liveScheduleNotice'
export const LIVE_BETTING_SECONDS_KEY   = 'liveBettingSeconds'

export async function getSleepMode(): Promise<boolean> {
  return ssCached('sleepMode', 3000, async () => {
    try {
      const setting = await prisma.systemSetting.findUnique({
        where: { key: SLEEP_MODE_KEY },
        select: { value: true },
      })
      return setting?.value === 'true'
    } catch {
      return false // fail open — don't break the game if DB is slow
    }
  })
}

export async function setSleepMode(active: boolean, adminId: string): Promise<void> {
  await prisma.systemSetting.upsert({
    where: { key: SLEEP_MODE_KEY },
    create: { key: SLEEP_MODE_KEY, value: String(active), updatedBy: adminId },
    update: { value: String(active), updatedBy: adminId },
  })
  ssInvalidate('sleepMode')
}

export async function getLiveStreamUrl(): Promise<string | null> {
  return ssCached('liveStreamUrl', 3000, async () => {
    try {
      const setting = await prisma.systemSetting.findUnique({
        where: { key: LIVE_STREAM_URL_KEY },
        select: { value: true },
      })
      return setting?.value ?? null
    } catch {
      return null
    }
  })
}

export async function setLiveStreamUrl(url: string | null, adminId: string): Promise<void> {
  if (url === null) {
    await prisma.systemSetting.deleteMany({ where: { key: LIVE_STREAM_URL_KEY } })
  } else {
    await prisma.systemSetting.upsert({
      where: { key: LIVE_STREAM_URL_KEY },
      create: { key: LIVE_STREAM_URL_KEY, value: url, updatedBy: adminId },
      update: { value: url, updatedBy: adminId },
    })
  }
  ssInvalidate('liveStreamUrl')
}

export async function getLiveSchedule(): Promise<{ start: string | null; end: string | null; notice: string | null }> {
  return ssCached('liveSchedule', 8000, async () => {
    try {
      const [startSetting, endSetting, noticeSetting] = await Promise.all([
        prisma.systemSetting.findUnique({ where: { key: LIVE_SCHEDULE_START_KEY }, select: { value: true } }),
        prisma.systemSetting.findUnique({ where: { key: LIVE_SCHEDULE_END_KEY }, select: { value: true } }),
        prisma.systemSetting.findUnique({ where: { key: LIVE_SCHEDULE_NOTICE_KEY }, select: { value: true } }),
      ])
      return {
        start:  startSetting?.value  ?? null,
        end:    endSetting?.value    ?? null,
        notice: noticeSetting?.value ?? null,
      }
    } catch {
      return { start: null, end: null, notice: null }
    }
  })
}

export async function setLiveSchedule(
  start: string | null,
  end: string | null,
  adminId: string,
  notice?: string | null,
): Promise<void> {
  const upsertOrDelete = (key: string, value: string | null) =>
    value
      ? prisma.systemSetting.upsert({
          where: { key },
          create: { key, value, updatedBy: adminId },
          update: { value, updatedBy: adminId },
        })
      : prisma.systemSetting.deleteMany({ where: { key } })

  await Promise.all([
    upsertOrDelete(LIVE_SCHEDULE_START_KEY, start),
    upsertOrDelete(LIVE_SCHEDULE_END_KEY, end),
    upsertOrDelete(LIVE_SCHEDULE_NOTICE_KEY, notice ?? null),
  ])
  ssInvalidate('liveSchedule')
}

// ─── Persistent in-app announcement ──────────────────────────────────────────
// A single banner message the admin posts to every customer. Stored as JSON so
// each post gets a fresh id (lets clients re-show it even if a previous one was
// dismissed). null = no announcement.
export interface Announcement {
  id: string
  message: string
  createdAt: string
}

export async function getAnnouncement(): Promise<Announcement | null> {
  return ssCached('announcement', 8000, async () => {
    try {
      const s = await prisma.systemSetting.findUnique({
        where: { key: ANNOUNCEMENT_KEY },
        select: { value: true },
      })
      if (!s?.value) return null
      return JSON.parse(s.value) as Announcement
    } catch {
      return null
    }
  })
}

// ─── User notification feed (all admin-sent notifications) ───────────────────
// Every notification the admin sends is a NotificationCampaign row. The user's
// bell shows the recent ones. Cached (all users see the same list; templating
// is applied per-user in the loader), invalidated when a new one is sent.
export interface FeedNotification {
  id: string
  title: string | null
  message: string
  createdAt: string
}

export async function getRecentNotifications(): Promise<FeedNotification[]> {
  return ssCached('recentNotifications', 30_000, async () => {
    try {
      const rows = await prisma.notificationCampaign.findMany({
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: { id: true, title: true, message: true, createdAt: true },
      })
      return rows.map(r => ({ id: r.id, title: r.title, message: r.message, createdAt: r.createdAt.toISOString() }))
    } catch {
      return []
    }
  })
}

// Call after creating/deleting a campaign so the user feed refreshes promptly.
export function invalidateNotifications() {
  ssInvalidate('recentNotifications')
}

// Post a new announcement (message given) or clear it (null/empty). Returns the
// stored announcement (or null when cleared) so the caller can broadcast it.
export async function setAnnouncement(message: string | null, adminId: string): Promise<Announcement | null> {
  if (!message || !message.trim()) {
    await prisma.systemSetting.deleteMany({ where: { key: ANNOUNCEMENT_KEY } })
    ssInvalidate('announcement')
    return null
  }
  const announcement: Announcement = {
    id: crypto.randomUUID(),
    message: message.trim(),
    createdAt: new Date().toISOString(),
  }
  const value = JSON.stringify(announcement)
  await prisma.systemSetting.upsert({
    where: { key: ANNOUNCEMENT_KEY },
    create: { key: ANNOUNCEMENT_KEY, value, updatedBy: adminId },
    update: { value, updatedBy: adminId },
  })
  ssInvalidate('announcement')
  return announcement
}

// ─── Referral commission campaign ────────────────────────────────────────────
// Admin-configurable: while `enabled`, a referrer earns `percent`% of EVERY
// approved deposit their referred users make (not just the first one), for
// as long as the campaign stays on. Applied in admin.transactions.tsx at
// deposit-approval time. Disabling stops future payouts; past ones are kept.

export interface ReferralConfig {
  enabled: boolean
  percent: number // e.g. 10 means 10%
}

async function fetchReferralConfig(): Promise<ReferralConfig> {
  try {
    const settings = await prisma.systemSetting.findMany({
      where: { key: { in: [REFERRAL_ENABLED_KEY, REFERRAL_PERCENT_KEY] } },
      select: { key: true, value: true },
    })
    const m = new Map(settings.map(s => [s.key, s.value]))
    const enabled = m.get(REFERRAL_ENABLED_KEY) === 'true'
    const percent = Number(m.get(REFERRAL_PERCENT_KEY) ?? 0)
    return { enabled, percent: Number.isFinite(percent) && percent > 0 ? percent : 0 }
  } catch {
    return { enabled: false, percent: 0 } // fail closed — never pay out on a DB hiccup
  }
}

// Cached (5s) — cheap enough for the root loader to call on every page view.
// A toggle only invalidates the cache on the SERVERLESS INSTANCE that ran the
// write; on Vercel a different instance can keep serving a stale value for up
// to the full TTL. Fine for a promo banner, but NOT for anything that decides
// a real payout — use getReferralConfigFresh() for that.
export async function getReferralConfig(): Promise<ReferralConfig> {
  return ssCached('referralConfig', 5000, fetchReferralConfig)
}

// Uncached — always reads the current DB value. Deposit-approval is a rare,
// human-paced admin action (not a hot path), so the extra round-trip is cheap
// insurance against paying (or skipping) a referral commission based on a
// stale cache read from another instance.
export async function getReferralConfigFresh(): Promise<ReferralConfig> {
  return fetchReferralConfig()
}

export async function setReferralConfig(config: { enabled: boolean; percent: number }, adminId: string): Promise<void> {
  await Promise.all([
    prisma.systemSetting.upsert({
      where: { key: REFERRAL_ENABLED_KEY },
      create: { key: REFERRAL_ENABLED_KEY, value: String(config.enabled), updatedBy: adminId },
      update: { value: String(config.enabled), updatedBy: adminId },
    }),
    prisma.systemSetting.upsert({
      where: { key: REFERRAL_PERCENT_KEY },
      create: { key: REFERRAL_PERCENT_KEY, value: String(config.percent), updatedBy: adminId },
      update: { value: String(config.percent), updatedBy: adminId },
    }),
  ])
  ssInvalidate('referralConfig')
}

// ─── Competition ─────────────────────────────────────────────────────────────

export async function getCompetitionEnabled(): Promise<boolean> {
  try {
    const s = await prisma.systemSetting.findUnique({ where: { key: COMPETITION_ENABLED_KEY }, select: { value: true } })
    return s?.value === 'true'
  } catch { return false }
}

export async function setCompetitionEnabled(active: boolean, adminId: string): Promise<void> {
  await prisma.systemSetting.upsert({
    where: { key: COMPETITION_ENABLED_KEY },
    create: { key: COMPETITION_ENABLED_KEY, value: String(active), updatedBy: adminId },
    update: { value: String(active), updatedBy: adminId },
  })
  ssInvalidate('competitionConfig')
}

export interface CompetitionConfig {
  enabled: boolean
  type: CompetitionType      // which wallet + which modes
  rules: string | null
  start: string | null       // ISO UTC
  end:   string | null       // ISO UTC
  summary: CompetitionWinner[] | null  // top-3 snapshot, null if not yet summarized
  menuVisible: boolean       // show Competition in user menu: enabled OR summary set
  hasConfig: boolean         // type/rules/dates have been saved (not a blank slate)
  wasStarted: boolean        // true once admin has clicked Start at least once
}

export async function getCompetitionConfig(): Promise<CompetitionConfig> {
 return ssCached('competitionConfig', 8000, async () => {
  try {
    const settings = await prisma.systemSetting.findMany({
      where: {
        key: {
          in: [
            COMPETITION_ENABLED_KEY, COMPETITION_TYPE_KEY,
            COMPETITION_RULES_KEY,   COMPETITION_START_KEY,
            COMPETITION_END_KEY,     COMPETITION_SUMMARY_KEY,
            COMPETITION_STARTED_KEY,
          ],
        },
      },
      select: { key: true, value: true },
    })
    const m = new Map(settings.map(s => [s.key, s.value]))
    const enabled = m.get(COMPETITION_ENABLED_KEY) === 'true'
    const rawType = m.get(COMPETITION_TYPE_KEY)
    const type: CompetitionType =
      rawType === 'REAL_LIVE' ? 'REAL_LIVE'
      : rawType === 'REAL_ALL' ? 'REAL_ALL'
      : 'DEMO_LIVE'
    let summary: CompetitionWinner[] | null = null
    const summaryStr = m.get(COMPETITION_SUMMARY_KEY)
    if (summaryStr) {
      try { summary = JSON.parse(summaryStr) as CompetitionWinner[] } catch { summary = null }
    }
    const hasConfig = m.has(COMPETITION_TYPE_KEY) || m.has(COMPETITION_RULES_KEY)
      || m.has(COMPETITION_START_KEY) || m.has(COMPETITION_END_KEY)
    const wasStarted = m.get(COMPETITION_STARTED_KEY) === 'true'
    return {
      enabled, type,
      rules:   m.get(COMPETITION_RULES_KEY) ?? null,
      start:   m.get(COMPETITION_START_KEY) ?? null,
      end:     m.get(COMPETITION_END_KEY)   ?? null,
      summary,
      menuVisible: enabled || summary !== null,
      hasConfig,
      wasStarted,
    }
  } catch {
    return {
      enabled: false, type: 'DEMO_LIVE', rules: null, start: null, end: null,
      summary: null, menuVisible: false, hasConfig: false, wasStarted: false,
    }
  }
 })
}

export async function setCompetitionSummary(
  winners: CompetitionWinner[] | null,
  adminId: string,
): Promise<void> {
  if (winners === null) {
    await prisma.systemSetting.deleteMany({ where: { key: COMPETITION_SUMMARY_KEY } })
  } else {
    const value = JSON.stringify(winners)
    await prisma.systemSetting.upsert({
      where: { key: COMPETITION_SUMMARY_KEY },
      create: { key: COMPETITION_SUMMARY_KEY, value, updatedBy: adminId },
      update: { value, updatedBy: adminId },
    })
  }
  ssInvalidate('competitionConfig')
}

export async function setCompetitionConfig(
  config: { type?: CompetitionType; rules: string | null; start: string | null; end: string | null },
  adminId: string,
): Promise<void> {
  const upsert = (key: string, value: string | null) =>
    value
      ? prisma.systemSetting.upsert({
          where: { key },
          create: { key, value, updatedBy: adminId },
          update: { value, updatedBy: adminId },
        })
      : prisma.systemSetting.deleteMany({ where: { key } })

  await Promise.all([
    config.type
      ? prisma.systemSetting.upsert({
          where: { key: COMPETITION_TYPE_KEY },
          create: { key: COMPETITION_TYPE_KEY, value: config.type, updatedBy: adminId },
          update: { value: config.type, updatedBy: adminId },
        })
      : Promise.resolve(),
    upsert(COMPETITION_RULES_KEY, config.rules),
    upsert(COMPETITION_START_KEY, config.start),
    upsert(COMPETITION_END_KEY,   config.end),
  ])
  ssInvalidate('competitionConfig')
}
