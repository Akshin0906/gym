// Oura Cloud API client. Auth uses OAuth2 implicit flow (response_type=token):
// the user registers an OAuth app at cloud.ouraring.com, pastes the Client ID
// once, then approves via a browser redirect. Tokens live ~30 days in
// localStorage; user re-auths when expired.

const TOKEN_KEY = 'workout-tracker:ouraToken'
const TOKEN_EXPIRES_KEY = 'workout-tracker:ouraTokenExpiresAt'
const CLIENT_ID_KEY = 'workout-tracker:ouraClientId'
const STATE_KEY = 'workout-tracker:ouraOAuthState'

const OAUTH_SCOPES = ['daily', 'personal', 'workout', 'heartrate']

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function safeSet(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch {
    // ignored
  }
}

export function getOuraClientId(): string | null {
  return safeGet(CLIENT_ID_KEY)
}

export function setOuraClientId(id: string | null): void {
  safeSet(CLIENT_ID_KEY, id?.trim() || null)
}

export function getOuraToken(): string | null {
  return safeGet(TOKEN_KEY)
}

export function getOuraTokenExpiresAt(): number | null {
  const raw = safeGet(TOKEN_EXPIRES_KEY)
  if (!raw) return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

export function isOuraTokenExpired(): boolean {
  const at = getOuraTokenExpiresAt()
  if (at === null) return false
  return Date.now() >= at
}

export function clearOuraToken(): void {
  safeSet(TOKEN_KEY, null)
  safeSet(TOKEN_EXPIRES_KEY, null)
}

function setOuraToken(token: string, expiresAtMs: number | null): void {
  safeSet(TOKEN_KEY, token)
  safeSet(TOKEN_EXPIRES_KEY, expiresAtMs === null ? null : String(expiresAtMs))
}

export function ouraRedirectUri(): string {
  return `${window.location.origin}/settings`
}

function randomState(): string {
  const arr = new Uint8Array(16)
  crypto.getRandomValues(arr)
  return btoa(String.fromCharCode(...arr))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

export function beginOuraAuth(clientId: string): void {
  const state = randomState()
  safeSet(STATE_KEY, state)
  const params = new URLSearchParams({
    response_type: 'token',
    client_id: clientId,
    redirect_uri: ouraRedirectUri(),
    scope: OAUTH_SCOPES.join(' '),
    state,
  })
  window.location.href = `https://cloud.ouraring.com/oauth/authorize?${params.toString()}`
}

export interface ConsumedAuth {
  ok: boolean
  error?: string
}

// Called on Settings screen mount. If the URL hash contains an OAuth response
// from Oura, validate it, persist the token, and clean the URL. Returns null
// if no auth response is present.
export function consumeOuraAuthRedirect(): ConsumedAuth | null {
  const hash = window.location.hash
  if (!hash || hash.length < 2) return null

  const params = new URLSearchParams(hash.slice(1))
  const accessToken = params.get('access_token')
  const error = params.get('error')
  if (!accessToken && !error) return null

  const stateReturned = params.get('state')
  const expectedState = safeGet(STATE_KEY)
  safeSet(STATE_KEY, null)

  // Clean the hash from the URL regardless of outcome.
  history.replaceState(
    null,
    '',
    window.location.pathname + window.location.search,
  )

  if (!stateReturned || stateReturned !== expectedState) {
    return { ok: false, error: 'OAuth state mismatch — request ignored' }
  }

  if (error) {
    return { ok: false, error: `Oura: ${error}` }
  }

  if (!accessToken) {
    return { ok: false, error: 'No access token returned' }
  }

  const expiresIn = Number(params.get('expires_in')) || 0
  const expiresAt = expiresIn > 0 ? Date.now() + expiresIn * 1000 : null
  setOuraToken(accessToken, expiresAt)
  return { ok: true }
}

export interface OuraPersonalInfo {
  id: string
  age?: number | null
  weight?: number | null
  height?: number | null
  biological_sex?: string | null
  email?: string | null
}

export interface OuraDailySleep {
  id: string
  day: string
  score: number | null
  timestamp: string
  contributors: Record<string, number | null>
}

export interface OuraDailyReadiness {
  id: string
  day: string
  score: number | null
  temperature_deviation: number | null
  timestamp: string
  contributors: Record<string, number | null>
}

export interface OuraDailyActivity {
  id: string
  day: string
  score: number | null
  active_calories: number | null
  total_calories: number | null
  steps: number | null
}

interface OuraPage<T> {
  data: T[]
  next_token: string | null
}

async function fetchOura<T>(path: string): Promise<T> {
  const token = getOuraToken()
  if (!token) throw new Error('Oura is not connected')
  if (isOuraTokenExpired()) throw new Error('Oura token expired — reconnect')
  const res = await fetch(`/api/oura/${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (res.status === 401) {
    clearOuraToken()
    throw new Error('Oura token rejected — reconnect')
  }
  if (!res.ok) {
    let detail = ''
    try {
      detail = (await res.text()).slice(0, 160)
    } catch {
      // ignored
    }
    throw new Error(
      `Oura request failed (${res.status})${detail ? `: ${detail}` : ''}`,
    )
  }
  return res.json() as Promise<T>
}

export function getPersonalInfo(): Promise<OuraPersonalInfo> {
  return fetchOura<OuraPersonalInfo>('usercollection/personal_info')
}

export async function getDailySleep(
  start: string,
  end: string,
): Promise<OuraDailySleep[]> {
  const r = await fetchOura<OuraPage<OuraDailySleep>>(
    `usercollection/daily_sleep?start_date=${start}&end_date=${end}`,
  )
  return r.data
}

export async function getDailyReadiness(
  start: string,
  end: string,
): Promise<OuraDailyReadiness[]> {
  const r = await fetchOura<OuraPage<OuraDailyReadiness>>(
    `usercollection/daily_readiness?start_date=${start}&end_date=${end}`,
  )
  return r.data
}

export async function getDailyActivity(
  start: string,
  end: string,
): Promise<OuraDailyActivity[]> {
  const r = await fetchOura<OuraPage<OuraDailyActivity>>(
    `usercollection/daily_activity?start_date=${start}&end_date=${end}`,
  )
  return r.data
}

export function ymd(d: Date): string {
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}
