import { useCallback, useMemo, useState } from 'react'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { useDocumentFlowStore, type OpenWizardOptions } from '@/stores/useDocumentFlowStore'

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
  /** "Implement Document…": the wizard on a document. */
  open: () => Promise<void>
  /** "Orchestrate tickets…": the wizard on the project's board tickets. */
  orchestrate: () => Promise<void>
}

const ORCHESTRATE: OpenWizardOptions = { source: 'tickets' }

/** Ad-hoc connections need the same shape as "Save as Project": at least two member projects. */
export function distinctMemberProjectCount(connection: ImplementDocumentConnection): number {
  return new Set((connection.members ?? []).map((m) => m.project_id)).size
}

/**
 * "Implement Document…" for a connection row (sidebar instance, pinned instance or an
 * ad-hoc connection). An instance opens the wizard on its connection project; an ad-hoc
 * connection is first promoted through "Save as Project" and the wizard opens on the new
 * project — the run needs a project to own its tickets, integration instance and report.
 * "Orchestrate tickets…" sits next to it with the same gating and the same promotion: the
 * wizard then starts on the project's board tickets (an ad-hoc connection's new project has
 * none yet, and the picker says so).
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

  const openWizard = useCallback(
    async (options?: OpenWizardOptions): Promise<void> => {
      // The document path's call stays exactly `openWizard(projectId)`
      const show = (projectId: string): void =>
        options
          ? useDocumentFlowStore.getState().openWizard(projectId, null, options)
          : useDocumentFlowStore.getState().openWizard(projectId)
      if (!connection || !available) return
      if (savedProjectId) {
        show(savedProjectId)
        return
      }
      if (busy) return
      setBusy(true)
      try {
        // The store already toasts on failure and returns null; nothing to open then.
        const projectId = await saveConnectionAsProject(connection.id)
        if (projectId) show(projectId)
      } finally {
        setBusy(false)
      }
    },
    [connection, available, savedProjectId, busy, saveConnectionAsProject]
  )
  const open = useCallback(() => openWizard(), [openWizard])
  const orchestrate = useCallback(() => openWizard(ORCHESTRATE), [openWizard])

  return { available, busy, open, orchestrate }
}
