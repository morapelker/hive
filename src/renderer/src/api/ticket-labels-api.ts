import type {
  SavedTicketLabel,
  SavedTicketLabelCreate,
  SavedTicketLabelMutationResult,
  SavedTicketLabelUpdate
} from '@shared/lib/ticket-labels'
import { getRendererRpcClient } from './rpc-client'

/**
 * The machine-wide saved-label catalog (server domain rpc/domains/ticket-labels.ts). A rejected
 * create or update carries the DB's message as is ('A label named "X" already exists'), so a
 * caller can show `error.message` to the user.
 */
export const ticketLabelsApi = {
  list: async (): Promise<SavedTicketLabel[]> =>
    getRendererRpcClient().request<SavedTicketLabel[]>('ticketLabels.list', {}),
  create: async (data: SavedTicketLabelCreate): Promise<SavedTicketLabel> =>
    getRendererRpcClient().request<SavedTicketLabel>('ticketLabels.create', data),
  update: async (
    id: string,
    data: SavedTicketLabelUpdate
  ): Promise<SavedTicketLabelMutationResult> =>
    getRendererRpcClient().request<SavedTicketLabelMutationResult>('ticketLabels.update', {
      id,
      data
    }),
  reorder: async (ids: readonly string[]): Promise<SavedTicketLabelMutationResult> =>
    getRendererRpcClient().request<SavedTicketLabelMutationResult>('ticketLabels.reorder', {
      ids
    }),
  delete: async (id: string): Promise<SavedTicketLabelMutationResult> =>
    getRendererRpcClient().request<SavedTicketLabelMutationResult>('ticketLabels.delete', { id }),
  /** Saved label id -> how many tickets carry it (archived included), for the delete confirm. */
  usage: async (): Promise<Record<string, number>> =>
    getRendererRpcClient().request<Record<string, number>>('ticketLabels.usage', {})
}
