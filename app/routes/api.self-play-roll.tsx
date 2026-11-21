// Self-play (RANDOM) roll — ONE server call that picks the dice AND settles the
// money atomically, then returns the dice for the client to animate.
//
// Replaces the old two-phase flow (/api/pick-dice → /api/save-round). That flow
// revealed the dice BEFORE any money moved and let the browser decide whether
// to save the round — so a player (or just a closed tab) could skip saving
// losing rounds, or request dice repeatedly and only save winners. Here the
// stake is debited in the same transaction that records the round, before the
// client ever sees the dice, so every roll is paid for.
//
// Dice rules — identical order to the original pick-dice:
//   1. ADMIN_LOCKED → zero-payout dice
//   2. PROMO wallet → zero-payout dice
//   3. REAL + REAL_LIVE competition participant → 403
//   4. sleep mode → zero-payout dice
//   5. otherwise resolveAndAdvancePhase → adversarial dice for that phase
//   any lookup error in 1–5 → PHASE_A odds
//   DEMO → NORMAL phase, none of the above
import type { BetResult, SelfPlayPhase } from '@prisma/client'
import { prisma } from '~/lib/prisma.server'
import { notifyAdmin, notifyCompetition, notifyUser } from '~/lib/pusher.server'
import {
  VALID_SYMBOLS, VALID_RANGES, SYMBOL_VALUES,
  type SymbolBetIn, type RangeBetIn, type PairBetIn, type WalletType,
  pickAdversarialDice, pickZeroPayoutDice, getPayoutConfig,
  payoutForSymbol, payoutForRange, payoutForPair,
} from '~/lib/game-logic.server'
import { SELF_PLAY_ENABLED } from '~/lib/features'

type WalletKey = 'DEMO' | 'REAL' | 'PROMO'

class InsufficientBalanceError extends Error {}

function parseBets(raw: unknown): {
  wallet: WalletKey
  symbolBets: SymbolBetIn[]
  rangeBets: RangeBetIn[]
  pairBets: PairBetIn[]
} | { error: string } {
  if (!raw || typeof raw !== 'object') return { error: 'Invalid payload.' }
  const p = raw as Record<string, unknown>
  if (p.wallet !== 'DEMO' && p.wallet !== 'REAL' && p.wallet !== 'PROMO')
    return { error: 'wallet must be DEMO, REAL or PROMO.' }

  const bets = (p.bets ?? {}) as Record<string, unknown>
  const symbol = (Array.isArray(bets.symbol) ? bets.symbol : []) as SymbolBetIn[]
  const range  = (Array.isArray(bets.range)  ? bets.range  : []) as RangeBetIn[]
  const pair   = (Array.isArray(bets.pair)   ? bets.pair   : []) as PairBetIn[]

  for (const s of symbol) {
    if (!VALID_SYMBOLS.includes(s.symbol)) return { error: `Invalid symbol: ${s.symbol}` }
    if (!Number.isInteger(s.cell) || s.cell < 0 || s.cell > 7) return { error: 'Invalid symbol cell index.' }
    if (!Number.isInteger(s.amount) || s.amount <= 0) return { error: 'Symbol bet amount invalid.' }
  }
  for (const r of range) {
    if (!VALID_RANGES.includes(r.range)) return { error: `Invalid range: ${r.range}` }
    if (!Number.isInteger(r.amount) || r.amount <= 0) return { error: 'Range bet amount invalid.' }
  }
  for (const pp of pair) {
    if (!VALID_SYMBOLS.includes(pp.symbolA) || !VALID_SYMBOLS.includes(pp.symbolB))
      return { error: 'Invalid pair symbols.' }
    if (!Number.isInteger(pp.cellA) || !Number.isInteger(pp.cellB)) return { error: 'Invalid pair cells.' }
    if (!Number.isInteger(pp.amount) || pp.amount <= 0) return { error: 'Pair bet amount invalid.' }
  }
  return { wallet: p.wallet as WalletKey, symbolBets: symbol, rangeBets: range, pairBets: pair }
}

export async function action({ request }: { request: Request }) {
  if (!SELF_PLAY_ENABLED) {
    return Response.json({ error: 'Self-play is currently disabled.' }, { status: 403 })
  }

  const { getCurrentUser } = await import('~/lib/auth.server')
  let user: Awaited<ReturnType<typeof getCurrentUser>>
  try {
    user = await getCurrentUser(request)
  } catch {
    return Response.json({ error: 'Session error.' }, { status: 503 })
  }
  if (!user) return Response.json({ error: 'Signed out.' }, { status: 401 })

  let raw: unknown
  try { raw = await request.json() } catch {
    return Response.json({ error: 'Invalid JSON body.' }, { status: 400 })
  }
  const parsed = parseBets(raw)
  if ('error' in parsed) return Response.json(parsed, { status: 400 })
  const { wallet: walletKey, symbolBets, rangeBets, pairBets } = parsed

  const totalStake =
    symbolBets.reduce((s, b) => s + b.amount, 0) +
    rangeBets.reduce((s, b) => s + b.amount, 0) +
    pairBets.reduce((s, b) => s + b.amount, 0)
  if (totalStake <= 0) return Response.json({ error: 'No bets placed.' }, { status: 400 })

  const cfg = getPayoutConfig()

  try {
    // Fast pre-check (the real guard is the conditional debit in the transaction).
    const wallet = await prisma.wallet.findUnique({
      where: { userId_type: { userId: user.id, type: walletKey } },
      select: { id: true, balance: true },
    })
    if (!wallet) return Response.json({ error: 'Wallet not found.' }, { status: 404 })
    if (wallet.balance < totalStake) {
      return Response.json({ error: `Insufficient ${walletKey} balance.`, balance: wallet.balance }, { status: 400 })
    }

    // ── Decide the dice ────────────────────────────────────────────────────
    let dice: [import('@prisma/client').DiceSymbol, import('@prisma/client').DiceSymbol, import('@prisma/client').DiceSymbol]
    let forceZero = false
    let phase: SelfPlayPhase = 'NORMAL'

    // Same order and same error handling as the original /api/pick-dice:
    //   ADMIN_LOCKED → zero, PROMO → zero, REAL_LIVE participant → 403,
    //   sleep mode → zero, otherwise resolve phase. ANY lookup error in this
    //   block falls back to PHASE_A odds (the roll still happens).
    if (walletKey !== 'DEMO') {
      let blocked: Response | null = null
      try {
        const userRecord = await prisma.user.findUnique({
          where: { id: user.id },
          select: { selfPlayPhase: true, selfPlayPhaseBalance: true },
        })

        if (userRecord?.selfPlayPhase === 'ADMIN_LOCKED') {
          forceZero = true
        } else if (walletKey === 'PROMO') {
          forceZero = true
        } else {
          if (walletKey === 'REAL') {
            const { getCompetitionConfig } = await import('~/lib/system-settings.server')
            const competition = await getCompetitionConfig()
            if (competition.enabled && competition.type === 'REAL_LIVE') {
              const participant = await prisma.competitionParticipant.findUnique({ where: { userId: user.id } })
              if (participant) {
                blocked = Response.json({ error: 'Real wallet is restricted to live mode during this competition.' }, { status: 403 })
              }
            }
          }

          if (!blocked) {
            const { getSleepMode } = await import('~/lib/system-settings.server')
            if (await getSleepMode()) {
              forceZero = true
            } else {
              const { getPlayerGameState } = await import('~/lib/player-winnings.server')
              const { resolveAndAdvancePhase } = await import('~/lib/self-play-phase.server')
              const [gameState, freshWallet] = await Promise.all([
                getPlayerGameState(user.id),
                prisma.wallet.findUnique({ where: { id: wallet.id }, select: { balance: true } }),
              ])
              if (userRecord) {
                const resolved = await resolveAndAdvancePhase(
                  user.id,
                  { phase: userRecord.selfPlayPhase, phaseEntryBalance: userRecord.selfPlayPhaseBalance },
                  freshWallet?.balance ?? 0,
                  gameState.netProfit,
                  gameState.lastDepositAmount,
                )
                phase = resolved.phase
              }
            }
          }
        }
      } catch {
        phase = 'PHASE_A'
      }
      if (blocked) return blocked
    }

    dice = forceZero
      ? pickZeroPayoutDice(symbolBets, rangeBets, pairBets, cfg)
      : pickAdversarialDice(symbolBets, rangeBets, pairBets, cfg, walletKey as WalletType, phase)
    const diceSum = SYMBOL_VALUES[dice[0]] + SYMBOL_VALUES[dice[1]] + SYMBOL_VALUES[dice[2]]

    // ── Payouts ────────────────────────────────────────────────────────────
    const symbolPayouts = symbolBets.map(b => payoutForSymbol(b, dice, cfg))
    const rangePayouts  = rangeBets.map(b => payoutForRange(b, diceSum, cfg))
    const pairPayouts   = pairBets.map(b => payoutForPair(b, dice, cfg))
    const totalPayout =
      symbolPayouts.reduce((a, b) => a + b, 0) +
      rangePayouts.reduce((a, b) => a + b, 0) +
      pairPayouts.reduce((a, b) => a + b, 0)

    // PROMO: winning stakes return to PROMO, profit goes to REAL.
    // DEMO/REAL: gross payout returns to the same wallet.
    const isPromo = walletKey === 'PROMO'
    let promoStakeReturn = 0
    let realProfit = 0
    if (isPromo) {
      symbolBets.forEach((b, i) => { if (symbolPayouts[i] > 0) { promoStakeReturn += b.amount; realProfit += symbolPayouts[i] - b.amount } })
      rangeBets.forEach((b, i)  => { if (rangePayouts[i] > 0)  { promoStakeReturn += b.amount; realProfit += rangePayouts[i] - b.amount } })
      pairBets.forEach((b, i)   => { if (pairPayouts[i] > 0)   { promoStakeReturn += b.amount; realProfit += pairPayouts[i] - b.amount } })
    }
    const sourceCredit = isPromo ? promoStakeReturn : totalPayout
    const netDelta = totalPayout - totalStake
    const userId = user.id

    // ── Settle atomically ──────────────────────────────────────────────────
    const result = await prisma.$transaction(async db => {
      // Conditional debit: succeeds only if the wallet still holds the stake,
      // so parallel rolls can never spend the same money twice.
      const debit = await db.wallet.updateMany({
        where: { id: wallet.id, balance: { gte: totalStake } },
        data: { balance: { decrement: totalStake }, version: { increment: 1 } },
      })
      if (debit.count === 0) throw new InsufficientBalanceError(`Insufficient ${walletKey} balance.`)
      const afterDebit = await db.wallet.findUnique({ where: { id: wallet.id }, select: { balance: true } })
      const balanceAfterStake = afterDebit?.balance ?? 0
      const balanceBefore = balanceAfterStake + totalStake
      const newBalance = balanceAfterStake + sourceCredit

      const now = new Date()
      const round = await db.gameRound.create({
        data: {
          mode: 'RANDOM', status: 'RESOLVED',
          dice1: dice[0], dice2: dice[1], dice3: dice[2], diceSum,
          bettingClosesAt: now, resolvedAt: now,
        },
      })

      await Promise.all([
        ...symbolBets.map((b, i) => db.bet.create({ data: {
          roundId: round.id, userId, walletId: wallet.id, walletType: walletKey,
          kind: 'SYMBOL', amount: b.amount, payout: symbolPayouts[i],
          result: (symbolPayouts[i] > 0 ? 'WIN' : 'LOSS') as BetResult,
          symbol: b.symbol, cell: b.cell, resolvedAt: now,
        }})),
        ...rangeBets.map((b, i) => db.bet.create({ data: {
          roundId: round.id, userId, walletId: wallet.id, walletType: walletKey,
          kind: 'RANGE', amount: b.amount, payout: rangePayouts[i],
          result: (rangePayouts[i] > 0 ? 'WIN' : 'LOSS') as BetResult,
          range: b.range, resolvedAt: now,
        }})),
        ...pairBets.map((b, i) => db.bet.create({ data: {
          roundId: round.id, userId, walletId: wallet.id, walletType: walletKey,
          kind: 'PAIR', amount: b.amount, payout: pairPayouts[i],
          result: (pairPayouts[i] > 0 ? 'WIN' : 'LOSS') as BetResult,
          pairA: b.symbolA, pairB: b.symbolB, cellA: b.cellA, cellB: b.cellB, resolvedAt: now,
        }})),
      ])

      await db.transaction.create({ data: {
        userId, walletId: wallet.id, type: 'LOSS',
        amount: totalStake, balanceBefore, balanceAfter: balanceAfterStake,
        status: 'COMPLETED', roundId: round.id, idempotencyKey: crypto.randomUUID(),
        note: 'Self-play round stake',
      }})

      if (sourceCredit > 0) {
        await db.wallet.update({
          where: { id: wallet.id },
          data: { balance: { increment: sourceCredit }, version: { increment: 1 } },
        })
        await db.transaction.create({ data: {
          userId, walletId: wallet.id, type: 'WIN',
          amount: sourceCredit, balanceBefore: balanceAfterStake, balanceAfter: newBalance,
          status: 'COMPLETED', roundId: round.id, idempotencyKey: crypto.randomUUID(),
          note: isPromo ? 'Self-play round — PROMO stake refund' : 'Self-play round payout',
        }})
      }

      if (isPromo && realProfit > 0) {
        const realWallet = await db.wallet.findUnique({ where: { userId_type: { userId, type: 'REAL' } } })
        if (realWallet) {
          const updatedReal = await db.wallet.update({
            where: { id: realWallet.id },
            data: { balance: { increment: realProfit }, version: { increment: 1 } },
            select: { balance: true },
          })
          await db.transaction.create({ data: {
            userId, walletId: realWallet.id, type: 'WIN',
            amount: realProfit, balanceBefore: updatedReal.balance - realProfit, balanceAfter: updatedReal.balance,
            status: 'COMPLETED', roundId: round.id, idempotencyKey: crypto.randomUUID(),
            note: 'Self-play round — PROMO profit to REAL',
          }})
        }
      }

      return { roundId: round.id, newBalance }
    })

    notifyAdmin('round:resolved', { roundId: result.roundId, mode: 'RANDOM', dice: dice as string[], diceSum })
    notifyUser(user.id, 'round:resolved', { roundId: result.roundId, mode: 'RANDOM', dice: dice as string[], diceSum })
    if (walletKey === 'DEMO') {
      notifyCompetition('ranking:updated', { userId: user.id, newDemoBalance: result.newBalance })
    }

    return Response.json({
      ok: true,
      roundId: result.roundId,
      dice: dice as string[],
      stake: totalStake,
      payout: totalPayout,
      net: netDelta,
      balance: result.newBalance,
    })
  } catch (err) {
    if (err instanceof InsufficientBalanceError) {
      return Response.json({ error: err.message }, { status: 400 })
    }
    console.error('[api/self-play-roll]', err)
    return Response.json({ error: 'Failed to play round. Please try again.' }, { status: 500 })
  }
}

export function loader() {
  return new Response('Method Not Allowed', { status: 405 })
}
