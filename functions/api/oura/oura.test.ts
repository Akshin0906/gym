import { afterEach, describe, expect, it, vi } from 'vitest'

import { onRequest } from './[[path]]'

function request(
  path: string,
  options: RequestInit = {},
  search = '',
): Promise<Response> {
  return onRequest({
    request: new Request(`https://gym.test/api/oura/${path}${search}`, options),
    params: { path },
  })
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('Oura proxy allowlist', () => {
  it('allows only exact endpoints and GET requests', async () => {
    const nested = await request('usercollection/daily_sleep/private')
    expect(nested.status).toBe(403)
    expect(await nested.json()).toEqual({ error: 'path_not_allowed' })

    const post = await request('usercollection/personal_info', {
      method: 'POST',
    })
    expect(post.status).toBe(405)
    expect(post.headers.get('allow')).toBe('GET')
  })

  it('rejects unexpected, duplicate, reversed, or invalid query parameters', async () => {
    const cases = [
      '?start_date=2026-08-01&end_date=2026-08-05&extra=true',
      '?start_date=2026-08-01&start_date=2026-08-02&end_date=2026-08-05',
      '?start_date=2026-08-05&end_date=2026-08-01',
      '?start_date=2026-02-30&end_date=2026-03-01',
    ]

    for (const search of cases) {
      const response = await request(
        'usercollection/daily_sleep',
        {},
        search,
      )
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({ error: 'invalid_query' })
    }
  })

  it('forwards a bounded, authenticated request to the fixed upstream origin', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const response = await request(
      'usercollection/daily_readiness',
      { headers: { Authorization: 'Bearer test-token' } },
      '?start_date=2026-08-01&end_date=2026-08-05',
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toContain('private')
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.ouraring.com/v2/usercollection/daily_readiness?start_date=2026-08-01&end_date=2026-08-05',
      {
        method: 'GET',
        headers: {
          Authorization: 'Bearer test-token',
          Accept: 'application/json',
        },
        redirect: 'error',
      },
    )
  })

  it('returns a generic gateway error when Oura is unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('private detail')))
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    const response = await request('usercollection/personal_info', {
      headers: { Authorization: 'Bearer test-token' },
    })

    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({ error: 'upstream_unavailable' })
    expect(consoleError).toHaveBeenCalled()
  })
})
