// READ-ONLY audit: did anyone bet money they didn't have?
//
// Run on the server (mongosh script, changes nothing):
//   mongosh "mongodb://admin:PASSWORD@localhost:27017/pupatao?authSource=admin" --quiet scripts/check-bet-balances.js
// Optional: DAYS=30 (default 7) via --eval 'var DAYS=30' before the file.
//
// Checks
//  1. Wallets with a NEGATIVE balance (should never exist).
//  2. RANDOM (self-play) rounds created recently — self-play is disabled, so
//     any here were made by hand-crafted requests to /api/play-round.
//  3. Every REAL/PROMO bet group (user × round × wallet) whose stakes are NOT
//     covered by a 'LOSS' stake ledger row — i.e. a bet that was never debited.
//  4. Customers whose REAL + PROMO is 0 now but who have bets in the period,
//     with their stake/ledger totals, so you can see they paid for them.

const days = typeof DAYS === 'number' ? DAYS : 7
const since = new Date(Date.now() - days * 864e5)
const fmt = n => (n ?? 0).toLocaleString('en-US')
print(`\n=== Bet/balance audit — last ${days} days (since ${since.toISOString()}) ===\n`)

// 1
const neg = db.Wallet.find({ balance: { $lt: 0 } }, { userId: 1, type: 1, balance: 1 }).toArray()
print(`1. Negative wallets: ${neg.length}`)
neg.forEach(w => print(`   user ${w.userId}  ${w.type}  ${fmt(w.balance)} ₭`))

// 2
const randomRounds = db.GameRound.countDocuments({ mode: 'RANDOM', createdAt: { $gte: since } })
print(`\n2. Self-play (RANDOM) rounds in period: ${randomRounds}${randomRounds ? '  ← self-play is OFF, these came from crafted requests' : ''}`)

// 3 + 4
const groups = db.Bet.aggregate([
  { $match: { createdAt: { $gte: since }, walletType: { $in: ['REAL', 'PROMO'] } } },
  { $group: { _id: { u: '$userId', r: '$roundId', w: '$walletId' }, type: { $first: '$walletType' }, stake: { $sum: '$amount' }, n: { $sum: 1 } } },
]).toArray()

let uncovered = 0
const perUser = {}
for (const g of groups) {
  const loss = db.Transaction.aggregate([
    { $match: { userId: g._id.u, walletId: g._id.w, roundId: g._id.r, type: 'LOSS' } },
    { $group: { _id: null, s: { $sum: '$amount' } } },
  ]).toArray()[0]?.s ?? 0
  const u = String(g._id.u)
  perUser[u] ??= { stake: 0, debited: 0, bets: 0 }
  perUser[u].stake += g.stake; perUser[u].debited += loss; perUser[u].bets += g.n
  // Cancelled bets are deleted but their LOSS row stays, so loss >= stake is normal.
  if (loss < g.stake) {
    uncovered++
    const tel = db.User.findOne({ _id: g._id.u }, { tel: 1 })?.tel
    print(`   ✗ ${tel}  round ${g._id.r}  ${g.type}  bets ${fmt(g.stake)} ₭ but only ${fmt(loss)} ₭ debited`)
  }
}
print(`\n3. Bet groups checked: ${groups.length}, NOT fully debited: ${uncovered}${uncovered ? '' : '  ✓ every bet was paid for'}`)

const users = Object.keys(perUser)
const zero = []
for (const u of users) {
  const ws = db.Wallet.find({ userId: ObjectId(u), type: { $in: ['REAL', 'PROMO'] } }, { type: 1, balance: 1 }).toArray()
  const total = ws.reduce((s, w) => s + w.balance, 0)
  if (total <= 0) zero.push({ u, ...perUser[u] })
}
print(`\n4. Customers with REAL+PROMO = 0 now who bet in the period: ${zero.length}`)
zero.slice(0, 50).forEach(z => {
  const tel = db.User.findOne({ _id: ObjectId(z.u) }, { tel: 1 })?.tel
  print(`   ${tel}  bets ${z.bets}  staked ${fmt(z.stake)} ₭  debited ${fmt(z.debited)} ₭  ${z.debited >= z.stake ? '✓ paid' : '✗ NOT PAID'}`)
})
if (zero.length > 50) print(`   … and ${zero.length - 50} more`)
print('')
