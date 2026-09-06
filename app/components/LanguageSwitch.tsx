import { useFetcher, useLocation } from 'react-router'
import { Globe } from 'lucide-react'
import { LOCALES, LOCALE_FLAG, LOCALE_LABEL, type Locale } from '~/lib/i18n'
import { useLocale } from '~/lib/use-t'

interface Props {
  /** Layout variant. `pill` is the dense header pill; `inline` is a row of
   *  buttons used on the profile page. */
  variant?: 'pill' | 'inline'
}

// Submits to /api/locale, which sets the cookie and redirects back so the
// next SSR pass renders in the chosen language.
export function LanguageSwitch({ variant = 'inline' }: Props) {
  const fetcher = useFetcher()
  const location = useLocation()
  const current = useLocale()

  function pick(locale: Locale) {
    if (locale === current) return
    const fd = new FormData()
    fd.append('locale', locale)
    fd.append('redirectTo', location.pathname + location.search)
    fetcher.submit(fd, { method: 'post', action: '/api/locale' })
  }

  if (variant === 'pill') {
    const next: Locale = current === 'lo' ? 'en' : 'lo'
    return (
      <button
        type="button"
        onClick={() => pick(next)}
        title={`Switch to ${LOCALE_LABEL[next]}`}
        className="flex items-center gap-1 rounded-full px-2.5 py-1 text-[10px] font-bold  transition-opacity hover:opacity-90"
        style={{ background: '#ffe4e6', color: '#c8102e', border: '1px solid #e8949e' }}
      >
        <Globe size={11} />
        <span aria-hidden>{LOCALE_FLAG[next]}</span>
        {LOCALE_LABEL[next]}
      </button>
    )
  }

  return (
    <div className="flex gap-2">
      {LOCALES.map(l => {
        const active = l === current
        return (
          <button
            key={l}
            type="button"
            onClick={() => pick(l)}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-lg px-4 py-2 text-sm font-bold  transition-opacity hover:opacity-90"
            style={{
              background: active ? '#c8102e' : '#fff0f2',
              color: active ? '#fff' : '#6b4a4f',
              border: `1.5px solid ${active ? '#fde68a' : '#f2ccd2'}`,
            }}
          >
            <span aria-hidden className="text-base leading-none">{LOCALE_FLAG[l]}</span>
            <span>{LOCALE_LABEL[l]}</span>
          </button>
        )
      })}
    </div>
  )
}
