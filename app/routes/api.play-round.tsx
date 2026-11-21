import type { Route } from './+types/api.play-round'
import type { DiceSymbol, RangeKey, BetResult, Prisma } from '@prisma/client'
import { prisma } from '~/lib/prisma.server'
import { notifyAdmin, notifyAdminBatch, notifyUser } from '~/lib/pusher.server'
import type { BetPlacedPayload } from '~/lib/pusher-channels'
import {
  SYMBOL_VALUES, VALID_SYMBOLS, RANGE_BOUNDS, VALID_RANGES,
  type SymbolBetIn, type RangeBetIn, type PairBetIn, type SumBetIn,
  payoutForSymbol, payoutForRange, payoutForPair, payoutForSum,
  pickAdversarialDice, getPayoutConfig, type PayoutConfig,
} from '~/lib/game-logic.server'

const MAX_BET_PER_ROUND = 10_000_000

// Thrown inside a transaction when the atomic stake debit finds the wallet
// short. Caught by the action and returned as a 400 (not a 500).
class InsufficientBalanceError extends Error {}

// Atomically debit `amount` from a wallet ONLY if it still holds at least that
// much. A conditional update (balance >= amount) is evaluated by MongoDB on the
// document itself, so two concurrent bets can never both spend the same money —
// unlike "read balance → check → write absolute balance", where parallel
// requests all pass the check against the same stale value.
// Returns the balance before and after the debit.
async function debitStakeOrThrow(
  db: Prisma.TransactionClient,
  walletId: string,
  amount: number,
  walletKey: WalletKey,
): Promise<{ before: number; after: number }> {
  const res = await db.wallet.updateMany({
    where: { id: walletId, balance: { gte: amount } },
    data: { balance: { decrement: amount }, version: { increment: 1 } },
  })
  if (res.count === 0) {
    const w = await db.wallet.findUnique({ where: { id: walletId }, select: { balance: true } })
    throw new InsufficientBalanceError(
      `Insufficient ${walletKey} balance: ${(w?.balance ?? 0).toLocaleString()} ₭ available, ${amount.toLocaleString()} ₭ requested.`,
    )
  }
  const w = await db.wallet.findUnique({ where: { id: walletId }, select: { balance: true } })
  const after = w?.balance ?? 0
  return { before: after + amount, after }
}

// LIVE per-betting-target caps (per round). A "target" is a single symbol,
// range, exact-sum number, or pair combo. One user may stake at most
// LIVE_TARGET_USER_CAP on a target; all users combined at most
// LIVE_TARGET_ROUND_CAP — once a target hits the round cap it's full for
// everyone. (RANDOM/self-play is single-player, so these don't apply there.)
const LIVE_TARGET_USER_CAP  = 200_000
const LIVE_TARGET_ROUND_CAP = 1_000_000

// Canonical key identifying a betting target, so bets on the same option
// aggregate regardless of which board cell was tapped (e.g. both GOURD cells →
// one SYMBOL:GOURD bucket; a pair is order-independent).
function liveTargetKey(b: {
  kind: string
  symbol: string | null
  range: string | null
  pairA: string | null
  pairB: string | null
  exactSum: number | null
}): string | null {
  if (b.kind === 'SYMBOL' && b.symbol) return `SYMBOL:${b.symbol}`
  if (b.kind === 'RANGE' && b.range) return `RANGE:${b.range}`
  if (b.kind === 'SUM' && b.exactSum != null) return `SUM:${b.exactSum}`
  if (b.kind === 'PAIR' && b.pairA && b.pairB) return `PAIR:${[b.pairA, b.pairB].sort().join('-')}`
  return null
}

type Mode = 'RANDOM' | 'LIVE'
type WalletKey = 'DEMO' | 'REAL' | 'PROMO'

interface PlayRoundPayload {
  mode: Mode
  wallet: WalletKey
  bets: {
    symbol?: SymbolBetIn[]
    range?: RangeBetIn[]
    pair?: PairBetIn[]
    sum?: SumBetIn[]   // exact-sum bets, LIVE mode only (numbers 3–18)
  }
}

function parsePayload(raw: unknown): PlayRoundPayload | { error: string } {
  if (!raw || typeof raw !== 'object') return { error: 'Invalid payload.' }
  const p = raw as Partial<PlayRoundPayload>
  if (p.mode !== 'RANDOM' && p.mode !== 'LIVE') return { error: 'mode must be RANDOM or LIVE.' }
  if (p.wallet !== 'DEMO' && p.wallet !== 'REAL' && p.wallet !== 'PROMO') return { error: 'wallet must be DEMO, REAL or PROMO.' }
  const bets = p.bets ?? {}
  const symbol = bets.symbol ?? []
  const range = bets.range ?? []
  const pair = bets.pair ?? []
  const sum = bets.sum ?? []
  for (const s of symbol) {
    if (!VALID_SYMBOLS.includes(s.symbol)) return { error: `Invalid symbol: ${s.symbol}.` }
    if (!Number.isInteger(s.cell) || s.cell < 0 || s.cell > 7) return { error: 'Invalid symbol cell index.' }
    if (!Number.isInteger(s.amount) || s.amount <= 0) return { error: 'Symbol bet amount must be positive integer.' }
  }
  for (const r of range) {
    if (!VALID_RANGES.includes(r.range)) return { error: `Invalid range: ${r.range}.` }
    if (!Number.isInteger(r.amount) || r.amount <= 0) return { error: 'Range bet amount must be positive integer.' }
  }
  for (const pp of pair) {
    if (!VALID_SYMBOLS.includes(pp.symbolA) || !VALID_SYMBOLS.includes(pp.symbolB)) return { error: 'Invalid pair symbols.' }
    if (!Number.isInteger(pp.cellA) || !Number.isInteger(pp.cellB)) return { error: 'Invalid pair cells.' }
    if (!Number.isInteger(pp.amount) || pp.amount <= 0) return { error: 'Pair bet amount must be positive integer.' }
  }
  if (sum.length > 0) {
    if (p.mode !== 'LIVE') return { error: 'Sum bets are only allowed in LIVE mode.' }
    const uniqueSums = new Set(sum.map(b => b.sum))
    if (uniqueSums.size > 3) return { error: 'Maximum 3 different numbers per round.' }
    for (const sb of sum) {
      if (!Number.isInteger(sb.sum) || sb.sum < 3 || sb.sum > 18) return { error: `Invalid sum: ${sb.sum}. Must be 3–18.` }
      if (!Number.isInteger(sb.amount) || sb.amount <= 0) return { error: 'Sum bet amount must be positive integer.' }
    }
  }
  return {
    mode: p.mode,
    wallet: p.wallet,
    bets: { symbol, range, pair, sum },
  }
}


export async function action({ request }: Route.ActionArgs) {
  // Resolve session manually instead of using `requireUser` so a missing/expired
  // session returns a JSON 401 here rather than throwing a redirect to /login.
  const { getCurrentUser } = await import('~/lib/auth.server')
  let user: Awaited<ReturnType<typeof getCurrentUser>>
  try {
    user = await getCurrentUser(request)
  } catch (err) {
    console.error('[api/play-round] session lookup failed:', err)
    return Response.json({ error: 'Could not verify session — please retry.' }, { status: 503 })
  }
  if (!user) {
    return Response.json({ error: 'You are signed out. Please sign in again.' }, { status: 401 })
  }

  let raw: unknown
  try {
    raw = await request.json()
  } catch {
    return Response.json({ error: 'Invalid JSON body.' }, { status: 400 })
  }

  const parsed = parsePayload(raw)
  if ('error' in parsed) return Response.json(parsed, { status: 400 })
  const { mode, wallet: walletKey, bets } = parsed

  // Self-play never goes through this endpoint — the client uses the atomic
  // /api/self-play-roll, which also applies sleep mode, admin lock and the
  // competition restrictions. This RANDOM path lacks those checks, so it's
  // refused outright to stop hand-crafted requests from bypassing them.
  if (mode === 'RANDOM') {
    return Response.json({ error: 'Self-play uses /api/self-play-roll.' }, { status: 403 })
  }

  const symbolBets = bets.symbol ?? []
  const rangeBets = bets.range ?? []
  const pairBets = bets.pair ?? []
  const sumBets = bets.sum ?? []
  const totalStake =
    symbolBets.reduce((s, b) => s + b.amount, 0) +
    rangeBets.reduce((s, b) => s + b.amount, 0) +
    pairBets.reduce((s, b) => s + b.amount, 0) +
    sumBets.reduce((s, b) => s + b.amount, 0)

  if (totalStake <= 0) {
    return Response.json({ error: 'No bets placed.' }, { status: 400 })
  }
  if (totalStake > MAX_BET_PER_ROUND) {
    return Response.json({ error: 'Round stake exceeds limit.' }, { status: 400 })
  }

  try {
    const wallet = await prisma.wallet.findUnique({
      where: { userId_type: { userId: user.id, type: walletKey } },
    })
    if (!wallet) return Response.json({ error: `${walletKey} wallet not found.` }, { status: 404 })
    if (wallet.balance < totalStake) {
      return Response.json(
        {
          error: `Insufficient ${walletKey} balance: ${wallet.balance.toLocaleString()} ₭ available, ${totalStake.toLocaleString()} ₭ requested.`,
          balance: wallet.balance,
          required: totalStake,
          wallet: walletKey,
        },
        { status: 400 },
      )
    }

    if (mode === 'LIVE') {
      // PROMO in live mode: only allowed when real balance is 0.
      // Prevents bonus abuse (deposit → get promo → play promo → withdraw deposit).
      if (walletKey === 'PROMO') {
        const realWallet = await prisma.wallet.findUnique({
          where: { userId_type: { userId: user.id, type: 'REAL' } },
          select: { balance: true },
        })
        if (realWallet && realWallet.balance > 0) {
          return Response.json(
            { error: 'ບໍ່ສາມາດໃຊ້ Promo Balance ໃນ Live mode ໄດ້ ເມື່ອມີ Real Balance ຢູ່' },
            { status: 403 },
          )
        }
      }
      return await handleLiveBets({ user, wallet, walletKey, totalStake, symbolBets, rangeBets, pairBets, sumBets })
    }

    let phase: import('@prisma/client').SelfPlayPhase = 'NORMAL'
    if (walletKey !== 'DEMO') {
      try {
        const { prisma } = await import('~/lib/prisma.server')
        const { getPlayerGameState } = await import('~/lib/player-winnings.server')
        const { resolveAndAdvancePhase } = await import('~/lib/self-play-phase.server')
        const [userRecord, gameState] = await Promise.all([
          prisma.user.findUnique({ where: { id: user.id }, select: { selfPlayPhase: true, selfPlayPhaseBalance: true } }),
          getPlayerGameState(user.id),
        ])
        if (userRecord) {
          const resolved = await resolveAndAdvancePhase(
            user.id,
            { phase: userRecord.selfPlayPhase, phaseEntryBalance: userRecord.selfPlayPhaseBalance },
            wallet.balance,
            gameState.netProfit,
            gameState.lastDepositAmount,
          )
          phase = resolved.phase
        }
      } catch {
        phase = 'PHASE_A'
      }
    }

    return await handleRandomRound({
      user, wallet, walletKey, totalStake, phase,
      symbolBets, rangeBets, pairBets,
    })
  } catch (err) {
    if (err instanceof InsufficientBalanceError) {
      return Response.json({ error: err.message }, { status: 400 })
    }
    console.error('[api/play-round]', err)
    const isConn =
      err instanceof Error &&
      /Server selection timeout|No available servers|received fatal alert|ECONNREFUSED|ENOTFOUND/i.test(err.message)
    return Response.json(
      { error: isConn ? 'Cannot reach the database.' : err instanceof Error ? err.message : 'Failed to record round.' },
      { status: isConn ? 503 : 500 },
    )
  }
}

// ─── RANDOM (self-play) — dice are picked server-side adversarially, then
//   round + bets + ledger all settle in one shot.
async function handleRandomRound(args: {
  user: { id: string; tel: string; firstName: string | null; lastName: string | null }
  wallet: { id: string; balance: number }
  walletKey: WalletKey
  totalStake: number
  phase: import('@prisma/client').SelfPlayPhase
  symbolBets: SymbolBetIn[]
  rangeBets: RangeBetIn[]
  pairBets: PairBetIn[]
}) {
  const { user, wallet, walletKey, totalStake, phase, symbolBets, rangeBets, pairBets } = args
  const cfg = getPayoutConfig()
  const dice = pickAdversarialDice(symbolBets, rangeBets, pairBets, cfg, walletKey as 'DEMO' | 'REAL' | 'PROMO', phase)
  const diceSum = SYMBOL_VALUES[dice[0]] + SYMBOL_VALUES[dice[1]] + SYMBOL_VALUES[dice[2]]
  const symbolPayouts = symbolBets.map(b => payoutForSymbol(b, dice, cfg))
  const rangePayouts = rangeBets.map(b => payoutForRange(b, diceSum, cfg))
  const pairPayouts = pairBets.map(b => payoutForPair(b, dice, cfg))
  const totalPayout =
    symbolPayouts.reduce((a, b) => a + b, 0) +
    rangePayouts.reduce((a, b) => a + b, 0) +
    pairPayouts.reduce((a, b) => a + b, 0)

  // PROMO wallet rule: winning stakes return to PROMO; profit credits REAL.
  // Losing stakes are forfeit. Effective per-bet:
  //   WIN:  PROMO unchanged for stake  (stake refunded), REAL +profit
  //   LOSS: PROMO −stake, REAL unchanged.
  // For DEMO/REAL: existing behavior — gross payout returns to the same wallet.
  const isPromo = walletKey === 'PROMO'
  let realProfit = 0       // only used when isPromo — sum of profit from winning bets
  let promoStakeReturn = 0 // only used when isPromo — sum of stakes from winning bets
  if (isPromo) {
    symbolBets.forEach((b, i) => {
      const p = symbolPayouts[i]
      if (p > 0) { promoStakeReturn += b.amount; realProfit += p - b.amount }
    })
    rangeBets.forEach((b, i) => {
      const p = rangePayouts[i]
      if (p > 0) { promoStakeReturn += b.amount; realProfit += p - b.amount }
    })
    pairBets.forEach((b, i) => {
      const p = pairPayouts[i]
      if (p > 0) { promoStakeReturn += b.amount; realProfit += p - b.amount }
    })
  }
  const netDelta = totalPayout - totalStake
  // What goes back into the SOURCE wallet: for PROMO only the winning stakes
  // (profit is credited to REAL); for DEMO/REAL the full gross payout.
  const sourceCredit = isPromo ? promoStakeReturn : totalPayout

  const result = await prisma.$transaction(async db => {
    // Debit FIRST, atomically — fails the whole round if the wallet is short.
    const { before: balanceBefore, after: balanceAfterStake } =
      await debitStakeOrThrow(db, wallet.id, totalStake, walletKey)
    const newBalance = balanceAfterStake + sourceCredit

    const round = await db.gameRound.create({
      data: {
        mode: 'RANDOM',
        status: 'RESOLVED',
        dice1: dice[0], dice2: dice[1], dice3: dice[2], diceSum,
        bettingClosesAt: new Date(),
        resolvedAt: new Date(),
      },
    })

    const betWrites: Promise<unknown>[] = []
    symbolBets.forEach((b, i) => {
      const payout = symbolPayouts[i]
      const result: BetResult = payout > 0 ? 'WIN' : 'LOSS'
      betWrites.push(db.bet.create({
        data: {
          roundId: round.id, userId: user.id, walletId: wallet.id, walletType: walletKey,
          kind: 'SYMBOL', amount: b.amount, payout, result,
          symbol: b.symbol, cell: b.cell, resolvedAt: new Date(),
        },
      }))
    })
    rangeBets.forEach((b, i) => {
      const payout = rangePayouts[i]
      const result: BetResult = payout > 0 ? 'WIN' : 'LOSS'
      betWrites.push(db.bet.create({
        data: {
          roundId: round.id, userId: user.id, walletId: wallet.id, walletType: walletKey,
          kind: 'RANGE', amount: b.amount, payout, result,
          range: b.range, resolvedAt: new Date(),
        },
      }))
    })
    pairBets.forEach((b, i) => {
      const payout = pairPayouts[i]
      const result: BetResult = payout > 0 ? 'WIN' : 'LOSS'
      betWrites.push(db.bet.create({
        data: {
          roundId: round.id, userId: user.id, walletId: wallet.id, walletType: walletKey,
          kind: 'PAIR', amount: b.amount, payout, result,
          pairA: b.symbolA, pairB: b.symbolB, cellA: b.cellA, cellB: b.cellB,
          resolvedAt: new Date(),
        },
      }))
    })
    await Promise.all(betWrites)

    // Source wallet (DEMO/REAL/PROMO) — credit back per the rule above, as an
    // increment on top of the already-debited balance (never an absolute write).
    if (sourceCredit > 0) {
      await db.wallet.update({
        where: { id: wallet.id },
        data: { balance: { increment: sourceCredit }, version: { increment: 1 } },
      })
    }

    await db.transaction.create({
      data: {
        userId: user.id, walletId: wallet.id, type: 'LOSS',
        amount: totalStake, balanceBefore, balanceAfter: balanceAfterStake,
        status: 'COMPLETED', roundId: round.id, idempotencyKey: crypto.randomUUID(),
        note: 'Self-play round stake',
      },
    })

    if (isPromo) {
      // PROMO win → refund stake portion to PROMO, profit goes to REAL.
      if (promoStakeReturn > 0) {
        await db.transaction.create({
          data: {
            userId: user.id, walletId: wallet.id, type: 'WIN',
            amount: promoStakeReturn, balanceBefore: balanceAfterStake, balanceAfter: newBalance,
            status: 'COMPLETED', roundId: round.id, idempotencyKey: crypto.randomUUID(),
            note: 'Self-play round — PROMO stake refund (winning bets)',
          },
        })
      }
      if (realProfit > 0) {
        const realWallet = await db.wallet.findUnique({
          where: { userId_type: { userId: user.id, type: 'REAL' } },
        })
        if (realWallet) {
          const updatedReal = await db.wallet.update({
            where: { id: realWallet.id },
            data: { balance: { increment: realProfit }, version: { increment: 1 } },
            select: { balance: true },
          })
          await db.transaction.create({
            data: {
              userId: user.id, walletId: realWallet.id, type: 'WIN',
              amount: realProfit, balanceBefore: updatedReal.balance - realProfit, balanceAfter: updatedReal.balance,
              status: 'COMPLETED', roundId: round.id, idempotencyKey: crypto.randomUUID(),
              note: 'Self-play round — PROMO profit credited to REAL',
            },
          })
        }
      }
    } else if (totalPayout > 0) {
      await db.transaction.create({
        data: {
          userId: user.id, walletId: wallet.id, type: 'WIN',
          amount: totalPayout, balanceBefore: balanceAfterStake, balanceAfter: newBalance,
          status: 'COMPLETED', roundId: round.id, idempotencyKey: crypto.randomUUID(),
          note: 'Self-play round payout',
        },
      })
    }

    return { roundId: round.id, newBalance }
  })

  // RANDOM rounds resolve immediately — emit one round:resolved event (not the
  // bet-by-bet stream that LIVE uses, since the admin live page only shows LIVE).
  const placedAt = new Date().toISOString()
  notifyAdmin('round:resolved', {
    roundId: result.roundId, mode: 'RANDOM',
    dice: dice as string[], diceSum,
  })
  notifyUser(user.id, 'round:resolved', {
    roundId: result.roundId, mode: 'RANDOM',
    dice: dice as string[], diceSum,
  })

  return Response.json({
    ok: true,
    roundId: result.roundId,
    dice: dice as string[],
    stake: totalStake,
    payout: totalPayout,
    net: netDelta,
    balance: result.newBalance,
    placedAt,
  })
}

// ─── LIVE — bets attach to the admin's currently-open BETTING round. Stake is
//   debited now; payouts are credited later when the admin enters the dice on
//   the admin Live page. No dice come from the customer for this mode.
async function handleLiveBets(args: {
  user: { id: string; tel: string; firstName: string | null; lastName: string | null; betLocked: boolean }
  wallet: { id: string; balance: number }
  walletKey: WalletKey
  totalStake: number
  symbolBets: SymbolBetIn[]
  rangeBets: RangeBetIn[]
  pairBets: PairBetIn[]
  sumBets: SumBetIn[]
}) {
  const { user, wallet, walletKey, totalStake, symbolBets, rangeBets, pairBets, sumBets } = args

  // Bet-locked users cannot place LIVE bets (the board is hidden client-side; this
  // is the server-side safety net).
  if (user.betLocked) {
    return Response.json({ error: 'ບັນຊີຂອງທ່ານຖືກລັອກການແທງ Live ຊົ່ວຄາວ.' }, { status: 403 })
  }

  const openRound = await prisma.gameRound.findFirst({
    where: { mode: 'LIVE', status: 'BETTING' },
    orderBy: { createdAt: 'desc' },
    select: { id: true, bettingClosesAt: true },
  })
  if (!openRound) {
    return Response.json({ error: 'No live round is open right now.' }, { status: 409 })
  }
  if (openRound.bettingClosesAt && openRound.bettingClosesAt.getTime() < Date.now()) {
    return Response.json({ error: 'Betting window closed for this round.' }, { status: 409 })
  }

  // ── Per-target limits ────────────────────────────────────────────────────
  // Sum the incoming stake per target, then add existing bets in this round
  // (this user's, and everyone's) and enforce the per-user / per-round caps.
  const incomingByTarget = new Map<string, number>()
  const addIncoming = (k: string, amt: number) => incomingByTarget.set(k, (incomingByTarget.get(k) ?? 0) + amt)
  for (const b of symbolBets) addIncoming(`SYMBOL:${b.symbol}`, b.amount)
  for (const b of rangeBets)  addIncoming(`RANGE:${b.range}`, b.amount)
  for (const b of sumBets)    addIncoming(`SUM:${b.sum}`, b.amount)
  for (const b of pairBets)   addIncoming(`PAIR:${[b.symbolA, b.symbolB].sort().join('-')}`, b.amount)

  if (incomingByTarget.size > 0) {
    const existing = await prisma.bet.findMany({
      where: { roundId: openRound.id },
      select: { userId: true, kind: true, amount: true, symbol: true, range: true, pairA: true, pairB: true, exactSum: true },
    })
    const userTotals = new Map<string, number>()
    const allTotals = new Map<string, number>()
    for (const b of existing) {
      const k = liveTargetKey(b)
      if (!k) continue
      allTotals.set(k, (allTotals.get(k) ?? 0) + b.amount)
      if (b.userId === user.id) userTotals.set(k, (userTotals.get(k) ?? 0) + b.amount)
    }
    for (const [k, inc] of incomingByTarget) {
      if ((userTotals.get(k) ?? 0) + inc > LIVE_TARGET_USER_CAP) {
        return Response.json(
          { error: `ເດີມພັນສູງສຸດ ${LIVE_TARGET_USER_CAP.toLocaleString()} ₭ ຕໍ່ລາຍການຕໍ່ຄົນ.` },
          { status: 400 },
        )
      }
      if ((allTotals.get(k) ?? 0) + inc > LIVE_TARGET_ROUND_CAP) {
        return Response.json(
          { error: `ລາຍການນີ້ເຕັມແລ້ວ (ສູງສຸດ ${LIVE_TARGET_ROUND_CAP.toLocaleString()} ₭ ຕໍ່ຮອບ). ກະລຸນາເລືອກລາຍການອື່ນ.` },
          { status: 409 },
        )
      }
    }
  }

  const placedAt = new Date()
  const placedAtIso = placedAt.toISOString()
  const userName = [user.firstName, user.lastName].filter(Boolean).join(' ') || null

  // Realtime payloads for the admin Live board, built from the validated input.
  // Sent only AFTER the DB transaction below commits (see there for why).
  const betShapes: Array<{ kind: 'SYMBOL' | 'RANGE' | 'PAIR' | 'SUM'; amount: number; symbol: DiceSymbol | null; range: RangeKey | null; pairA: DiceSymbol | null; pairB: DiceSymbol | null; exactSum: number | null }> = [
    ...symbolBets.map(b => ({ kind: 'SYMBOL' as const, amount: b.amount, symbol: b.symbol, range: null, pairA: null, pairB: null, exactSum: null })),
    ...rangeBets.map(b => ({ kind: 'RANGE' as const, amount: b.amount, symbol: null, range: b.range, pairA: null, pairB: null, exactSum: null })),
    ...pairBets.map(b => ({ kind: 'PAIR' as const, amount: b.amount, symbol: null, range: null, pairA: b.symbolA, pairB: b.symbolB, exactSum: null })),
    ...sumBets.map(b => ({ kind: 'SUM' as const, amount: b.amount, symbol: null, range: null, pairA: null, pairB: null, exactSum: b.sum })),
  ]
  const betEvents = betShapes.map(b => ({
    event: 'bet:placed' as const,
    payload: {
      roundId: openRound.id, mode: 'LIVE' as const,
      userId: user.id, userTel: user.tel, userName, walletType: walletKey,
      kind: b.kind, amount: b.amount,
      symbol: b.symbol, range: b.range, pairA: b.pairA, pairB: b.pairB,
      exactSum: b.exactSum,
      createdAt: placedAtIso,
    } satisfies BetPlacedPayload,
  }))

  // Persist FIRST, then broadcast. The admin Live page must only ever show bets
  // that actually exist: broadcasting in parallel with the write meant a bet
  // the DB rejected (insufficient balance, write conflict) still popped up on
  // the admin board, looking like a zero-balance customer had bet.
  const result = await prisma.$transaction(async db => {
    // Atomic conditional debit — the stake leaves the wallet only if the wallet
    // still holds it, so parallel submissions can't overspend.
    const { before, after: newBalance } = await debitStakeOrThrow(db, wallet.id, totalStake, args.walletKey)

    // Create all bets in parallel — reduces DB round trips from N sequential to 1 parallel batch.
    await Promise.all([
      ...symbolBets.map(b => db.bet.create({
        data: { roundId: openRound.id, userId: user.id, walletId: wallet.id, walletType: args.walletKey, kind: 'SYMBOL', amount: b.amount, symbol: b.symbol, cell: b.cell },
      })),
      ...rangeBets.map(b => db.bet.create({
        data: { roundId: openRound.id, userId: user.id, walletId: wallet.id, walletType: args.walletKey, kind: 'RANGE', amount: b.amount, range: b.range },
      })),
      ...pairBets.map(b => db.bet.create({
        data: { roundId: openRound.id, userId: user.id, walletId: wallet.id, walletType: args.walletKey, kind: 'PAIR', amount: b.amount, pairA: b.symbolA, pairB: b.symbolB, cellA: b.cellA, cellB: b.cellB },
      })),
      ...sumBets.map(b => db.bet.create({
        data: { roundId: openRound.id, userId: user.id, walletId: wallet.id, walletType: args.walletKey, kind: 'SUM', amount: b.amount, exactSum: b.sum },
      })),
    ])

    await db.transaction.create({
      data: {
        userId: user.id, walletId: wallet.id, type: 'LOSS',
        amount: totalStake, balanceBefore: before, balanceAfter: newBalance,
        status: 'COMPLETED', roundId: openRound.id, idempotencyKey: crypto.randomUUID(),
        note: 'Live round stake',
      },
    })

    return { roundId: openRound.id, newBalance }
  })

  // Best-effort realtime — only after commit. A Pusher hiccup never fails the bet.
  if (betEvents.length > 0) {
    await notifyAdminBatch(betEvents).catch(err => { console.error('[live-bet] realtime broadcast failed', err) })
  }

  return Response.json({
    ok: true,
    roundId: result.roundId,
    stake: totalStake,
    balance: result.newBalance,
    pending: true,  // payouts settled when admin resolves the round
    placedAt: placedAtIso,
  })
}

export function loader() {
  return new Response('Method Not Allowed', { status: 405 })
}
