// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { DevSessionProvider, DevSessionSnapshot } from './tedooo-dev-session'
import { prefixForSnapshot, startTicketKeyPrefixSync } from './ticket-key-prefix'

// `vi.mock` is hoisted above every other statement, so the values its factories close over
// have to be hoisted too.
const { log, ensureTicketKeyPrefix } = vi.hoisted(() => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  ensureTicketKeyPrefix: vi.fn((prefix: string) => prefix)
}))
vi.mock('./logger', () => ({ createLogger: () => log }))
// The sync must never reach the real database in these tests: every path injects `ensurePrefix`,
// and the module-level fallback is covered through this mock.
vi.mock('../db', () => ({ getDatabase: () => ({ ensureTicketKeyPrefix }) }))

const snapshot = (
  context: Partial<NonNullable<DevSessionSnapshot['context']>> | null
): DevSessionSnapshot => ({
  token: context ? 'tok' : null,
  context:
    context === null
      ? null
      : {
          userId: 'u1',
          email: 'mor@tedooo.com',
          orgId: 'org-1',
          orgName: 'Tedooo',
          apiUrl: null,
          policy: null,
          ...context
        }
})

interface FakeProvider extends DevSessionProvider {
  emit(next: DevSessionSnapshot): void
  unsubscribe: ReturnType<typeof vi.fn>
  listeners: Array<(snapshot: DevSessionSnapshot) => void>
}

const makeProvider = (initial: DevSessionSnapshot): FakeProvider => {
  const listeners: FakeProvider['listeners'] = []
  const unsubscribe = vi.fn()
  return {
    listeners,
    unsubscribe,
    get: () => initial,
    subscribe: (listener) => {
      listeners.push(listener)
      return unsubscribe
    },
    emit: (next) => listeners.forEach((listener) => listener(next)),
    request: vi.fn(async () => ({}) as never),
    enqueue: vi.fn(),
    notify: vi.fn()
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('prefixForSnapshot', () => {
  it('derives the prefix from the email domain of a signed-in organisation', () => {
    expect(prefixForSnapshot(snapshot({}))).toBe('TD')
  })

  it('falls back to the organisation name for a public mail address', () => {
    expect(prefixForSnapshot(snapshot({ email: 'bob@gmail.com', orgName: 'Google' }))).toBe('GL')
  })

  it('is null without an organisation or without a context', () => {
    expect(prefixForSnapshot(snapshot({ orgId: null }))).toBeNull()
    expect(prefixForSnapshot(snapshot(null))).toBeNull()
    expect(prefixForSnapshot(snapshot({ email: 'bob@gmail.com', orgName: null }))).toBeNull()
  })
})

describe('startTicketKeyPrefixSync', () => {
  it('applies the initial snapshot right away', () => {
    const ensurePrefix = vi.fn((prefix: string) => prefix)
    startTicketKeyPrefixSync({ provider: makeProvider(snapshot({})), ensurePrefix })
    expect(ensurePrefix).toHaveBeenCalledTimes(1)
    expect(ensurePrefix).toHaveBeenCalledWith('TD')
  })

  it('ignores a snapshot without an organisation or without a context', () => {
    const ensurePrefix = vi.fn((prefix: string) => prefix)
    const provider = makeProvider(snapshot({ orgId: null }))
    startTicketKeyPrefixSync({ provider, ensurePrefix })
    provider.emit(snapshot(null))
    expect(ensurePrefix).not.toHaveBeenCalled()
  })

  it('wires the subscribe listener and returns its unsubscribe', () => {
    const ensurePrefix = vi.fn((prefix: string) => prefix)
    const provider = makeProvider(snapshot(null))
    const stop = startTicketKeyPrefixSync({ provider, ensurePrefix })
    expect(provider.listeners).toHaveLength(1)
    expect(stop).toBe(provider.unsubscribe)
    expect(provider.unsubscribe).not.toHaveBeenCalled()

    // Signing in later is what makes the first call.
    provider.emit(snapshot({}))
    expect(ensurePrefix).toHaveBeenCalledWith('TD')

    stop()
    expect(provider.unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('applies a later snapshot with a different organisation', () => {
    const ensurePrefix = vi.fn((prefix: string) => prefix)
    const provider = makeProvider(snapshot({}))
    startTicketKeyPrefixSync({ provider, ensurePrefix })
    provider.emit(snapshot({ email: 'x@google.com', orgId: 'org-2', orgName: 'Google' }))
    expect(ensurePrefix.mock.calls).toEqual([['TD'], ['GL']])
  })

  it('calls ensurePrefix once for the same prefix twice in a row', () => {
    const ensurePrefix = vi.fn((prefix: string) => prefix)
    const provider = makeProvider(snapshot({}))
    startTicketKeyPrefixSync({ provider, ensurePrefix })
    provider.emit(snapshot({}))
    // A different user of the same organisation derives the same prefix: still no new call.
    provider.emit(snapshot({ userId: 'u2', email: 'bob@tedooo.com' }))
    expect(ensurePrefix).toHaveBeenCalledTimes(1)
  })

  it('re-applies after a sign-out / sign-in cycle only when the prefix changed', () => {
    const ensurePrefix = vi.fn((prefix: string) => prefix)
    const provider = makeProvider(snapshot({}))
    startTicketKeyPrefixSync({ provider, ensurePrefix })
    provider.emit(snapshot(null))
    provider.emit(snapshot({}))
    expect(ensurePrefix).toHaveBeenCalledTimes(1)
    provider.emit(snapshot({ email: 'x@google.com', orgId: 'org-2', orgName: 'Google' }))
    expect(ensurePrefix).toHaveBeenCalledTimes(2)
  })

  it('logs, without throwing, when the database keeps another organisation prefix', () => {
    const ensurePrefix = vi.fn(() => 'TD')
    const provider = makeProvider(snapshot({ email: 'x@google.com', orgName: 'Google' }))
    expect(() => startTicketKeyPrefixSync({ provider, ensurePrefix })).not.toThrow()
    expect(ensurePrefix).toHaveBeenCalledWith('GL')
    expect(log.info).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ stored: 'TD', derived: 'GL' })
    )
  })

  it('swallows a failing ensurePrefix and retries on the next snapshot', () => {
    const ensurePrefix = vi
      .fn((prefix: string) => prefix)
      .mockImplementationOnce(() => {
        throw new Error('database is locked')
      })
    const provider = makeProvider(snapshot({}))
    expect(() => startTicketKeyPrefixSync({ provider, ensurePrefix })).not.toThrow()
    expect(log.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ prefix: 'TD', error: 'database is locked' })
    )
    // The failed attempt was not recorded as applied, so the same prefix is tried again.
    provider.emit(snapshot({}))
    expect(ensurePrefix).toHaveBeenCalledTimes(2)
  })

  it('uses the database when no ensurePrefix is injected', () => {
    startTicketKeyPrefixSync({ provider: makeProvider(snapshot({})) })
    expect(ensureTicketKeyPrefix).toHaveBeenCalledWith('TD')
  })

  it('is a no-op without a provider (not hosted)', () => {
    const ensurePrefix = vi.fn((prefix: string) => prefix)
    const stopExplicit = startTicketKeyPrefixSync({ provider: null, ensurePrefix })
    // No provider installed in this process either: the singleton is null under tests.
    const stopDefault = startTicketKeyPrefixSync({ ensurePrefix })
    expect(() => stopExplicit()).not.toThrow()
    expect(() => stopDefault()).not.toThrow()
    expect(ensurePrefix).not.toHaveBeenCalled()
    expect(ensureTicketKeyPrefix).not.toHaveBeenCalled()
  })
})
