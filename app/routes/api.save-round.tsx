// RETIRED. Self-play used to be two calls: /api/pick-dice revealed the dice,
// then the browser chose whether to call /api/save-round to settle the money —
// which let players skip saving losing rounds. Both are replaced by the single
// atomic /api/self-play-roll (see api.self-play-roll.tsx). This stub only tells
// stale cached clients to refresh; it never picks dice or moves money.
const GONE = { error: 'ກະລຸນາໂຫຼດແອັບໃໝ່ (Please refresh the app).' }

export function action() {
  return Response.json(GONE, { status: 410 })
}

export function loader() {
  return new Response('Method Not Allowed', { status: 405 })
}
