// Global feature flags. Plain constants so both the client bundle and the
// server can import them (no server-only code here).

// Self-play (random) mode. Self-play is the heaviest source of frontend/DB
// load — every roll fires /api/pick-dice + /api/save-round plus phase checks.
// When false the game is LIVE-ONLY: the self-play UI is hidden AND the roll
// endpoints reject requests, so no self-play load can reach the DB even from a
// stale browser tab. Flip to true to restore self-play.
export const SELF_PLAY_ENABLED = false
