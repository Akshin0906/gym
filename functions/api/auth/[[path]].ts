import {
  clearSessionCookie,
  randomToken,
  readCloudSession,
  safeEqual,
  sessionCookie,
  sha256Hex,
  SESSION_MAX_AGE_MS,
  SESSION_MAX_AGE_SECONDS,
  type CloudAuthEnv,
  type D1Database,
} from '../../lib/cloudAuth'

interface Env extends CloudAuthEnv {
  CLOUD_PAIRING_SECRET: string
  WORKOUT_DB: D1Database
  LLM_RATE?: KVNamespace
}

interface PagesContext {
  request: Request
  env: Env
  params: { path?: string | string[] }
}

interface KVNamespace {
  get(key: string): Promise<string | null>
  put(
    key: string,
    value: string,
    options?: { expirationTtl?: number },
  ): Promise<void>
}

const PAIR_ATTEMPT_LIMIT = 5
const PAIR_ATTEMPT_WINDOW_SECONDS = 900
const PAIR_ATTEMPT_TTL_SECONDS = 1800

function json(
  status: number,
  body: unknown,
  headers?: HeadersInit,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      ...headers,
    },
  })
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object'
}

function routePath(ctx: PagesContext): string {
  const raw = ctx.params.path
  return Array.isArray(raw) ? raw.join('/') : (raw ?? '')
}

function clientIp(request: Request): string {
  return (
    request.headers.get('cf-connecting-ip') ??
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    'unknown'
  )
}

async function isWithinPairAttemptLimit(
  kv: KVNamespace,
  request: Request,
): Promise<boolean> {
  const bucket = Math.floor(
    Date.now() / (PAIR_ATTEMPT_WINDOW_SECONDS * 1000),
  )
  const key = `cloud_pair:${clientIp(request)}:${bucket}`
  const raw = await kv.get(key)
  const count = raw ? Number(raw) : 0
  if (count >= PAIR_ATTEMPT_LIMIT) return false
  await kv.put(key, String(count + 1), {
    expirationTtl: PAIR_ATTEMPT_TTL_SECONDS,
  })
  return true
}

function sessionBody(session: {
  id: string
  device_name: string
  created_at: number
  last_seen_at: number
  expires_at: number
}): unknown {
  return {
    paired: true,
    device: {
      id: session.id,
      name: session.device_name,
      createdAt: session.created_at,
      lastSeenAt: session.last_seen_at,
      expiresAt: session.expires_at,
    },
  }
}

async function handleStatus(ctx: PagesContext): Promise<Response> {
  if (!ctx.env.WORKOUT_DB) {
    return json(500, { error: 'server_misconfigured: WORKOUT_DB unset' })
  }
  const session = await readCloudSession(ctx.request, ctx.env)
  if (!session) return json(200, { paired: false })
  return json(200, sessionBody(session))
}

async function handlePair(ctx: PagesContext): Promise<Response> {
  if (!ctx.env.WORKOUT_DB) {
    return json(500, { error: 'server_misconfigured: WORKOUT_DB unset' })
  }
  if (!ctx.env.CLOUD_PAIRING_SECRET) {
    return json(500, {
      error: 'server_misconfigured: CLOUD_PAIRING_SECRET unset',
    })
  }
  if (!ctx.env.LLM_RATE) {
    return json(500, {
      error: 'server_misconfigured: LLM_RATE unset',
    })
  }
  if (!(await isWithinPairAttemptLimit(ctx.env.LLM_RATE, ctx.request))) {
    return json(429, { error: 'rate_limited' })
  }

  let body: unknown
  try {
    body = await ctx.request.json()
  } catch {
    return json(400, { error: 'invalid_json' })
  }
  if (!isObject(body)) return json(400, { error: 'invalid_pairing_request' })

  const pairingSecret =
    typeof body.pairingSecret === 'string' ? body.pairingSecret : ''
  if (
    !pairingSecret ||
    !safeEqual(pairingSecret, ctx.env.CLOUD_PAIRING_SECRET)
  ) {
    return json(401, { error: 'unauthorized' })
  }

  const deviceName =
    typeof body.deviceName === 'string' && body.deviceName.trim()
      ? body.deviceName.trim().slice(0, 80)
      : 'Phone PWA'
  const userAgent = ctx.request.headers.get('user-agent')?.slice(0, 300) ?? null
  const token = randomToken()
  const tokenHash = await sha256Hex(token)
  const now = Date.now()
  const expiresAt = now + SESSION_MAX_AGE_MS
  const id = crypto.randomUUID()

  await ctx.env.WORKOUT_DB.prepare(
    `INSERT INTO cloud_auth_sessions
       (id, token_hash, device_name, created_at, last_seen_at, expires_at,
        revoked_at, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
  )
    .bind(id, tokenHash, deviceName, now, now, expiresAt, userAgent)
    .run()

  return json(
    201,
    sessionBody({
      id,
      device_name: deviceName,
      created_at: now,
      last_seen_at: now,
      expires_at: expiresAt,
    }),
    {
      'set-cookie': sessionCookie(ctx.request, token, SESSION_MAX_AGE_SECONDS),
    },
  )
}

async function handleLogout(ctx: PagesContext): Promise<Response> {
  if (ctx.env.WORKOUT_DB) {
    const session = await readCloudSession(ctx.request, ctx.env)
    if (session) {
      await ctx.env.WORKOUT_DB.prepare(
        `UPDATE cloud_auth_sessions
         SET revoked_at = ?
         WHERE id = ?`,
      )
        .bind(Date.now(), session.id)
        .run()
    }
  }
  return json(
    200,
    { paired: false },
    {
      'set-cookie': clearSessionCookie(ctx.request),
    },
  )
}

export const onRequest = async (ctx: PagesContext): Promise<Response> => {
  try {
    const path = routePath(ctx)
    const method = ctx.request.method.toUpperCase()

    if (path === 'cloud' && method === 'GET') return await handleStatus(ctx)
    if (path === 'cloud' && method === 'POST') return await handlePair(ctx)
    if (path === 'cloud' && method === 'DELETE') return await handleLogout(ctx)

    return json(404, { error: 'not_found' })
  } catch (err) {
    return json(500, {
      error: 'internal_error',
      detail: err instanceof Error ? err.message : String(err),
    })
  }
}
