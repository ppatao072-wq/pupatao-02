// Deposit turnover (wagering) requirement + held referral commission.
//
// Anti-abuse rule: money that came INTO a user's REAL wallet from a deposit
// must be bet at least TURNOVER_MULTIPLIER×
// before it can leave again (withdraw / transfer out). Without it, a customer
// can deposit, collect the first-topup PROMO bonus + the referrer's commission,
// then pull the deposit straight back out and play on bonus money only.
//
// Turnover is DERIVED from the ledger (no counter to keep in sync across every
// bet / settle / cancel / refund path):
//   cycle start  = the user's latest COMPLETED or PENDING withdrawal (or ever)
//   required     = Σ approved REAL deposits since cycle start (legacy REFERRAL_BONUS
//                  rows on REAL also count; new commission goes to PROMO)
//   wagered      = Σ settled (WIN/LOSS) REAL bet stakes since cycle start,
//                  with opposite LOW+HIGH bets in the same round counted once
//                  (betting both sides is a near-zero-risk hedge, not real play)
//   remaining    = max(0, required × multiplier − wagered)
import type { Prisma, PrismaClient } from '@prisma/client'
import { prisma } from '~/lib/prisma.server'
import { registeredFromSameIp } from '~/lib/linked-accounts.server'

export const TURNOVER_MULTIPLIER = 1

// Rollout cutoff: deposits/bets before this instant are ignored, so existing
// customers aren't suddenly blocked by their old history. Override with the
// TURNOVER_START env var (ISO datetime) if needed.
const TURNOVER_START = new Date(process.env.TURNOVER_START || '2026-11-09T00:00:00+07:00')

type Db = PrismaClient | Prisma.TransactionClient

export interface TurnoverStatus {
  required: number
  wagered: number
  remaining: number
}

/** Credits that arrived at/after `since` — by approval time, falling back to creation. */
function creditedSince(since: Date | null): Prisma.TransactionWhereInput {
  if (!since) return {}
  return { OR: [{ reviewedAt: { gt: since } }, { reviewedAt: null, createdAt: { gt: since } }] }
}

/**
 * Settled REAL stake by `userId` on wallet `walletId` since `since`, with
 * hedged LOW+HIGH pairs within one round counted only once (the smaller side
 * is dropped).
 */
async function wageredSince(db: Db, userId: string, walletId: string, since: Date | null): Promise<number> {
  const base: Prisma.BetWhereInput = {
    userId,
    walletId,
    result: { in: ['WIN', 'LOSS'] },
    ...(since ? { createdAt: { gt: since } } : {}),
  }
  const [total, ranges] = await Promise.all([
    db.bet.aggregate({ where: base, _sum: { amount: true } }),
    db.bet.groupBy({
      by: ['roundId', 'range'],
      where: { ...base, kind: 'RANGE', range: { in: ['LOW', 'HIGH'] } },
      _sum: { amount: true },
    }),
  ])
  // Per round: subtract min(LOW, HIGH) — the hedged portion.
  const perRound = new Map<string, { LOW: number; HIGH: number }>()
  for (const r of ranges) {
    const e = perRound.get(r.roundId) ?? { LOW: 0, HIGH: 0 }
    if (r.range === 'LOW' || r.range === 'HIGH') e[r.range] += r._sum.amount ?? 0
    perRound.set(r.roundId, e)
  }
  let hedged = 0
  for (const e of perRound.values()) hedged += Math.min(e.LOW, e.HIGH)
  return Math.max(0, (total._sum.amount ?? 0) - hedged)
}

/** Net REAL loss (Σ stake − Σ payout over settled bets) since `since`; ≥ 0. */
async function netLossSince(db: Db, userId: string, walletId: string, since: Date): Promise<number> {
  const agg = await db.bet.aggregate({
    where: { userId, walletId, result: { in: ['WIN', 'LOSS'] }, createdAt: { gt: since } },
    _sum: { amount: true, payout: true },
  })
  return Math.max(0, (agg._sum.amount ?? 0) - (agg._sum.payout ?? 0))
}

export async function getTurnoverStatus(userId: string, db: Db = prisma): Promise<TurnoverStatus> {
  const [realWallet, lastWithdraw] = await Promise.all([
    db.wallet.findUnique({ where: { userId_type: { userId, type: 'REAL' } }, select: { id: true } }),
    db.transaction.findFirst({
      where: { userId, type: 'WITHDRAW', status: { in: ['COMPLETED', 'PENDING'] } },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    }),
  ])
  if (!realWallet) return { required: 0, wagered: 0, remaining: 0 }
  const lastAt = lastWithdraw?.createdAt ?? null
  const since = !lastAt || lastAt < TURNOVER_START ? TURNOVER_START : lastAt

  const [credits, wagered] = await Promise.all([
    db.transaction.aggregate({
      where: {
        walletId: realWallet.id,
        type: { in: ['DEPOSIT', 'REFERRAL_BONUS'] },
        status: 'COMPLETED',
        ...creditedSince(since),
      },
      _sum: { amount: true },
    }),
    wageredSince(db, userId, realWallet.id, since),
  ])
  const required = (credits._sum.amount ?? 0) * TURNOVER_MULTIPLIER
  return { required, wagered, remaining: Math.max(0, required - wagered) }
}

/** Lao message shown when a withdraw / transfer is blocked by turnover. */
export function turnoverBlockedMessage(s: TurnoverStatus): string {
  return `ທ່ານຕ້ອງຫຼິ້ນ (ວາງເດີມພັນ) ຈາກຍອດເງິນຝາກໃຫ້ຄົບກ່ອນ ຈຶ່ງຈະຖອນ ຫຼື ໂອນເງິນໄດ້. ຍັງເຫຼືອອີກ ${s.remaining.toLocaleString()} ₭ (ຫຼິ້ນແລ້ວ ${s.wagered.toLocaleString()} / ${s.required.toLocaleString()} ₭).`
}

// ─────────────────────────────────────────────────────────────────────────────
// Held referral commission
// ─────────────────────────────────────────────────────────────────────────────
// On deposit approval the referrer's commission is written as a PENDING
// REFERRAL_BONUS row (no wallet credit). It is released — credited to the
// referrer's PROMO wallet (never REAL), row → COMPLETED — only once the REFEREE
// has, with their REAL wallet since that deposit was approved:
//   1. wagered ≥ deposit × TURNOVER_MULTIPLIER, AND
//   2. actually LOST the deposit: net loss (Σ stake − Σ payout) ≥ deposit.
// Net loss is used rather than "balance = 0" because withdrawing also empties
// the balance — that must NOT release the commission.
// Pending rows are released oldest-first, consuming both budgets cumulatively
// so one bet/loss never satisfies two deposits.
//
// Each pending row's idempotencyKey is `referral:<depositTxId>`, which both
// links it to its deposit and stops a reverse → re-approve cycle paying twice.

export function referralKey(depositTxId: string) {
  return `referral:${depositTxId}`
}

export interface ReleasedCommission {
  txId: string
  amount: number
  newPromoBalance: number
  refereeTel: string
}

/** Releases (to PROMO) every pending commission owed to `referrerId` whose referee has wagered AND lost the deposit. */
export async function releaseReferralCommissions(referrerId: string): Promise<ReleasedCommission[]> {
  const pending = await prisma.transaction.findMany({
    where: { userId: referrerId, type: 'REFERRAL_BONUS', status: 'PENDING' },
    orderBy: { createdAt: 'asc' },
    select: { id: true, idempotencyKey: true, targetUserId: true, amount: true },
  })
  if (pending.length === 0) return []

  // Resolve each pending row's source deposit (amount + approval time).
  const depositIds = pending
    .map(p => p.idempotencyKey?.startsWith('referral:') ? p.idempotencyKey.slice('referral:'.length) : null)
    .filter((x): x is string => !!x)
  const deposits = await prisma.transaction.findMany({
    where: { id: { in: depositIds } },
    select: { id: true, amount: true, status: true, reviewedAt: true, createdAt: true, walletId: true, userId: true },
  })
  const depById = new Map(deposits.map(d => [d.id, d]))

  // Group pending rows by referee, in deposit order.
  const byReferee = new Map<string, { row: typeof pending[number]; dep: typeof deposits[number] }[]>()
  for (const row of pending) {
    const depId = row.idempotencyKey?.slice('referral:'.length)
    const dep = depId ? depById.get(depId) : undefined
    if (!dep || !row.targetUserId) continue
    const list = byReferee.get(row.targetUserId) ?? []
    list.push({ row, dep })
    byReferee.set(row.targetUserId, list)
  }

  const released: ReleasedCommission[] = []
  for (const [refereeId, items] of byReferee) {
    // Same registration IP as the referrer → self-referral; void every held
    // commission from this referee instead of ever paying it.
    if (await registeredFromSameIp(referrerId, refereeId)) {
      await prisma.transaction.updateMany({
        where: { id: { in: items.map(i => i.row.id) }, status: 'PENDING' },
        data: { status: 'CANCELLED', note: 'Referral commission voided — referrer and referee registered from the same IP' },
      })
      continue
    }
    items.sort((a, b) => (a.dep.reviewedAt ?? a.dep.createdAt).getTime() - (b.dep.reviewedAt ?? b.dep.createdAt).getTime())
    const firstAt = items[0].dep.reviewedAt ?? items[0].dep.createdAt
    // Wagering since the oldest still-pending deposit (minus 1 ms so a bet in
    // the same millisecond as approval still counts).
    const fromAt = new Date(firstAt.getTime() - 1)
    let [wagerBudget, lossBudget] = await Promise.all([
      wageredSince(prisma, refereeId, items[0].dep.walletId, fromAt),
      netLossSince(prisma, refereeId, items[0].dep.walletId, fromAt),
    ])
    const referee = await prisma.user.findUnique({ where: { id: refereeId }, select: { tel: true } })

    for (const { row, dep } of items) {
      const needWager = dep.amount * TURNOVER_MULTIPLIER
      if (wagerBudget < needWager || lossBudget < dep.amount) break
      wagerBudget -= needWager
      lossBudget -= dep.amount
      try {
        const res = await prisma.$transaction(async db => {
          // Re-check inside the tx so two concurrent releases can't double-pay.
          const fresh = await db.transaction.findUnique({ where: { id: row.id }, select: { status: true } })
          if (fresh?.status !== 'PENDING') return null
          const wallet = await db.wallet.findUnique({ where: { userId_type: { userId: referrerId, type: 'PROMO' } } })
          if (!wallet) return null
          const newBal = wallet.balance + row.amount
          const claimed = await db.transaction.updateMany({
            where: { id: row.id, status: 'PENDING' },
            data: { status: 'COMPLETED', walletId: wallet.id, balanceBefore: wallet.balance, balanceAfter: newBal, reviewedAt: new Date() },
          })
          if (claimed.count !== 1) return null
          await db.wallet.update({ where: { id: wallet.id }, data: { balance: newBal, version: { increment: 1 } } })
          return newBal
        })
        if (res !== null) {
          released.push({ txId: row.id, amount: row.amount, newPromoBalance: res, refereeTel: referee?.tel ?? '' })
        }
      } catch (e) {
        console.error('[referral.release] failed for', row.id, e)
      }
    }
  }
  return released
}

/**
 * Safe wrapper for loaders/actions: releases what's due and pushes a realtime
 * update to the referrer. Never throws.
 */
export async function releaseReferralCommissionsAndNotify(referrerId: string): Promise<void> {
  try {
    const released = await releaseReferralCommissions(referrerId)
    if (released.length === 0) return
    const { notifyUser } = await import('~/lib/pusher.server')
    for (const r of released) {
      notifyUser(referrerId, 'transaction:updated', {
        id: r.txId, status: 'COMPLETED', type: 'DEPOSIT',
        amount: r.amount, balanceAfter: r.newPromoBalance,
        note: `ຄອມມິຊັນ +${r.amount.toLocaleString()} ₭ (Promo) — ${r.refereeTel}`,
      })
    }
  } catch (e) {
    console.error('[referral.release]', e)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PROMO forfeit on withdrawal
// ─────────────────────────────────────────────────────────────────────────────
// Bonus credit is for playing, not for parking while the deposit is pulled
// out. Any REAL withdrawal request forfeits the remaining PROMO balance
// (PROMO_FORFEIT row, key `promo-forfeit:<withdrawTxId>`). If the admin then
// rejects or reverses that withdrawal, the forfeited amount is restored.

export function promoForfeitKey(withdrawTxId: string) {
  return `promo-forfeit:${withdrawTxId}`
}

/**
 * Zeroes `userId`'s PROMO wallet, recording a PROMO_FORFEIT row under the
 * idempotency `key` (re-forfeits if that row was previously restored).
 * Returns the amount forfeited (0 if nothing to take).
 */
export async function forfeitPromo(db: Db, userId: string, key: string, note: string): Promise<number> {
  const promo = await db.wallet.findUnique({ where: { userId_type: { userId, type: 'PROMO' } } })
  if (!promo || promo.balance <= 0) return 0
  const existing = await db.transaction.findUnique({ where: { idempotencyKey: key }, select: { id: true, status: true } })
  if (existing?.status === 'COMPLETED') return 0
  await db.wallet.update({ where: { id: promo.id }, data: { balance: 0, version: { increment: 1 } } })
  const data = {
    userId, walletId: promo.id, type: 'PROMO_FORFEIT' as const,
    amount: promo.balance, balanceBefore: promo.balance, balanceAfter: 0,
    status: 'COMPLETED' as const,
    note: `${note} (${promo.balance.toLocaleString()} ₭)`,
  }
  if (existing) await db.transaction.update({ where: { id: existing.id }, data })
  else await db.transaction.create({ data: { ...data, idempotencyKey: key } })
  return promo.balance
}

/** Gives back the PROMO forfeited under `key`. Returns the amount restored. */
export async function restorePromo(db: Db, key: string, reason: string): Promise<number> {
  const row = await db.transaction.findUnique({ where: { idempotencyKey: key } })
  if (!row || row.status !== 'COMPLETED') return 0
  const promo = await db.wallet.findUnique({ where: { id: row.walletId } })
  if (!promo) return 0
  await db.wallet.update({ where: { id: promo.id }, data: { balance: promo.balance + row.amount, version: { increment: 1 } } })
  await db.transaction.update({
    where: { id: row.id },
    data: { status: 'CANCELLED', note: `${row.note ?? 'Promo forfeit'} — restored (${reason})` },
  })
  return row.amount
}

/** Zeroes the user's PROMO wallet for withdrawal `withdrawTxId`. Returns the amount forfeited. */
export function forfeitPromoForWithdraw(db: Db, userId: string, withdrawTxId: string): Promise<number> {
  return forfeitPromo(db, userId, promoForfeitKey(withdrawTxId), 'Promo balance forfeited on withdrawal')
}

/** Gives back the PROMO forfeited for withdrawal `withdrawTxId` (on reject / reverse). */
export function restorePromoForWithdraw(db: Db, withdrawTxId: string): Promise<number> {
  return restorePromo(db, promoForfeitKey(withdrawTxId), 'withdrawal cancelled')
}

// ─────────────────────────────────────────────────────────────────────────────
// PROMO forfeit on deposit → transfer (cross-account bonus farming)
// ─────────────────────────────────────────────────────────────────────────────
// If the SENDER has an approved REAL deposit in
// the current turnover cycle — i.e. since their last withdrawal — moving REAL
// money to another account voids the PROMO balance of BOTH accounts. This
// catches second accounts registered from a different IP that the same-IP
// transfer lock (linked-accounts.server.ts) can't see.

/** True when the sender's REAL money in this cycle came from a fresh deposit/commission. */
export function senderHasFreshDeposit(turnover: TurnoverStatus): boolean {
  return turnover.required > 0
}

export function transferForfeitKey(transferRef: string, side: 'sender' | 'recipient') {
  return `promo-forfeit:transfer:${transferRef}:${side}`
}

export const TRANSFER_FORFEIT_NOTE = 'Promo balance forfeited — transfer of deposited funds between accounts'

/** Cancels the held commission tied to a deposit that is being reversed/rejected. */
export async function cancelHeldReferralCommission(db: Db, depositTxId: string): Promise<void> {
  await db.transaction.updateMany({
    where: { idempotencyKey: referralKey(depositTxId), status: 'PENDING' },
    data: { status: 'CANCELLED' },
  })
}
