import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { documentFlowApi } from '@/api/document-flow-api'
import { resolvePRContentGeneration } from '@/lib/pr-content-provider'
import { resolvePreferredAgentSdk, useSettingsStore } from '@/stores/useSettingsStore'
import { isTerminalItemStatus } from '@shared/document-flow/planning'
import type { DocumentFlowUpdatedEvent } from '@shared/document-flow-events'
import {
  DEFAULT_DOCUMENT_RUN_CONFIG,
  DOCUMENT_RUN_MAX_PARALLEL_LIMIT,
  type DocumentRun,
  type DocumentRunDetail,
  type DocumentRunGeneration,
  type DocumentRunItem,
  type DocumentRunItemPatch,
  type DocumentRunLaunchConfig,
  type DocumentRunPatch,
  type DocumentRunPromptStyle
} from '@shared/types/document-flow'

/** Last-used run settings, remembered across runs (persisted in localStorage). */
export interface DocumentFlowPrefs {
  maxParallel: number
  interactive: boolean
  promptStyle: DocumentRunPromptStyle
  /** Verify command per project id; an empty string means "none", remembered as such. */
  verifyCommandByProject: Record<string, string>
  defaultLaunch: DocumentRunLaunchConfig | null
}

export interface DocumentFlowWizardState {
  open: boolean
  projectId: string | null
  /** Set once the document has a run (extracting, failed or in preview). */
  runId: string | null
}

interface DocumentFlowState {
  /** Every run this client has loaded, by id. Projection of the server's rows. */
  runsById: Record<string, DocumentRunDetail>
  /** Projects whose run list was fetched at least once. */
  loadedProjects: Record<string, boolean>
  wizard: DocumentFlowWizardState
  /** Run shown in the run dashboard dialog; null = closed. */
  dashboardRunId: string | null
  prefs: DocumentFlowPrefs

  // ── Data ──
  /** Fetch the runs of a project (or all runs). Never throws; failures are logged. */
  loadRuns: (projectId?: string) => Promise<void>
  /** Re-read one run with its events. Returns null (and forgets the run) when it is gone. */
  refreshRun: (runId: string) => Promise<DocumentRunDetail | null>
  applyDetail: (detail: DocumentRunDetail) => void
  applyRun: (run: DocumentRun) => void
  applyItem: (item: DocumentRunItem) => void
  removeRun: (runId: string) => void
  /** Server push: re-read the run (debounced per run), or drop it when deleted. */
  handleUpdated: (event: DocumentFlowUpdatedEvent) => void

  // ── Wizard / dashboard ──
  openWizard: (projectId: string, runId?: string | null) => void
  closeWizard: () => void
  openDashboard: (runId: string) => void
  closeDashboard: () => void

  // ── Actions (RPC wrappers that apply the result; they reject on failure) ──
  createRun: (projectId: string, documentPath: string, notes?: string) => Promise<DocumentRunDetail>
  retryExtraction: (runId: string) => Promise<DocumentRunDetail>
  updateRun: (runId: string, patch: DocumentRunPatch) => Promise<DocumentRun>
  updateItem: (
    runId: string,
    itemId: string,
    patch: DocumentRunItemPatch
  ) => Promise<DocumentRunItem>
  /** Launch a previewed run and remember its settings as the next run's defaults. */
  startRun: (runId: string) => Promise<DocumentRunDetail>
  pauseRun: (runId: string) => Promise<void>
  resumeRun: (runId: string) => Promise<void>
  /** Change how many tickets may hold a slot. The limit gates launches; nothing running stops. */
  setRunMaxParallel: (runId: string, maxParallel: number) => Promise<void>
  cancelRun: (runId: string) => Promise<void>
  /** Skip everything that is not merged yet and finalize with what is. */
  finishRunNow: (runId: string) => Promise<void>
  deleteRun: (runId: string) => Promise<void>
  /** Put a flagged item back into the pipeline: re-judge its session, or relaunch it. */
  retryItem: (runId: string, itemId: string) => Promise<void>
  /** Override the classifier: treat the item as done and queue it for merging. */
  markItemDone: (runId: string, itemId: string) => Promise<void>
  skipItem: (runId: string, itemId: string) => Promise<void>
  setPrefs: (patch: Partial<DocumentFlowPrefs>) => void
}

const DEFAULT_PREFS: DocumentFlowPrefs = {
  maxParallel: DEFAULT_DOCUMENT_RUN_CONFIG.maxParallel,
  interactive: DEFAULT_DOCUMENT_RUN_CONFIG.interactive,
  promptStyle: DEFAULT_DOCUMENT_RUN_CONFIG.promptStyle,
  verifyCommandByProject: {},
  defaultLaunch: null
}

const REFRESH_DEBOUNCE_MS = 120
const refreshTimers = new Map<string, ReturnType<typeof setTimeout>>()

/** Counters a retry starts over with, so a retried item gets its full set of attempts again. */
const RESET_ATTEMPTS: DocumentRunItemPatch = {
  status_detail: null,
  nudge_count: 0,
  conflict_attempts: 0,
  conflict_head: null,
  fix_attempts: 0,
  continue_attempts: 0,
  last_checked_at: null,
  retry_at: null
}

/** The generation model, resolved exactly as the PR flow resolves it. */
export function resolveDocumentFlowGeneration(): DocumentRunGeneration | null {
  const { prContentModel, defaultAgentSdk, availableAgentSdks } = useSettingsStore.getState()
  return resolvePRContentGeneration(
    prContentModel,
    defaultAgentSdk ?? 'claude-code',
    availableAgentSdks
  )
}

export function clampMaxParallel(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_DOCUMENT_RUN_CONFIG.maxParallel
  return Math.min(DOCUMENT_RUN_MAX_PARALLEL_LIMIT, Math.max(1, Math.round(value)))
}

export const useDocumentFlowStore = create<DocumentFlowState>()(
  persist(
    (set, get) => ({
      runsById: {},
      loadedProjects: {},
      wizard: { open: false, projectId: null, runId: null },
      dashboardRunId: null,
      prefs: DEFAULT_PREFS,

      loadRuns: async (projectId) => {
        try {
          const details = await documentFlowApi.list(projectId)
          set((state) => {
            const runsById = { ...state.runsById }
            const listed = new Set(details.map((detail) => detail.run.id))
            // Runs of this project that the server no longer lists were deleted elsewhere.
            for (const [id, detail] of Object.entries(runsById)) {
              const inScope = projectId === undefined || detail.run.project_id === projectId
              if (inScope && !listed.has(id)) delete runsById[id]
            }
            for (const detail of details) {
              // List results carry no events; keep the ones already loaded.
              const events = runsById[detail.run.id]?.events ?? []
              runsById[detail.run.id] = { ...detail, events }
            }
            return {
              runsById,
              loadedProjects:
                projectId === undefined
                  ? state.loadedProjects
                  : { ...state.loadedProjects, [projectId]: true }
            }
          })
        } catch (error) {
          console.error('[documentFlow] failed to load runs', error)
        }
      },

      refreshRun: async (runId) => {
        try {
          const detail = await documentFlowApi.get(runId)
          if (!detail) {
            get().removeRun(runId)
            return null
          }
          get().applyDetail(detail)
          return detail
        } catch (error) {
          console.error('[documentFlow] failed to refresh run', runId, error)
          return get().runsById[runId] ?? null
        }
      },

      applyDetail: (detail) =>
        set((state) => ({ runsById: { ...state.runsById, [detail.run.id]: detail } })),

      applyRun: (run) =>
        set((state) => {
          const existing = state.runsById[run.id]
          return {
            runsById: {
              ...state.runsById,
              [run.id]: { run, items: existing?.items ?? [], events: existing?.events ?? [] }
            }
          }
        }),

      applyItem: (item) =>
        set((state) => {
          const existing = state.runsById[item.run_id]
          if (!existing) return state
          const items = existing.items.some((candidate) => candidate.id === item.id)
            ? existing.items.map((candidate) => (candidate.id === item.id ? item : candidate))
            : [...existing.items, item].sort((a, b) => a.position - b.position)
          return { runsById: { ...state.runsById, [item.run_id]: { ...existing, items } } }
        }),

      removeRun: (runId) =>
        set((state) => {
          if (!state.runsById[runId]) return state
          const runsById = { ...state.runsById }
          delete runsById[runId]
          return {
            runsById,
            dashboardRunId: state.dashboardRunId === runId ? null : state.dashboardRunId,
            wizard: state.wizard.runId === runId ? { ...state.wizard, runId: null } : state.wizard
          }
        }),

      handleUpdated: (event) => {
        const pending = refreshTimers.get(event.runId)
        if (pending) clearTimeout(pending)
        if (event.reason === 'deleted') {
          refreshTimers.delete(event.runId)
          get().removeRun(event.runId)
          return
        }
        refreshTimers.set(
          event.runId,
          setTimeout(() => {
            refreshTimers.delete(event.runId)
            void get().refreshRun(event.runId)
          }, REFRESH_DEBOUNCE_MS)
        )
      },

      openWizard: (projectId, runId = null) => set({ wizard: { open: true, projectId, runId } }),
      closeWizard: () => set((state) => ({ wizard: { ...state.wizard, open: false } })),
      openDashboard: (runId) => {
        set({ dashboardRunId: runId })
        void get().refreshRun(runId)
      },
      closeDashboard: () => set({ dashboardRunId: null }),

      createRun: async (projectId, documentPath, notes) => {
        const trimmedNotes = notes?.trim()
        const detail = await documentFlowApi.createRun({
          projectId,
          documentPath,
          generation: resolveDocumentFlowGeneration(),
          ...(trimmedNotes ? { notes: trimmedNotes } : {})
        })
        get().applyDetail(detail)
        set((state) => ({ wizard: { ...state.wizard, projectId, runId: detail.run.id } }))
        return detail
      },

      retryExtraction: async (runId) => {
        const detail = await documentFlowApi.retryExtraction({
          runId,
          generation: resolveDocumentFlowGeneration()
        })
        get().applyDetail(detail)
        return detail
      },

      updateRun: async (runId, patch) => {
        const run = await documentFlowApi.updateRun(runId, patch)
        get().applyRun(run)
        return run
      },

      updateItem: async (runId, itemId, patch) => {
        const item = await documentFlowApi.updateItem(runId, itemId, patch)
        get().applyItem(item)
        return item
      },

      startRun: async (runId) => {
        const detail = await documentFlowApi.start(runId, resolvePreferredAgentSdk())
        get().applyDetail(detail)
        const { config, project_id: projectId } = detail.run
        get().setPrefs({
          maxParallel: clampMaxParallel(config.maxParallel),
          interactive: config.interactive,
          promptStyle: config.promptStyle,
          defaultLaunch: config.defaultLaunch,
          verifyCommandByProject: {
            ...get().prefs.verifyCommandByProject,
            [projectId]: config.verifyCommand ?? ''
          }
        })
        return detail
      },

      pauseRun: async (runId) => {
        await get().updateRun(runId, { status: 'paused' })
      },

      resumeRun: async (runId) => {
        await get().updateRun(runId, { status: 'running' })
      },

      setRunMaxParallel: async (runId, maxParallel) => {
        // Only this field: the server merges it into the config the run has by then.
        await get().updateRun(runId, { config: { maxParallel: clampMaxParallel(maxParallel) } })
      },

      cancelRun: async (runId) => {
        get().applyDetail(await documentFlowApi.cancel(runId))
      },

      finishRunNow: async (runId) => {
        // Paused first: the orchestrator starts nothing new while the rest is closed.
        if (get().runsById[runId]?.run.status === 'running') {
          await get().updateRun(runId, { status: 'paused' })
        }
        const detail = (await get().refreshRun(runId)) ?? get().runsById[runId]
        if (!detail) return
        const finishedAt = new Date().toISOString()
        for (const item of detail.items) {
          if (!item.selected || isTerminalItemStatus(item.status)) continue
          // Its merge is already on the branch: finalizing counts it as merged, not skipped.
          if (item.merge_sha) continue
          await get().updateItem(runId, item.id, {
            status: 'skipped',
            status_detail: 'Skipped when the run was finished early.',
            finished_at: finishedAt
          })
        }
        get().applyDetail(await documentFlowApi.finalize(runId))
      },

      deleteRun: async (runId) => {
        await documentFlowApi.delete(runId)
        get().removeRun(runId)
      },

      retryItem: async (runId, itemId) => {
        const item = get().runsById[runId]?.items.find((candidate) => candidate.id === itemId)
        if (!item) return
        // With a session there is work to judge again; without one the launch itself failed.
        await get().updateItem(runId, itemId, {
          ...RESET_ATTEMPTS,
          status: item.session_id ? 'checking' : 'pending',
          finished_at: null
        })
      },

      markItemDone: async (runId, itemId) => {
        await get().updateItem(runId, itemId, {
          ...RESET_ATTEMPTS,
          status: 'ready',
          status_detail: 'Marked done by you.',
          finished_at: null
        })
      },

      skipItem: async (runId, itemId) => {
        await get().updateItem(runId, itemId, {
          status: 'skipped',
          status_detail: 'Skipped by you.',
          finished_at: new Date().toISOString()
        })
      },

      setPrefs: (patch) => set((state) => ({ prefs: { ...state.prefs, ...patch } }))
    }),
    {
      name: 'hive-document-flow',
      storage: createJSONStorage(() => localStorage),
      // Inclusion-based: only the remembered run settings persist; runs always refetch.
      partialize: (state) => ({ prefs: state.prefs }),
      merge: (persisted, current) => ({
        ...current,
        prefs: { ...DEFAULT_PREFS, ...((persisted as { prefs?: DocumentFlowPrefs })?.prefs ?? {}) }
      })
    }
  )
)

/** Runs of a project, newest first. */
export function selectRunsForProject(
  runsById: Record<string, DocumentRunDetail>,
  projectId: string
): DocumentRunDetail[] {
  return Object.values(runsById)
    .filter((detail) => detail.run.project_id === projectId)
    .sort((a, b) => b.run.created_at.localeCompare(a.run.created_at))
}

/** Runs the orchestrator is (or could be) driving: launched and not finished. */
export function selectActiveRuns(runsById: Record<string, DocumentRunDetail>): DocumentRunDetail[] {
  return Object.values(runsById)
    .filter((detail) => detail.run.status === 'running' || detail.run.status === 'paused')
    .sort((a, b) => a.run.created_at.localeCompare(b.run.created_at))
}
