// Cloudflare Pages Function: passthrough proxy to Oura Cloud API v2.
// Browser-direct calls to api.ouraring.com fail CORS, so we forward
// from our own origin. The user's personal access token rides in the
// Authorization header; this proxy never persists it.

const ALLOWED_PATHS = [
  'usercollection/personal_info',
  'usercollection/daily_sleep',
  'usercollection/daily_readiness',
  'usercollection/daily_activity',
  'usercollection/sleep',
  'usercollection/workout',
  'usercollection/heartrate',
  'usercollection/session',
  'usercollection/tag',
]

function pathAllowed(path: string): boolean {
  return ALLOWED_PATHS.some((p) => path === p || path.startsWith(p + '/'))
}

interface PagesContext {
  request: Request
  params: { path?: string | string[] }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

export const onRequest = async (ctx: PagesContext): Promise<Response> => {
  const url = new URL(ctx.request.url)
  const raw = ctx.params.path
  const path = Array.isArray(raw) ? raw.join('/') : (raw ?? '')

  if (!pathAllowed(path)) {
    return json(403, { error: 'path not allowed' })
  }

  const auth = ctx.request.headers.get('Authorization')
  if (!auth) {
    return json(401, { error: 'missing Authorization header' })
  }

  const upstream = await fetch(
    `https://api.ouraring.com/v2/${path}${url.search}`,
    {
      method: ctx.request.method,
      headers: { Authorization: auth, Accept: 'application/json' },
    },
  )

  // Per-user data — `private` so shared caches don't cross-contaminate.
  // 5 min fresh + 10 min stale is plenty for daily metrics that change once a day.
  const cacheControl = upstream.ok
    ? 'private, max-age=300, stale-while-revalidate=600'
    : 'no-store'

  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      'content-type':
        upstream.headers.get('content-type') ?? 'application/json',
      'cache-control': cacheControl,
      vary: 'authorization',
    },
  })
}
