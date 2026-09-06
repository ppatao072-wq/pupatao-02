// Web Push (PWA notifications) — client side.
// Handles feature detection, the iOS "must be installed" rule, permission,
// subscribing via the service worker, and syncing the subscription to the server.

export type PushState =
  | 'unsupported'   // browser has no Push/Notification/SW support
  | 'installFirst'  // iOS: must Add to Home Screen before push works
  | 'default'       // supported, not yet subscribed
  | 'granted'       // subscribed & permission granted
  | 'denied'        // user blocked notifications

function isIosDevice(): boolean {
  const ua = navigator.userAgent
  const iPadOS = /Macintosh/.test(ua) && navigator.maxTouchPoints > 1
  return /iP(hone|ad|od)/.test(ua) || iPadOS
}

function isStandalone(): boolean {
  return (
    window.matchMedia?.('(display-mode: standalone)').matches ||
    (navigator as unknown as { standalone?: boolean }).standalone === true
  )
}

export function pushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  )
}

// Current state for rendering the opt-in button.
export async function getPushState(): Promise<PushState> {
  if (!pushSupported()) {
    // On iOS the APIs only exist once installed to the Home Screen.
    if (isIosDevice() && !isStandalone()) return 'installFirst'
    return 'unsupported'
  }
  if (isIosDevice() && !isStandalone()) return 'installFirst'
  if (Notification.permission === 'denied') return 'denied'
  if (Notification.permission === 'granted') {
    try {
      const reg = await navigator.serviceWorker.getRegistration()
      const sub = await reg?.pushManager.getSubscription()
      return sub ? 'granted' : 'default'
    } catch {
      return 'default'
    }
  }
  return 'default'
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(base64)
  const arr = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i)
  return arr
}

// Request permission, subscribe, and persist to the server. Returns the new state.
// Logs each failure point to the console (prefixed [push]) to aid debugging.
export async function enablePush(): Promise<{ ok: boolean; state: PushState }> {
  if (!pushSupported()) {
    const state = isIosDevice() && !isStandalone() ? 'installFirst' : 'unsupported'
    console.warn('[push] not supported →', state)
    return { ok: false, state }
  }
  if (isIosDevice() && !isStandalone()) {
    console.warn('[push] iOS: add to Home Screen first')
    return { ok: false, state: 'installFirst' }
  }

  const permission = await Notification.requestPermission()
  console.info('[push] permission =', permission)
  if (permission !== 'granted') return { ok: false, state: permission === 'denied' ? 'denied' : 'default' }

  try {
    const reg = await navigator.serviceWorker.ready
    console.info('[push] service worker ready:', reg.scope)

    const res = await fetch('/api/push-subscribe')
    const { vapidPublicKey } = (await res.json()) as { vapidPublicKey?: string }
    if (!vapidPublicKey) {
      console.error('[push] no VAPID public key from server — is VAPID_PUBLIC_KEY set? (use `npm run start:local`)')
      return { ok: false, state: 'default' }
    }

    let sub = await reg.pushManager.getSubscription()
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
      })
    }
    console.info('[push] subscribed, endpoint:', sub.endpoint.slice(0, 60), '…')

    const save = await fetch('/api/push-subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscription: sub.toJSON() }),
    })
    const saveBody = await save.json().catch(() => ({}))
    console.info('[push] server save:', save.status, saveBody)
    if (!save.ok) return { ok: false, state: 'granted' }

    return { ok: true, state: 'granted' }
  } catch (err) {
    console.error('[push] enable failed:', err)
    return { ok: false, state: 'default' }
  }
}

// Unsubscribe locally and tell the server to drop the row.
export async function disablePush(): Promise<{ ok: boolean; state: PushState }> {
  try {
    const reg = await navigator.serviceWorker.getRegistration()
    const sub = await reg?.pushManager.getSubscription()
    if (sub) {
      await fetch('/api/push-subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscription: sub.toJSON(), unsubscribe: true }),
      })
      await sub.unsubscribe()
    }
    return { ok: true, state: 'default' }
  } catch {
    return { ok: false, state: 'default' }
  }
}
