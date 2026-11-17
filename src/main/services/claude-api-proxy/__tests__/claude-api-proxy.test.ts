// @vitest-environment node
import http from 'http'
import type { AddressInfo } from 'net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const dbMocks = vi.hoisted(() => ({
  settings: null as string | null,
  rows: new Map<string, Record<string, unknown>>(),
  // What getSavedUsageAccountOrganizations returns; an Error makes it throw.
  organizations: [] as Array<{ id: string; email: string; org_uuid: string | null }> | Error,
  // Every setSavedUsageAccountOrgUuid call, in order.
  organizationWrites: [] as Array<{ id: string; orgUuid: string | null }>
}))

const storeMocks = vi.hoisted(() => ({
  listClaudeAccountTokenFingerprints: vi.fn(
    async () => [] as Array<{ email: string; uuid: string; tokenFingerprint: string | null }>
  ),
  readClaudeLiveTokenFingerprint: vi.fn(async () => null as string | null),
  isClaudeAccountManaged: vi.fn(async () => true),
  readClaudeLiveIdentityCached: vi.fn(async () => ({
    email: null as string | null,
    uuid: null as string | null
  })),
  readClaudeLiveRawBlob: vi.fn(async () => null as string | null),
  addClaudeAccount: vi.fn(async () => '1'),
  rememberClaudeAccountUuid: vi.fn(async () => false),
  repairStaleClaudeLiveIdentityUuid: vi.fn(async () => false)
}))

const publisherMocks = vi.hoisted(() => ({
  publishDesktopBackendEvent: vi.fn(async () => true)
}))

vi.mock('../../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}))

vi.mock('../../../db', () => ({
  getDatabase: () => ({
    getSetting: () => dbMocks.settings,
    getSavedUsageAccountByProviderEmail: (_provider: string, email: string) =>
      dbMocks.rows.get(email) ?? null,
    getSavedUsageAccountOrganizations: () => {
      if (dbMocks.organizations instanceof Error) throw dbMocks.organizations
      return dbMocks.organizations
    },
    upsertSavedUsageAccount: (data: Record<string, unknown>) => {
      const email = data.email as string
      const row = {
        id: `row-${email}`,
        provider: 'anthropic',
        email,
        credentials_json: '',
        last_usage_json: data.last_usage_json ?? null,
        last_fetched_at: data.last_usage_json ? 'polled' : null,
        status: 'ok',
        last_error: null,
        created_at: 'c',
        updated_at: 'u'
      }
      dbMocks.rows.set(email, row)
      return row
    },
    updateSavedUsageAccountLiveUsage: (id: string, lastUsageJson: string) => {
      for (const row of dbMocks.rows.values()) {
        if (row.id === id) {
          row.last_usage_json = lastUsageJson
          return row
        }
      }
      return null
    },
    // One column of one table: a write shows on the row and in the organizations read.
    setSavedUsageAccountOrgUuid: (id: string, orgUuid: string | null) => {
      dbMocks.organizationWrites.push({ id, orgUuid })
      for (const row of dbMocks.rows.values()) {
        if (row.id !== id) continue
        row.org_uuid = orgUuid
        if (!(dbMocks.organizations instanceof Error)) {
          dbMocks.organizations = [
            ...dbMocks.organizations.filter((entry) => entry.id !== id),
            { id, email: row.email as string, org_uuid: orgUuid }
          ]
        }
        return row
      }
      return null
    }
  })
}))

vi.mock('../../account-store-claude', () => storeMocks)

vi.mock('../../../desktop/backend-event-publisher', () => publisherMocks)

import {
  buildUpstreamCaCertificates,
  claudeApiProxySkipReason,
  closeClaudeApiProxy,
  DEFAULT_CLAUDE_API_UPSTREAM,
  parseClaudeApiProxyPort,
  parseClaudeCertStores,
  resolveClaudeApiUpstream,
  splitPemCertificates,
  startClaudeApiProxy,
  __resetClaudeApiProxyCachesForTests
} from '../claude-api-proxy'
import { getClaudeApiProxyEnv, getClaudeApiProxyUserBaseUrl } from '../claude-api-proxy-env'
import {
  __resetClaudeUsageLiveUpdaterForTests,
  submitClaudeUsageObservation
} from '../claude-usage-live'
import { parseUnifiedRateLimitHeaders } from '../anthropic-rate-limit-headers'
import { fingerprintSecret } from '../../credential-fingerprint'

const ENV_KEYS = ['ANTHROPIC_BASE_URL', '_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL']
const saved: Record<string, string | undefined> = {}

const PEM_A = '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----'
const PEM_B = '-----BEGIN CERTIFICATE-----\nBBBB\n-----END CERTIFICATE-----'

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key]
    delete process.env[key]
  }
  dbMocks.settings = null
  dbMocks.rows.clear()
  dbMocks.organizations = []
  dbMocks.organizationWrites = []
  __resetClaudeApiProxyCachesForTests()
})

afterEach(async () => {
  await closeClaudeApiProxy()
  // The updater outlives the proxy; each test starts with one that remembers nothing.
  __resetClaudeUsageLiveUpdaterForTests()
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
  vi.clearAllMocks()
})

describe('claudeApiProxySkipReason', () => {
  it('skips in environments where a loopback http hop would break the CLI', () => {
    expect(claudeApiProxySkipReason({})).toBeNull()
    expect(claudeApiProxySkipReason({ HTTPS_PROXY: 'http://corp:3128' })).toBe('http-proxy-env')
    expect(claudeApiProxySkipReason({ http_proxy: 'http://corp:3128' })).toBe('http-proxy-env')
    expect(claudeApiProxySkipReason({ ALL_PROXY: 'socks5://corp:1080' })).toBe('http-proxy-env')
    expect(claudeApiProxySkipReason({ CLAUDE_CODE_CLIENT_CERT: '/certs/me.pem' })).toBe(
      'client-cert'
    )
    expect(claudeApiProxySkipReason({ ANTHROPIC_UNIX_SOCKET: '/tmp/a.sock' })).toBe('unix-socket')
    expect(claudeApiProxySkipReason({ CLAUDE_CODE_USE_BEDROCK: '1' })).toBe('third-party-provider')
    expect(claudeApiProxySkipReason({ CLAUDE_CODE_USE_VERTEX: 'true' })).toBe(
      'third-party-provider'
    )
    expect(claudeApiProxySkipReason({ CLAUDE_CODE_USE_FOUNDRY: 'yes' })).toBe(
      'third-party-provider'
    )
    expect(claudeApiProxySkipReason({ CLAUDE_CODE_USE_ANTHROPIC_AWS: '1' })).toBe(
      'third-party-provider'
    )
    expect(claudeApiProxySkipReason({ CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD: '1' })).toBe(
      'third-party-provider'
    )
    expect(claudeApiProxySkipReason({ CLAUDE_CODE_USE_BEDROCK: '0' })).toBeNull()
    expect(claudeApiProxySkipReason({ CLAUDE_CODE_USE_BEDROCK: 'false' })).toBeNull()
    expect(claudeApiProxySkipReason({ HIVE_DISABLE_CLAUDE_API_PROXY: '1' })).toBe('disabled')
  })
})

describe('parseClaudeApiProxyPort', () => {
  it('accepts 0 and valid ports, falls back to the default otherwise', () => {
    expect(parseClaudeApiProxyPort(undefined)).toBe(42411)
    expect(parseClaudeApiProxyPort('')).toBe(42411)
    expect(parseClaudeApiProxyPort('0')).toBe(0)
    expect(parseClaudeApiProxyPort('5555')).toBe(5555)
    expect(parseClaudeApiProxyPort('70000')).toBe(42411)
    expect(parseClaudeApiProxyPort('abc')).toBe(42411)
  })
})

describe('upstream trust roots', () => {
  it('splits PEM bundles into certificate blocks', () => {
    expect(splitPemCertificates(`junk\n${PEM_A}\n\n${PEM_B}\ntrailing`)).toEqual([
      `${PEM_A}\n`,
      `${PEM_B}\n`
    ])
    expect(splitPemCertificates('')).toEqual([])
  })

  it('parses CLAUDE_CODE_CERT_STORE like the CLI (default bundled,system)', () => {
    expect(parseClaudeCertStores(undefined)).toEqual(['bundled', 'system'])
    expect(parseClaudeCertStores('bundled')).toEqual(['bundled'])
    expect(parseClaudeCertStores(' system , bundled ')).toEqual(['system', 'bundled'])
    expect(parseClaudeCertStores('nonsense')).toEqual(['bundled', 'system'])
  })

  it('combines the bundled and system stores with NODE_EXTRA_CA_CERTS / SSL_CERT_FILE', () => {
    const readCa = vi.fn((type: string) =>
      type === 'bundled' ? ['bundled-1', 'bundled-2'] : type === 'system' ? ['system-1'] : []
    )
    const readFile = vi.fn((path: string) => {
      if (path === '/corp/ca.pem') return `${PEM_A}\n${PEM_B}`
      throw new Error('ENOENT')
    })
    const trust = buildUpstreamCaCertificates(
      { NODE_EXTRA_CA_CERTS: '/corp/ca.pem', SSL_CERT_FILE: '/missing.pem' },
      readCa,
      readFile
    )
    expect(trust.ca).toEqual(['bundled-1', 'bundled-2', 'system-1', `${PEM_A}\n`, `${PEM_B}\n`])
    expect(trust.sources).toEqual(['bundled:2', 'system:1', 'NODE_EXTRA_CA_CERTS:2'])

    const bundledOnly = buildUpstreamCaCertificates({ CLAUDE_CODE_CERT_STORE: 'bundled' }, readCa)
    expect(bundledOnly.ca).toEqual(['bundled-1', 'bundled-2'])
  })

  it('reads real trust roots from this runtime', () => {
    const trust = buildUpstreamCaCertificates({})
    expect(trust.ca.length).toBeGreaterThan(0)
    expect(trust.ca[0]).toContain('-----BEGIN CERTIFICATE-----')
  })
})

describe('resolveClaudeApiUpstream', () => {
  it('prefers the Settings env var, then the original shell value, then the public API', () => {
    expect(resolveClaudeApiUpstream(null, 1234, {})).toBe(DEFAULT_CLAUDE_API_UPSTREAM)
    expect(resolveClaudeApiUpstream('https://gw.example.com/anthropic/', 1234, {})).toBe(
      'https://gw.example.com/anthropic'
    )
    expect(
      resolveClaudeApiUpstream('https://gw.example.com', 1234, {
        ANTHROPIC_BASE_URL: 'http://settings-gw:8080'
      })
    ).toBe('http://settings-gw:8080')
  })

  it('never resolves to the proxy itself or to garbage', () => {
    expect(resolveClaudeApiUpstream('http://127.0.0.1:1234', 1234, {})).toBe(
      DEFAULT_CLAUDE_API_UPSTREAM
    )
    expect(resolveClaudeApiUpstream('http://localhost:1234/', 1234, {})).toBe(
      DEFAULT_CLAUDE_API_UPSTREAM
    )
    expect(resolveClaudeApiUpstream('not a url', 1234, {})).toBe(DEFAULT_CLAUDE_API_UPSTREAM)
    expect(resolveClaudeApiUpstream('ftp://x', 1234, { ANTHROPIC_BASE_URL: '   ' })).toBe(
      DEFAULT_CLAUDE_API_UPSTREAM
    )
    // A different loopback port is a legitimate upstream (another local gateway).
    expect(resolveClaudeApiUpstream('http://127.0.0.1:9999', 1234, {})).toBe(
      'http://127.0.0.1:9999'
    )
  })
})

describe('startClaudeApiProxy', () => {
  it('starts on a loopback port, exports the env, chains to the original base URL, and restores on close', async () => {
    dbMocks.organizations = [
      { id: 'row-a', email: 'a@example.com', org_uuid: 'org-a' },
      { id: 'row-b', email: 'b@example.com', org_uuid: null }
    ]
    const result = await startClaudeApiProxy({
      env: {
        ANTHROPIC_BASE_URL: 'https://gateway.example.com/v1-proxy',
        HIVE_CLAUDE_API_PROXY_PORT: '0'
      }
    })
    expect(result.started).toBe(true)
    if (!result.started) return
    expect(result.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(result.upstream).toBe('https://gateway.example.com/v1-proxy')
    expect(process.env.ANTHROPIC_BASE_URL).toBe(result.baseUrl)
    expect(process.env._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL).toBe('1')
    expect(getClaudeApiProxyEnv()).toEqual({
      ANTHROPIC_BASE_URL: result.baseUrl,
      _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL: '1'
    })
    // The address the proxy took over stays readable for launches that must know it.
    expect(getClaudeApiProxyUserBaseUrl()).toBe('https://gateway.example.com/v1-proxy')
    await vi.waitFor(() =>
      expect(storeMocks.repairStaleClaudeLiveIdentityUuid).toHaveBeenCalledTimes(1)
    )
    // The identity-file repair is given every account's stored organization.
    expect(storeMocks.repairStaleClaudeLiveIdentityUuid).toHaveBeenCalledWith([
      { email: 'a@example.com', orgUuid: 'org-a' },
      { email: 'b@example.com', orgUuid: null }
    ])

    // Idempotent: a second start reports the running proxy.
    const again = await startClaudeApiProxy()
    expect(again).toMatchObject({ started: true, baseUrl: result.baseUrl })

    await closeClaudeApiProxy()
    expect(getClaudeApiProxyEnv()).toEqual({})
    expect(getClaudeApiProxyUserBaseUrl()).toBeNull()
    expect(process.env.ANTHROPIC_BASE_URL).toBeUndefined()
    expect(process.env._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL).toBeUndefined()
  })

  it('still repairs the identity file by account uuid when the organizations cannot be read', async () => {
    dbMocks.organizations = new Error('database is locked')
    const result = await startClaudeApiProxy({
      env: { HIVE_CLAUDE_API_PROXY_PORT: '0' },
      includeSettingsEnv: false
    })
    expect(result.started).toBe(true)
    await vi.waitFor(() =>
      expect(storeMocks.repairStaleClaudeLiveIdentityUuid).toHaveBeenCalledTimes(1)
    )
    expect(storeMocks.repairStaleClaudeLiveIdentityUuid).toHaveBeenCalledWith([])
  })

  it('does not start or touch the env when skipped', async () => {
    const result = await startClaudeApiProxy({ env: { HTTPS_PROXY: 'http://corp:3128' } })
    expect(result).toEqual({ started: false, reason: 'http-proxy-env' })
    expect(process.env.ANTHROPIC_BASE_URL).toBeUndefined()
    expect(getClaudeApiProxyEnv()).toEqual({})
    expect(getClaudeApiProxyUserBaseUrl()).toBeNull()
  })

  it('also honours a corporate proxy configured in Settings → Environment Variables', async () => {
    dbMocks.settings = JSON.stringify({
      environmentVariables: [{ key: 'HTTPS_PROXY', value: 'http://corp:3128' }]
    })
    const result = await startClaudeApiProxy({ env: { HIVE_CLAUDE_API_PROXY_PORT: '0' } })
    expect(result).toEqual({ started: false, reason: 'http-proxy-env' })
    expect(getClaudeApiProxyEnv()).toEqual({})
  })

  it('relays a Claude request end to end and publishes the attributed live usage', async () => {
    const upstream = http.createServer((req, res) => {
      req.resume()
      req.on('end', () => {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'anthropic-ratelimit-unified-5h-utilization': '0.42',
          'anthropic-ratelimit-unified-5h-reset': '1790902800',
          'anthropic-ratelimit-unified-7d-utilization': '0.1',
          'anthropic-ratelimit-unified-7d-reset': '1791036000',
          'anthropic-ratelimit-unified-status': 'allowed'
        })
        res.end('event: message_stop\ndata: {}\n\n')
      })
    })
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
    const upstreamPort = (upstream.address() as AddressInfo).port
    const uuid = '718fd88e-2076-4451-bc5f-066158379585'
    // The request below carries `Bearer x`; the account owning that token is
    // the one billed, whatever uuid the body reports.
    storeMocks.listClaudeAccountTokenFingerprints.mockResolvedValue([
      { email: 'other@example.com', uuid, tokenFingerprint: fingerprintSecret('some-other-token') },
      {
        email: 'me@example.com',
        uuid: '0d2c9a9e-1f1d-4a8a-9d2c-3a4b5c6d7e8f',
        tokenFingerprint: fingerprintSecret('x')
      }
    ])
    storeMocks.readClaudeLiveIdentityCached.mockResolvedValue({ email: 'Me@example.com', uuid })
    // A previously polled row: live updates must not disturb its poll stamp.
    dbMocks.rows.set('me@example.com', {
      id: 'row-me@example.com',
      provider: 'anthropic',
      email: 'me@example.com',
      credentials_json: '',
      last_usage_json: JSON.stringify({
        five_hour: { utilization: 1, resets_at: null },
        seven_day: { utilization: 2, resets_at: null },
        extra_usage: { is_enabled: true, utilization: 0, used_credits: 0, monthly_limit: 10 }
      }),
      last_fetched_at: 'polled-earlier',
      status: 'ok',
      last_error: null,
      created_at: 'c',
      updated_at: 'u'
    })

    try {
      const result = await startClaudeApiProxy({
        env: {
          ANTHROPIC_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
          HIVE_CLAUDE_API_PROXY_PORT: '0'
        }
      })
      expect(result.started).toBe(true)
      if (!result.started) return

      const body = JSON.stringify({
        model: 'claude-opus-5-5',
        messages: [{ role: 'user', content: 'hi' }],
        metadata: {
          user_id: JSON.stringify({ device_id: 'd', account_uuid: uuid, session_id: 's' })
        },
        stream: true
      })
      const response = await fetch(`${result.baseUrl}/v1/messages?beta=true`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer x' },
        body
      })
      expect(response.status).toBe(200)
      expect(await response.text()).toContain('message_stop')

      await vi.waitFor(() =>
        expect(publisherMocks.publishDesktopBackendEvent).toHaveBeenCalledTimes(1)
      )
      const [channel, payload] = publisherMocks.publishDesktopBackendEvent.mock
        .calls[0] as unknown as [
        string,
        {
          email: string
          accountId: string
          isLiveAccount: boolean
          liveEmail: string | null
          usage: { five_hour: { utilization: number }; extra_usage?: unknown }
        }
      ]
      expect(channel).toBe('usage:claudeLive')
      expect(payload.email).toBe('me@example.com')
      expect(payload.accountId).toBe('row-me@example.com')
      expect(payload.isLiveAccount).toBe(true)
      expect(payload.liveEmail).toBe('me@example.com')
      expect(payload.usage.five_hour.utilization).toBe(42)
      expect(payload.usage.extra_usage).toBeDefined()
      const row = dbMocks.rows.get('me@example.com')!
      expect(row.last_usage_json).toContain('"utilization":42')
      expect(row.last_fetched_at).toBe('polled-earlier')
    } finally {
      await new Promise<void>((resolve) => {
        upstream.closeAllConnections()
        upstream.close(() => resolve())
      })
    }
  })

  // Code Mode PRD AT-2: the organization on a proxied response is the organization of the
  // account whose token the request carried.
  it('stores the organization a proxied response names for the account its token belongs to', async () => {
    const organization = 'f43590b8-1111-4222-8333-444455556666'
    let sevenDay = 0.1
    const upstream = http.createServer((req, res) => {
      req.resume()
      req.on('end', () => {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'Anthropic-Organization-Id': organization.toUpperCase(),
          'anthropic-ratelimit-unified-7d-utilization': String(sevenDay),
          'anthropic-ratelimit-unified-7d-reset': '4078890000',
          'anthropic-ratelimit-unified-status': 'allowed'
        })
        res.end('event: message_stop\ndata: {}\n\n')
      })
    })
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
    const upstreamPort = (upstream.address() as AddressInfo).port
    const uuid = '0d2c9a9e-1f1d-4a8a-9d2c-3a4b5c6d7e8f'
    // Somebody else is signed in; the request below runs on me@example.com's token.
    storeMocks.listClaudeAccountTokenFingerprints.mockResolvedValue([
      { email: 'me@example.com', uuid, tokenFingerprint: fingerprintSecret('x') }
    ])
    storeMocks.readClaudeLiveIdentityCached.mockResolvedValue({
      email: 'other@example.com',
      uuid: '718fd88e-2076-4451-bc5f-066158379585'
    })
    storeMocks.readClaudeLiveTokenFingerprint.mockResolvedValue(fingerprintSecret('another-token'))
    dbMocks.rows.set('me@example.com', {
      id: 'row-me@example.com',
      provider: 'anthropic',
      email: 'me@example.com',
      credentials_json: '',
      last_usage_json: null,
      last_fetched_at: null,
      status: 'ok',
      last_error: null,
      org_uuid: null,
      created_at: 'c',
      updated_at: 'u'
    })
    const publishedEmails = (): string[] =>
      (
        publisherMocks.publishDesktopBackendEvent.mock.calls as unknown as Array<
          [string, { email: string }]
        >
      ).map(([, payload]) => payload.email)

    try {
      const result = await startClaudeApiProxy({
        env: {
          ANTHROPIC_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
          HIVE_CLAUDE_API_PROXY_PORT: '0'
        }
      })
      expect(result.started).toBe(true)
      if (!result.started) return

      const request = async (): Promise<void> => {
        const response = await fetch(`${result.baseUrl}/v1/messages?beta=true`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: 'Bearer x' },
          body: JSON.stringify({
            model: 'claude-haiku-5-5',
            messages: [{ role: 'user', content: 'hi' }],
            metadata: {
              user_id: JSON.stringify({ device_id: 'd', account_uuid: uuid, session_id: 's' })
            }
          })
        })
        expect(response.status).toBe(200)
        await response.text()
      }

      await request()
      await vi.waitFor(() => expect(publishedEmails()).toEqual(['me@example.com']))
      // The header crossed the tunnel and was stored in the form the store compares by.
      expect(dbMocks.organizationWrites).toEqual([
        { id: 'row-me@example.com', orgUuid: organization }
      ])
      expect(dbMocks.rows.get('me@example.com')?.org_uuid).toBe(organization)

      // A second response with the same organization is a usage update and no write.
      sevenDay = 0.2
      await request()
      await vi.waitFor(() => expect(publishedEmails()).toHaveLength(2))
      expect(dbMocks.rows.get('me@example.com')?.last_usage_json).toContain('"utilization":20')
      expect(dbMocks.organizationWrites).toHaveLength(1)

      // What a Code Mode session reports: the usage and the organization, no credential.
      submitClaudeUsageObservation({
        credentialFingerprint: null,
        accountUuid: null,
        organizationUuid: organization,
        snapshot: parseUnifiedRateLimitHeaders({
          'anthropic-ratelimit-unified-7d-utilization': '0.61',
          'anthropic-ratelimit-unified-7d-reset': '4078890000',
          'anthropic-ratelimit-unified-status': 'allowed'
        })!,
        observedAt: Date.now()
      })
      await vi.waitFor(() => expect(publishedEmails()).toHaveLength(3))
      expect(publishedEmails()[2]).toBe('me@example.com')
      expect(dbMocks.rows.get('me@example.com')?.last_usage_json).toContain('"utilization":61')
      expect(dbMocks.organizationWrites).toHaveLength(1)
    } finally {
      await new Promise<void>((resolve) => {
        upstream.closeAllConnections()
        upstream.close(() => resolve())
      })
    }
  })
})
