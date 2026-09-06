import { useEffect, useState } from 'react'
import { useFetcher } from 'react-router'
import { Check, Loader, LogIn, UserRoundPlus, X } from 'lucide-react'
import { PasswordInput } from './PasswordInput'
import { useT } from '~/lib/use-t'

interface RegisterModalProps {
  open: boolean
  onClose: () => void
  /** Path to return to after successful registration (defaults to current page). */
  next?: string
  /** Optional reason shown above the form. */
  hint?: string
  /** Called when the user clicks "Sign In" — swap to the login modal in-place. */
  onSwitchToLogin?: () => void
}

// Overlay sign-up modal. Matches LoginModal styling — bottom sheet on mobile,
// centred card on desktop. Submits to the `/register` action via a fetcher so
// the current page stays mounted; on success the session cookie is set and
// the root loader revalidates, after which the caller closes the modal.
export function RegisterModal({ open, onClose, next, hint, onSwitchToLogin }: RegisterModalProps) {
  const fetcher = useFetcher<{ error?: string } | null>()
  const submitting = fetcher.state !== 'idle'
  const t = useT()
  const [agreed, setAgreed] = useState(false)

  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  const nextPath = next ?? (typeof window !== 'undefined' ? window.location.pathname + window.location.search : '/')

  return (
    <div
      className="fixed inset-0 z-[100] flex items-end justify-center p-0 backdrop-blur-sm md:items-center md:p-4"
      style={{ background: 'rgba(0,0,0,0.75)' }}
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        onClick={e => e.stopPropagation()}
        className={[
          'relative w-full overflow-y-auto p-6',
          'h-[80vh] max-h-[80vh] rounded-t-3xl pb-[max(1.5rem,env(safe-area-inset-bottom))]',
          'animate-in slide-in-from-bottom duration-300',
          'md:h-auto md:max-h-[90vh] md:w-full md:max-w-md md:rounded-2xl md:pb-6 md:animate-in md:fade-in md:zoom-in-95 md:duration-200',
        ].join(' ')}
        style={{
          background: 'linear-gradient(135deg, #ffffff, #fff5f6)',
          boxShadow: '0 10px 60px rgba(0,0,0,0.7)',
        }}
      >
        {/* Drag-handle affordance on mobile */}
        <div
          aria-hidden
          className="mx-auto mb-3 h-1 w-10 rounded-full md:hidden"
          style={{ background: '#c8102e' }}
        />

        {/* Close button — top-right on all breakpoints */}
        <button
          onClick={onClose}
          type="button"
          className="absolute right-3 top-3 z-10 flex h-9 w-9 items-center justify-center rounded-full transition-opacity hover:opacity-80"
          style={{ background: '#ffe4e6', border: '1px solid #e8949e', color: '#2b0b10' }}
          aria-label={t('common.close')}
        >
          <X size={18} />
        </button>

        <div className="mb-1 text-center text-xs font-bold " style={{ color: '#9c1024' }}>
          {t('auth.titleRegister')}
        </div>
        <h2 className="mb-1 text-center text-2xl font-bold" style={{ color: '#c8102e' }}>
          {t('auth.createAccount')}
        </h2>
        <p className="mb-4 text-center text-[11px]" style={{ color: '#6b4a4f' }}>
          {hint ?? t('auth.registerHint')}
        </p>

        <fetcher.Form method="post" action="/register" className="flex flex-col gap-3">
          <input type="hidden" name="next" value={nextPath} />

          <label className="flex gap-1 text-xs font-semibold" style={{ color: '#6b4a4f' }}>
            {t('auth.phone')} <span className='text-rose-500'>*</span>
          </label>
          <input
            name="tel"
            type="tel"
            autoComplete="tel"
            required
            placeholder="+85620xxxxxxxx"
            className="rounded-lg px-3 py-2.5 text-sm font-semibold outline-none"
            style={{ background: '#fff0f2', color: '#c8102e', border: '2px solid #e8949e' }}
          />

          <label className="flex gap-1 text-xs font-semibold" style={{ color: '#6b4a4f' }}>
            {t('auth.password')} <span className='text-rose-500'>*</span>
          </label>
          <PasswordInput name="password" autoComplete="new-password" required minLength={6} />

          <label className="flex gap-1 text-xs font-semibold" style={{ color: '#6b4a4f' }}>
            {t('auth.referralCode')}
          </label>
          {/* Optional — pre-filled from ?ref=CODE when arriving via a share
              link, but a user can also type someone's code by hand (or clear
              it). Same `ref` field the action already reads either way. */}
          <input
            name="ref"
            type="text"
            autoComplete="off"
            placeholder={t('auth.referralCodePlaceholder')}
            defaultValue={typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('ref') ?? '' : ''}
            className="rounded-lg px-3 py-2.5 text-sm font-semibold uppercase outline-none placeholder:normal-case"
            style={{ background: '#fff0f2', color: '#c8102e', border: '2px solid #e8949e' }}
          />

          {fetcher.data?.error && (
            <div
              className="rounded-lg px-3 py-2 text-xs font-semibold"
              style={{ background: 'rgba(220,38,38,0.2)', color: '#dc2626', border: '1px solid #f87171' }}
            >
              {fetcher.data.error}
            </div>
          )}

          {/* Rules-agreement gate — submit button stays disabled until ticked. */}
          <input type="hidden" name="agreedRules" value={agreed ? '1' : ''} />
          <label className="mt-1 flex cursor-pointer items-start gap-2 select-none">
            <button
              type="button"
              onClick={() => setAgreed(v => !v)}
              aria-pressed={agreed}
              aria-label={t('auth.agreeRulesLink')}
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded transition-colors"
              style={{
                background: agreed ? '#16a34a' : '#fff0f2',
                border: `2px solid ${agreed ? '#4ade80' : '#e8949e'}`,
              }}
            >
              {agreed && <Check size={12} className="text-white" strokeWidth={3} />}
            </button>
            <span
              onClick={() => setAgreed(v => !v)}
              className="text-[11px] leading-snug"
              style={{ color: '#6b4a4f' }}
            >
              {t('auth.agreeRulesPrefix')}{' '}
              <a
                href="/rules"
                target="_blank"
                rel="noopener noreferrer"
                onClick={e => e.stopPropagation()}
                className="font-bold underline-offset-2 hover:underline"
                style={{ color: '#c8102e' }}
              >
                {t('auth.agreeRulesLink')}
              </a>
              {t('auth.agreeRulesSuffix')}
            </span>
          </label>

          {/* Login + Register side by side (flex). Login is a real button now
              (not a text link) and shown first. */}
          <div className="mt-2 flex items-stretch gap-2">
            {onSwitchToLogin ? (
              <button
                type="button"
                onClick={onSwitchToLogin}
                className="flex flex-1 items-center justify-center gap-2 rounded-xl py-3 text-sm font-bold"
                style={{ background: 'linear-gradient(135deg, #c8102e, #a50d26)', color: '#fff', border: '2px solid #e8949e' }}
              >
                <LogIn size={16} />
                {t('auth.signIn')}
              </button>
            ) : (
              <a
                href="/login"
                className="flex flex-1 items-center justify-center gap-2 rounded-xl py-3 text-sm font-bold"
                style={{ background: 'linear-gradient(135deg, #c8102e, #a50d26)', color: '#fff', border: '2px solid #e8949e' }}
              >
                <LogIn size={16} />
                {t('auth.signIn')}
              </a>
            )}

            <button
              type="submit"
              disabled={submitting || !agreed}
              className="flex flex-1 items-center justify-center gap-2 rounded-xl py-3 text-sm font-bold disabled:opacity-50 disabled:cursor-not-allowed"
              style={{
                background: 'linear-gradient(135deg, #16a34a, #15803d)',
                color: '#fff',
                border: '2px solid #4ade80',
              }}
            >
              {submitting ? <Loader size={16} className='animate-spin' /> : <UserRoundPlus size={16} />}
              {submitting ? t('auth.creating') : t('auth.createAccount')}
            </button>
          </div>
        </fetcher.Form>
      </div>
    </div>
  )
}
