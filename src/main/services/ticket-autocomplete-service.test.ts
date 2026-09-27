import { describe, expect, it, vi } from 'vitest'

vi.mock('./logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))

import {
  TicketAutocompleteService,
  type TicketAutocompleteCorpusSource
} from './ticket-autocomplete-service'

const PHRASE = 'use subagents to read the task first'

function setup(initial: string[]) {
  let documents = initial
  let fingerprint = 'v1'
  let clock = 0
  const source: TicketAutocompleteCorpusSource = {
    fingerprint: vi.fn(() => fingerprint),
    documents: vi.fn(() => documents)
  }
  const service = new TicketAutocompleteService({
    source,
    refreshIntervalMs: 1000,
    now: () => clock,
    defer: (task) => task()
  })
  return {
    service,
    source,
    setCorpus: (next: string[], nextFingerprint: string) => {
      documents = next
      fingerprint = nextFingerprint
    },
    advance: (ms: number) => {
      clock += ms
    }
  }
}

describe('TicketAutocompleteService', () => {
  it('builds the model from the corpus on first use', () => {
    const { service, source } = setup([PHRASE, PHRASE, PHRASE])
    expect(service.suggest('use subagents to ')?.text).toBe('read the task first')
    expect(source.documents).toHaveBeenCalledTimes(1)
    expect(service.status()).toMatchObject({ documents: 3, builtAt: 0 })
  })

  it('learns new tickets once the refresh interval has passed', () => {
    const { service, setCorpus, advance } = setup([])
    expect(service.suggest('use subagents to ')).toBeNull()

    setCorpus([PHRASE, PHRASE, PHRASE], 'v2')
    // Within the interval the old model answers and nothing is re-read.
    advance(500)
    expect(service.suggest('use subagents to ')).toBeNull()

    // The next call after the interval answers from the current model and
    // refreshes behind it; the one after that sees the new tickets.
    advance(600)
    service.suggest('use subagents to ')
    expect(service.suggest('use subagents to ')?.text).toBe('read the task first')
  })

  it('does not re-read the corpus while the fingerprint is unchanged', () => {
    const { service, source, advance } = setup([PHRASE])
    service.suggest('x ')
    advance(5000)
    service.suggest('x ')
    expect(source.fingerprint).toHaveBeenCalledTimes(2)
    expect(source.documents).toHaveBeenCalledTimes(1)
  })

  it('skips the rebuild when only non-text fields changed', () => {
    const { service, setCorpus, advance } = setup([PHRASE])
    service.suggest('x ')
    const { builtAt } = service.status()
    advance(5000)
    setCorpus([PHRASE], 'v2') // e.g. a ticket moved column: same text
    service.suggest('x ')
    expect(service.status().builtAt).toBe(builtAt)
  })

  it('keeps serving the previous model when a refresh fails', () => {
    const { service, source, advance } = setup([PHRASE, PHRASE, PHRASE])
    service.suggest('x ')
    vi.mocked(source.fingerprint).mockImplementation(() => {
      throw new Error('database is locked')
    })
    advance(5000)
    service.suggest('x ')
    expect(service.suggest('use subagents to ')?.text).toBe('read the task first')
  })
})
