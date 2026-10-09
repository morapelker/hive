// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { testCodeServer, waitForSignInCode } from '../code-server-client'

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

function clock(): { now: () => number; sleep: (ms: number) => Promise<void>; slept: number[] } {
  let t = 1_000_000
  const slept: number[] = []
  return {
    now: () => t,
    sleep: async (ms) => {
      slept.push(ms)
      t += ms
    },
    slept
  }
}

describe('waitForSignInCode', () => {
  it('asks the server with the email, since and a timeout capped at the server limit', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, {
        status: 'code',
        code: ' 123456 ',
        receivedAt: '2026-10-09T10:00:05.000Z'
      })
    )
    const c = clock()

    const result = await waitForSignInCode({
      baseUrl: 'http://claudit-dashboard:3000/',
      apiToken: 's3cret',
      email: 'me+tag@example.com',
      sinceMs: 1_760_000_000_000,
      budgetMs: 200_000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: c.now,
      sleep: c.sleep
    })

    expect(result).toEqual({ kind: 'code', code: '123456', receivedAt: '2026-10-09T10:00:05.000Z' })
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    const parsed = new URL(url)
    expect(parsed.pathname).toBe('/api/codes/wait')
    expect(parsed.searchParams.get('email')).toBe('me+tag@example.com')
    expect(parsed.searchParams.get('since')).toBe('1760000000000')
    expect(parsed.searchParams.get('timeout')).toBe('120')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer s3cret')
  })

  it('keeps asking across 204s until the budget is spent, then reports a timeout', async () => {
    const c = clock()
    const fetchImpl = vi.fn(async () => {
      c.sleep(30_000) // the server held the request for its timeout
      return new Response(null, { status: 204 })
    })

    const result = await waitForSignInCode({
      baseUrl: 'http://host',
      email: 'a@b.com',
      sinceMs: 0,
      budgetMs: 90_000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: c.now,
      sleep: c.sleep
    })

    expect(result).toEqual({ kind: 'timeout' })
    expect(fetchImpl).toHaveBeenCalledTimes(3)
    const timeouts = fetchImpl.mock.calls.map((call) =>
      new URL((call as unknown as [string])[0]).searchParams.get('timeout')
    )
    expect(timeouts).toEqual(['90', '60', '30'])
  })

  it('retries after a network error and surfaces the server failure record', async () => {
    const c = clock()
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce(jsonResponse(200, { status: 'failed', reason: 'obscura timed out' }))

    const result = await waitForSignInCode({
      baseUrl: 'http://host',
      email: 'a@b.com',
      sinceMs: 0,
      budgetMs: 60_000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: c.now,
      sleep: c.sleep
    })

    expect(result).toEqual({ kind: 'failed', reason: 'obscura timed out' })
    expect(c.slept).toEqual([2000])
  })

  it('stops immediately on a rejected token or a bad request', async () => {
    const c = clock()
    const unauthorized = vi.fn(async () => new Response(null, { status: 401 }))
    await expect(
      waitForSignInCode({
        baseUrl: 'http://host',
        email: 'a@b.com',
        sinceMs: 0,
        budgetMs: 60_000,
        fetchImpl: unauthorized as unknown as typeof fetch,
        now: c.now,
        sleep: c.sleep
      })
    ).rejects.toThrow('rejected the API token')

    const bad = vi.fn(async () => new Response('{"error":"email is required"}', { status: 400 }))
    await expect(
      waitForSignInCode({
        baseUrl: 'http://host',
        email: 'a@b.com',
        sinceMs: 0,
        budgetMs: 60_000,
        fetchImpl: bad as unknown as typeof fetch,
        now: c.now,
        sleep: c.sleep
      })
    ).rejects.toThrow('rejected the request')
  })

  it('gives up with a clear error when the server stays unreachable', async () => {
    const c = clock()
    const fetchImpl = vi.fn(async () => {
      throw new Error('getaddrinfo ENOTFOUND claudit-dashboard')
    })

    await expect(
      waitForSignInCode({
        baseUrl: 'http://claudit-dashboard:3000',
        email: 'a@b.com',
        sinceMs: 0,
        budgetMs: 5_000,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        now: c.now,
        sleep: c.sleep
      })
    ).rejects.toThrow('Code server unreachable: getaddrinfo ENOTFOUND claudit-dashboard')
  })
})

describe('testCodeServer', () => {
  it('treats 204 as reachable and 401 as a token problem', async () => {
    const ok = vi.fn(async () => new Response(null, { status: 204 }))
    expect(
      await testCodeServer({ baseUrl: 'http://host/', fetchImpl: ok as unknown as typeof fetch })
    ).toEqual({ ok: true, message: 'Code server reachable' })
    const url = new URL((ok.mock.calls[0] as unknown as [string])[0])
    expect(url.searchParams.get('timeout')).toBe('0')
    expect(url.searchParams.get('email')).toBe('probe@example.com')

    const unauthorized = vi.fn(async () => new Response(null, { status: 401 }))
    expect(
      (
        await testCodeServer({
          baseUrl: 'http://host',
          fetchImpl: unauthorized as unknown as typeof fetch
        })
      ).ok
    ).toBe(false)

    const down = vi.fn(async () => {
      throw new Error('ECONNREFUSED')
    })
    expect(
      await testCodeServer({ baseUrl: 'http://host', fetchImpl: down as unknown as typeof fetch })
    ).toEqual({ ok: false, message: 'Could not reach the code server: ECONNREFUSED' })
  })
})
