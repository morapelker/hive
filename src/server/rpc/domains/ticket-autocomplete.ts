import { Effect } from 'effect'
import { z } from 'zod'
import type { TicketAutocompleteSuggestion } from '../../../shared/ticket-autocomplete/model'
import type { TicketAutocompleteStatus } from '../../../main/services/ticket-autocomplete-service'
import type { RpcHandler } from '../router'

export interface TicketAutocompleteRpcService {
  readonly suggest: (
    before: string
  ) => Effect.Effect<TicketAutocompleteSuggestion | null, unknown, never>
  readonly status: () => Effect.Effect<TicketAutocompleteStatus, unknown, never>
}

/**
 * The model only reads the tail of the text before the caret, so clients send
 * a bounded slice; the cap keeps a misbehaving client from shipping megabytes.
 */
export const TICKET_AUTOCOMPLETE_MAX_BEFORE_CHARS = 20_000

const suggestParamsSchema = z
  .object({ before: z.string().max(TICKET_AUTOCOMPLETE_MAX_BEFORE_CHARS) })
  .strict()

const emptyParamsSchema = z.union([z.object({}).strict(), z.undefined(), z.null()])

export const makeLiveTicketAutocompleteRpcService = (): TicketAutocompleteRpcService => ({
  suggest: (before) =>
    Effect.tryPromise({
      try: async () => {
        const { getTicketAutocompleteService } =
          await import('../../../main/services/ticket-autocomplete-service')
        return (await getTicketAutocompleteService()).suggest(before)
      },
      catch: (cause) => cause
    }),
  status: () =>
    Effect.tryPromise({
      try: async () => {
        const { getTicketAutocompleteService } =
          await import('../../../main/services/ticket-autocomplete-service')
        return (await getTicketAutocompleteService()).status()
      },
      catch: (cause) => cause
    })
})

export const makeTicketAutocompleteRpcHandlers = (
  service: TicketAutocompleteRpcService = makeLiveTicketAutocompleteRpcService()
): ReadonlyMap<string, RpcHandler> =>
  new Map<string, RpcHandler>([
    [
      'ticketAutocomplete.suggest',
      (params) =>
        Effect.gen(function* () {
          const { before } = yield* Effect.try({
            try: () => suggestParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.suggest(before)
        })
    ],
    [
      'ticketAutocomplete.status',
      (params) =>
        Effect.gen(function* () {
          yield* Effect.try({
            try: () => emptyParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.status()
        })
    ]
  ])
