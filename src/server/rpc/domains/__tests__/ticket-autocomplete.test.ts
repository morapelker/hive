import { Effect } from 'effect'
import { describe, expect, it, vi } from 'vitest'

import type { RpcContext } from '../../router'
import {
  TICKET_AUTOCOMPLETE_MAX_BEFORE_CHARS,
  makeTicketAutocompleteRpcHandlers,
  type TicketAutocompleteRpcService
} from '../ticket-autocomplete'

const context = { eventBus: null } as unknown as RpcContext
const suggestion = { text: 'ement', confidence: 0.9, support: 12, contextLength: 0 }

function makeService(
  overrides: Partial<TicketAutocompleteRpcService> = {}
): TicketAutocompleteRpcService {
  return {
    suggest: () => Effect.succeed(suggestion),
    status: () =>
      Effect.succeed({ documents: 1, tokens: 2, vocabulary: 2, builtAt: 0, buildMs: 1 }),
    ...overrides
  }
}

function run(service: TicketAutocompleteRpcService, method: string, params: unknown) {
  const handler = makeTicketAutocompleteRpcHandlers(service).get(method)
  if (!handler) throw new Error(`missing handler for ${method}`)
  return Effect.runPromise(handler(params, context) as Effect.Effect<unknown, never, never>)
}

describe('ticketAutocomplete RPC handlers', () => {
  it('registers suggest and status', () => {
    expect([...makeTicketAutocompleteRpcHandlers(makeService()).keys()].sort()).toEqual([
      'ticketAutocomplete.status',
      'ticketAutocomplete.suggest'
    ])
  })

  it('passes the text before the caret to the service', async () => {
    const suggest = vi.fn(() => Effect.succeed(suggestion))
    await expect(
      run(makeService({ suggest }), 'ticketAutocomplete.suggest', { before: 'impl' })
    ).resolves.toEqual(suggestion)
    expect(suggest).toHaveBeenCalledWith('impl')
  })

  it('rejects malformed or oversized params', async () => {
    const service = makeService()
    await expect(run(service, 'ticketAutocomplete.suggest', {})).rejects.toBeDefined()
    await expect(
      run(service, 'ticketAutocomplete.suggest', { before: 'x', extra: true })
    ).rejects.toBeDefined()
    await expect(
      run(service, 'ticketAutocomplete.suggest', {
        before: 'x'.repeat(TICKET_AUTOCOMPLETE_MAX_BEFORE_CHARS + 1)
      })
    ).rejects.toBeDefined()
  })

  it('returns model status', async () => {
    await expect(run(makeService(), 'ticketAutocomplete.status', {})).resolves.toMatchObject({
      documents: 1
    })
  })
})
