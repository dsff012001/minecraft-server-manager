import { asc, count, eq } from 'drizzle-orm'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { ControlPanel } from '@/components/control-panel'
import { auth } from '@/lib/auth'
import { db, ensurePanelSchema } from '@/lib/db'
import { user } from '@/lib/db/schema'

export default async function Page() {
  await ensurePanelSchema()
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) redirect('/sign-in')

  let [record] = await db.select().from(user).where(eq(user.id, session.user.id)).limit(1)
  const [{ value: totalUsers }] = await db.select({ value: count() }).from(user)
  const [{ value: managers }] = await db.select({ value: count() }).from(user).where(eq(user.role, 'manager'))
  const [firstUser] = await db.select({ id: user.id }).from(user).orderBy(asc(user.createdAt)).limit(1)

  // İlk hesap sistem sahibi/yönetici olur. Eski kurulumlarda ilk admin hesabını
  // yeni Yönetici rolüne güvenli biçimde taşır.
  if (record && (totalUsers === 1 || managers === 0 && firstUser?.id === record.id) && (!record.approved || record.role !== 'manager')) {
    ;[record] = await db.update(user).set({ role: 'manager', approved: true, updatedAt: new Date() }).where(eq(user.id, record.id)).returning()
  }

  if (!record?.approved) redirect('/pending')
  return <ControlPanel />
}
