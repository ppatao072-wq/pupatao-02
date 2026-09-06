import { Form, redirect, useActionData, useNavigation } from 'react-router'
import { Loader, LogIn, ShieldCheck } from 'lucide-react'
import type { Route } from './+types/admin.login'
import { prisma } from '~/lib/prisma.server'
import { createAdminSession, getCurrentAdmin, verifyAdminPassword } from '~/lib/admin-auth.server'
import { useT } from '~/lib/use-t'

export async function loader({ request }: Route.LoaderArgs) {
  const admin = await getCurrentAdmin(request)
  if (admin) throw redirect('/admin')
  return null
}

export async function action({ request }: Route.ActionArgs) {
  const fd = await request.formData()
  const email = String(fd.get('email') ?? '').trim().toLowerCase()
  const password = String(fd.get('password') ?? '')
  const next = String(fd.get('next') ?? '/admin') || '/admin'

  if (!email || !password) {
    return { error: 'admin.login.error.required' as const }
  }

  try {
    const admin = await prisma.admin.findUnique({ where: { email } })
    if (!admin) return { error: 'admin.login.error.invalidCredentials' as const }
    if (admin.status !== 'ACTIVE') return { error: 'admin.login.error.accountInactive' as const }

    const ok = await verifyAdminPassword(password, admin.passwordHash)
    if (!ok) return { error: 'admin.login.error.invalidCredentials' as const }

    // MUST be awaited — see the identical note in routes/login.tsx.
    return await createAdminSession(admin.id, request, next)
  } catch (err) {
    console.error('[admin/login]', err)
    const isConn =
      err instanceof Error &&
      /Server selection timeout|No available servers|received fatal alert|ECONNREFUSED|ENOTFOUND/i.test(err.message)
    return {
      error: isConn
        ? ('admin.login.error.dbUnreachable' as const)
        : ('admin.login.error.generic' as const),
    }
  }
}

export default function AdminLoginPage() {
  const data = useActionData<typeof action>()
  const navigation = useNavigation()
  const submitting = navigation.state !== 'idle'
  const t = useT()

  return (
    <div
      className="flex min-h-screen items-center justify-center px-4 font-sans"
      style={{ background: 'linear-gradient(160deg, #ffffff 0%, #fff5f6 50%, #ffe4e6 100%)' }}
    >
      <div
        className="w-full max-w-sm rounded-2xl p-6"
        style={{ background: 'linear-gradient(135deg, #ffffff, #fff5f6)', border: '1px solid #f2ccd2', boxShadow: '0 10px 60px rgba(0,0,0,0.7)' }}
      >
        <div className="mb-1 flex items-center justify-center gap-2 text-xs font-bold " style={{ color: '#6b4a4f' }}>
          <ShieldCheck size={14} /> {t('admin.login.badge')}
        </div>
        <h1 className="mb-5 text-center text-2xl font-bold" style={{ color: '#c8102e' }}>
          Pupatao Admin
        </h1>

        <Form method="post" className="flex flex-col gap-3">
          <label className="text-xs font-semibold" style={{ color: '#6b4a4f' }}>{t('admin.login.emailLabel')}</label>
          <input
            name="email"
            type="email"
            autoComplete="username"
            required
            placeholder="admin@pupatao.com"
            className="rounded-lg px-3 py-2.5 text-sm font-semibold outline-none"
            style={{ background: '#fff5f6', color: '#c8102e', border: '1.5px solid #f2ccd2' }}
          />

          <label className="text-xs font-semibold" style={{ color: '#6b4a4f' }}>{t('admin.login.passwordLabel')}</label>
          <input
            name="password"
            type="password"
            autoComplete="current-password"
            required
            className="rounded-lg px-3 py-2.5 text-sm font-semibold outline-none"
            style={{ background: '#fff5f6', color: '#c8102e', border: '1.5px solid #f2ccd2' }}
          />

          {data?.error && (
            <div
              className="rounded-lg px-3 py-2 text-xs font-semibold"
              style={{ background: 'rgba(220,38,38,0.2)', color: '#dc2626', border: '1px solid #f87171' }}
            >
              {t(data.error)}
            </div>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="mt-2 flex items-center justify-center gap-2 rounded-xl py-3 text-sm font-bold  disabled:opacity-50"
            style={{
              background: 'linear-gradient(135deg, #c8102e, #a50d26)',
              color: '#fff',
              border: '1.5px solid #e8949e',
            }}
          >
            {submitting ? <Loader size={16} className="animate-spin" /> : <LogIn size={16} />}
            {submitting ? t('admin.login.signingIn') : t('admin.login.signIn')}
          </button>
        </Form>
      </div>
    </div>
  )
}
