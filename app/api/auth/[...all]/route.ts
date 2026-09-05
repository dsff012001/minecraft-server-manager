import { auth } from '@/lib/auth'
import { ensurePanelSchema } from '@/lib/db'
import { toNextJsHandler } from 'better-auth/next-js'

const handlers = toNextJsHandler(auth.handler)

export async function GET(request: Request) {
  await ensurePanelSchema()
  return handlers.GET(request)
}

export async function POST(request: Request) {
  await ensurePanelSchema()
  return handlers.POST(request)
}
