// Cloudflare Pages Function: passthrough proxy to Oura Cloud API v2.
// Browser-direct calls to api.ouraring.com fail CORS, so we forward
// from our own origin. The user's personal access token rides in the
// Authorization header; this proxy never persists it.

const ALLOWED_PATHS = new Set([
  'usercollection/personal_info',
  'usercollection/daily_sleep',
  'usercollection/daily_readiness',
  'usercollection/daily_activity',
])

function pathAllowed(path: string): boolean {
  return ALLOWED_PATHS.has(path)
}

function isCalendarDate(value: string | null): value is string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  )
}

function queryAllowed(path: string, url: URL): boolean {
  if (path === 'usercollection/personal_info') {
    return url.searchParams.size === 0
  }

  let keyCount = 0
  let hasUnexpectedKey = false
  url.searchParams.forEach((_value, key) => {
    keyCount += 1
    if (key !== 'start_date' && key !== 'end_date') {
      hasUnexpectedKey = true
    }
  })
  if (
    keyCount !== 2 ||
    hasUnexpectedKey ||
    url.searchParams.getAll('start_date').length !== 1 ||
    url.searchParams.getAll('end_date').length !== 1
  ) {
    return false
  }

  const start = url.searchParams.get('start_date')
  const end = url.searchParams.get('end_date')
  return isCalendarDate(start) && isCalendarDate(end) && start <= end
}

interface PagesContext {
  request: Request
  params: { path?: string | string[] }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  })
}

export const onRequest = async (ctx: PagesContext): Promise<Response> => {
  const url = new URL(ctx.request.url)
  const raw = ctx.params.path
  const path = Array.isArray(raw) ? raw.join('/') : (raw ?? '')

  if (!pathAllowed(path)) {
    return json(403, { error: 'path_not_allowed' })
  }

  if (ctx.request.method.toUpperCase() !== 'GET') {
    const response = json(405, { error: 'method_not_allowed' })
    response.headers.set('allow', 'GET')
    return response
  }

  if (!queryAllowed(path, url)) {
    return json(400, { error: 'invalid_query' })
  }

  const auth = ctx.request.headers.get('Authorization')
  if (!auth || auth.length > 4096 || !/^Bearer [^\s]+$/.test(auth)) {
    return json(401, { error: 'invalid_authorization' })
  }

  let upstream: Response
  try {
    upstream = await fetch(
      `https://api.ouraring.com/v2/${path}${url.search}`,
      {
        method: 'GET',
        headers: { Authorization: auth, Accept: 'application/json' },
        redirect: 'error',
      },
    )
  } catch (error) {
    console.error('oura proxy failure', error)
    return json(502, { error: 'upstream_unavailable' })
  }

  // Per-user data — `private` so shared caches don't cross-contaminate.
  // 5 min fresh + 10 min stale is plenty for daily metrics that change once a day.
  const cacheControl = upstream.ok
    ? 'private, max-age=300, stale-while-revalidate=600'
    : 'no-store'

  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      'content-type':
        upstream.headers.get('content-type')?.startsWith('application/json')
          ? (upstream.headers.get('content-type') as string)
          : 'application/json',
      'cache-control': cacheControl,
      vary: 'authorization',
      'x-content-type-options': 'nosniff',
    },
  })
}
