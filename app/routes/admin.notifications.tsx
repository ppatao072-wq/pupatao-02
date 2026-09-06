import { useEffect, useRef, useState } from 'react'
import { useFetcher, useLoaderData } from 'react-router'
import { Bell, Loader, Play, Pause, Trash2, Send, CalendarClock, Repeat, Users as UsersIcon } from 'lucide-react'
import { toast } from 'sonner'
import type { NotificationAudience } from '@prisma/client'
import type { Route } from './+types/admin.notifications'
import { requireRole } from '~/lib/admin-auth.server'
import { prisma } from '~/lib/prisma.server'
import { parseLocaleCookie } from '~/lib/i18n'
import { AUDIENCE_LABELS, AUDIENCE_VALUES } from '~/lib/notifications.server'
import { useT } from '~/lib/use-t'

export async function loader({ request }: Route.LoaderArgs) {
  await requireRole(request, ['ADMIN', 'SUPERADMIN'])
  const locale = parseLocaleCookie(request.headers.get('cookie'))

  const [campaigns, subscriberCount] = await Promise.all([
    prisma.notificationCampaign.findMany({ orderBy: { createdAt: 'desc' }, take: 50 }),
    prisma.pushSubscription.count(),
  ])

  return {
    subscriberCount,
    // Localized audience options for the <select> (server-side so we never
    // import the .server label map into the client bundle).
    audiences: AUDIENCE_VALUES.map(v => ({ value: v, label: AUDIENCE_LABELS[v][locale] })),
    campaigns: campaigns.map(c => ({
      id: c.id,
      title: c.title,
      message: c.message,
      audience: c.audience,
      audienceLabel: AUDIENCE_LABELS[c.audience][locale],
      mode: c.mode,
      timeOfDay: c.timeOfDay,
      scheduledAt: c.scheduledAt?.toISOString() ?? null,
      active: c.active,
      lastRunAt: c.lastRunAt?.toISOString() ?? null,
      lastSent: c.lastSent,
    })),
  }
}

export async function action({ request }: Route.ActionArgs) {
  const admin = await requireRole(request, ['ADMIN', 'SUPERADMIN'])
  const fd = await request.formData()
  const op = String(fd.get('op') ?? '')

  try {
    if (op === 'create') {
      const message = String(fd.get('message') ?? '').trim()
      if (!message) return { error: 'Message is required' }
      const title = String(fd.get('title') ?? '').trim() || null
      const audience = String(fd.get('audience') ?? 'ALL') as NotificationAudience
      if (!AUDIENCE_VALUES.includes(audience)) return { error: 'Invalid audience' }
      const schedule = String(fd.get('schedule') ?? 'now')

      if (schedule === 'daily') {
        const timeOfDay = String(fd.get('timeOfDay') ?? '').trim()
        if (!/^\d{2}:\d{2}$/.test(timeOfDay)) return { error: 'Time is required' }
        await prisma.notificationCampaign.create({
          data: { title, message, audience, mode: 'DAILY', timeOfDay, active: true, createdById: admin.id },
        })
        return { ok: true, created: true }
      }

      if (schedule === 'once') {
        const dt = String(fd.get('scheduledAt') ?? '').trim()
        // datetime-local value ("YYYY-MM-DDTHH:mm") is entered in GMT+7.
        const scheduledAt = new Date(`${dt}:00+07:00`)
        if (!dt || isNaN(scheduledAt.getTime())) return { error: 'Valid date & time required' }
        await prisma.notificationCampaign.create({
          data: { title, message, audience, mode: 'ONCE', scheduledAt, active: true, createdById: admin.id },
        })
        return { ok: true, created: true }
      }

      // schedule === 'now' → create + fire immediately (push) AND show it as a
      // persistent in-app announcement (the bell) for every user.
      const c = await prisma.notificationCampaign.create({
        data: { title, message, audience, mode: 'ONCE', active: false, createdById: admin.id },
      })
      const { runCampaign } = await import('~/lib/notifications.server')
      const res = await runCampaign(c)

      // Refresh the in-app notification feed for every user (the bell) and
      // signal all connected clients to refetch it immediately.
      const { invalidateNotifications } = await import('~/lib/system-settings.server')
      const { notifyGame } = await import('~/lib/pusher.server')
      invalidateNotifications()
      notifyGame('announcement:posted', { id: c.id, message, createdAt: new Date().toISOString() })

      return { ok: true, sent: res.sent }
    }

    if (op === 'runNow') {
      const id = String(fd.get('id') ?? '')
      const c = await prisma.notificationCampaign.findUnique({ where: { id } })
      if (!c) return { error: 'Not found' }
      const { runCampaign } = await import('~/lib/notifications.server')
      const res = await runCampaign(c)
      return { ok: true, sent: res.sent }
    }

    if (op === 'toggle') {
      const id = String(fd.get('id') ?? '')
      const c = await prisma.notificationCampaign.findUnique({ where: { id } })
      if (!c) return { error: 'Not found' }
      await prisma.notificationCampaign.update({ where: { id }, data: { active: !c.active } })
      return { ok: true }
    }

    if (op === 'delete') {
      const id = String(fd.get('id') ?? '')
      await prisma.notificationCampaign.delete({ where: { id } }).catch(() => { /* already gone */ })
      // Drop it from the user notification feed too.
      const { invalidateNotifications } = await import('~/lib/system-settings.server')
      const { notifyGame } = await import('~/lib/pusher.server')
      invalidateNotifications()
      notifyGame('announcement:posted', { id, message: '', createdAt: new Date().toISOString() })
      return { ok: true }
    }

    return { error: 'Unknown action' }
  } catch (err) {
    console.error('[admin/notifications]', err)
    return { error: 'Something went wrong' }
  }
}

const PARAMS = ['phone_number', 'first_name', 'last_name', 'name'] as const

export default function AdminNotifications() {
  const t = useT()
  const { subscriberCount, audiences, campaigns } = useLoaderData<typeof loader>()
  const fetcher = useFetcher<{ ok?: boolean; sent?: number; created?: boolean; error?: string }>()
  const busy = fetcher.state !== 'idle'

  const [message, setMessage] = useState('')
  const msgRef = useRef<HTMLTextAreaElement>(null)

  // Toast on completion, then reset the composer.
  const lastHandled = useRef<unknown>(null)
  useEffect(() => {
    if (fetcher.state !== 'idle' || !fetcher.data || fetcher.data === lastHandled.current) return
    lastHandled.current = fetcher.data
    if (fetcher.data.error) {
      toast.error(fetcher.data.error)
    } else if (fetcher.data.sent !== undefined) {
      toast.success(t('admin.notifications.sentToast', { n: String(fetcher.data.sent) }))
      setMessage('')
    } else if (fetcher.data.created) {
      toast.success(t('admin.notifications.createdToast'))
      setMessage('')
    }
  }, [fetcher.state, fetcher.data, t])

  function insertParam(p: string) {
    const token = `{{${p}}}`
    const el = msgRef.current
    if (!el) { setMessage(m => m + token); return }
    const start = el.selectionStart ?? message.length
    const end = el.selectionEnd ?? message.length
    const next = message.slice(0, start) + token + message.slice(end)
    setMessage(next)
    requestAnimationFrame(() => {
      el.focus()
      const pos = start + token.length
      el.setSelectionRange(pos, pos)
    })
  }

  // Live preview with sample recipient data.
  const preview = renderPreview(message)

  const panel = { background: '#0f172a', border: '1px solid #1e1b4b' }
  const field = { background: '#1e1b4b', color: '#fde68a', border: '1px solid #4338ca' }

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-5 px-4 py-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl" style={{ background: '#312e81' }}>
          <Bell size={20} color="#a5b4fc" />
        </div>
        <div className="min-w-0">
          <h1 className="text-lg font-bold text-white">{t('admin.notifications.title')}</h1>
          <p className="text-xs" style={{ color: '#a5b4fc' }}>{t('admin.notifications.subtitle')}</p>
        </div>
        <div className="ml-auto flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-bold" style={{ background: '#1e1b4b', color: '#a5b4fc' }}>
          <UsersIcon size={13} /> {subscriberCount} <span className="opacity-70">{t('admin.notifications.subscribers')}</span>
        </div>
      </div>

      <div className="grid gap-5 lg:grid-cols-[1fr_1fr]">
        {/* ── Composer ── */}
        <fetcher.Form method="post" className="flex flex-col gap-3 rounded-2xl p-4" style={panel}>
          <input type="hidden" name="op" value="create" />
          {/* Scheduling removed (no cron on this plan) — always send immediately. */}
          <input type="hidden" name="schedule" value="now" />
          <input type="hidden" name="message" value={message} />

          <div className="text-sm font-bold" style={{ color: '#e9d5ff' }}>{t('admin.notifications.compose')}</div>

          {/* Title */}
          <label className="text-[10px] font-semibold" style={{ color: '#a5b4fc' }}>{t('admin.notifications.titleLabel')}</label>
          <input name="title" placeholder={t('admin.notifications.titlePlaceholder')} className="rounded-lg px-3 py-2 text-xs outline-none" style={field} />

          {/* Audience */}
          <label className="text-[10px] font-semibold" style={{ color: '#a5b4fc' }}>{t('admin.notifications.audience')}</label>
          <select name="audience" defaultValue="ALL" className="rounded-lg px-3 py-2 text-xs outline-none" style={field}>
            {audiences.map(a => (
              <option key={a.value} value={a.value} style={{ background: '#1e1b4b' }}>{a.label}</option>
            ))}
          </select>

          {/* Message + params */}
          <label className="text-[10px] font-semibold" style={{ color: '#a5b4fc' }}>{t('admin.notifications.message')}</label>
          <textarea
            ref={msgRef}
            value={message}
            onChange={e => setMessage(e.target.value)}
            rows={4}
            placeholder={t('admin.notifications.messagePlaceholder')}
            className="resize-none rounded-lg px-3 py-2 text-xs outline-none"
            style={field}
          />
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[10px]" style={{ color: '#818cf8' }}>{t('admin.notifications.params')}</span>
            {PARAMS.map(p => (
              <button
                key={p}
                type="button"
                onClick={() => insertParam(p)}
                className="rounded-full px-2 py-0.5 text-[10px] font-semibold active:scale-95"
                style={{ background: '#312e81', color: '#c7d2fe', border: '1px solid #4338ca' }}
              >
                {`{{${p}}}`}
              </button>
            ))}
          </div>

          {/* Preview */}
          {message.trim() && (
            <div className="rounded-lg p-2.5" style={{ background: '#0b1220', border: '1px dashed #4338ca' }}>
              <div className="mb-1 text-[9px] font-bold uppercase tracking-wide" style={{ color: '#818cf8' }}>{t('admin.notifications.preview')}</div>
              <div className="text-xs" style={{ color: '#e2e8f0' }}>{preview}</div>
            </div>
          )}

          <button
            type="submit"
            disabled={busy || !message.trim()}
            className="mt-1 inline-flex items-center justify-center gap-1.5 rounded-lg py-2.5 text-xs font-bold disabled:opacity-50"
            style={{ background: 'linear-gradient(135deg,#4338ca,#312e81)', color: '#fff', border: '1px solid #818cf8' }}
          >
            {busy ? <Loader size={14} className="animate-spin" /> : <Send size={14} />}
            {busy ? t('admin.notifications.sending') : t('admin.notifications.sendNow')}
          </button>
        </fetcher.Form>

        {/* ── Campaign list ── */}
        <div className="flex flex-col gap-2.5 rounded-2xl p-4" style={panel}>
          <div className="text-sm font-bold" style={{ color: '#e9d5ff' }}>{t('admin.notifications.campaigns')}</div>
          {campaigns.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-10 text-center">
              <Bell size={28} color="#4338ca" />
              <p className="text-xs" style={{ color: '#64748b' }}>{t('admin.notifications.none')}</p>
            </div>
          ) : (
            campaigns.map(c => <CampaignRow key={c.id} c={c} />)
          )}
        </div>
      </div>
    </div>
  )
}

type Campaign = ReturnType<typeof useLoaderData<typeof loader>>['campaigns'][number]

function CampaignRow({ c }: { c: Campaign }) {
  const t = useT()
  const fetcher = useFetcher<{ ok?: boolean; sent?: number; error?: string }>()
  const busy = fetcher.state !== 'idle'

  const lastHandled = useRef<unknown>(null)
  useEffect(() => {
    if (fetcher.state !== 'idle' || !fetcher.data || fetcher.data === lastHandled.current) return
    lastHandled.current = fetcher.data
    if (fetcher.data.error) toast.error(fetcher.data.error)
    else if (fetcher.data.sent !== undefined) toast.success(t('admin.notifications.sentToast', { n: String(fetcher.data.sent) }))
  }, [fetcher.state, fetcher.data, t])

  const statusStyle = c.mode === 'ONCE' && !c.active && c.lastRunAt
    ? { bg: 'rgba(22,163,74,0.15)', fg: '#4ade80', label: t('admin.notifications.done') }
    : c.active
      ? { bg: 'rgba(67,56,202,0.2)', fg: '#a5b4fc', label: t('admin.notifications.active') }
      : { bg: 'rgba(100,116,139,0.15)', fg: '#94a3b8', label: t('admin.notifications.paused') }

  const schedText = c.mode === 'DAILY'
    ? `${t('admin.notifications.daily')} · ${c.timeOfDay ?? ''}`
    : c.scheduledAt
      ? new Date(c.scheduledAt).toLocaleString('en-GB', { timeZone: 'Asia/Bangkok', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
      : t('admin.notifications.sendNow')

  return (
    <div className="rounded-xl p-3" style={{ background: '#0b1220', border: '1px solid #1e1b4b' }}>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          {c.title && <div className="truncate text-xs font-bold" style={{ color: '#fde68a' }}>{c.title}</div>}
          <div className="line-clamp-2 text-[11px]" style={{ color: '#cbd5e1' }}>{c.message}</div>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[9px]">
            <span className="rounded-full px-1.5 py-0.5 font-semibold" style={{ background: '#1e1b4b', color: '#c7d2fe' }}>{c.audienceLabel}</span>
            <span className="flex items-center gap-1 rounded-full px-1.5 py-0.5 font-semibold" style={{ background: '#1e1b4b', color: '#a5b4fc' }}>
              {c.mode === 'DAILY' ? <Repeat size={9} /> : <CalendarClock size={9} />}{schedText}
            </span>
            {c.lastSent != null && (
              <span className="rounded-full px-1.5 py-0.5" style={{ color: '#64748b' }}>{t('admin.notifications.lastSent', { n: String(c.lastSent) })}</span>
            )}
          </div>
        </div>
        <span className="shrink-0 rounded-full px-2 py-0.5 text-[9px] font-bold" style={{ background: statusStyle.bg, color: statusStyle.fg }}>{statusStyle.label}</span>
      </div>

      <div className="mt-2 flex items-center gap-1.5">
        <fetcher.Form method="post" className="inline">
          <input type="hidden" name="op" value="runNow" />
          <input type="hidden" name="id" value={c.id} />
          <button type="submit" disabled={busy} className="flex items-center gap-1 rounded-lg px-2 py-1 text-[10px] font-bold disabled:opacity-50" style={{ background: '#4338ca', color: '#fff' }}>
            {busy ? <Loader size={11} className="animate-spin" /> : <Send size={11} />} {t('admin.notifications.runNow')}
          </button>
        </fetcher.Form>

        {c.mode === 'DAILY' && (
          <fetcher.Form method="post" className="inline">
            <input type="hidden" name="op" value="toggle" />
            <input type="hidden" name="id" value={c.id} />
            <button type="submit" disabled={busy} className="flex items-center gap-1 rounded-lg px-2 py-1 text-[10px] font-bold disabled:opacity-50" style={{ background: '#1e1b4b', color: '#a5b4fc' }}>
              {c.active ? <><Pause size={11} /> {t('admin.notifications.pause')}</> : <><Play size={11} /> {t('admin.notifications.resume')}</>}
            </button>
          </fetcher.Form>
        )}

        <fetcher.Form method="post" className="ml-auto inline" onSubmit={e => { if (!confirm(t('admin.notifications.deleteConfirm'))) e.preventDefault() }}>
          <input type="hidden" name="op" value="delete" />
          <input type="hidden" name="id" value={c.id} />
          <button type="submit" disabled={busy} className="flex items-center gap-1 rounded-lg px-2 py-1 text-[10px] font-bold disabled:opacity-50" style={{ background: 'rgba(127,29,29,0.4)', color: '#fca5a5' }}>
            <Trash2 size={11} /> {t('admin.notifications.delete')}
          </button>
        </fetcher.Form>
      </div>
    </div>
  )
}

// Client-side preview mirror of renderTemplate with sample values.
function renderPreview(template: string): string {
  const sample: Record<string, string> = {
    phone_number: '+856 20 7885 6194',
    first_name: 'Somchai',
    last_name: 'Phimmasone',
    name: 'Somchai Phimmasone',
  }
  return template.replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (full, key: string) => sample[key.toLowerCase()] ?? full)
}
