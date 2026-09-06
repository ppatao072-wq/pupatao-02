import { useEffect, useState } from 'react'
import { useFetcher, useLoaderData } from 'react-router'
import { Check, Gift, Loader, Users, Wallet, X } from 'lucide-react'
import type { Route } from './+types/admin.referral'
import { requireAdmin, requireRole } from '~/lib/admin-auth.server'
import { prisma } from '~/lib/prisma.server'
import { getReferralConfig, setReferralConfig } from '~/lib/system-settings.server'
import { useT } from '~/lib/use-t'
import { t as translate, parseLocaleCookie } from '~/lib/i18n'

// ─── LOADER ──────────────────────────────────────────────────────────
export async function loader({ request }: Route.LoaderArgs) {
  await requireRole(request, ['ADMIN', 'SUPERADMIN'])

  const [config, referralBonusAgg, totalReferredUsers] = await Promise.all([
    getReferralConfig(),
    prisma.transaction.groupBy({
      by: ['userId'],
      where: { type: 'REFERRAL_BONUS' },
      _sum: { amount: true },
      _count: { _all: true },
    }),
    prisma.user.count({ where: { referredById: { not: null } } }),
  ])

  const totalPaid = referralBonusAgg.reduce((sum, r) => sum + (r._sum.amount ?? 0), 0)

  const topAgg = referralBonusAgg
    .sort((a, b) => (b._sum.amount ?? 0) - (a._sum.amount ?? 0))
    .slice(0, 50)

  const referrerIds = topAgg.map(r => r.userId)
  const referrerUsers = referrerIds.length
    ? await prisma.user.findMany({
        where: { id: { in: referrerIds } },
        select: {
          id: true, tel: true, firstName: true, lastName: true,
          _count: { select: { referrals: true } },
        },
      })
    : []
  const userMap = new Map(referrerUsers.map(u => [u.id, u]))

  const leaderboard = topAgg.map(r => {
    const u = userMap.get(r.userId)
    return {
      userId: r.userId,
      tel: u?.tel ?? '—',
      name: u ? [u.firstName, u.lastName].filter(Boolean).join(' ') || null : null,
      referralCount: u?._count.referrals ?? 0,
      payoutCount: r._count._all,
      totalEarned: r._sum.amount ?? 0,
    }
  })

  return {
    config,
    totalPaid,
    totalReferredUsers,
    activeReferrers: referralBonusAgg.length,
    leaderboard,
  }
}

// ─── ACTION ──────────────────────────────────────────────────────────
export async function action({ request }: Route.ActionArgs) {
  const admin = await requireAdmin(request)
  const locale = parseLocaleCookie(request.headers.get('cookie'))
  if (admin.role === 'SUPPORT') return { error: translate(locale, 'admin.referral.err.insufficientPermissions') }
  const fd = await request.formData()
  const op = String(fd.get('op') ?? '')

  if (op === 'toggleReferral') {
    const current = await getReferralConfig()
    const next = !current.enabled
    await setReferralConfig({ enabled: next, percent: current.percent }, admin.id)
    await prisma.auditLog.create({
      data: { actorId: admin.id, action: next ? 'referral.enable' : 'referral.disable', metadata: { percent: current.percent } },
    })
    return { ok: true }
  }

  if (op === 'savePercent') {
    const raw = Number(fd.get('percent'))
    if (!Number.isFinite(raw) || raw <= 0 || raw > 100) {
      return { error: translate(locale, 'admin.referral.err.invalidPercent') }
    }
    const current = await getReferralConfig()
    await setReferralConfig({ enabled: current.enabled, percent: raw }, admin.id)
    await prisma.auditLog.create({
      data: { actorId: admin.id, action: 'referral.setPercent', metadata: { percent: raw } },
    })
    return { ok: true }
  }

  return { error: translate(locale, 'admin.referral.err.unknownOp') }
}

// ─── PAGE ─────────────────────────────────────────────────────────────
export default function AdminReferral() {
  const t = useT()
  const { config, totalPaid, totalReferredUsers, activeReferrers, leaderboard } = useLoaderData<typeof loader>()
  const [percentInput, setPercentInput] = useState(String(config.percent || 10))
  const [showConfirm, setShowConfirm] = useState(false)
  const toggleFetcher = useFetcher<{ ok?: boolean; error?: string }>()
  const percentFetcher = useFetcher<{ ok?: boolean; error?: string }>()

  useEffect(() => {
    if (toggleFetcher.state === 'idle' && toggleFetcher.data?.ok) setShowConfirm(false)
  }, [toggleFetcher.state, toggleFetcher.data])

  const isEnabled = config.enabled
  const fmt = (n: number) => n.toLocaleString()

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h1 className="flex items-center gap-2 text-xl font-bold" style={{ color: '#fbbf24' }}>
          <Gift size={20} /> {t('admin.referral.title')}
        </h1>
        <span className="rounded-full px-3 py-1 text-[10px] font-bold"
          style={{
            background: isEnabled ? 'rgba(22,163,74,0.2)' : 'rgba(100,116,139,0.2)',
            color: isEnabled ? '#4ade80' : '#94a3b8',
            border: `1px solid ${isEnabled ? '#16a34a' : '#334155'}`,
          }}>
          {isEnabled ? t('admin.referral.status.on') : t('admin.referral.status.off')}
        </span>
      </div>

      {/* ── Stats ── */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="rounded-xl p-4" style={{ background: '#0f172a', border: '1px solid #1e1b4b' }}>
          <div className="flex items-center gap-2 text-[10px] font-bold" style={{ color: '#a5b4fc' }}>
            <Wallet size={12} /> {t('admin.referral.stats.totalPaid')}
          </div>
          <div className="mt-1 text-lg font-bold" style={{ color: '#4ade80' }}>{fmt(totalPaid)} ₭</div>
        </div>
        <div className="rounded-xl p-4" style={{ background: '#0f172a', border: '1px solid #1e1b4b' }}>
          <div className="flex items-center gap-2 text-[10px] font-bold" style={{ color: '#a5b4fc' }}>
            <Users size={12} /> {t('admin.referral.stats.totalReferred')}
          </div>
          <div className="mt-1 text-lg font-bold" style={{ color: '#fde68a' }}>{fmt(totalReferredUsers)}</div>
        </div>
        <div className="rounded-xl p-4" style={{ background: '#0f172a', border: '1px solid #1e1b4b' }}>
          <div className="flex items-center gap-2 text-[10px] font-bold" style={{ color: '#a5b4fc' }}>
            <Gift size={12} /> {t('admin.referral.stats.activeReferrers')}
          </div>
          <div className="mt-1 text-lg font-bold" style={{ color: '#fde68a' }}>{fmt(activeReferrers)}</div>
        </div>
      </div>

      {/* ── Campaign settings ── */}
      <div className="rounded-xl p-4"
        style={{
          background: isEnabled ? 'rgba(22,163,74,0.08)' : '#0f172a',
          border: `1px solid ${isEnabled ? '#16a34a' : '#1e1b4b'}`,
        }}>
        <div className="mb-3 text-sm font-bold" style={{ color: '#fde68a' }}>
          {t('admin.referral.panel.heading')}
        </div>
        <p className="mb-4 text-xs" style={{ color: '#a5b4fc' }}>
          {isEnabled
            ? t('admin.referral.panel.descOn', { percent: config.percent })
            : t('admin.referral.panel.descOff')}
        </p>

        <div className="flex flex-wrap items-end gap-3">
          <percentFetcher.Form method="post" className="flex items-end gap-2">
            <input type="hidden" name="op" value="savePercent" />
            <div className="flex flex-col gap-1">
              <label className="text-[10px] font-bold" style={{ color: '#a5b4fc' }}>
                {t('admin.referral.form.percentLabel')}
              </label>
              <div className="flex items-center gap-1.5">
                <input
                  name="percent"
                  type="number"
                  min={1}
                  max={100}
                  step={1}
                  value={percentInput}
                  onChange={e => setPercentInput(e.target.value)}
                  className="w-20 rounded-lg px-3 py-2 text-sm font-bold outline-none"
                  style={{ background: '#1e1b4b', color: '#fde68a', border: '1px solid #4338ca' }}
                />
                <span className="text-xs font-bold" style={{ color: '#a5b4fc' }}>%</span>
              </div>
            </div>
            <button type="submit" disabled={percentFetcher.state !== 'idle'}
              className="inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-xs font-bold disabled:opacity-50"
              style={{ background: 'linear-gradient(135deg,#4338ca,#312e81)', color: '#fff', border: '1px solid #818cf8' }}>
              {percentFetcher.state !== 'idle' ? <Loader size={12} className="animate-spin" /> : <Check size={12} />}
              {percentFetcher.state !== 'idle' ? t('admin.referral.form.saving') : t('admin.referral.form.save')}
            </button>
          </percentFetcher.Form>

          <button type="button" onClick={() => setShowConfirm(true)}
            className="inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-xs font-bold"
            style={{
              background: isEnabled ? 'linear-gradient(135deg,#7f1d1d,#450a0a)' : 'linear-gradient(135deg,#14532d,#052e16)',
              color: '#fff', border: `1px solid ${isEnabled ? '#fca5a5' : '#4ade80'}`,
            }}>
            {isEnabled ? t('admin.referral.disable') : t('admin.referral.enable')}
          </button>
        </div>
        {percentFetcher.data?.error && (
          <p className="mt-2 text-xs font-semibold" style={{ color: '#f87171' }}>{percentFetcher.data.error}</p>
        )}
      </div>

      {/* ── Leaderboard ── */}
      <div className="overflow-hidden rounded-xl" style={{ background: '#0f172a', border: '1px solid #1e1b4b' }}>
        <div className="px-4 py-3 text-[10px] font-bold" style={{ background: '#1e1b4b', color: '#a5b4fc' }}>
          {t('admin.referral.leaderboard.heading')}
        </div>
        {leaderboard.length === 0 ? (
          <div className="px-4 py-8 text-center text-xs" style={{ color: '#64748b' }}>
            {t('admin.referral.leaderboard.empty')}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="text-[10px] font-bold" style={{ color: '#64748b' }}>
                  <th className="w-8 px-3 py-2 text-right">#</th>
                  <th className="px-3 py-2">{t('admin.referral.leaderboard.col.player')}</th>
                  <th className="px-3 py-2 text-right">{t('admin.referral.leaderboard.col.referrals')}</th>
                  <th className="px-3 py-2 text-right">{t('admin.referral.leaderboard.col.payouts')}</th>
                  <th className="px-3 py-2 text-right">{t('admin.referral.leaderboard.col.totalEarned')}</th>
                </tr>
              </thead>
              <tbody>
                {leaderboard.map((r, i) => (
                  <tr key={r.userId} style={{ borderTop: '1px solid #1e1b4b', color: '#e9d5ff' }}>
                    <td className="px-3 py-2.5 text-right" style={{ color: '#64748b' }}>{i + 1}</td>
                    <td className="px-3 py-2.5">
                      <div className="text-xs font-semibold" style={{ color: '#fde68a' }}>{r.name ?? '—'}</div>
                      <div className="text-[10px]" style={{ color: '#818cf8' }}>{r.tel}</div>
                    </td>
                    <td className="px-3 py-2.5 text-right text-xs" style={{ color: '#a5b4fc' }}>{r.referralCount}</td>
                    <td className="px-3 py-2.5 text-right text-xs" style={{ color: '#a5b4fc' }}>{r.payoutCount}</td>
                    <td className="px-3 py-2.5 text-right font-bold" style={{ color: '#4ade80' }}>{fmt(r.totalEarned)} ₭</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Enable/disable confirmation */}
      {showConfirm && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center p-6"
          style={{ background: 'rgba(0,0,0,0.8)' }} onClick={() => setShowConfirm(false)}>
          <div className="w-full max-w-sm rounded-2xl p-6"
            style={{ background: '#1e0040', border: `2px solid ${isEnabled ? '#ef4444' : '#16a34a'}` }}
            onClick={e => e.stopPropagation()}>
            <h2 className="mb-1 flex items-center gap-2 text-base font-bold" style={{ color: isEnabled ? '#f87171' : '#4ade80' }}>
              <Gift size={16} /> {isEnabled ? t('admin.referral.confirmDisable.title') : t('admin.referral.confirmEnable.title')}
            </h2>
            <p className="mt-3 text-sm" style={{ color: '#e9d5ff' }}>
              {isEnabled
                ? t('admin.referral.confirmDisable.body')
                : t('admin.referral.confirmEnable.body', { percent: percentInput })}
            </p>
            <div className="mt-5 flex gap-3">
              <button type="button" onClick={() => setShowConfirm(false)}
                className="flex-1 rounded-xl py-2.5 text-sm font-bold"
                style={{ background: '#2d1b4e', color: '#a78bfa', border: '1px solid #4c1d95' }}>
                <X size={12} className="inline mr-1" />{t('admin.referral.confirm.cancel')}
              </button>
              <toggleFetcher.Form method="post" className="flex-1">
                <input type="hidden" name="op" value="toggleReferral" />
                <button type="submit" disabled={toggleFetcher.state !== 'idle'}
                  className="w-full rounded-xl py-2.5 text-sm font-bold disabled:opacity-50"
                  style={{
                    background: isEnabled ? 'linear-gradient(135deg,#7f1d1d,#450a0a)' : 'linear-gradient(135deg,#14532d,#052e16)',
                    color: '#fff', border: `1px solid ${isEnabled ? '#fca5a5' : '#4ade80'}`,
                  }}>
                  {toggleFetcher.state !== 'idle' ? t('admin.referral.confirm.confirming') : t('admin.referral.confirm.confirm')}
                </button>
              </toggleFetcher.Form>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
