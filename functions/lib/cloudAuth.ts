export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement
  first<T = unknown>(): Promise<T | null>
  all<T = unknown>(): Promise<{ results?: T[] }>
  run(): Promise<D1Result>
}

export interface D1Result<T = unknown> {
  results?: T[]
  success?: boolean
  error?: string
  meta?: { changes?: number; last_row_id?: number }
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>
}

export interface CloudAuthEnv {
  CLOUD_AUTOMATION_SECRET?: string
  WORKOUT_DB: D1Database
}

export interface CloudAuthSessionRow {
  id: string
  token_hash: string
  device_name: string
  created_at: number
  last_seen_at: number
  expires_at: number
  revoked_at: number | null
  user_agent: string | null
}

export const CLOUD_SESSION_COOKIE = 'gym_cloud_session'
export const SESSION_MAX_AGE_SECONDS = 31536000
export const SESSION_MAX_AGE_MS = 31536000000
const SESSION_TOUCH_INTERVAL_MS = 300000

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
    },
  })
}

export function safeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder()
  const aBytes = enc.encode(a)
  const bBytes = enc.encode(b)
  if (aBytes.length !== bBytes.length) return false
  let diff = 0
  for (let i = 0; i < aBytes.length; i++) diff |= aBytes[i] ^ bBytes[i]
  return diff === 0
}

export async function sha256Hex(value: string): Promise<string> {
  const enc = new TextEncoder()
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(value))
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

function getCookie(request: Request, name: string): string | null {
  const cookie = request.headers.get('cookie')
  if (!cookie) return null
  const parts = cookie.split(';')
  for (const part of parts) {
    const [rawName, ...rawValue] = part.trim().split('=')
    if (rawName === name) return rawValue.join('=')
  }
  return null
}

export function sessionCookie(
  request: Request,
  token: string,
  maxAge: number,
): string {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : ''
  return `${CLOUD_SESSION_COOKIE}=${token}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure}`
}

export function clearSessionCookie(request: Request): string {
  return sessionCookie(request, '', 0)
}

export function randomToken(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export async function readCloudSession(
  request: Request,
  env: CloudAuthEnv,
): Promise<CloudAuthSessionRow | null> {
  const token = getCookie(request, CLOUD_SESSION_COOKIE)
  if (!token) return null
  const tokenHash = await sha256Hex(token)
  const now = Date.now()
  const row = await env.WORKOUT_DB.prepare(
    `SELECT id, token_hash, device_name, created_at, last_seen_at, expires_at,
            revoked_at, user_agent
     FROM cloud_auth_sessions
     WHERE token_hash = ?
       AND revoked_at IS NULL
       AND expires_at > ?`,
  )
    .bind(tokenHash, now)
    .first<CloudAuthSessionRow>()
  if (!row) return null
  // Chat polls frequently; avoid turning every authenticated read into a D1
  // write while still keeping device activity reasonably current.
  if (now - row.last_seen_at >= SESSION_TOUCH_INTERVAL_MS) {
    await env.WORKOUT_DB.prepare(
      `UPDATE cloud_auth_sessions
       SET last_seen_at = ?
       WHERE id = ?`,
    )
      .bind(now, row.id)
      .run()
  }
  return { ...row, last_seen_at: now }
}

export function hasAutomationAuth(
  request: Request,
  env: CloudAuthEnv,
): boolean {
  const provided = request.headers.get('X-Cloud-Automation-Secret')?.trim()
  const expected = env.CLOUD_AUTOMATION_SECRET?.trim()
  if (!provided || !expected) return false
  return safeEqual(provided, expected)
}

export async function requireDeviceSession(
  request: Request,
  env: CloudAuthEnv,
): Promise<Response | null> {
  if (!env.WORKOUT_DB) {
    return json(500, { error: 'internal_error' })
  }
  const session = await readCloudSession(request, env)
  if (session) return null
  return json(401, { error: 'unauthorized' })
}

export function requireAutomationSecret(
  request: Request,
  env: CloudAuthEnv,
): Response | null {
  if (!env.WORKOUT_DB) {
    return json(500, { error: 'internal_error' })
  }
  if (!env.CLOUD_AUTOMATION_SECRET?.trim()) {
    return json(500, { error: 'internal_error' })
  }
  if (hasAutomationAuth(request, env)) return null
  return json(401, { error: 'unauthorized' })
}

export async function requireCloudAuth(
  request: Request,
  env: CloudAuthEnv,
): Promise<Response | null> {
  if (!env.WORKOUT_DB) {
    return json(500, { error: 'internal_error' })
  }
  if (hasAutomationAuth(request, env)) return null
  return requireDeviceSession(request, env)
}
