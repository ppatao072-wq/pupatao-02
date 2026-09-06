// One-time backfill: set Bet.walletType from each bet's wallet.
// Run ONCE after deploying the walletType change:
//   docker compose exec pupatao-client node scripts/backfill-bet-wallettype.mjs
// Idempotent (only touches rows where walletType is still null) — safe to re-run.
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()
const CHUNK = 200

async function main() {
  console.log('Loading wallets…')
  const wallets = await prisma.wallet.findMany({ select: { id: true, type: true } })
  const byType = { REAL: [], DEMO: [], PROMO: [] }
  for (const w of wallets) (byType[w.type] ??= []).push(w.id)

  for (const type of ['REAL', 'DEMO', 'PROMO']) {
    const ids = byType[type] ?? []
    if (ids.length === 0) continue
    let updated = 0
    for (let i = 0; i < ids.length; i += CHUNK) {
      const slice = ids.slice(i, i + CHUNK)
      const res = await prisma.bet.updateMany({
        where: { walletId: { in: slice }, walletType: null },
        data: { walletType: type },
      })
      updated += res.count
      process.stdout.write(`  ${type}: +${res.count} (running total ${updated})\n`)
    }
    console.log(`${type}: backfilled ${updated} bets`)
  }
  console.log('Backfill complete.')
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1) })
