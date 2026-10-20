/**
 * Name resolution for the proxy's upstream leg that never touches the libuv
 * thread pool.
 *
 * Node's default `dns.lookup` is a blocking `getaddrinfo` on one of the four
 * thread-pool threads. When those threads are wedged (a resolver that never
 * answers, a file read on a hung mount) every new upstream connection waits
 * behind them for as long as the wedge lasts — which is exactly how a whole
 * night of "No response from API" looked in the Electron main process. The
 * c-ares resolver (`dns.Resolver`) talks UDP/TCP on the event loop instead,
 * so a stall elsewhere in the process cannot delay it, and its answers are
 * cached here so a burst of sessions reconnecting pays for one query.
 *
 * `getaddrinfo` stays as the fallback (with a deadline): c-ares reads
 * /etc/resolv.conf, which a VPN or a captive network can leave pointing at a
 * resolver that only the system resolver knows how to reach.
 */
import dns from 'dns'
import type { LookupAddress } from 'dns'
import type { LookupFunction } from 'net'

export interface UpstreamDnsOptions {
  /** Cap on how long a positive answer is reused, regardless of the record TTL. Default 5 min. */
  maxTtlMs?: number
  /** Floor on how long a positive answer is reused when the record TTL is tiny. Default 30 s. */
  minTtlMs?: number
  /** How long one c-ares query may take before the fallback is tried. Default 4 s. */
  resolveTimeoutMs?: number
  /** How long the `getaddrinfo` fallback may take before the lookup fails. Default 6 s. */
  fallbackTimeoutMs?: number
  /** Injectable for tests. */
  resolver?: Pick<dns.promises.Resolver, 'resolve4' | 'resolve6'>
  fallbackLookup?: typeof dns.lookup
  now?: () => number
}

export interface UpstreamDnsStats {
  hits: number
  misses: number
  resolveErrors: number
  fallbacks: number
  fallbackErrors: number
  /** Milliseconds the last successful resolution took (cache misses only). */
  lastResolveMs: number
  cachedHosts: number
}

interface CacheEntry {
  addresses: LookupAddress[]
  expiresAt: number
}

interface ResolvedAnswer {
  addresses: LookupAddress[]
  ttlMs: number
}

export interface UpstreamDns {
  /** Drop-in `lookup` for `http.Agent` / `net.connect`. */
  lookup: LookupFunction
  /** Resolve a host now (bypassing the agent), e.g. to warm the cache or probe the resolver. */
  resolve: (hostname: string) => Promise<LookupAddress[]>
  stats: () => UpstreamDnsStats
  /** Forget every cached answer (after a network change). */
  clear: () => void
}

const DEFAULT_MAX_TTL_MS = 5 * 60_000
const DEFAULT_MIN_TTL_MS = 30_000
const DEFAULT_RESOLVE_TIMEOUT_MS = 4_000
const DEFAULT_FALLBACK_TIMEOUT_MS = 6_000

const IPV4_LITERAL = /^\d{1,3}(\.\d{1,3}){3}$/
const isIpLiteral = (hostname: string): number | null => {
  if (IPV4_LITERAL.test(hostname)) return 4
  if (hostname.includes(':')) return 6
  return null
}

function withDeadline<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      const error = new Error(`${label} timed out after ${ms} ms`) as NodeJS.ErrnoException
      error.code = 'ETIMEOUT'
      reject(error)
    }, ms)
    timer.unref?.()
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

export function createUpstreamDns(options: UpstreamDnsOptions = {}): UpstreamDns {
  const maxTtlMs = options.maxTtlMs ?? DEFAULT_MAX_TTL_MS
  const minTtlMs = options.minTtlMs ?? DEFAULT_MIN_TTL_MS
  const resolveTimeoutMs = options.resolveTimeoutMs ?? DEFAULT_RESOLVE_TIMEOUT_MS
  const fallbackTimeoutMs = options.fallbackTimeoutMs ?? DEFAULT_FALLBACK_TIMEOUT_MS
  const resolver = options.resolver ?? new dns.promises.Resolver()
  const fallbackLookup = options.fallbackLookup ?? dns.lookup
  const now = options.now ?? Date.now

  const cache = new Map<string, CacheEntry>()
  const inFlight = new Map<string, Promise<LookupAddress[]>>()
  const stats: UpstreamDnsStats = {
    hits: 0,
    misses: 0,
    resolveErrors: 0,
    fallbacks: 0,
    fallbackErrors: 0,
    lastResolveMs: 0,
    cachedHosts: 0
  }

  const resolveFamily = async (hostname: string, family: 4 | 6): Promise<ResolvedAnswer> => {
    const records =
      family === 4
        ? await resolver.resolve4(hostname, { ttl: true })
        : await resolver.resolve6(hostname, { ttl: true })
    const addresses = records.map((record) => ({ address: record.address, family }))
    const ttlSeconds = records.reduce(
      (min, record) => Math.min(min, record.ttl),
      Number.POSITIVE_INFINITY
    )
    const ttlMs = Number.isFinite(ttlSeconds) ? ttlSeconds * 1000 : minTtlMs
    return { addresses, ttlMs }
  }

  /** IPv4 first (what the API's anycast edge serves best), IPv6 appended when it exists. */
  const resolveViaCares = async (hostname: string): Promise<ResolvedAnswer> => {
    const [v4, v6] = await Promise.allSettled([
      withDeadline(resolveFamily(hostname, 4), resolveTimeoutMs, 'resolve4'),
      withDeadline(resolveFamily(hostname, 6), resolveTimeoutMs, 'resolve6')
    ])
    const addresses: LookupAddress[] = []
    let ttlMs = Number.POSITIVE_INFINITY
    for (const settled of [v4, v6]) {
      if (settled.status !== 'fulfilled') continue
      addresses.push(...settled.value.addresses)
      ttlMs = Math.min(ttlMs, settled.value.ttlMs)
    }
    if (addresses.length === 0) {
      const reason = v4.status === 'rejected' ? v4.reason : v6.status === 'rejected' ? v6.reason : null
      throw reason instanceof Error ? reason : new Error(`no addresses for ${hostname}`)
    }
    return { addresses, ttlMs: Number.isFinite(ttlMs) ? ttlMs : minTtlMs }
  }

  const resolveViaFallback = (hostname: string): Promise<LookupAddress[]> =>
    withDeadline(
      new Promise<LookupAddress[]>((resolve, reject) => {
        fallbackLookup(hostname, { all: true, verbatim: false }, (error, addresses) => {
          if (error) reject(error)
          else resolve(addresses as LookupAddress[])
        })
      }),
      fallbackTimeoutMs,
      'getaddrinfo'
    )

  const resolveUncached = async (hostname: string): Promise<LookupAddress[]> => {
    const startedAt = now()
    let answer: ResolvedAnswer
    try {
      answer = await resolveViaCares(hostname)
    } catch (caresError) {
      stats.resolveErrors += 1
      stats.fallbacks += 1
      try {
        const addresses = await resolveViaFallback(hostname)
        answer = { addresses, ttlMs: minTtlMs }
      } catch (fallbackError) {
        stats.fallbackErrors += 1
        const error = (
          fallbackError instanceof Error ? fallbackError : new Error(String(fallbackError))
        ) as NodeJS.ErrnoException
        error.message = `${error.message} (c-ares: ${
          caresError instanceof Error ? caresError.message : String(caresError)
        })`
        throw error
      }
    }
    stats.lastResolveMs = now() - startedAt
    const ttlMs = Math.min(maxTtlMs, Math.max(minTtlMs, answer.ttlMs))
    cache.set(hostname, { addresses: answer.addresses, expiresAt: now() + ttlMs })
    stats.cachedHosts = cache.size
    return answer.addresses
  }

  const resolve = async (hostname: string): Promise<LookupAddress[]> => {
    const literal = isIpLiteral(hostname)
    if (literal !== null) return [{ address: hostname, family: literal }]
    const cached = cache.get(hostname)
    if (cached && cached.expiresAt > now()) {
      stats.hits += 1
      return cached.addresses
    }
    stats.misses += 1
    const pending = inFlight.get(hostname)
    if (pending) return pending
    const promise = resolveUncached(hostname).finally(() => inFlight.delete(hostname))
    inFlight.set(hostname, promise)
    return promise
  }

  const lookup: LookupFunction = (hostname, lookupOptions, callback) => {
    const wantsAll = typeof lookupOptions === 'object' && lookupOptions !== null && lookupOptions.all === true
    const family =
      typeof lookupOptions === 'object' && lookupOptions !== null ? lookupOptions.family : undefined
    resolve(hostname).then(
      (addresses) => {
        const filtered =
          family === 4 || family === 6 || family === 'IPv4' || family === 'IPv6'
            ? addresses.filter((entry) =>
                family === 4 || family === 'IPv4' ? entry.family === 4 : entry.family === 6
              )
            : addresses
        const usable = filtered.length > 0 ? filtered : addresses
        if (wantsAll) {
          ;(callback as (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void)(
            null,
            usable
          )
        } else {
          callback(null, usable[0].address, usable[0].family)
        }
      },
      (error: NodeJS.ErrnoException) => {
        if (!error.code) error.code = 'ENOTFOUND'
        callback(error, '', 0)
      }
    )
  }

  return {
    lookup,
    resolve,
    stats: () => ({ ...stats, cachedHosts: cache.size }),
    clear: () => {
      cache.clear()
      stats.cachedHosts = 0
    }
  }
}
