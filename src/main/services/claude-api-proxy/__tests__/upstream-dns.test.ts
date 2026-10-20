// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { createUpstreamDns, type UpstreamDnsOptions } from '../upstream-dns'

type Records = Array<{ address: string; ttl: number }>

function fakeResolver(v4: Records | Error, v6: Records | Error = new Error('ENODATA')) {
  return {
    resolve4: vi.fn(async () => {
      if (v4 instanceof Error) throw v4
      return v4
    }),
    resolve6: vi.fn(async () => {
      if (v6 instanceof Error) throw v6
      return v6
    })
  } as unknown as NonNullable<UpstreamDnsOptions['resolver']> & {
    resolve4: ReturnType<typeof vi.fn>
    resolve6: ReturnType<typeof vi.fn>
  }
}

const lookupAll = (dns: ReturnType<typeof createUpstreamDns>, host: string) =>
  new Promise<Array<{ address: string; family: number }>>((resolve, reject) => {
    dns.lookup(host, { all: true }, (error, addresses) => {
      if (error) reject(error)
      else resolve(addresses as Array<{ address: string; family: number }>)
    })
  })

const lookupOne = (dns: ReturnType<typeof createUpstreamDns>, host: string) =>
  new Promise<{ address: string; family: number }>((resolve, reject) => {
    dns.lookup(host, {}, (error, address, family) => {
      if (error) reject(error)
      else resolve({ address: address as string, family: family as number })
    })
  })

describe('createUpstreamDns', () => {
  it('resolves through c-ares, IPv4 first, and serves repeats from the cache', async () => {
    const resolver = fakeResolver([{ address: '160.79.104.10', ttl: 60 }], [
      { address: '2607:6bc0::10', ttl: 60 }
    ])
    let now = 1_000_000
    const dns = createUpstreamDns({ resolver, now: () => now })
    expect(await lookupAll(dns, 'api.anthropic.com')).toEqual([
      { address: '160.79.104.10', family: 4 },
      { address: '2607:6bc0::10', family: 6 }
    ])
    expect(await lookupOne(dns, 'api.anthropic.com')).toEqual({ address: '160.79.104.10', family: 4 })
    expect(resolver.resolve4).toHaveBeenCalledTimes(1)
    expect(dns.stats()).toMatchObject({ hits: 1, misses: 1, fallbacks: 0, cachedHosts: 1 })

    // Past the TTL the next lookup queries again.
    now += 61_000
    await lookupOne(dns, 'api.anthropic.com')
    expect(resolver.resolve4).toHaveBeenCalledTimes(2)
  })

  it('clamps the cache lifetime between the floor and the cap', async () => {
    const resolver = fakeResolver([{ address: '1.1.1.1', ttl: 1 }])
    let now = 0
    const dns = createUpstreamDns({ resolver, now: () => now, minTtlMs: 30_000, maxTtlMs: 300_000 })
    await lookupOne(dns, 'x.test')
    now += 20_000
    await lookupOne(dns, 'x.test')
    expect(resolver.resolve4).toHaveBeenCalledTimes(1) // a 1 s TTL is held for 30 s

    const longResolver = fakeResolver([{ address: '1.1.1.1', ttl: 86_400 }])
    const longDns = createUpstreamDns({ resolver: longResolver, now: () => now, maxTtlMs: 300_000 })
    await lookupOne(longDns, 'y.test')
    now += 301_000
    await lookupOne(longDns, 'y.test')
    expect(longResolver.resolve4).toHaveBeenCalledTimes(2) // a day-long TTL is capped at 5 min
  })

  it('falls back to getaddrinfo when c-ares cannot answer, and fails when both cannot', async () => {
    const resolver = fakeResolver(new Error('ECONNREFUSED'), new Error('ECONNREFUSED'))
    const fallback = vi.fn((_host: string, _opts: unknown, cb: (e: null, a: unknown) => void) =>
      cb(null, [{ address: '10.0.0.5', family: 4 }])
    )
    const dns = createUpstreamDns({
      resolver,
      fallbackLookup: fallback as unknown as UpstreamDnsOptions['fallbackLookup']
    })
    expect(await lookupOne(dns, 'gateway.corp')).toEqual({ address: '10.0.0.5', family: 4 })
    expect(dns.stats()).toMatchObject({ fallbacks: 1, resolveErrors: 1, fallbackErrors: 0 })

    const failing = vi.fn((_host: string, _opts: unknown, cb: (e: Error) => void) => {
      const error = new Error('getaddrinfo ENOTFOUND') as NodeJS.ErrnoException
      error.code = 'ENOTFOUND'
      cb(error)
    })
    const deadDns = createUpstreamDns({
      resolver,
      fallbackLookup: failing as unknown as UpstreamDnsOptions['fallbackLookup']
    })
    await expect(lookupOne(deadDns, 'nowhere.test')).rejects.toMatchObject({ code: 'ENOTFOUND' })
    expect(deadDns.stats()).toMatchObject({ fallbacks: 1, fallbackErrors: 1 })
  })

  it('gives the fallback a deadline so a stuck getaddrinfo cannot hang the lookup', async () => {
    const resolver = fakeResolver(new Error('ETIMEOUT'), new Error('ETIMEOUT'))
    const neverAnswers = vi.fn(() => {})
    const dns = createUpstreamDns({
      resolver,
      fallbackTimeoutMs: 20,
      fallbackLookup: neverAnswers as unknown as UpstreamDnsOptions['fallbackLookup']
    })
    const startedAt = Date.now()
    await expect(lookupOne(dns, 'stuck.test')).rejects.toMatchObject({ code: 'ETIMEOUT' })
    expect(Date.now() - startedAt).toBeLessThan(2_000)
  })

  it('answers IP literals without touching any resolver', async () => {
    const resolver = fakeResolver(new Error('must not be called'))
    const dns = createUpstreamDns({ resolver })
    expect(await lookupOne(dns, '127.0.0.1')).toEqual({ address: '127.0.0.1', family: 4 })
    expect(await lookupOne(dns, '::1')).toEqual({ address: '::1', family: 6 })
    expect(resolver.resolve4).not.toHaveBeenCalled()
  })

  it('coalesces concurrent misses into one query', async () => {
    const resolver = fakeResolver([{ address: '9.9.9.9', ttl: 60 }])
    const dns = createUpstreamDns({ resolver })
    await Promise.all([lookupOne(dns, 'a.test'), lookupOne(dns, 'a.test'), lookupOne(dns, 'a.test')])
    expect(resolver.resolve4).toHaveBeenCalledTimes(1)
  })
})
