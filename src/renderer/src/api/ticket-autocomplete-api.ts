import type { TicketAutocompleteSuggestion } from '@shared/ticket-autocomplete/model'
import { getRendererRpcClient } from './rpc-client'

/** The model reads only the tail of the text; don't ship whole documents per keystroke. */
const MAX_BEFORE_CHARS = 2_000

export const ticketAutocompleteApi = {
  suggest: async (before: string): Promise<TicketAutocompleteSuggestion | null> =>
    getRendererRpcClient().request<TicketAutocompleteSuggestion | null>(
      'ticketAutocomplete.suggest',
      { before: before.length > MAX_BEFORE_CHARS ? before.slice(-MAX_BEFORE_CHARS) : before }
    )
}
