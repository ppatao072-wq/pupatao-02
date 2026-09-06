import type { Route } from './+types/api.admin-tx-qr'
import { requireAdmin } from '~/lib/admin-auth.server'
import { prisma } from '~/lib/prisma.server'
import { uploadToBunny } from '~/lib/bunny.server'
import { notifyAdmin } from '~/lib/pusher.server'

const MAX_SIZE = 8 * 1024 * 1024 // 8 MB
const MIME_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'application/pdf': 'pdf',
}

// Admin-only. Uploads a QR (or payment slip) image and stamps it onto a WITHDRAW
// transaction's `slipUrl`, replacing whatever bank-QR snapshot was captured at
// request time. Used when the customer's snapshotted QR is missing or wrong and
// the admin needs to attach the correct one to pay them out.
export async function action({ request }: Route.ActionArgs) {
  const admin = await requireAdmin(request)
  if (admin.role === 'SUPPORT') {
    return Response.json({ error: 'Insufficient permissions.' }, { status: 403 })
  }

  let fd: FormData
  try {
    fd = await request.formData()
  } catch {
    return Response.json({ error: 'Invalid form data.' }, { status: 400 })
  }

  const txId = String(fd.get('txId') ?? '')
  const file = fd.get('file')
  if (!txId) return Response.json({ error: 'Missing txId.' }, { status: 400 })
  if (!(file instanceof File)) return Response.json({ error: 'No file uploaded.' }, { status: 400 })

  const ext = MIME_EXT[file.type]
  if (!ext) {
    return Response.json({ error: 'Unsupported file type. Use JPG, PNG, WebP, GIF, or PDF.' }, { status: 400 })
  }
  if (file.size > MAX_SIZE) {
    return Response.json({ error: `File too large. Maximum ${Math.round(MAX_SIZE / 1024 / 1024)}MB.` }, { status: 400 })
  }

  const tx = await prisma.transaction.findUnique({
    where: { id: txId },
    include: { user: { select: { id: true, tel: true } } },
  })
  if (!tx) return Response.json({ error: 'Transaction not found.' }, { status: 404 })
  if (tx.type !== 'WITHDRAW') {
    return Response.json({ error: 'QR upload is only available for withdraw transactions.' }, { status: 400 })
  }

  const telSlug = tx.user.tel.replace(/\D/g, '') || tx.userId
  const key = `u-${telSlug}/withdraw-qr/${Date.now()}.${ext}`

  let url: string
  try {
    const buf = await file.arrayBuffer()
    const res = await uploadToBunny({ body: buf, path: key, contentType: file.type })
    url = res.url
  } catch (err) {
    console.error('[api/admin-tx-qr] upload', err)
    const msg = err instanceof Error ? err.message : 'Upload failed.'
    return Response.json({ error: msg }, { status: 500 })
  }

  const updated = await prisma.$transaction(async (db) => {
    const u = await db.transaction.update({ where: { id: tx.id }, data: { slipUrl: url } })
    await db.auditLog.create({
      data: {
        actorId: admin.id,
        action: 'withdraw.qrUpload',
        target: `transaction:${tx.id}`,
        metadata: { slipUrl: url },
      },
    })
    return u
  })

  // Refresh any other admin's open list (the uploader's own view revalidates
  // client-side). The QR is admin-facing, so the customer isn't notified.
  notifyAdmin('transaction:resolved', { id: updated.id })

  return Response.json({ ok: true, url })
}

export function loader() {
  return new Response('Method Not Allowed', { status: 405 })
}
