// Linked-account detection (multi-account / self-referral abuse).
//
// Rule: two accounts that were REGISTERED from the same IP address cannot
// transfer money to each other (general or locked transfer, and claiming a
// locked transfer). Blocks the "account B deposits → moves money to account A"
// path used to farm promo/referral bonuses with a second account.
import { prisma } from '~/lib/prisma.server'

/** Client IP as seen behind Vercel's proxy — same source the Session rows use. */
export function getClientIp(request: Request): string | null {
  return (
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    request.headers.get('x-real-ip')?.trim() ||
    null
  )
}

/**
 * The IP a user registered from. Users created before `registerIp` existed
 * fall back to the IP of their earliest recorded session (their first login
 * after signing up), which is then saved so the lookup is a one-time cost.
 */
export async function getRegisterIp(userId: string): Promise<string | null> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { registerIp: true } })
  if (!user) return null
  if (user.registerIp) return user.registerIp

  const first = await prisma.session.findFirst({
    where: { userId, ip: { not: null } },
    orderBy: { createdAt: 'asc' },
    select: { ip: true },
  })
  const ip = first?.ip ?? null
  if (ip) {
    await prisma.user.update({ where: { id: userId }, data: { registerIp: ip } }).catch(() => { /* best effort */ })
  }
  return ip
}

/** True when both accounts were registered from the same (known) IP. */
export async function registeredFromSameIp(userIdA: string, userIdB: string): Promise<boolean> {
  const [a, b] = await Promise.all([getRegisterIp(userIdA), getRegisterIp(userIdB)])
  return !!a && !!b && a === b
}

export const SAME_IP_TRANSFER_ERROR =
  'ບໍ່ສາມາດໂອນເງິນລະຫວ່າງບັນຊີທີ່ລົງທະບຽນຈາກ IP ດຽວກັນໄດ້. ກະລຸນາຕິດຕໍ່ພະນັກງານ ຖ້າທ່ານຄິດວ່ານີ້ແມ່ນຄວາມຜິດພາດ.'
