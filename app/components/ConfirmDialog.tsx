import { useEffect, type ReactNode } from 'react'
import { useFetcher } from 'react-router'
import { Loader, X } from 'lucide-react'

export type ConfirmTone = 'danger' | 'success' | 'neutral'

interface ConfirmDialogProps {
  open: boolean
  onClose: () => void
  title: string
  description?: string
  tone?: ConfirmTone
  confirmLabel: string
  /** Hidden form fields submitted to the parent route's action. */
  fields: Record<string, string>
  /** Form method (defaults to "post"). */
  method?: 'post' | 'put' | 'delete'
  /** Optional explicit action URL — defaults to the current route. */
  action?: string
  /** Called with `true` once the action returns `{ ok: true }`. */
  onSettled?: (ok: boolean) => void
  /** Extra form content rendered above the action buttons (e.g. a reason select). */
  children?: ReactNode
  /** Disables the confirm button without affecting cancel (e.g. reason not picked yet). */
  confirmDisabled?: boolean
}

const TONE_STYLES: Record<ConfirmTone, { bg: string; border: string; color: string }> = {
  danger: { bg: 'linear-gradient(135deg, #7f1d1d, #4c0519)', border: '#fca5a5', color: '#fff' },
  success: { bg: 'linear-gradient(135deg, #14532d, #052e16)', border: '#4ade80', color: '#fff' },
  neutral: { bg: 'linear-gradient(135deg, #c8102e, #7d0a1c)', border: '#e8949e', color: '#fff' },
}

// Generic confirm dialog used by admin actions (approve/reject deposits,
// suspend/activate customers, etc.). Submits via useFetcher so the page
// stays mounted; on success the loader revalidates and the row updates.
export function ConfirmDialog({
  open,
  onClose,
  title,
  description,
  tone = 'neutral',
  confirmLabel,
  fields,
  method = 'post',
  action,
  onSettled,
  children,
  confirmDisabled,
}: ConfirmDialogProps) {
  const fetcher = useFetcher<{ ok?: boolean; error?: string }>()
  const submitting = fetcher.state !== 'idle'
  const toneStyle = TONE_STYLES[tone]

  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !submitting) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose, submitting])

  // Close + notify when the action settles successfully.
  useEffect(() => {
    if (fetcher.state !== 'idle' || !fetcher.data) return
    if (fetcher.data.ok) {
      onSettled?.(true)
      onClose()
    }
  }, [fetcher.state, fetcher.data, onSettled, onClose])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-[100] flex items-end justify-center p-0 backdrop-blur-sm md:items-center md:p-4"
      style={{ background: 'rgba(0,0,0,0.75)' }}
      onClick={submitting ? undefined : onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        onClick={e => e.stopPropagation()}
        className={[
          'relative w-full p-5',
          'rounded-t-2xl pb-[max(1.25rem,env(safe-area-inset-bottom))]',
          'animate-in slide-in-from-bottom duration-200',
          'md:max-w-sm md:rounded-xl md:pb-5 md:fade-in md:zoom-in-95',
        ].join(' ')}
        style={{
          background: 'linear-gradient(135deg, #ffffff, #fff5f6)',
          border: '1px solid #f2ccd2',
          boxShadow: '0 10px 60px rgba(0,0,0,0.7)',
        }}
      >
        <div aria-hidden className="mx-auto mb-3 h-1 w-10 rounded-full md:hidden" style={{ background: '#c8102e' }} />

        <button
          type="button"
          onClick={onClose}
          disabled={submitting}
          className="absolute right-3 top-3 flex h-8 w-8 items-center justify-center rounded-full transition-opacity hover:opacity-80 disabled:opacity-30"
          style={{ background: '#ffffff', border: '1px solid #f2ccd2', color: '#6b4a4f' }}
          aria-label="Close"
        >
          <X size={14} />
        </button>

        <h3 className="mb-1 text-base font-bold" style={{ color: '#c8102e' }}>{title}</h3>
        {description && (
          <p className="mb-4 text-xs" style={{ color: '#6b4a4f' }}>{description}</p>
        )}

        {fetcher.data?.error && (
          <div
            className="mb-3 rounded-lg px-3 py-2 text-xs font-semibold"
            style={{ background: 'rgba(220,38,38,0.2)', color: '#dc2626', border: '1px solid #f87171' }}
          >
            {fetcher.data.error}
          </div>
        )}

        <fetcher.Form method={method} action={action}>
          {Object.entries(fields).map(([k, v]) => (
            <input key={k} type="hidden" name={k} value={v} />
          ))}
          {children && <div className="mb-4">{children}</div>}
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="rounded-md px-3 py-1.5 text-xs font-bold  disabled:opacity-50"
              style={{ background: 'transparent', color: '#6b4a4f', border: '1px solid #f2ccd2' }}
            >
              CANCEL
            </button>
            <button
              type="submit"
              disabled={submitting || confirmDisabled}
              className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-bold  disabled:opacity-50"
              style={{ background: toneStyle.bg, color: toneStyle.color, border: `1px solid ${toneStyle.border}` }}
            >
              {submitting && <Loader size={12} className="animate-spin" />}
              {confirmLabel}
            </button>
          </div>
        </fetcher.Form>
      </div>
    </div>
  )
}
