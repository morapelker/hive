import { useEffect } from 'react'
import { documentFlowApi } from '@/api/document-flow-api'
import { getRendererRpcClient } from '@/api/rpc-client'
import type { HiveClient } from '@/api/hive-client'
import { cancelRunBoardReloads, scheduleRunBoardReload } from '@/lib/document-flow/board-sync'
import { startMigrationWatcher } from '@/lib/document-flow/migrations'
import { DocumentFlowRunner } from '@/lib/document-flow/runner'
import { createLiveRunnerPorts } from '@/lib/document-flow/runner-ports'
import { useDocumentFlowStore } from '@/stores/useDocumentFlowStore'

const swallow = (): void => {}

/**
 * Mount-once (AppLayout): keeps the document-flow store in sync with the server
 * (`documentFlow:updated`) and the board with what the server wrote to it, loads the runs,
 * drives every launched run this client owns, and follows the migration sessions of the
 * finished ones.
 */
export function useDocumentFlowRunner(): void {
  useEffect(() => {
    const store = useDocumentFlowStore.getState()
    let unsubscribeUpdates: () => void = swallow
    let unsubscribeOpen: () => void = swallow
    try {
      unsubscribeUpdates = documentFlowApi.onUpdated((event) => {
        useDocumentFlowStore.getState().handleUpdated(event)
        // The service also writes to the board (a run's ticket, an orchestrator's tickets)
        scheduleRunBoardReload(event)
      })
      // Pushes sent while the socket was down are gone; a reconnect re-reads everything.
      const client = getRendererRpcClient() as Partial<Pick<HiveClient, 'onOpen'>>
      if (typeof client.onOpen === 'function') {
        unsubscribeOpen = client.onOpen(() => {
          void useDocumentFlowStore.getState().loadRuns()
        })
      }
    } catch {
      // No RPC client (tests, detached windows): nothing to sync.
    }
    void store.loadRuns()

    const runner = new DocumentFlowRunner(createLiveRunnerPorts())
    runner.start()
    const stopMigrationWatcher = startMigrationWatcher()

    return () => {
      runner.stop()
      stopMigrationWatcher()
      unsubscribeUpdates()
      unsubscribeOpen()
      cancelRunBoardReloads()
    }
  }, [])
}
