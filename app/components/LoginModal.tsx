import { useEffect } from 'react'
import { useFetcher } from 'react-router'
import { Loader, LogIn, X } from 'lucide-react'
import { PasswordInput } from './PasswordInput'
import { useT } from '~/lib/use-t'

const WHATSAPP_ADMIN = '+8562078959344'

interface LoginModalProps {
  open: boolean
  onClose: () => void
  /** Path to return to after successful login (defaults to current page). */
  next?: string
  /** Optional reason shown above the form, e.g. "Sign in to use your real wallet." */
  hint?: string
  /** Called when the user clicks "Register" — swap to the register modal in-place. */
  onSwitchToRegister?: () => void
}

// Overlay sign-in modal. Submits to the `/login` action via a fetcher so the
// current page doesn't navigate away on success — once the root loader
// revalidates and the session user materialises, the caller closes the modal.
export function LoginModal({ open, onClose, next, hint, onSwitchToRegister }: LoginModalProps) {
  const fetcher = useFetcher<{ error?: string } | null>()
  const submitting = fetcher.state !== 'idle'
  const t = useT()

  // Close the modal if the browser hits Esc while it's open.
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
  // Stays in English so admins (who reply in either language) get a stable
  // contact handle. The localised label is on the link itself.
  const waText = encodeURIComponent('Hello, I forgot my password for my Pupatao account. My phone number is: ')

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
          // Mobile (< md): bottom sheet, 80vh, rounded top only, slide up.
          'h-[80vh] max-h-[80vh] rounded-t-3xl pb-[max(1.5rem,env(safe-area-inset-bottom))]',
          'animate-in slide-in-from-bottom duration-300',
          // md+ : fully centred card, auto-height, wider, fade-in only.
          'md:h-auto md:max-h-[90vh] md:w-full md:max-w-md md:rounded-xl md:pb-6 md:animate-in md:fade-in md:zoom-in-95 md:duration-200',
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
          {t('auth.titleLogin')}
        </div>
        <h2 className="mb-1 text-center text-2xl font-bold" style={{ color: '#c8102e' }}>
          {t('auth.welcomeBack')}
        </h2>
        {hint && (
          <p className="mb-4 text-center text-[11px]" style={{ color: '#6b4a4f' }}>
            {hint}
          </p>
        )}
        {!hint && <div className="mb-4" />}

        <fetcher.Form method="post" action="/login" className="flex flex-col gap-3">
          <input type="hidden" name="next" value={nextPath} />

          <label className="flex gap-1 text-xs font-semibold" style={{ color: '#6b4a4f' }}>
            {t('auth.phone')} <span className="text-rose-500">*</span>
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
            {t('auth.password')}<span className="text-rose-500">*</span>
          </label>
          <PasswordInput name="password" autoComplete="current-password" required />

          {fetcher.data?.error && (
            <div
              className="rounded-lg px-3 py-2 text-xs font-semibold"
              style={{ background: 'rgba(220,38,38,0.2)', color: '#dc2626', border: '1px solid #f87171' }}
            >
              {fetcher.data.error}
            </div>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="flex items-center justify-center gap-2 mt-2 w-full rounded-xl py-3 text-sm font-bold  disabled:opacity-50"
            style={{
              background: 'linear-gradient(135deg, #16a34a, #15803d)',
              color: '#fff',
              border: '2px solid #4ade80',
            }}
          >
            {submitting ? <Loader size={16} className='animate-spin' /> : <LogIn size={16} />}
            {submitting ? t('auth.signingIn') : t('auth.signIn')}
          </button>
        </fetcher.Form>

        <div className="mt-5 flex flex-col items-center gap-2 text-sm" style={{ color: '#6b4a4f' }}>
          <div>
            {t('auth.noAccount')}{' '}&nbsp;
            {onSwitchToRegister ? (
              <button
                type="button"
                onClick={onSwitchToRegister}
                className="text-base font-bold underline underline-offset-2"
                style={{ color: '#c8102e' }}
              >
                {t('auth.register')}
              </button>
            ) : (
              <a href="/register" className="text-base font-bold underline underline-offset-2" style={{ color: '#c8102e' }}>
                {t('auth.register')}
              </a>
            )}
          </div>
          <a
            href={`https://wa.me/${WHATSAPP_ADMIN.replace(/[^\d]/g, '')}?text=${waText}`}
            target="_blank"
            rel="noreferrer"
            className="font-bold text-md"
            style={{ color: '#c8102e' }}
          >
            {t('auth.forgotPassword')}
          </a>
        </div>
      </div>
    </div>
  )
}
