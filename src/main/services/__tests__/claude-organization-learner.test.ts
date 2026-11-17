// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The learner on simulated responses: a fake table of accounts (id, email,
// organization), a fake credential per account, a scripted profile request
// and a clock the test moves. No database, Keychain or network.

vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }))
vi.mock('../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}))
vi.mock('../../db', () => ({ getDatabase: vi.fn() }))

import {
  ClaudeOrganizationLearner,
  ORGANIZATION_LEARN_BASE_BACKOFF_MS,
  ORGANIZATION_LEARN_MAX_BACKOFF_MS,
  ORGANIZATION_LEARN_RATE_LIMIT_PAUSE_MS,
  type ClaudeOrganizationLearnerCredential
} from '../claude-organization-learner'
import type { ClaudeProfileOrganizationResult } from '../usage-service'

const ORG_A = 'f43590b8-1111-4222-8333-444455556666'
const ORG_B = '3ccde938-7777-4888-9999-aaaabbbbcccc'
const START = Date.parse('2026-11-17T10:00:00.000Z')
const MINUTE = 60_000

interface Account {
  id: string
  email: string
  organization: string | null
}

function harness() {
  const accounts = new Map<string, Account>()
  const credentials = new Map<string, ClaudeOrganizationLearnerCredential | null>()
  /** What the profile request answers, per access token. */
  const answers = new Map<string, ClaudeProfileOrganizationResult>()
  const requests: string[] = []
  const logged: Array<{ level: 'info' | 'warn'; message: string; data?: Record<string, unknown> }> =
    []
  let now = START

  const fetchOrganization = vi.fn(
    async (accessToken: string): Promise<ClaudeProfileOrganizationResult> => {
      requests.push(accessToken)
      return answers.get(accessToken) ?? { ok: false, reason: 'failed' }
    }
  )
  const readCredential = vi.fn(async (account: { email: string }) => {
    const credential = credentials.get(account.email)
    return credential === undefined ? null : credential
  })
  const storeOrganization = vi.fn((account: { id: string }, organizationUuid: string) => {
    const row = accounts.get(account.id)
    if (!row || row.organization !== null) return false
    row.organization = organizationUuid
    return true
  })

  const learner = new ClaudeOrganizationLearner({
    listAccountsWithoutOrganization: () =>
      [...accounts.values()]
        .filter((account) => account.organization === null)
        .map(({ id, email }) => ({ id, email })),
    readCredential,
    fetchOrganization,
    storeOrganization,
    now: () => now,
    log: {
      info: (message, data) => logged.push({ level: 'info', message, data }),
      warn: (message, data) => logged.push({ level: 'warn', message, data })
    }
  })

  return {
    learner,
    accounts,
    requests,
    logged,
    fetchOrganization,
    readCredential,
    storeOrganization,
    /** A managed account with a usable token `token-<id>`. */
    add(id: string, organization: string | null = null): Account {
      const account = { id, email: `${id}@example.com`, organization }
      accounts.set(id, account)
      credentials.set(account.email, {
        accessToken: `token-${id}`,
        expiresAt: START + 8 * 3600_000
      })
      return account
    },
    setCredential(id: string, credential: ClaudeOrganizationLearnerCredential | null) {
      credentials.set(`${id}@example.com`, credential)
    },
    answer(id: string, result: ClaudeProfileOrganizationResult) {
      answers.set(`token-${id}`, result)
    },
    advance(ms: number) {
      now += ms
    }
  }
}

describe('ClaudeOrganizationLearner', () => {
  let h: ReturnType<typeof harness>

  beforeEach(() => {
    h = harness()
  })

  it('gives an account with no organization the one its own credential returns', async () => {
    h.add('a')
    h.add('b')
    h.answer('a', { ok: true, organizationUuid: ORG_A })
    h.answer('b', { ok: true, organizationUuid: ORG_B })

    await h.learner.sweep()

    expect(h.requests).toEqual(['token-a', 'token-b'])
    expect(h.accounts.get('a')!.organization).toBe(ORG_A)
    expect(h.accounts.get('b')!.organization).toBe(ORG_B)
  })

  it('makes no request for an account whose organization is known', async () => {
    h.add('a', ORG_A)

    await h.learner.sweep()
    h.advance(24 * 60 * MINUTE)
    await h.learner.sweep()

    expect(h.fetchOrganization).not.toHaveBeenCalled()
    expect(h.readCredential).not.toHaveBeenCalled()
    expect(h.accounts.get('a')!.organization).toBe(ORG_A)
  })

  it('makes no further request once the organization was learned', async () => {
    h.add('a')
    h.answer('a', { ok: true, organizationUuid: ORG_A })

    await h.learner.sweep()
    await h.learner.sweep()
    h.advance(60 * MINUTE)
    await h.learner.sweep()

    expect(h.requests).toEqual(['token-a'])
  })

  it('leaves the value empty after a failed request and retries later, not immediately', async () => {
    h.add('a')
    h.answer('a', { ok: false, reason: 'failed', status: 503 })

    await h.learner.sweep()
    expect(h.requests).toHaveLength(1)
    expect(h.accounts.get('a')!.organization).toBeNull()
    expect(h.storeOrganization).not.toHaveBeenCalled()

    // Asked again at once, and again just before the back-off is over: nothing is sent.
    await h.learner.sweep()
    await h.learner.sweep()
    h.advance(ORGANIZATION_LEARN_BASE_BACKOFF_MS - 1)
    await h.learner.sweep()
    expect(h.requests).toHaveLength(1)

    // Once it is over, the retry goes out, and this time it works.
    h.answer('a', { ok: true, organizationUuid: ORG_A })
    h.advance(1)
    await h.learner.sweep()
    expect(h.requests).toHaveLength(2)
    expect(h.accounts.get('a')!.organization).toBe(ORG_A)
  })

  it('doubles the wait with every failure, up to the cap', async () => {
    h.add('a')
    // A token with no expiry on record: this test runs the clock for a day.
    h.setCredential('a', { accessToken: 'token-a' })
    h.answer('a', { ok: false, reason: 'failed' })

    const waits: number[] = []
    await h.learner.sweep()
    for (let attempt = 0; attempt < 9; attempt += 1) {
      // Step a minute at a time, as account maintenance does, until the next request goes out.
      let waited = 0
      const before = h.requests.length
      while (h.requests.length === before && waited <= ORGANIZATION_LEARN_MAX_BACKOFF_MS) {
        h.advance(MINUTE)
        waited += MINUTE
        await h.learner.sweep()
      }
      waits.push(waited)
    }

    expect(waits.slice(0, 7)).toEqual([5, 10, 20, 40, 80, 160, 320].map((m) => m * MINUTE))
    expect(waits.slice(7)).toEqual([
      ORGANIZATION_LEARN_MAX_BACKOFF_MS,
      ORGANIZATION_LEARN_MAX_BACKOFF_MS
    ])
  })

  it('backs off after a rejected credential and after a profile without an organization', async () => {
    h.add('a')
    h.add('b')
    h.answer('a', { ok: false, reason: 'rejected', status: 401 })
    h.answer('b', { ok: false, reason: 'missing', status: 200 })

    await h.learner.sweep()
    await h.learner.sweep()
    h.advance(ORGANIZATION_LEARN_BASE_BACKOFF_MS - 1)
    await h.learner.sweep()

    expect(h.requests).toEqual(['token-a', 'token-b'])
    expect(h.accounts.get('a')!.organization).toBeNull()
    expect(h.accounts.get('b')!.organization).toBeNull()
  })

  it('keeps one account failing from holding up another', async () => {
    h.add('a')
    h.add('b')
    h.answer('a', { ok: false, reason: 'failed', status: 500 })
    h.answer('b', { ok: true, organizationUuid: ORG_B })

    await h.learner.sweep()

    expect(h.accounts.get('a')!.organization).toBeNull()
    expect(h.accounts.get('b')!.organization).toBe(ORG_B)
  })

  it('waits at least as long as a rate limit says, and asks nobody else meanwhile', async () => {
    h.add('a')
    h.add('b')
    h.answer('a', { ok: false, reason: 'rate-limited', status: 429, retryAfter: 1800 })
    h.answer('b', { ok: true, organizationUuid: ORG_B })

    await h.learner.sweep()
    // The sweep stopped at the 429: account b was not asked.
    expect(h.requests).toEqual(['token-a'])

    h.advance(1800_000 - 1)
    await h.learner.sweep()
    expect(h.requests).toEqual(['token-a'])

    h.answer('a', { ok: true, organizationUuid: ORG_A })
    h.advance(1)
    await h.learner.sweep()
    expect(h.requests).toEqual(['token-a', 'token-a', 'token-b'])
    expect(h.accounts.get('a')!.organization).toBe(ORG_A)
    expect(h.accounts.get('b')!.organization).toBe(ORG_B)
  })

  it('pauses a minute after a rate limit that names no time', async () => {
    h.add('a')
    h.add('b')
    h.answer('a', { ok: false, reason: 'rate-limited', status: 429 })
    h.answer('b', { ok: true, organizationUuid: ORG_B })

    await h.learner.sweep()
    h.advance(ORGANIZATION_LEARN_RATE_LIMIT_PAUSE_MS - 1)
    await h.learner.sweep()
    expect(h.requests).toEqual(['token-a'])

    // The pause is over for the others; the limited account keeps its own back-off.
    h.advance(1)
    await h.learner.sweep()
    expect(h.requests).toEqual(['token-a', 'token-b'])
  })

  it('sends nothing with a token that is expired or about to expire', async () => {
    h.add('a')
    h.answer('a', { ok: true, organizationUuid: ORG_A })
    h.setCredential('a', { accessToken: 'token-a', expiresAt: START + 30_000 })

    await h.learner.sweep()
    expect(h.requests).toEqual([])

    // The token watcher refreshed it a moment later. The learner does not read the
    // credential again every minute: it comes back when the account's wait is over.
    h.setCredential('a', { accessToken: 'token-a', expiresAt: START + 8 * 3600_000 })
    h.advance(MINUTE)
    await h.learner.sweep()
    expect(h.requests).toEqual([])
    expect(h.readCredential).toHaveBeenCalledTimes(1)

    h.advance(ORGANIZATION_LEARN_BASE_BACKOFF_MS - MINUTE)
    await h.learner.sweep()
    expect(h.requests).toEqual(['token-a'])
    expect(h.accounts.get('a')!.organization).toBe(ORG_A)
  })

  it('skips an account that left the account store or has no token', async () => {
    h.add('a')
    h.setCredential('a', null)

    await h.learner.sweep()
    await h.learner.sweep()
    h.advance(ORGANIZATION_LEARN_BASE_BACKOFF_MS - 1)
    await h.learner.sweep()

    expect(h.requests).toEqual([])
    expect(h.accounts.get('a')!.organization).toBeNull()
    // Its credential (the account's lock, the Keychain) is not read again on every sweep.
    expect(h.readCredential).toHaveBeenCalledTimes(1)

    h.advance(1)
    await h.learner.sweep()
    expect(h.readCredential).toHaveBeenCalledTimes(2)
  })

  it('carries on with the next account when a credential cannot be read', async () => {
    h.add('a')
    h.add('b')
    h.answer('b', { ok: true, organizationUuid: ORG_B })
    h.readCredential.mockRejectedValueOnce(new Error('keychain locked'))

    await expect(h.learner.sweep()).resolves.toBeUndefined()

    expect(h.requests).toEqual(['token-b'])
    expect(h.accounts.get('b')!.organization).toBe(ORG_B)

    // The unreadable one is not tried again at once, and is once its wait is over.
    h.answer('a', { ok: true, organizationUuid: ORG_A })
    await h.learner.sweep()
    expect(h.requests).toEqual(['token-b'])
    h.advance(ORGANIZATION_LEARN_BASE_BACKOFF_MS)
    await h.learner.sweep()
    expect(h.requests).toEqual(['token-b', 'token-a'])
  })

  it('makes one request for an account however many sweeps are asked for at once', async () => {
    h.add('a')
    let release: (result: ClaudeProfileOrganizationResult) => void = () => undefined
    h.fetchOrganization.mockImplementationOnce(
      (token: string) =>
        new Promise<ClaudeProfileOrganizationResult>((resolve) => {
          h.requests.push(token)
          release = resolve
        })
    )

    const sweeps = [h.learner.sweep(), h.learner.sweep(), h.learner.sweep()]
    await vi.waitFor(() => expect(h.requests).toHaveLength(1))
    release({ ok: true, organizationUuid: ORG_A })
    await Promise.all(sweeps)

    expect(h.requests).toEqual(['token-a'])
    expect(h.accounts.get('a')!.organization).toBe(ORG_A)
  })

  it('does not ask for an account that gained its organization while the sweep was under way', async () => {
    h.add('a')
    h.add('b')
    h.answer('b', { ok: true, organizationUuid: ORG_B })
    // While account a's request is out, a usage poll stores account b's organization.
    h.fetchOrganization.mockImplementationOnce(async (token: string) => {
      h.requests.push(token)
      h.accounts.get('b')!.organization = ORG_B
      return { ok: true, organizationUuid: ORG_A }
    })

    await h.learner.sweep()

    expect(h.requests).toEqual(['token-a'])
  })

  it('learns again, at once, for an account whose row was deleted and recreated', async () => {
    h.add('a')
    h.answer('a', { ok: false, reason: 'failed', status: 500 })
    await h.learner.sweep()

    // The account left the store and came back: a new row, no organization. The old row's
    // back-off is forgotten on the sweep that no longer sees it.
    h.accounts.delete('a')
    await h.learner.sweep()
    h.add('a')
    h.answer('a', { ok: true, organizationUuid: ORG_A })
    await h.learner.sweep()

    expect(h.requests).toEqual(['token-a', 'token-a'])
    expect(h.accounts.get('a')!.organization).toBe(ORG_A)
  })

  it('backs off when the answer could not be written, and not when the row has one by now', async () => {
    h.add('a')
    h.add('b')
    h.answer('a', { ok: true, organizationUuid: ORG_A })
    h.answer('b', { ok: true, organizationUuid: ORG_B })
    // Account a: the write fails. Account b: something else stored its organization first.
    h.storeOrganization.mockImplementationOnce(() => false)
    h.storeOrganization.mockImplementationOnce((account: { id: string }) => {
      h.accounts.get(account.id)!.organization = ORG_B
      return false
    })

    await h.learner.sweep()
    await h.learner.sweep()
    h.advance(ORGANIZATION_LEARN_BASE_BACKOFF_MS - 1)
    await h.learner.sweep()
    expect(h.requests).toEqual(['token-a', 'token-b'])
    expect(h.accounts.get('a')!.organization).toBeNull()

    h.advance(1)
    await h.learner.sweep()
    expect(h.requests).toEqual(['token-a', 'token-b', 'token-a'])
    expect(h.accounts.get('a')!.organization).toBe(ORG_A)
  })

  it('logs failures quietly: no token, no email, no whole organization id', async () => {
    h.add('a')
    h.add('b')
    h.answer('a', { ok: false, reason: 'rejected', status: 403 })
    h.answer('b', { ok: true, organizationUuid: ORG_B })

    await h.learner.sweep()

    expect(h.logged.map((entry) => entry.level)).toEqual(['info', 'info'])
    expect(h.logged[0].data).toEqual({
      accountId: 'a',
      reason: 'rejected',
      status: 403,
      failures: 1,
      retryInMs: ORGANIZATION_LEARN_BASE_BACKOFF_MS
    })
    const text = JSON.stringify(h.logged)
    expect(text).not.toContain('token-')
    expect(text).not.toContain('@example.com')
    expect(text).not.toContain(ORG_B)
    expect(text).toContain(ORG_B.slice(0, 8))
  })

  it('never rejects, even when the accounts cannot be listed', async () => {
    const learner = new ClaudeOrganizationLearner({
      listAccountsWithoutOrganization: () => {
        throw new Error('database is closing')
      },
      readCredential: async () => null,
      fetchOrganization: async () => ({ ok: false, reason: 'failed' }),
      storeOrganization: () => false,
      log: { info: vi.fn(), warn: vi.fn() }
    })

    await expect(learner.sweep()).resolves.toBeUndefined()
    await expect(learner.sweep()).resolves.toBeUndefined()
  })
})
