// Escapes a user-supplied search string for safe use inside Prisma's MongoDB
// `contains` filter, which passes the value straight through as a raw regex
// source (no escaping of its own). An admin typing a phone number — always
// "+"-prefixed in this app (e.g. "+8562099999999") — silently got ZERO
// results everywhere ("+" is a regex quantifier with nothing to repeat, so
// the pattern just never matches), even though the exact same digits
// without the "+" matched fine. Escape before building the filter; keep the
// original string wherever it's just displayed back (e.g. the search box).
export function escapeSearchTerm(term: string): string {
  return term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
