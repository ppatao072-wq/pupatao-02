import { useEffect } from 'react'
import { getPushState, enablePush } from '~/lib/push-client'

// Auto-subscribe to push with no manual button:
//   • permission already granted  → subscribe silently on load
//   • not decided yet ('default') → fire the permission request on the user's
//     FIRST interaction (a gesture is required by browsers; the one-time
//     "Allow?" dialog itself cannot be skipped — that's a hard browser rule)
//   • denied / unsupported / iOS-not-installed → do nothing
//
// Renders nothing. Mount once on a customer page.
export function PushAutoEnable() {
  useEffect(() => {
    let cancelled = false

    getPushState().then(state => {
      if (cancelled) return

      if (state === 'granted') {
        enablePush().catch(() => { /* ignore */ })
        return
      }

      if (state === 'default') {
        const onGesture = () => {
          window.removeEventListener('pointerdown', onGesture)
          window.removeEventListener('keydown', onGesture)
          enablePush().catch(() => { /* user may dismiss the prompt */ })
        }
        window.addEventListener('pointerdown', onGesture, { once: true })
        window.addEventListener('keydown', onGesture, { once: true })
      }
    }).catch(() => { /* ignore */ })

    return () => { cancelled = true }
  }, [])

  return null
}
