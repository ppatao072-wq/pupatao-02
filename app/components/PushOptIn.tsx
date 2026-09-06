import { useEffect, useState } from 'react'
import { Bell, BellOff, BellRing } from 'lucide-react'
import { useT } from '~/lib/use-t'
import { getPushState, enablePush, disablePush, type PushState } from '~/lib/push-client'

// Opt-in card for PWA push notifications ("we're live" alerts). Renders the
// right control for the device's current state (supported / iOS-install-needed /
// blocked / already on). Safe to drop anywhere; it self-detects on mount.
export function PushOptIn() {
  const t = useT()
  const [state, setState] = useState<PushState | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    getPushState().then(setState).catch(() => setState('unsupported'))
  }, [])

  if (state === null || state === 'unsupported') return null

  async function toggle(turnOn: boolean) {
    setBusy(true)
    try {
      const res = turnOn ? await enablePush() : await disablePush()
      setState(res.state)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="flex items-center gap-3 rounded-xl p-3"
      style={{ background: '#fff5f6', border: '1px solid #f2ccd2' }}
    >
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full" style={{ background: '#ffe4e6' }}>
        {state === 'granted' ? <BellRing size={18} color="#c8102e" /> : state === 'denied' ? <BellOff size={18} color="#dc2626" /> : <Bell size={18} color="#9c1024" />}
      </div>

      <div className="min-w-0 flex-1">
        <p className="text-sm font-bold" style={{ color: '#2b0b10' }}>{t('push.title')}</p>
        <p className="text-[11px]" style={{ color: '#9c1024' }}>
          {state === 'denied'
            ? t('push.blocked')
            : state === 'installFirst'
              ? t('push.installFirst')
              : t('push.desc')}
        </p>
      </div>

      {state === 'granted' ? (
        <button
          type="button"
          disabled={busy}
          onClick={() => toggle(false)}
          className="shrink-0 rounded-lg px-3 py-1.5 text-xs font-bold disabled:opacity-50"
          style={{ background: '#fff0f2', color: '#9c1024', border: '1px solid #f2ccd2' }}
        >
          {t('push.disable')}
        </button>
      ) : state === 'default' ? (
        <button
          type="button"
          disabled={busy}
          onClick={() => toggle(true)}
          className="shrink-0 rounded-lg px-3 py-1.5 text-xs font-bold disabled:opacity-50"
          style={{ background: '#c8102e', color: '#fff' }}
        >
          {t('push.enable')}
        </button>
      ) : null}
    </div>
  )
}
