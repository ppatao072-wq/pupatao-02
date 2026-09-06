import { useCallback, useEffect, useRef, useState } from 'react'
import { Form, Link, useFetcher, useLoaderData, useNavigation, useRevalidator, useSearchParams } from 'react-router'
import { ArrowDown, ArrowDownCircle, ArrowUp, ArrowUpCircle, ArrowUpDown, Eye, Lock, Loader, Search, Wallet, X } from 'lucide-react'
import type { Route } from './+types/admin.play-history'
import type { WalletType } from '@prisma/client'
import { requireAdmin, requireRole } from '~/lib/admin-auth.server'
import { prisma } from '~/lib/prisma.server'
import { ADMIN_CHANNEL, type BetPlacedPayload, type RoundResolvedPayload } from '~/lib/pusher-channels'
import { usePusherEvent } from '~/hooks/use-pusher'
import { useT } from '~/lib/use-t'
import { t as translate, parseLocaleCookie, type StringKey } from '~/lib/i18n'
import { escapeSearchTerm } from '~/lib/search'

const PAGE_SIZES = [10, 30, 50, 100, 200, 500] as const
const WALLET_TABS: ReadonlyArray<Extract<WalletType, 'REAL' | 'DEMO'>> = ['REAL', 'DEMO']
const BET_TYPES: { key: 'ALL' | 'SYMBOL' | 'PAIR' | 'LOW' | 'MIDDLE' | 'HIGH'; labelKey: StringKey }[] = [
  { key: 'ALL', labelKey: 'admin.playHistory.betType.all' },
  { key: 'SYMBOL', labelKey: 'admin.playHistory.betType.single' },
  { key: 'PAIR', labelKey: 'admin.playHistory.betType.pair' },
  { key: 'LOW', labelKey: 'admin.playHistory.betType.low' },
  { key: 'MIDDLE', labelKey: 'admin.playHistory.betType.middle' },
  { key: 'HIGH', labelKey: 'admin.playHistory.betType.high' },
]

// Maps a transaction type to its translation key; resolved at render via t().
const TYPE_LABEL_KEYS: Record<string, StringKey> = {
  DEPOSIT: 'admin.playHistory.txType.deposit', WIN: 'admin.playHistory.txType.win', TRANSFER_IN: 'admin.playHistory.txType.transferIn',
  PROMO_BONUS: 'admin.playHistory.txType.promoBonus', REFERRAL_BONUS: 'admin.playHistory.txType.referralBonus',
  WITHDRAW: 'admin.playHistory.txType.withdraw', LOSS: 'admin.playHistory.txType.loss', TRANSFER_OUT: 'admin.playHistory.txType.transferOut',
  DEMO_RESET: 'admin.playHistory.txType.demoReset', ADJUSTMENT: 'admin.playHistory.txType.adjustment',
}

function typeLabel(t: ReturnType<typeof useT>, type: string): string {
  const k = TYPE_LABEL_KEYS[type]
  return k ? t(k) : type
}

function formatAmount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(n % 1_000 === 0 ? 0 : 1)}K`
  return n.toString()
}

// ─── LOADER ──────────────────────────────────────────────────────────
export async function loader({ request }: Route.LoaderArgs) {
  await requireRole(request, ['ADMIN', 'SUPERADMIN'])
  const url = new URL(request.url)
  const page = Math.max(1, parseInt(url.searchParams.get('page') ?? '1', 10) || 1)
  const pageSizeRaw = parseInt(url.searchParams.get('pageSize') ?? '30', 10)
  const pageSize = (PAGE_SIZES as readonly number[]).includes(pageSizeRaw) ? pageSizeRaw : 30
  const walletParam = url.searchParams.get('wallet')
  const walletType: 'REAL' | 'DEMO' = walletParam === 'DEMO' ? 'DEMO' : 'REAL'
  const q = url.searchParams.get('q')?.trim() ?? ''
  const resultParam = url.searchParams.get('result') ?? 'ALL'
  const betTypeParam = url.searchParams.get('betType') ?? 'ALL'
  const modeParam = url.searchParams.get('mode') ?? 'ALL'
  const result: 'ALL' | 'WIN' | 'LOSS' = resultParam === 'WIN' ? 'WIN' : resultParam === 'LOSS' ? 'LOSS' : 'ALL'
  type BetTypeFilter = 'ALL' | 'SYMBOL' | 'PAIR' | 'LOW' | 'MIDDLE' | 'HIGH'
  const betType: BetTypeFilter = (['SYMBOL', 'PAIR', 'LOW', 'MIDDLE', 'HIGH'] as const).includes(betTypeParam as any) ? betTypeParam as BetTypeFilter : 'ALL'
  const mode: 'ALL' | 'RANDOM' | 'LIVE' = modeParam === 'RANDOM' ? 'RANDOM' : modeParam === 'LIVE' ? 'LIVE' : 'ALL'

  const betTypeWhere =
    betType === 'SYMBOL' ? { kind: 'SYMBOL' as const }
    : betType === 'PAIR' ? { kind: 'PAIR' as const }
    : betType === 'LOW' ? { kind: 'RANGE' as const, range: 'LOW' as const }
    : betType === 'MIDDLE' ? { kind: 'RANGE' as const, range: 'MIDDLE' as const }
    : betType === 'HIGH' ? { kind: 'RANGE' as const, range: 'HIGH' as const }
    : {}

  // `walletType` is now a denormalized, indexed column on Bet, so we filter it
  // directly instead of loading all ~1,151 wallet ids and doing a huge
  // `walletId IN (…)` scan (which was taking 100+ seconds and freezing the site).
  // Mode / phone-search filters still pre-fetch ids from their small collections.
  const { getSleepMode } = await import('~/lib/system-settings.server')
  const [roundIds, userIds, sleepMode] = await Promise.all([
    // Round IDs by mode — only when mode filter is active
    mode !== 'ALL'
      ? prisma.gameRound.findMany({ where: { mode: mode as 'RANDOM' | 'LIVE' }, select: { id: true } })
          .then(rs => rs.map(r => r.id))
      : Promise.resolve(null),
    // User IDs matching phone search — only when q is set. Escaped — phone
    // numbers are always "+"-prefixed and `contains` passes the term
    // straight through as a regex source (see lib/search.ts).
    q
      ? prisma.user.findMany({ where: { tel: { contains: escapeSearchTerm(q), mode: 'insensitive' } }, select: { id: true } })
          .then(us => us.map(u => u.id))
      : Promise.resolve(null),
    getSleepMode(),
  ])

  const where = {
    walletType,
    ...(result !== 'ALL' ? { result } : {}),
    ...betTypeWhere,
    ...(roundIds !== null ? { roundId: { in: roundIds } } : {}),
    ...(userIds !== null ? { userId: { in: userIds } } : {}),
  }

  const [total, bets] = await Promise.all([
    prisma.bet.count({ where }),
    prisma.bet.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        user: { select: { id: true, tel: true, firstName: true, lastName: true, selfPlayPhase: true } },
        round: { select: { mode: true, status: true, dice1: true, dice2: true, dice3: true, diceSum: true } },
      },
    }),
  ])

  return {
    page, total, pageSize, walletType, q, result, betType, mode, sleepMode,
    bets: bets.map(b => ({
      id: b.id,
      kind: b.kind,
      amount: b.amount,
      payout: b.payout,
      result: b.result,
      symbol: b.symbol,
      range: b.range,
      pairA: b.pairA,
      pairB: b.pairB,
      exactSum: b.exactSum,
      createdAt: b.createdAt.toISOString(),
      user: {
        id: b.user.id,
        tel: b.user.tel,
        name: [b.user.firstName, b.user.lastName].filter(Boolean).join(' ') || null,
        selfPlayPhase: b.user.selfPlayPhase as string,
      },
      round: b.round
        ? {
          mode: b.round.mode,
          status: b.round.status,
          dice: [b.round.dice1, b.round.dice2, b.round.dice3].filter(Boolean) as string[],
          diceSum: b.round.diceSum,
        }
        : null,
    })),
  }
}

// ─── ACTION ──────────────────────────────────────────────────────────
export async function action({ request }: Route.ActionArgs) {
  const admin = await requireAdmin(request)
  // Errors translated server-side from the locale cookie (actions can't use the hook).
  const locale = parseLocaleCookie(request.headers.get('cookie'))
  if (admin.role === 'SUPPORT') return { error: translate(locale, 'admin.playHistory.error.insufficientPermissions') }
  const fd = await request.formData()
  const op = String(fd.get('op') ?? '')
  const userId = String(fd.get('userId') ?? '')
  if (!userId) return { error: translate(locale, 'admin.playHistory.error.userIdRequired') }

  if (op === 'lockGame') {
    await prisma.user.update({ where: { id: userId }, data: { selfPlayPhase: 'ADMIN_LOCKED' } })
    await prisma.auditLog.create({ data: { actorId: admin.id, action: 'player.lock', target: `user:${userId}` } })
    return { ok: true }
  }
  if (op === 'unlockGame') {
    await prisma.user.update({ where: { id: userId }, data: { selfPlayPhase: 'NORMAL', selfPlayPhaseBalance: null } })
    await prisma.auditLog.create({ data: { actorId: admin.id, action: 'player.unlock', target: `user:${userId}` } })
    return { ok: true }
  }
  return { error: translate(locale, 'admin.playHistory.error.unknownOp') }
}

export default function AdminPlayHistory() {
  const t = useT()
  const data = useLoaderData<typeof loader>()
  const [params] = useSearchParams()
  const navigation = useNavigation()
  const revalidator = useRevalidator()
  const lockFetcher = useFetcher<{ ok?: boolean; error?: string }>()
  const lockProcessing = lockFetcher.state !== 'idle'
  const loading = navigation.state !== 'idle'
  const totalPages = Math.max(1, Math.ceil(data.total / data.pageSize))

  const [walletModal, setWalletModal] = useState<{ userId: string; tel: string } | null>(null)
  const [lockModal, setLockModal] = useState<{ userId: string; tel: string; isLocked: boolean } | null>(null)

  // Revalidate once the lock/unlock fetcher settles
  useEffect(() => {
    if (lockFetcher.state === 'idle' && lockFetcher.data?.ok) {
      revalidator.revalidate()
    }
  }, [lockFetcher.state, lockFetcher.data, revalidator])

  const onFirstPage = data.page === 1
  // This page's loader is the HEAVIEST in the admin (it scans the whole Bet
  // collection — 50k+ rows). During live play `bet:placed`/`round:resolved`
  // fire many times a minute, and re-running this query on each one stacked
  // expensive queries on the DB (the request pile-up / 40s response times).
  // Coalesce all realtime refreshes to at most once every 15s, first page only.
  const lastLiveRevalidateRef = useRef(0)
  const throttledLiveRevalidate = useCallback(() => {
    if (!onFirstPage) return
    const now = Date.now()
    if (now - lastLiveRevalidateRef.current < 15000) return
    lastLiveRevalidateRef.current = now
    revalidator.revalidate()
  }, [onFirstPage, revalidator])
  usePusherEvent<BetPlacedPayload>(ADMIN_CHANNEL, 'bet:placed', throttledLiveRevalidate)
  usePusherEvent<RoundResolvedPayload>(ADMIN_CHANNEL, 'round:resolved', throttledLiveRevalidate)

  function pageHref(p: number) {
    const next = new URLSearchParams(params)
    next.set('page', String(p))
    return `?${next.toString()}`
  }

  function walletHref(w: 'REAL' | 'DEMO') {
    const next = new URLSearchParams(params)
    next.set('wallet', w)
    next.delete('page')
    return `?${next.toString()}`
  }

  function resultHref(r: 'ALL' | 'WIN' | 'LOSS') {
    const next = new URLSearchParams(params)
    next.set('result', r)
    next.delete('page')
    return `?${next.toString()}`
  }

  function betTypeHref(bt: string) {
    const next = new URLSearchParams(params)
    next.set('betType', bt)
    next.delete('page')
    return `?${next.toString()}`
  }

  function modeHref(m: 'ALL' | 'RANDOM' | 'LIVE') {
    const next = new URLSearchParams(params)
    next.set('mode', m)
    next.delete('page')
    return `?${next.toString()}`
  }

  function confirmLock(userId: string, tel: string, isLocked: boolean) {
    setLockModal({ userId, tel, isLocked })
  }

  function executeLock(userId: string, isLocked: boolean) {
    const fd = new FormData()
    fd.set('op', isLocked ? 'unlockGame' : 'lockGame')
    fd.set('userId', userId)
    lockFetcher.submit(fd, { method: 'post' })
    setLockModal(null)
  }

  const filterStyle = (active: boolean, accent?: string) => ({
    background: active ? '#ffffff' : 'transparent',
    color: active ? (accent ?? '#c8102e') : '#9c1024',
    border: `1px solid ${active ? '#f2ccd2' : '#f2ccd2'}`,
  })

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold" style={{ color: '#c8102e' }}>{t('admin.playHistory.title')}</h1>
        <span className="text-xs" style={{ color: '#6b4a4f' }}>{t('admin.playHistory.betsCount', { n: data.total.toLocaleString() })}</span>
      </div>

      {data.sleepMode && (
        <div
          className="flex items-center gap-3 rounded-xl px-4 py-3"
          style={{ background: 'rgba(220,38,38,0.12)', border: '1px solid #ef4444' }}
        >
          <span className="text-base">🌙</span>
          <div className="min-w-0">
            <div className="text-xs font-bold" style={{ color: '#dc2626' }}>{t('admin.playHistory.sleepMode.title')}</div>
            <div className="text-[10px]" style={{ color: '#dc2626' }}>
              {t('admin.playHistory.sleepMode.desc')}
            </div>
          </div>
          <a
            href="/admin"
            className="ml-auto shrink-0 rounded-lg px-3 py-1.5 text-[10px] font-bold"
            style={{ background: 'rgba(220,38,38,0.2)', color: '#dc2626', border: '1px solid #ef4444' }}
          >
            {t('admin.playHistory.sleepMode.manage')}
          </a>
        </div>
      )}

      {/* ─── Wallet tabs ─────────────────────────────────────────────── */}
      <div className="flex overflow-hidden rounded-xl" style={{ border: '1px solid #f2ccd2' }}>
        {WALLET_TABS.map(w => {
          const active = data.walletType === w
          return (
            <Link key={w} to={walletHref(w)} className="flex-1 py-2 text-center text-xs font-bold transition-all"
              style={{ background: active ? '#c8102e' : '#fff5f6', color: active ? '#fff' : '#6b4a4f' }}>
              {w === 'REAL' ? t('admin.playHistory.wallet.real') : t('admin.playHistory.wallet.demo')}
            </Link>
          )
        })}
      </div>

      {/* ─── Filters + Search ─────────────────────────────────────────── */}
      <div className="flex flex-col gap-3 md:flex-row md:gap-4">
        <div className="flex flex-col gap-2 md:w-1/2">
          {/* Row 1: mode filter */}
          <div className="flex gap-1.5">
            {(['ALL', 'RANDOM', 'LIVE'] as const).map(m => (
              <Link key={m} to={modeHref(m)} className="rounded-md px-3 py-1 text-xs font-bold"
                style={filterStyle(data.mode === m, '#6b4a4f')}>
                {m === 'ALL' ? t('admin.playHistory.mode.all') : m === 'RANDOM' ? t('admin.playHistory.mode.random') : t('admin.playHistory.mode.live')}
              </Link>
            ))}
          </div>
          {/* Row 2: result filter */}
          <div className="flex gap-1.5">
            {(['ALL', 'WIN', 'LOSS'] as const).map(r => (
              <Link key={r} to={resultHref(r)} className="rounded-md px-3 py-1 text-xs font-bold"
                style={filterStyle(data.result === r, r === 'WIN' ? '#15803d' : r === 'LOSS' ? '#dc2626' : '#c8102e')}>
                {r === 'ALL' ? t('admin.playHistory.result.all') : r}
              </Link>
            ))}
          </div>
          {/* Row 3: bet type filter */}
          <div className="flex flex-wrap gap-1.5">
            {BET_TYPES.map(bt => (
              <Link key={bt.key} to={betTypeHref(bt.key)} className="rounded-md px-3 py-1 text-xs font-bold"
                style={filterStyle(data.betType === bt.key)}>
                {t(bt.labelKey)}
              </Link>
            ))}
          </div>
        </div>

        <Form method="get" className="flex items-center gap-2 md:w-1/2">
          <input type="hidden" name="wallet"  value={data.walletType} />
          <input type="hidden" name="result"  value={data.result} />
          <input type="hidden" name="betType" value={data.betType} />
          <input type="hidden" name="mode"    value={data.mode} />
          <input type="hidden" name="page"    value="1" />
          <select name="pageSize" defaultValue={data.pageSize}
            onChange={e => { e.currentTarget.form?.requestSubmit() }}
            className="rounded-lg px-2 py-2 text-xs font-bold outline-none shrink-0"
            style={{ background: '#fff5f6', color: '#6b4a4f', border: '1.5px solid #f2ccd2' }}>
            {PAGE_SIZES.map(s => <option key={s} value={s}>{t('admin.playHistory.pageSizeOption', { n: s })}</option>)}
          </select>
          <div className="relative flex-1">
            <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2" style={{ color: '#9c1024' }} />
            <input name="q" defaultValue={data.q} placeholder={t('admin.playHistory.searchPlaceholder')}
              className="w-full rounded-lg py-2 pl-9 pr-3 text-sm outline-none"
              style={{ background: '#fff5f6', color: '#c8102e', border: '1.5px solid #f2ccd2' }} />
          </div>
          <button type="submit" className="rounded-lg px-3 py-2 text-xs font-bold"
            style={{ background: '#c8102e', color: '#fff', border: '1.5px solid #e8949e' }}>
            {loading ? <Loader size={14} className="animate-spin" /> : t('admin.playHistory.search')}
          </button>
          {data.q && (
            <Link to={(() => { const n = new URLSearchParams(params); n.delete('q'); n.delete('page'); return `?${n}` })()}
              className="rounded-lg px-3 py-2 text-xs font-bold"
              style={{ background: '#ffffff', color: '#6b4a4f', border: '1.5px solid #f2ccd2' }}>
              {t('admin.playHistory.clear')}
            </Link>
          )}
        </Form>
      </div>

      {data.bets.length === 0 && (
        <div className="rounded-xl p-8 text-center text-xs" style={{ background: '#fff5f6', color: '#9c1024', border: '1px solid #f2ccd2' }}>
          {t('admin.playHistory.empty')}
        </div>
      )}

      {/* Mobile: cards */}
      {data.bets.length > 0 && (
        <div className="flex flex-col gap-2 md:hidden">
          {data.bets.map((b, i) => (
            <BetCard
              key={b.id} b={b}
              rowNum={(data.page - 1) * data.pageSize + i + 1}
              onView={() => setWalletModal({ userId: b.user.id, tel: b.user.tel })}
              onLock={() => confirmLock(b.user.id, b.user.tel, b.user.selfPlayPhase === 'ADMIN_LOCKED')}
              lockProcessing={lockProcessing}
            />
          ))}
        </div>
      )}

      {/* Desktop: table */}
      {data.bets.length > 0 && (
        <div className="hidden overflow-x-auto rounded-xl md:block" style={{ background: '#fff5f6', border: '1px solid #f2ccd2' }}>
          <table className="w-full text-left text-sm">
            <thead style={{ color: '#6b4a4f' }}>
              <tr className="text-[10px] font-bold" style={{ background: '#ffffff' }}>
                <th className="w-8 px-3 py-2 text-right" style={{ color: '#8a6d71' }}>#</th>
                <th className="px-3 py-2">{t('admin.playHistory.col.when')}</th>
                <th className="px-3 py-2">{t('admin.playHistory.col.player')}</th>
                <th className="px-3 py-2">{t('admin.playHistory.col.bet')}</th>
                <th className="px-3 py-2">{t('admin.playHistory.col.round')}</th>
                <th className="px-3 py-2 text-right">{t('admin.playHistory.col.stake')}</th>
                <th className="px-3 py-2 text-right">{t('admin.playHistory.col.payout')}</th>
                <th className="px-3 py-2">{t('admin.playHistory.col.result')}</th>
                <th className="px-3 py-2">{t('admin.playHistory.col.action')}</th>
              </tr>
            </thead>
            <tbody>
              {data.bets.map((b, i) => {
                const isLocked = b.user.selfPlayPhase === 'ADMIN_LOCKED'
                return (
                  <tr key={b.id} style={{ borderTop: '1px solid #f2ccd2', color: '#2b0b10' }}>
                    <td className="px-3 py-2 text-right text-[10px] font-bold tabular-nums" style={{ color: '#8a6d71' }}>
                      {(data.page - 1) * data.pageSize + i + 1}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-xs" style={{ color: '#9c1024' }}>
                      {new Date(b.createdAt).toLocaleString()}
                    </td>
                    <td className="px-3 py-2 text-xs">
                      <a
                        href={`/admin/customers?q=${encodeURIComponent(b.user.tel)}`}
                        className="font-semibold hover:underline"
                        style={{ color: isLocked ? '#dc2626' : '#c8102e' }}
                        title={isLocked ? t('admin.playHistory.locked') : undefined}
                      >
                        {b.user.tel}
                        {isLocked && <span className="ml-1 text-[9px]">🔒</span>}
                      </a>
                      {b.user.name && (
                        <div className="text-[10px]" style={{ color: '#9c1024' }}>{b.user.name}</div>
                      )}
                    </td>
                    <td className="px-3 py-2"><BetDescription b={b} /></td>
                    <td className="px-3 py-2 text-xs" style={{ color: '#6b4a4f' }}>
                      {b.round ? (
                        <div className="flex flex-col gap-0.5">
                          <span>{b.round.mode.charAt(0) + b.round.mode.slice(1).toLowerCase()} · {b.round.diceSum != null ? b.round.diceSum : b.round.status}</span>
                          {b.round.dice.length > 0 && (
                            <div className="flex items-center gap-0.5">
                              {b.round.dice.map((d, di) => <SymbolImg key={di} symbol={d} size={16} />)}
                            </div>
                          )}
                        </div>
                      ) : '—'}
                    </td>
                    <td className="px-3 py-2 text-right" style={{ color: '#c8102e' }}>{b.amount.toLocaleString()}</td>
                    <td className="px-3 py-2 text-right" style={{ color: b.payout && b.payout > 0 ? '#15803d' : '#9c1024' }}>
                      {b.payout != null ? b.payout.toLocaleString() : '—'}
                    </td>
                    <td className="px-3 py-2"><ResultPill result={b.result} /></td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-1.5">
                        {/* View wallet */}
                        <button
                          type="button"
                          onClick={() => setWalletModal({ userId: b.user.id, tel: b.user.tel })}
                          title={t('admin.playHistory.viewWallet')}
                          className="flex h-7 w-7 items-center justify-center rounded-md transition-opacity hover:opacity-80"
                          style={{ background: '#ffffff', color: '#6b4a4f', border: '1px solid #f2ccd2' }}
                        >
                          <Eye size={12} />
                        </button>
                        {/* Lock / Unlock */}
                        <button
                          type="button"
                          onClick={() => !lockProcessing && confirmLock(b.user.id, b.user.tel, isLocked)}
                          disabled={lockProcessing}
                          title={isLocked ? t('admin.playHistory.unlockPlayer') : t('admin.playHistory.lockPlayer')}
                          className="flex h-7 w-7 items-center justify-center rounded-md transition-opacity hover:opacity-80 disabled:opacity-50"
                          style={{
                            background: isLocked ? 'rgba(22,163,74,0.2)' : 'rgba(220,38,38,0.15)',
                            color: isLocked ? '#15803d' : '#dc2626',
                            border: `1px solid ${isLocked ? '#16a34a' : '#dc2626'}`,
                          }}
                        >
                          {lockProcessing ? <Loader size={12} className="animate-spin" /> : <Lock size={12} />}
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {totalPages > 1 && (
        <div className="flex flex-col items-center gap-1.5">
          <div className="flex items-center gap-2">
            {data.page > 1 && (
              <Link to={pageHref(data.page - 1)} className="rounded-md px-3 py-1.5 text-xs font-bold"
                style={{ background: '#ffffff', color: '#6b4a4f', border: '1px solid #f2ccd2' }}>{t('admin.playHistory.prev')}</Link>
            )}
            {data.page < totalPages && (
              <Link to={pageHref(data.page + 1)} className="rounded-md px-3 py-1.5 text-xs font-bold"
                style={{ background: '#ffffff', color: '#6b4a4f', border: '1px solid #f2ccd2' }}>{t('admin.playHistory.next')}</Link>
            )}
          </div>
          <span className="text-xs tabular-nums" style={{ color: '#6b4a4f' }}>
            {t('admin.playHistory.pageSummary', {
              from: Math.min((data.page - 1) * data.pageSize + 1, data.total),
              to: Math.min(data.page * data.pageSize, data.total).toLocaleString(),
              total: data.total.toLocaleString(),
              page: data.page,
              totalPages,
            })}
          </span>
        </div>
      )}

      {/* Modals */}
      {walletModal && (
        <PlayerWalletModal
          userId={walletModal.userId}
          tel={walletModal.tel}
          onClose={() => setWalletModal(null)}
        />
      )}
      {lockModal && (
        <LockConfirmModal
          tel={lockModal.tel}
          isLocked={lockModal.isLocked}
          onClose={() => !lockProcessing && setLockModal(null)}
          onConfirm={() => executeLock(lockModal.userId, lockModal.isLocked)}
          processing={lockProcessing}
        />
      )}
    </div>
  )
}

// ─── Shared helpers ───────────────────────────────────────────────────

type Bet = ReturnType<typeof useLoaderData<typeof loader>>['bets'][number]

function SymbolImg({ symbol, size = 18 }: { symbol: string; size?: number }) {
  return (
    <img src={`/symbols/${symbol.toLowerCase()}.png`} alt={symbol}
      width={size} height={size}
      className="inline-block rounded object-contain"
      style={{ background: '#fff', padding: 1 }} />
  )
}

// Simplified: icon(s) + type only, no symbol names
function BetDescription({ b }: { b: Bet }) {
  const t = useT()
  if (b.kind === 'SYMBOL' && b.symbol) {
    return (
      <span className="flex items-center gap-1 text-xs">
        <SymbolImg symbol={b.symbol} />
        <span style={{ color: '#6b4a4f' }}>{t('admin.playHistory.betType.single')}</span>
      </span>
    )
  }
  if (b.kind === 'PAIR' && b.pairA && b.pairB) {
    return (
      <span className="flex items-center gap-1 text-xs">
        <SymbolImg symbol={b.pairA} />
        <SymbolImg symbol={b.pairB} />
        <span style={{ color: '#6b4a4f' }}>{t('admin.playHistory.betType.pair')}</span>
      </span>
    )
  }
  if (b.kind === 'RANGE' && b.range) {
    const icon = b.range === 'LOW'
      ? <ArrowDown size={14} style={{ color: '#2563eb' }} />
      : b.range === 'HIGH'
        ? <ArrowUp size={14} style={{ color: '#dc2626' }} />
        : <ArrowUpDown size={14} style={{ color: '#9c1024' }} />
    const label = b.range === 'LOW' ? t('admin.playHistory.betType.low') : b.range === 'HIGH' ? t('admin.playHistory.betType.high') : t('admin.playHistory.betType.middle')
    return (
      <span className="flex items-center gap-1 text-xs">
        {icon}
        <span style={{ color: '#6b4a4f' }}>{label}</span>
      </span>
    )
  }
  if (b.kind === 'SUM' && b.exactSum != null) {
    return <span className="text-xs font-bold" style={{ color: '#b45309' }}>{t('admin.playHistory.bet.sumExact', { n: b.exactSum })}</span>
  }
  return <span className="text-xs">{b.kind}</span>
}

function BetCard({ b, rowNum, onView, onLock, lockProcessing }: { b: Bet; rowNum: number; onView: () => void; onLock: () => void; lockProcessing?: boolean }) {
  const t = useT()
  const isLocked = b.user.selfPlayPhase === 'ADMIN_LOCKED'
  return (
    <div className="rounded-xl p-3" style={{ background: '#fff5f6', border: '1px solid #f2ccd2' }}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] font-bold tabular-nums" style={{ color: '#8a6d71' }}>#{rowNum}</span>
            <a href={`/admin/customers?q=${encodeURIComponent(b.user.tel)}`}
              className="hover:underline"
              style={{ color: isLocked ? '#dc2626' : '#c8102e' }}>
              <div className="text-sm font-semibold">{b.user.tel}{isLocked ? ' 🔒' : ''}</div>
              {b.user.name && (
                <div className="text-[10px]" style={{ color: '#9c1024' }}>{b.user.name}</div>
              )}
            </a>
          </div>
          <div className="mt-0.5 text-xs" style={{ color: '#9c1024' }}>{new Date(b.createdAt).toLocaleString()}</div>
        </div>
        <ResultPill result={b.result} />
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs" style={{ color: '#6b4a4f' }}>
        <BetDescription b={b} />
        {b.round && (
          <span className="flex items-center gap-1">
            <span>{b.round.mode} · {b.round.diceSum != null ? b.round.diceSum : b.round.status}</span>
            {b.round.dice.map((d, di) => <SymbolImg key={di} symbol={d} size={14} />)}
          </span>
        )}
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2">
        <div className="rounded-md px-2 py-1.5" style={{ background: '#ffffff' }}>
          <div className="text-[9px] font-bold" style={{ color: '#6b4a4f' }}>{t('admin.playHistory.col.stake')}</div>
          <div className="font-semibold" style={{ color: '#c8102e' }}>{b.amount.toLocaleString()}</div>
        </div>
        <div className="rounded-md px-2 py-1.5" style={{ background: '#ffffff' }}>
          <div className="text-[9px] font-bold" style={{ color: '#6b4a4f' }}>{t('admin.playHistory.col.payout')}</div>
          <div className="font-semibold" style={{ color: b.payout && b.payout > 0 ? '#15803d' : '#6b4a4f' }}>
            {b.payout != null ? b.payout.toLocaleString() : '—'}
          </div>
        </div>
      </div>
      <div className="mt-2 flex gap-2">
        <button type="button" onClick={onView}
          className="flex flex-1 items-center justify-center gap-1.5 rounded-lg py-1.5 text-xs font-bold"
          style={{ background: '#ffffff', color: '#6b4a4f', border: '1px solid #f2ccd2' }}>
          <Eye size={12} /> {t('admin.playHistory.viewWallet')}
        </button>
        <button type="button" onClick={onLock} disabled={lockProcessing}
          className="flex flex-1 items-center justify-center gap-1.5 rounded-lg py-1.5 text-xs font-bold disabled:opacity-50"
          style={{
            background: isLocked ? 'rgba(22,163,74,0.2)' : 'rgba(220,38,38,0.15)',
            color: isLocked ? '#15803d' : '#dc2626',
            border: `1px solid ${isLocked ? '#16a34a' : '#dc2626'}`,
          }}>
          {lockProcessing ? <Loader size={12} className="animate-spin" /> : <Lock size={12} />}
          {isLocked ? t('admin.playHistory.card.unlock') : t('admin.playHistory.card.lock')}
        </button>
      </div>
    </div>
  )
}

function ResultPill({ result }: { result: string | null }) {
  if (!result) return <span className="text-[10px]" style={{ color: '#9c1024' }}>—</span>
  if (result === 'REFUNDED') {
    return (
      <span className="inline-block rounded-full px-2 py-0.5 text-[10px] font-bold"
        style={{ background: 'rgba(217,119,6,0.2)', color: '#b45309' }}>
        REFUNDED
      </span>
    )
  }
  const isWin = result === 'WIN'
  return (
    <span className="inline-block rounded-full px-2 py-0.5 text-[10px] font-bold"
      style={{ background: isWin ? 'rgba(22,163,74,0.2)' : 'rgba(220,38,38,0.2)', color: isWin ? '#15803d' : '#dc2626' }}>
      {result}
    </span>
  )
}

function TxStatusPill({ status }: { status: string }) {
  const map: Record<string, { bg: string; color: string }> = {
    COMPLETED: { bg: 'rgba(22,163,74,0.2)', color: '#15803d' },
    PENDING:   { bg: 'rgba(234,179,8,0.2)', color: '#b45309' },
    FAILED:    { bg: 'rgba(220,38,38,0.2)', color: '#dc2626' },
    CANCELLED: { bg: 'rgba(100,116,139,0.2)', color: '#8a6d71' },
  }
  const s = map[status] ?? { bg: 'rgba(100,116,139,0.2)', color: '#8a6d71' }
  return (
    <span className="inline-block rounded-full px-2 py-0.5 text-[10px] font-bold" style={{ background: s.bg, color: s.color }}>
      {status}
    </span>
  )
}

// ─── Lock confirm modal ───────────────────────────────────────────────

function LockConfirmModal({
  tel, isLocked, onClose, onConfirm, processing,
}: {
  tel: string
  isLocked: boolean
  onClose: () => void
  onConfirm: () => void
  processing?: boolean
}) {
  const t = useT()
  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center p-6"
      style={{ background: 'rgba(0,0,0,0.8)' }} onClick={onClose}>
      <div className="w-full max-w-sm rounded-2xl p-6"
        style={{ background: '#fff5f6', border: `2px solid ${isLocked ? '#16a34a' : '#dc2626'}` }}
        onClick={e => e.stopPropagation()}>
        <div className="mb-1 flex items-center gap-2">
          <Lock size={18} style={{ color: isLocked ? '#15803d' : '#dc2626' }} />
          <h2 className="text-base font-bold" style={{ color: isLocked ? '#15803d' : '#dc2626' }}>
            {isLocked ? t('admin.playHistory.lockModal.unlockTitle') : t('admin.playHistory.lockModal.lockTitle')}
          </h2>
        </div>
        <p className="mt-3 text-sm" style={{ color: '#2b0b10' }}>
          {isLocked
            ? t('admin.playHistory.lockModal.unlockDesc', { tel })
            : <>{t('admin.playHistory.lockModal.lockDescPrefix', { tel })} <strong className="text-red-400">{t('admin.playHistory.lockModal.lockDescBold')}</strong> {t('admin.playHistory.lockModal.lockDescSuffix')}</>
          }
        </p>
        <div className="mt-5 flex gap-3">
          <button type="button" onClick={onClose}
            className="flex-1 rounded-xl py-2.5 text-sm font-bold"
            style={{ background: '#fff0f2', color: '#9c1024', border: '1px solid #f2ccd2' }}>
            {t('admin.playHistory.lockModal.cancel')}
          </button>
          <button type="button" onClick={onConfirm} disabled={processing}
            className="flex flex-1 items-center justify-center gap-2 rounded-xl py-2.5 text-sm font-bold disabled:opacity-60"
            style={{
              background: isLocked ? 'linear-gradient(135deg,#16a34a,#14532d)' : 'linear-gradient(135deg,#dc2626,#7f1d1d)',
              color: '#fff',
              border: `1px solid ${isLocked ? '#4ade80' : '#fca5a5'}`,
            }}>
            {processing && <Loader size={14} className="animate-spin" />}
            {processing ? t('admin.playHistory.lockModal.processing') : isLocked ? t('admin.playHistory.lockModal.yesUnlock') : t('admin.playHistory.lockModal.yesLock')}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Player wallet modal (same as admin/wallet but with wallet picker) ─

type UserBase = { id: string; tel: string; name: string | null; status: string; role: string; createdAt: string }
type WalletBase = { type: string; balance: number }
type DetailData = {
  view: 'detail'
  user: UserBase
  wallet: WalletBase
  recent: { id: string; type: string; amount: number; status: string; balanceBefore: number; balanceAfter: number; note: string | null; createdAt: string }[]
}
type SummaryData = {
  view: 'summary'
  user: UserBase
  wallet: WalletBase
  incoming: { type: string; total: number; count: number }[]
  outgoing: { type: string; total: number; count: number }[]
  incomingTotal: number
  outgoingTotal: number
  calculatedAvailable: number
}

function PlayerWalletModal({ userId, tel, onClose }: { userId: string; tel: string; onClose: () => void }) {
  const t = useT()
  const [wallet, setWallet] = useState<'REAL' | 'DEMO' | 'PROMO'>('REAL')
  const [kind, setKind] = useState<'detail' | 'summary'>('detail')
  const detailFetcher = useFetcher<DetailData | { error: string }>()
  const summaryFetcher = useFetcher<SummaryData | { error: string }>()

  const active = kind === 'detail' ? detailFetcher : summaryFetcher
  const detailData = detailFetcher.data && !('error' in detailFetcher.data) ? detailFetcher.data : null
  const summaryData = summaryFetcher.data && !('error' in summaryFetcher.data) ? summaryFetcher.data : null
  const error = active.data && 'error' in active.data ? active.data.error : null

  // Reload whenever wallet or kind changes
  const fetchKey = `${userId}-${wallet}-${kind}`
  const [lastFetchKey, setLastFetchKey] = useState('')
  if (fetchKey !== lastFetchKey) {
    setLastFetchKey(fetchKey)
    if (kind === 'detail') {
      detailFetcher.load(`/api/admin/wallet-summary?userId=${userId}&view=detail&wallet=${wallet}`)
    } else {
      summaryFetcher.load(`/api/admin/wallet-summary?userId=${userId}&view=summary&wallet=${wallet}`)
    }
  }

  const walletColor: Record<string, string> = { REAL: '#c8102e', DEMO: '#6b4a4f', PROMO: '#b45309' }
  const walletLabel: Record<string, string> = { REAL: t('admin.playHistory.walletModal.real'), DEMO: t('admin.playHistory.walletModal.demo'), PROMO: t('admin.playHistory.walletModal.promo') }

  return (
    <div className="fixed inset-0 z-[100] flex items-end justify-center backdrop-blur-sm md:items-center md:p-4"
      style={{ background: 'rgba(0,0,0,0.75)' }} onClick={onClose} role="dialog" aria-modal="true">
      <div onClick={e => e.stopPropagation()}
        className="relative flex h-[92vh] w-full flex-col overflow-hidden rounded-t-2xl md:h-auto md:max-h-[90vh] md:max-w-3xl md:rounded-2xl"
        style={{ background: '#fff5f6', border: '1px solid #f2ccd2' }}>

        {/* Header */}
        <div className="flex items-center justify-between gap-3 border-b px-5 py-4" style={{ borderColor: '#f2ccd2', background: '#ffffff' }}>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 text-xs font-bold" style={{ color: '#6b4a4f' }}>
              <Wallet size={12} /> {t('admin.playHistory.walletModal.header')}
            </div>
            <div className="text-sm font-bold" style={{ color: '#c8102e' }}>
              <a href={`/admin/customers?q=${encodeURIComponent(tel)}`} className="hover:underline">{tel}</a>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap justify-end">
            {/* Wallet tabs */}
            <div className="flex overflow-hidden rounded-md text-[11px] font-bold" style={{ border: '1px solid #f2ccd2' }}>
              {(['REAL', 'DEMO', 'PROMO'] as const).map(w => (
                <button key={w} type="button" onClick={() => { setWallet(w); setKind('detail') }}
                  className="px-2.5 py-1 transition-colors"
                  style={{ background: wallet === w ? walletColor[w] : 'transparent', color: wallet === w ? '#2b0b10' : '#6b4a4f' }}>
                  {walletLabel[w]}
                </button>
              ))}
            </div>
            {/* View tabs */}
            <div className="flex overflow-hidden rounded-md text-[11px] font-bold" style={{ border: '1px solid #f2ccd2' }}>
              {(['detail', 'summary'] as const).map(k => (
                <button key={k} type="button" onClick={() => setKind(k)}
                  className="px-2.5 py-1 transition-colors"
                  style={{ background: kind === k ? '#c8102e' : 'transparent', color: kind === k ? '#fff' : '#6b4a4f' }}>
                  {k === 'detail' ? t('admin.playHistory.walletModal.detailTab') : t('admin.playHistory.walletModal.summaryTab')}
                </button>
              ))}
            </div>
            <button onClick={onClose} type="button"
              className="flex h-8 w-8 items-center justify-center rounded-full"
              style={{ background: '#ffffff', color: '#6b4a4f', border: '1px solid #f2ccd2' }}>
              <X size={14} />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {active.state !== 'idle' && !active.data && (
            <div className="flex h-32 items-center justify-center" style={{ color: '#6b4a4f' }}>
              <Loader size={18} className="animate-spin" />
            </div>
          )}
          {error && (
            <div className="rounded-lg px-3 py-2 text-xs" style={{ background: 'rgba(220,38,38,0.15)', color: '#dc2626', border: '1px solid #f87171' }}>
              {error}
            </div>
          )}
          {kind === 'detail' && detailData && <DetailView data={detailData} />}
          {kind === 'summary' && summaryData && <SummaryView data={summaryData} />}
        </div>
      </div>
    </div>
  )
}

function DetailView({ data }: { data: DetailData }) {
  const t = useT()
  const walletColor: Record<string, string> = { REAL: '#c8102e', DEMO: '#6b4a4f', PROMO: '#b45309' }
  const color = walletColor[data.wallet.type] ?? '#2b0b10'
  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-xl p-4" style={{ background: 'linear-gradient(135deg, #ffffff, #fff5f6)', border: '1px solid #f2ccd2' }}>
        <div className="text-[10px] font-bold tracking-wider" style={{ color: '#6b4a4f' }}>{t('admin.playHistory.detail.balance', { type: data.wallet.type })}</div>
        <div className="mt-1 text-xl font-bold md:text-3xl" style={{ color }}>{data.wallet.balance.toLocaleString()} ₭</div>
      </div>
      <div>
        <div className="mb-2 flex items-end justify-between gap-3">
          <div className="text-[10px] font-bold" style={{ color: '#6b4a4f' }}>{t('admin.playHistory.detail.recentTx')}</div>
          <div className="text-right">
            <div className="text-[9px]" style={{ color: '#8a6d71' }}>{t('admin.playHistory.detail.balanceAfter')}</div>
            <div className="text-xs font-bold" style={{ color }}>
              {(data.recent[0]?.balanceAfter ?? data.wallet.balance).toLocaleString()} ₭
            </div>
          </div>
        </div>
        <div className="overflow-x-auto rounded-lg" style={{ border: '1px solid #f2ccd2' }}>
          <table className="w-full min-w-[480px] text-left text-xs">
            <thead style={{ color: '#6b4a4f' }}>
              <tr style={{ background: '#ffffff' }}>
                <th className="px-3 py-2">{t('admin.playHistory.col.when')}</th>
                <th className="px-3 py-2">{t('admin.playHistory.detail.col.type')}</th>
                <th className="px-3 py-2 text-right">{t('admin.playHistory.detail.col.amount')}</th>
                <th className="px-3 py-2">{t('admin.playHistory.detail.col.status')}</th>
              </tr>
            </thead>
            <tbody>
              {data.recent.length === 0 && (
                <tr><td colSpan={4} className="px-3 py-3 text-center" style={{ color: '#8a6d71' }}>{t('admin.playHistory.detail.noTx')}</td></tr>
              )}
              {data.recent.map(tx => {
                const isOut = tx.type === 'WITHDRAW' || tx.type === 'LOSS' || tx.type === 'TRANSFER_OUT'
                return (
                  <tr key={tx.id} style={{ borderTop: '1px solid #f2ccd2', color: '#2b0b10' }}>
                    <td className="px-3 py-2 whitespace-nowrap" style={{ color: '#6b4a4f' }}>{new Date(tx.createdAt).toLocaleString()}</td>
                    <td className="px-3 py-2">{typeLabel(t, tx.type)}</td>
                    <td className="px-3 py-2 text-right" style={{ color: isOut ? '#dc2626' : '#15803d' }}>
                      {isOut ? '−' : '+'}{tx.amount.toLocaleString()}
                    </td>
                    <td className="px-3 py-2"><TxStatusPill status={tx.status} /></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <div className="mt-3 flex justify-center">
          <a href={`/admin/transactions?q=${encodeURIComponent(data.user.tel)}`}
            className="rounded-md px-4 py-1.5 text-xs font-bold hover:opacity-80"
            style={{ background: '#ffffff', color: '#6b4a4f', border: '1px solid #f2ccd2' }}>
            {t('admin.playHistory.detail.viewMore')}
          </a>
        </div>
      </div>
    </div>
  )
}

function SummaryView({ data }: { data: SummaryData }) {
  const t = useT()
  const walletColor: Record<string, string> = { REAL: '#c8102e', DEMO: '#6b4a4f', PROMO: '#b45309' }
  const color = walletColor[data.wallet.type] ?? '#2b0b10'
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <LedgerColumn tone="in" title={t('admin.playHistory.summary.depositsEarnings')} icon={<ArrowDownCircle size={14} />}
          rows={data.incoming} total={data.incomingTotal} />
        <LedgerColumn tone="out" title={t('admin.playHistory.summary.withdrawalsLosses')} icon={<ArrowUpCircle size={14} />}
          rows={data.outgoing} total={data.outgoingTotal} />
      </div>
      <div className="rounded-xl p-4" style={{ background: 'linear-gradient(135deg, #ffffff, #fff5f6)', border: '1px solid #f2ccd2' }}>
        <div className="text-[10px] font-bold tracking-wider" style={{ color: '#6b4a4f' }}>{t('admin.playHistory.summary.calculatedAvailable')}</div>
        <div className="mt-1 text-xl font-bold md:text-3xl" style={{ color: '#c8102e' }}>{data.calculatedAvailable.toLocaleString()} ₭</div>
        <div className="mt-3 flex items-center justify-between text-xs">
          <span style={{ color: '#8a6d71' }}>{t('admin.playHistory.summary.currentBalance', { type: data.wallet.type })}</span>
          <span className="font-bold" style={{ color }}>{data.wallet.balance.toLocaleString()} ₭</span>
        </div>
      </div>
    </div>
  )
}

function LedgerColumn({ tone, title, icon, rows, total }: {
  tone: 'in' | 'out'; title: string; icon: React.ReactNode
  rows: { type: string; total: number; count: number }[]; total: number
}) {
  const t = useT()
  const accent = tone === 'in' ? '#4ade80' : '#f87171'
  return (
    <div className="rounded-xl" style={{ background: '#fff5f6', border: '1px solid #f2ccd2' }}>
      <div className="flex items-center justify-between gap-2 px-4 py-3"
        style={{ background: tone === 'in' ? 'rgba(74,222,128,0.08)' : 'rgba(248,113,113,0.08)', borderBottom: '1px solid #f2ccd2' }}>
        <div className="flex items-center gap-1.5 text-[11px] font-bold" style={{ color: accent }}>{icon}{title}</div>
        <div className="text-xs font-bold" style={{ color: accent }}>{tone === 'in' ? '+' : '−'}{total.toLocaleString()}</div>
      </div>
      <ul>
        {rows.map(r => (
          <li key={r.type} className="flex items-center justify-between gap-3 px-4 py-2 text-xs" style={{ borderTop: '1px solid #f2ccd2' }}>
            <div className="flex flex-col">
              <span style={{ color: '#2b0b10' }}>{typeLabel(t, r.type)}</span>
              <span className="text-[10px]" style={{ color: '#8a6d71' }}>{t('admin.playHistory.ledger.entries', { n: r.count })}</span>
            </div>
            <span style={{ color: r.total > 0 ? accent : '#8a6d71' }} className="font-semibold">{r.total.toLocaleString()}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

export function ErrorBoundary() {
  const t = useT()
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-xl p-10 text-center"
      style={{ background: '#fff5f6', border: '1px solid #f2ccd2' }}>
      <p className="text-sm font-semibold" style={{ color: '#dc2626' }}>{t('admin.playHistory.errorBoundary.message')}</p>
      <a href="/admin/play-history"
        className="rounded-lg px-4 py-2 text-xs font-bold"
        style={{ background: '#ffffff', color: '#6b4a4f', border: '1px solid #f2ccd2' }}>
        {t('admin.playHistory.errorBoundary.tryAgain')}
      </a>
    </div>
  )
}

