import { useEffect, useState } from "react"
import {
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useFetcher,
  useRouteLoaderData,
  type ShouldRevalidateFunctionArgs,
} from "react-router"
import { Toaster } from "sonner"
import { Trophy, X } from "lucide-react"
import type { Route } from "./+types/root"
import { DEFAULT_LOCALE, parseLocaleCookie, t as translate, type Locale } from "./lib/i18n"
import { GlobalNavLoader } from "./components/GlobalNavLoader"
import { ReferralModal, type ReferralCampaign, type ReferralListItem } from "./components/ReferralModal"
import "./app.css"

// Serialized shape of the authed user that's safe to pass to the browser.
// Defined here (not re-exported from auth.server.ts) so client-side imports
// of this type never pull Prisma/bcrypt into the browser bundle.
export type SessionUser = {
  id: string
  tel: string
  firstName: string | null
  lastName: string | null
  profile: string | null
  role: 'PLAYER' | 'SUPPORT' | 'ADMIN' | 'SUPERADMIN'
} | null

// DB-backed wallet balances. Null when the visitor is anonymous.
export type SessionWallets = {
  demo: number
  real: number
  promo: number
} | null

export async function loader({ request }: Route.LoaderArgs) {
  const locale: Locale = parseLocaleCookie(request.headers.get('cookie'))

  // Lazy-import so Vite doesn't eagerly pull Prisma into client module graph.
  const { getCurrentUserWithSession } = await import("./lib/auth.server")
  let session: Awaited<ReturnType<typeof getCurrentUserWithSession>> = null
  try {
    session = await getCurrentUserWithSession(request)
  } catch (err) {
    // DB hiccup — render the page as anonymous rather than throwing the whole
    // root loader, which would otherwise drop the user into an error boundary
    // on every refresh.
    console.error('[root loader] getCurrentUserWithSession failed:', err)
  }
  const user = session?.user ?? null
  const sessionId = session?.sessionId ?? null

  let wallets: SessionWallets = null
  if (user) {
    // Wrapped so a transient DB hiccup doesn't blow up the root loader on
    // every page (which would otherwise look like the user got logged out
    // because the error boundary takes over until they re-navigate).
    try {
      const { prisma } = await import("./lib/prisma.server")
      const ws = await prisma.wallet.findMany({
        where: { userId: user.id },
        select: { type: true, balance: true },
      })
      wallets = {
        demo: ws.find(w => w.type === 'DEMO')?.balance ?? 0,
        real: ws.find(w => w.type === 'REAL')?.balance ?? 0,
        promo: ws.find(w => w.type === 'PROMO')?.balance ?? 0,
      }
    } catch (err) {
      console.error('[root loader] wallet fetch failed:', err)
      // Leave `wallets` null — page still renders, balances stay at the last
      // value the in-browser store knows about.
    }
  }

  const sessionUser: SessionUser = user
    ? {
      id: user.id,
      tel: user.tel,
      firstName: user.firstName,
      lastName: user.lastName,
      profile: user.profile,
      role: user.role,
    }
    : null
  // Both helpers already fail-safe internally (return a default on a DB
  // hiccup), but wrap the call anyway — a transient error in the dynamic
  // import itself, or any future change that removes that internal guard,
  // would otherwise throw the ENTIRE root loader and drop every page (not
  // just this one) into the generic error boundary until the next request.
  let competition = { enabled: false, menuVisible: false }
  let referral = { enabled: false, percent: 0 }
  try {
    const { getCompetitionConfig, getReferralConfig } = await import('./lib/system-settings.server')
    const [c, r] = await Promise.all([getCompetitionConfig(), getReferralConfig()])
    competition = c
    referral = r
  } catch (err) {
    console.error('[root loader] competition/referral config fetch failed:', err)
  }

  return {
    user: sessionUser, wallets, locale,
    sessionId, // ties the referral-campaign modal's dismissal to THIS login
    competitionEnabled: competition.enabled,    // for banner (only show while running)
    competitionMenuVisible: competition.menuVisible, // for menu item visibility
    referralCampaign: { enabled: referral.enabled, percent: referral.percent },
  }
}

// During live play the client calls revalidator.revalidate() constantly (on
// every Pusher event) to keep child routes fresh. Each of those re-ran THIS
// root loader too — re-fetching /_root.data hundreds of times (the flood in the
// logs). But the root data (session + wallets) doesn't change on those events:
// the on-screen balance is driven by the in-browser user-store (updated
// optimistically + via Pusher), not this loader. So skip re-running the root
// loader for same-URL programmatic revalidations; still revalidate on real
// navigations and on form submissions/actions.
export function shouldRevalidate({
  currentUrl, nextUrl, formMethod, defaultShouldRevalidate,
}: ShouldRevalidateFunctionArgs) {
  const sameUrl =
    currentUrl.pathname === nextUrl.pathname && currentUrl.search === nextUrl.search
  if (!formMethod && sameUrl) return false
  return defaultShouldRevalidate
}

export const links: Route.LinksFunction = () => [
  { rel: "icon", href: "/favicon.png", type: "image/png", sizes: "32x32" },
  { rel: "apple-touch-icon", href: "/apple-icon.png", sizes: "180x180" },
  { rel: "manifest", href: "/manifest.webmanifest" },
  { rel: "preconnect", href: "https://fonts.googleapis.com" },
  { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
  {
    rel: "stylesheet",
    href: "https://fonts.googleapis.com/css2?family=Geist:wght@100..900&family=Geist+Mono:wght@100..900&display=swap",
  },
]

export const meta: Route.MetaFunction = () => [
  { title: "Fish Prawn Crab Game" },
  { name: "description", content: "Traditional Asian dice betting game" },
  { name: "theme-color", content: "#1e0040" },
  { name: "mobile-web-app-capable", content: "yes" },
  { name: "apple-mobile-web-app-capable", content: "yes" },
  { name: "apple-mobile-web-app-status-bar-style", content: "black-translucent" },
  { name: "apple-mobile-web-app-title", content: "Pupatao" },
]

export function Layout({ children }: { children: React.ReactNode }) {
  const data = useRouteLoaderData<typeof loader>('root')
  const lang: Locale = data?.locale ?? DEFAULT_LOCALE
  return (
    <html lang={lang}>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
      </head>
      <body className="font-sans antialiased">
        <GlobalNavLoader />
        {children}
        <Toaster
          position="bottom-center"
          theme="dark"
          richColors
          closeButton
          toastOptions={{
            classNames: {
              success:
                '!bg-gradient-to-br !from-green-600 !to-green-800 !text-white !border-green-400',
            },
          }}
        />
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  )
}

export default function App({ loaderData }: Route.ComponentProps) {
  // Descendant routes read these via `useOutletContext<{ user, wallets, locale }>()`.
  return (
    <>
      {loaderData.user && loaderData.competitionEnabled && (
        <CompetitionBanner />
      )}
      {loaderData.user && loaderData.sessionId && loaderData.referralCampaign?.enabled && (
        <CampaignModal
          sessionId={loaderData.sessionId}
          percent={loaderData.referralCampaign.percent}
          locale={loaderData.locale}
        />
      )}
      <PWAInstallPrompt />
      <Outlet
        context={{
          user: loaderData.user,
          wallets: loaderData.wallets,
          locale: loaderData.locale,
        }}
      />
    </>
  )
}

// Promo banner shown every time the user logs in while competition is active.
// This component mounts fresh on each login (parent conditionally renders it when
// user+competitionEnabled are both truthy) so useState(true) means "show on mount".
// Dismissal is in-memory only — no storage — so it reappears after every login.
function CompetitionBanner() {
  const [visible, setVisible] = useState(true)

  function dismiss() {
    setVisible(false)
  }

  if (!visible) return null

  return (
    <div className="fixed bottom-4 left-1/2 z-[300] w-[calc(100%-2rem)] max-w-sm -translate-x-1/2"
      style={{
        background: 'linear-gradient(135deg,#1e0040,#3b0764)',
        border: '2px solid #fbbf24',
        borderRadius: 16,
        boxShadow: '0 8px 32px rgba(251,191,36,0.25)',
      }}>
      <div className="flex items-start gap-3 p-4">
        <span className="text-2xl shrink-0">🏆</span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-bold" style={{ color: '#fbbf24' }}>ການແຂ່ງຂັນ Demo!</div>
          <div className="mt-0.5 text-xs" style={{ color: '#c4b5fd' }}>
            ລະບົບມີການແຂ່ງຂັນ Demo Play ຢູ່ ຜູ້ທີ່ມີ Demo Balance ສູງສຸດຊະນະ!
          </div>
          <div className="mt-2 flex gap-2">
            <a href="/competition"
              onClick={dismiss}
              className="rounded-lg px-3 py-1.5 text-xs font-bold"
              style={{ background: 'linear-gradient(135deg,#ca8a04,#78350f)', color: '#fff', border: '1px solid #fbbf24' }}>
              <Trophy size={10} className="mr-1 inline" />
              ເບິ່ງຄະແນນ
            </a>
            <button type="button" onClick={dismiss}
              className="rounded-lg px-3 py-1.5 text-xs font-bold"
              style={{ background: 'rgba(255,255,255,0.08)', color: '#a5b4fc', border: '1px solid #4c1d95' }}>
              ປິດ
            </button>
          </div>
        </div>
        <button type="button" onClick={dismiss}
          className="shrink-0 rounded-full p-0.5" style={{ color: '#818cf8' }}>
          <X size={14} />
        </button>
      </div>
    </div>
  )
}

// Referral-campaign promo modal — shown once per LOGIN (not per page refresh)
// while admin has the referral commission campaign enabled. `sessionId` comes
// from the root loader and only changes on an actual new login (a fresh
// Session row — see getCurrentUserWithSession in auth.server.ts), so
// dismissal is remembered in localStorage keyed to it: refreshing the page
// keeps the same sessionId and stays dismissed, but the next real login gets
// a new id and shows the modal again. Rendered directly in App (not inside
// the Outlet), so it can't use useT()/useOutletContext — locale comes in as
// a prop and strings are translated directly via `t()`.
const CAMPAIGN_MODAL_SEEN_KEY = 'pupatao_campaign_modal_seen_for_session'

type ReferralApiResponse =
  | { code: string; shareUrl: string; referrals: ReferralListItem[]; campaign: ReferralCampaign }
  | { error: string }

function CampaignModal({ sessionId, percent, locale }: { sessionId: string; percent: number; locale: Locale }) {
  const [visible, setVisible] = useState(false)
  const [referralOpen, setReferralOpen] = useState(false)
  const referralFetcher = useFetcher<ReferralApiResponse>()

  useEffect(() => {
    try {
      if (localStorage.getItem(CAMPAIGN_MODAL_SEEN_KEY) === sessionId) return
    } catch { /* localStorage unavailable — fail open and show it */ }
    setVisible(true)
  }, [sessionId])

  function dismiss() {
    try { localStorage.setItem(CAMPAIGN_MODAL_SEEN_KEY, sessionId) } catch { /* ignore */ }
    setVisible(false)
  }

  // "Invite now" — dismiss the promo card and open the referral modal
  // in place (share link/code + QR + invite list), no page navigation.
  function openReferral() {
    dismiss()
    if (!referralFetcher.data && referralFetcher.state === 'idle') referralFetcher.load('/api/referral')
    setReferralOpen(true)
  }

  return (
    <>
      {visible && (
        <div
          className="fixed inset-0 z-[500] flex items-center justify-center p-4"
          style={{ background: 'rgba(15,0,32,0.85)' }}
          onClick={dismiss}
          role="dialog"
          aria-modal="true"
        >
          <div
            onClick={e => e.stopPropagation()}
            className="relative w-full max-w-sm rounded-2xl p-6 text-center animate-in fade-in zoom-in-95 duration-200"
            style={{
              background: 'linear-gradient(135deg, #3b0764, #1e0040)',
              border: '2px solid #fbbf24',
              boxShadow: '0 10px 40px rgba(251,191,36,0.35)',
            }}
          >
            <button
              type="button"
              onClick={dismiss}
              className="absolute right-3 top-3 flex h-8 w-8 items-center justify-center rounded-full transition-opacity hover:opacity-80"
              style={{ background: '#4c1d95', color: '#e9d5ff', border: '1px solid #7c3aed' }}
              aria-label={translate(locale, 'common.close')}
            >
              <X size={16} />
            </button>

            <div
              className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-full text-3xl"
              style={{ background: 'rgba(251,191,36,0.15)', border: '2px solid #fbbf24' }}
            >
              🎁
            </div>
            <h2 className="mb-2 text-lg font-bold" style={{ color: '#fde68a' }}>
              {translate(locale, 'campaign.modal.title')}
            </h2>
            <p className="mb-5 text-sm" style={{ color: '#e9d5ff' }}>
              {translate(locale, 'campaign.modal.body', { percent })}
            </p>
            <button
              type="button"
              onClick={openReferral}
              className="block w-full rounded-xl py-3 text-sm font-bold"
              style={{ background: 'linear-gradient(135deg,#ca8a04,#78350f)', color: '#fff', border: '1px solid #fbbf24' }}
            >
              {translate(locale, 'campaign.modal.cta')}
            </button>
          </div>
        </div>
      )}

      {/* Guard with `'code' in data` (only present on success) — /api/referral
          can also return `{ error }` on a DB hiccup, which would otherwise
          render this with undefined props and crash the page. */}
      {referralOpen && referralFetcher.data && 'code' in referralFetcher.data && (
        <ReferralModal
          open={referralOpen}
          onClose={() => setReferralOpen(false)}
          shareUrl={referralFetcher.data.shareUrl}
          code={referralFetcher.data.code}
          referrals={referralFetcher.data.referrals}
          campaign={referralFetcher.data.campaign}
          locale={locale}
        />
      )}
    </>
  )
}

// PWA install prompt — shown once per week (localStorage) to users who haven't
// installed the app yet. Android gets the native browser prompt; iOS/iPhone
// gets a step-by-step instruction card (Safari doesn't support beforeinstallprompt).
function PWAInstallPrompt() {
  const [show, setShow] = useState(false)
  const [isIos, setIsIos] = useState(false)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [deferredPrompt, setDeferredPrompt] = useState<any>(null)

  useEffect(() => {
    if (typeof window === 'undefined') return
    // Already installed as PWA (standalone mode) — never prompt
    const isStandalone =
      window.matchMedia('(display-mode: standalone)').matches ||
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (navigator as any).standalone === true
    if (isStandalone) return

    // Dismissed earlier in this browser session — don't re-show until next visit
    try {
      if (sessionStorage.getItem('pwa_prompt_dismissed') === '1') return
    } catch { /* sessionStorage unavailable */ }

    const ios = /iPad|iPhone|iPod/i.test(navigator.userAgent) &&
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      !(window as any).MSStream
    setIsIos(ios)

    // iOS: do NOT show the install prompt — iOS users stay in Safari (where the
    // live video plays reliably). Only Android gets the install prompt below.
    if (ios) return

    // Android / Chrome — beforeinstallprompt fires early (before React hydrates),
    // so entry.client.tsx captures it globally. Check that first; fall back to
    // a live listener in case it hasn't fired yet.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const captured = (window as any).__pwaInstallPrompt
    if (captured) {
      setDeferredPrompt(captured)
      setTimeout(() => setShow(true), 3000)
      return
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handler = (e: any) => {
      e.preventDefault()
      setDeferredPrompt(e)
      setTimeout(() => setShow(true), 3000)
    }
    window.addEventListener('beforeinstallprompt', handler)
    return () => window.removeEventListener('beforeinstallprompt', handler)
  }, [])

  function dismiss() {
    // Suppress for this browser session only — shows again on next visit
    try { sessionStorage.setItem('pwa_prompt_dismissed', '1') } catch { /* ignore */ }
    setShow(false)
  }

  async function installAndroid() {
    // Prefer the state copy, but fall back to the event captured globally in
    // entry.client.tsx (in case the effect's setState hasn't propagated).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dp = deferredPrompt ?? (typeof window !== 'undefined' ? (window as any).__pwaInstallPrompt : null)
    if (!dp || typeof dp.prompt !== 'function') {
      // No installable prompt available (e.g. an in-app browser / webview that
      // doesn't support beforeinstallprompt). Just close the card.
      dismiss()
      return
    }
    try {
      // prompt() MUST be called synchronously inside this click gesture.
      dp.prompt()
      await dp.userChoice
    } catch { /* prompt already consumed or unsupported — ignore */ }
    setDeferredPrompt(null)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    try { (window as any).__pwaInstallPrompt = null } catch { /* ignore */ }
    setShow(false)
    // Whether accepted or not, suppress for this session
    try { sessionStorage.setItem('pwa_prompt_dismissed', '1') } catch { /* ignore */ }
  }

  if (!show) return null

  return (
    <div
      className="fixed bottom-4 left-1/2 z-[400] w-[calc(100%-2rem)] max-w-sm -translate-x-1/2"
      style={{ filter: 'drop-shadow(0 8px 32px rgba(124,58,237,0.4))' }}
    >
      <div
        className="rounded-2xl p-5"
        style={{ background: 'linear-gradient(135deg,#1e0040,#2d1b4e)', border: '2px solid #7c3aed' }}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-3 mb-3">
          <div className="flex items-center gap-2">
            <span style={{ fontSize: 28 }}>📲</span>
            <div>
              <div className="text-sm font-bold" style={{ color: '#fde68a' }}>ຕິດຕັ້ງແອັບ Pupatao</div>
              <div className="text-[10px]" style={{ color: '#a78bfa' }}>
                {isIos ? 'ສຳລັບ iPhone / iPad' : 'ໃຊ້ງານໄດ້ດີຂຶ້ນຄືແອັບ'}
              </div>
            </div>
          </div>
          <button type="button" onClick={dismiss}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full"
            style={{ background: 'rgba(255,255,255,0.08)', color: '#818cf8' }}>
            <X size={14} />
          </button>
        </div>

        {isIos ? (
          /* iOS: step-by-step instructions (Safari has no install API) */
          <>
            <p className="mb-3 text-xs" style={{ color: '#c4b5fd' }}>
              Safari ໃນ iPhone ສາມາດຕິດຕັ້ງໄດ້ດ້ວຍຂັ້ນຕອນດັ່ງນີ້:
            </p>
            <ol className="flex flex-col gap-2">
              {[
                { step: '1', icon: '⬆️', text: 'ກົດປຸ່ມ Share (ຮູບສີ່ລ່ຽມ + ລູກສອນ) ຢູ່ລຸ່ມໜ້າຈໍ' },
                { step: '2', icon: '➕', text: 'ເລື່ອນລົງ ແລ້ວກົດ "Add to Home Screen"' },
                { step: '3', icon: '✅', text: 'ກົດ "Add" ມູມຂວາເທິງ' },
              ].map(({ step, icon, text }) => (
                <li key={step} className="flex items-start gap-2 rounded-lg px-3 py-2"
                  style={{ background: 'rgba(124,58,237,0.12)', border: '1px solid #4c1d95' }}>
                  <span className="shrink-0 text-sm">{icon}</span>
                  <span className="text-xs" style={{ color: '#e9d5ff' }}>{text}</span>
                </li>
              ))}
            </ol>
            <button type="button" onClick={dismiss}
              className="mt-4 w-full rounded-xl py-2.5 text-sm font-bold"
              style={{ background: 'linear-gradient(135deg,#4c1d95,#2d1b4e)', color: '#e9d5ff', border: '1px solid #7c3aed' }}>
              ເຂົ້າໃຈແລ້ວ
            </button>
          </>
        ) : (
          /* Android / Chrome: trigger native install prompt */
          <>
            <p className="mb-4 text-xs" style={{ color: '#c4b5fd' }}>
              ຕິດຕັ້ງ Pupatao ໃສ່ໜ້າຈໍຫຼັກ — ໄວ, ສະດວກ, ໃຊ້ໄດ້ຄືແອັບ!
            </p>
            <div className="flex gap-2">
              <button type="button" onClick={dismiss}
                className="flex-1 rounded-xl py-2.5 text-sm font-bold"
                style={{ background: 'rgba(255,255,255,0.06)', color: '#a78bfa', border: '1px solid #4c1d95' }}>
                ບໍ່ດຽວນີ້
              </button>
              <button type="button" onClick={installAndroid}
                className="flex-1 rounded-xl py-2.5 text-sm font-bold"
                style={{ background: 'linear-gradient(135deg,#7c3aed,#4c1d95)', color: '#fff', border: '1px solid #a78bfa' }}>
                ຕິດຕັ້ງເລີຍ
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  const isRouteError = error && typeof error === "object" && "status" in error
  const status = isRouteError ? (error as { status: number }).status : 500
  const is404 = status === 404

  // NOTE: We intentionally do NOT auto-reload here. Auto-reloading under load
  // is dangerous — when the server is slow/overwhelmed, every error triggers a
  // reload, which is another request piling onto the overload, which causes
  // more errors and more reloads (a self-reinforcing storm). Instead we show a
  // friendly message with a MANUAL retry button, so recovery is user-paced and
  // never adds load automatically.
  if (is404) {
    return (
      <main className="min-h-screen flex flex-col items-center justify-center gap-3 p-6 text-center">
        <h1 className="text-3xl font-bold">404</h1>
        <p className="text-sm opacity-80">The requested page could not be found.</p>
        <a href="/" className="mt-2 rounded-lg px-4 py-2 text-sm font-bold"
          style={{ background: "#4338ca", color: "#fff" }}>ກັບໜ້າຫຼັກ · Home</a>
      </main>
    )
  }

  return (
    <main className="min-h-screen flex flex-col items-center justify-center gap-4 p-6 text-center"
      style={{ background: "linear-gradient(160deg, #0f172a, #1e1b4b)", color: "#e9d5ff" }}>
      <div>
        <p className="text-base font-bold" style={{ color: "#fde68a" }}>
          ເວັບໄຊຕ໌ກຳລັງຫຍຸ້ງ, ກະລຸນາລອງໃໝ່
        </p>
        <p className="mt-1 text-xs opacity-70">The site is busy — please try again in a moment.</p>
      </div>
      <button type="button" onClick={() => { window.location.reload() }}
        className="mt-1 rounded-lg px-5 py-2 text-sm font-bold"
        style={{ background: "#4338ca", color: "#fff", border: "1px solid #818cf8" }}>
        ລອງອີກຄັ້ງ · Try again
      </button>
    </main>
  )
}
