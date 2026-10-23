import type { ServerEvent } from '@shared/rpc/protocol'
import {
  DATA_CONSOLE_CHANNEL,
  isDataConsoleEvent,
  type DataConsoleEvent,
  type DataConsoleListResponse
} from '@shared/data-projects/console-types'
import { getRendererRpcClient } from './rpc-client'

const request = <T>(method: string, params: object): Promise<T> =>
  getRendererRpcClient().request<T>(method, params)

/**
 * The console log of data projects (server: src/server/rpc/domains/data-console.ts): every
 * statement the app sent to a project's server, masked like history, kept in server memory.
 * Desktop-only like the rest of `dataProjects.*`: device principals are refused by the
 * remote-access policy and by the domain's own principal guard.
 */
export const dataConsoleApi = {
  /** The project's entries, oldest first; with `since`, only newer ones. */
  list: (id: string, since?: number): Promise<DataConsoleListResponse> =>
    request('dataProjects.console.list', since === undefined ? { id } : { id, since }),
  /** Empties the project's log (every open console gets a 'cleared' event). */
  clear: (id: string): Promise<{ success: boolean }> =>
    request('dataProjects.console.clear', { id }),
  /** New entries / clears, for every project (filter by `dataProjectId`). */
  onEvent: (callback: (event: DataConsoleEvent) => void): (() => void) =>
    getRendererRpcClient().subscribe(DATA_CONSOLE_CHANNEL, (event: ServerEvent) => {
      if (isDataConsoleEvent(event.payload)) callback(event.payload)
    })
}
