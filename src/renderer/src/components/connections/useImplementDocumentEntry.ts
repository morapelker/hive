import { useCallback, useMemo, useState } from 'react'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { useDocumentFlowStore } from '@/stores/useDocumentFlowStore'

/** The little a connection row needs to expose to offer "Implement Document…". */
export interface ImplementDocumentConnection {
  id: string
  saved_project_id?: string | null
  members?: { project_id: string }[] | null
}

export interface ImplementDocumentEntry {
  /** Whether the row gets the menu item at all. */
  available: boolean
  /** Promoting an ad-hoc connection to a project is in flight; the item is disabled meanwhile. */
  busy: boolean
  open: () => Promise<void>
}

/** Ad-hoc connections need the same shape as "Save as Project": at least two member projects. */
export function distinctMemberProjectCount(connection: ImplementDocumentConnection): number {
  return new Set((connection.members ?? []).map((m) => m.project_id)).size
}

/**
 * "Implement Document…" for a connection row (sidebar instance, pinned instance or an
 * ad-hoc connection). An instance opens the wizard on its connection project; an ad-hoc
 * connection is first promoted through "Save as Project" and the wizard opens on the new
 * project — the run needs a project to own its tickets, integration instance and report.
 */
export function useImplementDocumentEntry(
  connection: ImplementDocumentConnection | null | undefined
): ImplementDocumentEntry {
  const saveConnectionAsProject = useConnectionStore((s) => s.saveConnectionAsProject)
  const [busy, setBusy] = useState(false)

  const savedProjectId = connection?.saved_project_id ?? null
  const memberProjectCount = useMemo(
    () => (connection ? distinctMemberProjectCount(connection) : 0),
    [connection]
  )
  const available = savedProjectId !== null || memberProjectCount >= 2

  const open = useCallback(async (): Promise<void> => {
    if (!connection || !available) return
    if (savedProjectId) {
      useDocumentFlowStore.getState().openWizard(savedProjectId)
      return
    }
    if (busy) return
    setBusy(true)
    try {
      // The store already toasts on failure and returns null; nothing to open then.
      const projectId = await saveConnectionAsProject(connection.id)
      if (projectId) useDocumentFlowStore.getState().openWizard(projectId)
    } finally {
      setBusy(false)
    }
  }, [connection, available, savedProjectId, busy, saveConnectionAsProject])

  return { available, busy, open }
}
