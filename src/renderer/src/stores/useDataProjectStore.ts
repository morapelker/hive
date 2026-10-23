// Data projects (database connections in the sidebar): the list, live connection statuses,
// which one is open in the main pane, and the global dialogs that act on them (add/edit wizard,
// credentials prompt, change-icon dialog). Persistence and connections live server-side
// (`dataProjects.*` RPC, src/server/rpc/domains/data-projects.ts); this store mirrors them.
//
// Selection contract:
// - `select(id)` makes the data project the main-pane content. It clears the git project,
//   worktree and connection selection (store-coordination), and when the Pinned Board is in
//   front it keeps pinned mode ON and only puts the board "behind" (showContentOverPinnedBoard),
//   so the Pinned Board row / Cmd+P bring the board back. The moment the board shows again (or
//   the regular board view is switched on) the data project selection is dropped.
// - Selecting a git project, worktree or connection clears `selectedDataProjectId` through
//   `clearDataProjectSelection()` (registered below).
// - Staged table edits are never dropped without asking. Entry points that leave the data project
//   run through `leaveDataProjectThen` (store-coordination): at once when nothing is staged,
//   otherwise after the user chose to discard. A selection made without asking first (the clear
//   callback or the board coming forward with edits staged) keeps the data project on screen
//   until the user answered: Discard shows the new selection, Keep editing puts the data project
//   back in front.
//
// Ordering: git projects and data projects share one `sort_order` space (one sidebar list).
// `applySidebarOrder` writes the merged order to both stores locally and persists it with
// `dataProjects.reorderSidebar`. Our own writes do not come back as db:changed (the sync hook
// skips its own origin), so create/duplicate mirror the server's "shift everything down one and
// insert at 0" here, for both kinds.
//
// Secrets: never stored here. The credentials prompt sends what the user types straight to
// `provideSessionSecrets` and keeps nothing.
//
// Removal: what the clients keep per project (tabs and query drafts on disk, runs, recent Mongo
// filters, the assistant conversation) goes with it, after `remove` and for projects a later
// `load` no longer lists (removed elsewhere); the first load also prunes workspaces left on disk
// by projects that no longer exist.

import { create } from 'zustand'
import { dataProjectsApi } from '@/api/data-projects-api'
import { dbApi } from '@/api/db-api'
import { projectApi } from '@/api/project-api'
import { toast } from '@/lib/toast'
import {
  DATA_ENVIRONMENT_DEFAULTS,
  DATA_ENVIRONMENTS,
  DATA_ERROR_CODES,
  DATA_HARD_ROW_CAP,
  DATA_SAFE_MODES,
  DEFAULT_DATA_ROW_LIMIT,
  type DataConnectionStatus,
  type DataEngine,
  type DataEnvironment,
  type DataProject,
  type DataProjectCreateInput,
  type DataProjectIcon,
  type DataProjectUpdateInput,
  type DataSafeMode,
  type DataSecrets,
  type SidebarOrderEntry
} from '@shared/data-projects/types'
import { useKanbanStore } from './useKanbanStore'
import { useProjectStore } from './useProjectStore'
import {
  clearConnectionSelection,
  clearWorktreeSelection,
  registerDataProjectClear,
  registerDataProjectLeaveGuard
} from './store-coordination'

export { leaveDataProjectThen } from './store-coordination'

// ---------------------------------------------------------------------------------------------
// Defaults for new connections (Settings › Databases)
// ---------------------------------------------------------------------------------------------

/**
 * Own settings key, not the `app_settings` blob: paired phones may write that blob, and these
 * defaults decide how strictly a new database connection guards writes.
 */
export const DATA_PROJECT_DEFAULTS_KEY = 'data_projects_defaults'

export interface DataProjectDefaults {
  environment: DataEnvironment
  /** 'auto' = the environment's own default (DATA_ENVIRONMENT_DEFAULTS[env].safeMode). */
  safeMode: DataSafeMode | 'auto'
  /** Auto-limit for query results; 0 = none (the hard cap still applies). */
  defaultLimit: number
  /** Statement timeout for new connections, ms; 0 = none. */
  queryTimeoutMs: number
  /** May the AI assistant read sample rows of new connections. */
  allowAiDataAccess: boolean
}

export const BUILTIN_DATA_PROJECT_DEFAULTS: DataProjectDefaults = {
  environment: 'development',
  safeMode: 'auto',
  defaultLimit: DEFAULT_DATA_ROW_LIMIT,
  queryTimeoutMs: 0,
  allowAiDataAccess: false
}

const MAX_QUERY_TIMEOUT_MS = 24 * 60 * 60 * 1000

/** Field-by-field validation: a bad or partial blob degrades to the built-in values. */
export function parseDataProjectDefaults(raw: string | null | undefined): DataProjectDefaults {
  if (!raw) return { ...BUILTIN_DATA_PROJECT_DEFAULTS }
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return { ...BUILTIN_DATA_PROJECT_DEFAULTS }
  }
  if (!value || typeof value !== 'object') return { ...BUILTIN_DATA_PROJECT_DEFAULTS }
  const v = value as Record<string, unknown>
  const isInt = (n: unknown, max: number): n is number =>
    typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= max
  return {
    environment: (DATA_ENVIRONMENTS as readonly unknown[]).includes(v.environment)
      ? (v.environment as DataEnvironment)
      : BUILTIN_DATA_PROJECT_DEFAULTS.environment,
    safeMode:
      v.safeMode === 'auto' || (DATA_SAFE_MODES as readonly unknown[]).includes(v.safeMode)
        ? (v.safeMode as DataSafeMode | 'auto')
        : BUILTIN_DATA_PROJECT_DEFAULTS.safeMode,
    defaultLimit: isInt(v.defaultLimit, DATA_HARD_ROW_CAP)
      ? v.defaultLimit
      : BUILTIN_DATA_PROJECT_DEFAULTS.defaultLimit,
    queryTimeoutMs: isInt(v.queryTimeoutMs, MAX_QUERY_TIMEOUT_MS)
      ? v.queryTimeoutMs
      : BUILTIN_DATA_PROJECT_DEFAULTS.queryTimeoutMs,
    allowAiDataAccess:
      typeof v.allowAiDataAccess === 'boolean'
        ? v.allowAiDataAccess
        : BUILTIN_DATA_PROJECT_DEFAULTS.allowAiDataAccess
  }
}

// ---------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------

export type DataProjectWizardRequest =
  | {
      mode: 'create'
      /** Pre-picked engine (skips the engine step). */
      engine?: DataEngine
      /** Pre-filled connection URL (the engine step parses it and jumps ahead). */
      url?: string
    }
  | {
      mode: 'edit'
      projectId: string
      /** Step to open on ('connection' by default). */
      step?: 'connection' | 'details'
    }

export interface CredentialsPromptRequest {
  projectId: string
  /** Why it is asked ("Saved password can't be read on this Mac"). */
  message?: string
}

interface DataProjectState {
  projects: DataProject[]
  /** The first list call finished (successfully or not). */
  loaded: boolean
  isLoading: boolean
  error: string | null
  /** Latest connection status per project (server events + RPC answers). */
  statuses: Record<string, DataConnectionStatus>
  /** Projects whose connect failed with DATA_CREDENTIALS_REQUIRED → the server's message. */
  credentialsRequired: Record<string, string>
  /** Projects that connected at least once this app session (the view keeps its workspace). */
  everConnected: Record<string, true>
  /**
   * Bumped when a project's connection settings or secrets change: the view reconnects on a new
   * value (the server closed the old connections).
   */
  connectionEpoch: Record<string, number>
  selectedDataProjectId: string | null
  assistantOpenById: Record<string, boolean>
  wizard: DataProjectWizardRequest | null
  credentialsPrompt: CredentialsPromptRequest | null
  /** "Change icon…" dialog target. */
  iconDialogProjectId: string | null
  defaults: DataProjectDefaults
  defaultsLoaded: boolean

  load: () => Promise<void>
  getProject: (id: string) => DataProject | undefined
  select: (id: string | null) => void
  create: (input: DataProjectCreateInput) => Promise<DataProject>
  update: (id: string, patch: DataProjectUpdateInput) => Promise<DataProject>
  remove: (id: string) => Promise<boolean>
  duplicate: (id: string) => Promise<DataProject | null>
  /** Opens (or re-opens) the connection; resolves true when connected. Never throws. */
  connect: (id: string) => Promise<boolean>
  /** Connects unless already connected or waiting for credentials. Never throws. */
  ensureConnected: (id: string) => Promise<boolean>
  disconnect: (id: string) => Promise<void>
  applyStatus: (status: DataConnectionStatus) => void
  setSafeMode: (id: string, mode: DataSafeMode) => Promise<boolean>
  setEnvironment: (id: string, environment: DataEnvironment) => Promise<boolean>
  setPinned: (id: string, pinned: boolean) => Promise<boolean>
  setIcon: (id: string, icon: DataProjectIcon | null, iconColor: string | null) => Promise<boolean>
  toggleAssistant: (id: string) => void
  setAssistantOpen: (id: string, open: boolean) => void
  /** Persists a merged sidebar order of git projects and data projects. */
  applySidebarOrder: (entries: SidebarOrderEntry[]) => void
  openWizard: (request?: DataProjectWizardRequest) => void
  closeWizard: () => void
  openCredentialsPrompt: (projectId: string, message?: string) => void
  closeCredentialsPrompt: () => void
  /** Hands typed secrets to the server (this session, or remembered) and reconnects. */
  submitCredentials: (
    projectId: string,
    secrets: DataSecrets,
    remember: boolean
  ) => Promise<boolean>
  openIconDialog: (projectId: string) => void
  closeIconDialog: () => void
  loadDefaults: () => Promise<DataProjectDefaults>
  saveDefaults: (patch: Partial<DataProjectDefaults>) => Promise<boolean>
  /** Tests only. */
  reset: () => void
}

// ---------------------------------------------------------------------------------------------
// Module-level bookkeeping (not state: promises and subscriptions)
// ---------------------------------------------------------------------------------------------

/** One connect per project at a time: workspaces, the view and the assistant share it. */
const inflightConnects = new Map<string, Promise<boolean>>()
let loadSeq = 0
let unsubscribeStatus: (() => void) | null = null

/** Strictness (higher = stricter); mirrors data-project-ui's SAFE_MODE_ORDER. */
const SAFE_MODE_RANK: Readonly<Record<DataSafeMode, number>> = {
  off: 0,
  'half-safe': 1,
  safe: 2,
  'read-only': 3
}

const bySortOrder = (a: DataProject, b: DataProject): number =>
  a.sortOrder - b.sortOrder || a.name.localeCompare(b.name)

const without = <T>(record: Record<string, T>, key: string): Record<string, T> => {
  if (!(key in record)) return record
  const next = { ...record }
  delete next[key]
  return next
}

const pick = <T>(record: Record<string, T>, ids: Set<string>): Record<string, T> => {
  let changed = false
  const next: Record<string, T> = {}
  for (const [key, value] of Object.entries(record)) {
    if (ids.has(key)) next[key] = value
    else changed = true
  }
  return changed ? next : record
}

function errorCode(error: unknown): string | null {
  const name = (error as { name?: unknown } | null)?.name
  return typeof name === 'string' && name.startsWith('DATA_') ? name : null
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

/** Every git project moved down one slot server-side (a data project was inserted at 0). */
function shiftGitProjectsDown(): void {
  useProjectStore.setState((state) => ({
    projects: state.projects.map((p) => ({ ...p, sort_order: (p.sort_order ?? 0) + 1 }))
  }))
}

/**
 * The SQL workspace store once its chunk has loaded (staged table edits can only exist then):
 * leaving a project or applying a connection edit asks before dropping staged edits.
 */
let sqlWorkspace: typeof import('./useDataWorkspaceStore') | null = null
void import('./useDataWorkspaceStore')
  .then((m) => {
    sqlWorkspace = m
  })
  .catch(() => {})

const hasStagedEdits = (projectId: string): boolean =>
  typeof sqlWorkspace?.hasPendingEdits === 'function' && sqlWorkspace.hasPendingEdits(projectId)

/** Resolves true when nothing is staged or the user chose to discard (see confirmDiscardPendingEdits). */
const confirmLeaveStagedEdits = (projectId: string): Promise<boolean> =>
  hasStagedEdits(projectId) && sqlWorkspace
    ? sqlWorkspace.confirmDiscardPendingEdits(projectId)
    : Promise.resolve(true)

/**
 * Asks like confirmLeaveStagedEdits, but a Discard answer leaves the staged edits in place: the
 * caller drops them (discardStagedEdits) once its own change went through, so a failed change
 * keeps them.
 */
const askDiscardStagedEdits = (projectId: string): Promise<boolean> =>
  hasStagedEdits(projectId) && sqlWorkspace
    ? sqlWorkspace.askDiscardPendingEdits(projectId)
    : Promise.resolve(true)

/**
 * The open "discard the staged edits to leave?" question. Whoever wants to leave the same
 * project meanwhile (one click selects a worktree and its project) waits for the same answer
 * instead of replacing the question.
 */
let leaveQuestion: { projectId: string; answer: Promise<boolean> } | null = null

function askToLeave(projectId: string): Promise<boolean> {
  if (leaveQuestion?.projectId === projectId) return leaveQuestion.answer
  const question = { projectId, answer: confirmLeaveStagedEdits(projectId) }
  leaveQuestion = question
  const settle = (): void => {
    if (leaveQuestion === question) leaveQuestion = null
  }
  question.answer.then(settle, settle)
  return question.answer
}

/**
 * Something replaced the data project without asking first while edits are staged: it stays on
 * screen (MainPane shows a selected data project before anything else) until the user answered.
 * Discard → the new selection shows; Keep editing → `restore` puts the data project back in front.
 */
function stayUntilAnswered(projectId: string, restore: () => void): void {
  void askToLeave(projectId).then((leave) => {
    if (useDataProjectStore.getState().selectedDataProjectId !== projectId) return
    if (leave) useDataProjectStore.setState({ selectedDataProjectId: null })
    else restore()
  })
}

/**
 * The selected data project becomes the main-pane content: no git project, worktree or
 * connection stays selected, and the Pinned Board (when on) goes behind it.
 */
function takeMainPane(): void {
  clearWorktreeSelection()
  clearConnectionSelection()
  useProjectStore.setState((state) =>
    state.selectedProjectId === null ? state : { selectedProjectId: null }
  )
  // In front of the Pinned Board without switching pinned mode off.
  useKanbanStore.getState().showContentOverPinnedBoard()
}

/**
 * Drops what the database clients keep about removed projects: SQL / Mongo workspaces (tabs and
 * drafts, also on disk; runs; recent filters) and the assistant conversation. The stores belong
 * to the client's lazily loaded chunk, so they are imported here; an export that is missing (an
 * older build of the store) is skipped. With `keep`, also prunes every workspace whose project
 * is not in it (a complete, successfully loaded list only).
 */
function forgetProjectWorkspaces(ids: readonly string[], keep?: ReadonlySet<string>): void {
  if (ids.length === 0 && !keep) return
  void import('./useDataWorkspaceStore')
    .then((m) => {
      sqlWorkspace = m
      if (typeof m.forgetDataWorkspace !== 'function') return
      const stale = new Set(ids)
      if (keep) {
        for (const id of Object.keys(m.useDataWorkspaceStore.getState().workspaces)) {
          if (!keep.has(id)) stale.add(id)
        }
      }
      for (const id of stale) m.forgetDataWorkspace(id)
    })
    .catch(() => {})
  void import('./useMongoWorkspaceStore')
    .then((m) => {
      if (typeof m.forgetMongoWorkspace === 'function') {
        for (const id of ids) m.forgetMongoWorkspace(id)
      }
      if (keep && typeof m.pruneMongoWorkspaces === 'function') m.pruneMongoWorkspaces(keep)
    })
    .catch(() => {})
  if (ids.length === 0) return
  void import('./useDataAssistantStore')
    .then(({ useDataAssistantStore: assistant }) => {
      const drop = (id: string): void => {
        assistant.setState((state) =>
          id in state.conversations ? { conversations: without(state.conversations, id) } : state
        )
      }
      for (const id of ids) {
        const status = assistant.getState().conversations[id]?.status
        // A running answer is cancelled first; its late events find no conversation.
        if (status === 'running')
          void assistant
            .getState()
            .cancel(id)
            .finally(() => drop(id))
        else drop(id)
      }
    })
    .catch(() => {})
}

/** Workspaces left on disk by removed projects are pruned once per app session. */
let workspacesPruned = false

function ensureStatusSubscription(): void {
  if (unsubscribeStatus) return
  try {
    unsubscribeStatus = dataProjectsApi.onStatus((status) => {
      useDataProjectStore.getState().applyStatus(status)
    })
  } catch {
    // RPC client not initialised yet (very early or in tests): the next load() retries.
    unsubscribeStatus = null
  }
}

const initialState = {
  projects: [] as DataProject[],
  loaded: false,
  isLoading: false,
  error: null as string | null,
  statuses: {} as Record<string, DataConnectionStatus>,
  credentialsRequired: {} as Record<string, string>,
  everConnected: {} as Record<string, true>,
  connectionEpoch: {} as Record<string, number>,
  selectedDataProjectId: null as string | null,
  assistantOpenById: {} as Record<string, boolean>,
  wizard: null as DataProjectWizardRequest | null,
  credentialsPrompt: null as CredentialsPromptRequest | null,
  iconDialogProjectId: null as string | null,
  defaults: { ...BUILTIN_DATA_PROJECT_DEFAULTS },
  defaultsLoaded: false
}

// ---------------------------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------------------------

export const useDataProjectStore = create<DataProjectState>()((set, get) => {
  /** Optimistic single-field update with rollback; false (and a toast) on failure. */
  const patchProject = async (
    id: string,
    patch: DataProjectUpdateInput,
    failure: string
  ): Promise<boolean> => {
    const before = get().projects.find((p) => p.id === id)
    if (!before) return false
    set((state) => ({
      projects: state.projects.map((p) => (p.id === id ? ({ ...p, ...patch } as DataProject) : p))
    }))
    try {
      const updated = await dataProjectsApi.update(id, patch)
      set((state) => ({ projects: state.projects.map((p) => (p.id === id ? updated : p)) }))
      return true
    } catch (error) {
      set((state) => ({ projects: state.projects.map((p) => (p.id === id ? before : p)) }))
      toast.error(`${failure}: ${errorText(error, 'unknown error')}`)
      return false
    }
  }

  /** Mirrors the server's create/duplicate: everything moves down one, the new one is on top. */
  const insertOnTop = (project: DataProject): void => {
    set((state) => ({
      projects: [
        project,
        ...state.projects
          .filter((p) => p.id !== project.id)
          .map((p) => ({ ...p, sortOrder: p.sortOrder + 1 }))
      ]
    }))
    shiftGitProjectsDown()
  }

  return {
    ...initialState,

    load: async () => {
      ensureStatusSubscription()
      // The wizard reads the defaults for new connections: have them ready before it opens.
      if (!get().defaultsLoaded) void get().loadDefaults()
      const seq = ++loadSeq
      // Listed before this load started: one created meanwhile is not "removed elsewhere".
      const known = get().projects.map((p) => p.id)
      set({ isLoading: true })
      try {
        const list = await dataProjectsApi.list()
        if (seq !== loadSeq) return
        const projects = Array.isArray(list) ? [...list].sort(bySortOrder) : []
        const ids = new Set(projects.map((p) => p.id))
        // Removed elsewhere (another window, a paired device) since the last load.
        const gone = known.filter((id) => !ids.has(id))
        set((state) => ({
          projects,
          loaded: true,
          isLoading: false,
          error: null,
          statuses: pick(state.statuses, ids),
          credentialsRequired: pick(state.credentialsRequired, ids),
          assistantOpenById: pick(state.assistantOpenById, ids)
        }))
        // Only a real list proves what exists: never prune on a malformed answer.
        if (Array.isArray(list)) {
          const pruneAll = !workspacesPruned
          workspacesPruned = true
          forgetProjectWorkspaces(gone, pruneAll ? ids : undefined)
        }
        // Statuses of projects this renderer has not heard about yet (e.g. after a reload while
        // the server kept connections open): one cheap in-memory lookup each.
        const unknown = projects.filter((p) => !get().statuses[p.id])
        for (const project of unknown) {
          dataProjectsApi
            .status(project.id)
            .then((status) => {
              if (status && typeof status === 'object' && !get().statuses[project.id]) {
                get().applyStatus(status)
              }
            })
            .catch(() => {})
        }
      } catch (error) {
        if (seq !== loadSeq) return
        set({
          loaded: true,
          isLoading: false,
          error: errorText(error, 'Failed to load database connections')
        })
      }
    },

    getProject: (id) => get().projects.find((p) => p.id === id),

    select: (id) => {
      // Staged table edits of the project being left are lost with its view: ask first.
      const current = get().selectedDataProjectId
      if (current && current !== id && hasStagedEdits(current)) {
        void askToLeave(current).then((go) => {
          if (go) get().select(id)
        })
        return
      }
      if (id === null) {
        if (get().selectedDataProjectId !== null) set({ selectedDataProjectId: null })
        return
      }
      set({ selectedDataProjectId: id })
      // Same tick as the selection, like the worktree ↔ connection deconfliction.
      takeMainPane()
      dataProjectsApi
        .touch(id)
        .then(() => {
          const now = new Date().toISOString()
          set((state) => ({
            projects: state.projects.map((p) => (p.id === id ? { ...p, lastAccessedAt: now } : p))
          }))
        })
        .catch(() => {})
    },

    create: async (input) => {
      const project = await dataProjectsApi.create(input)
      insertOnTop(project)
      return project
    },

    update: async (id, patch) => {
      const reconnect = patch.config !== undefined || patch.secrets !== undefined
      // A connection change reconnects the view, which drops staged table edits: ask first, and
      // drop them only once the change is saved (a failed save keeps them).
      const dropStaged = reconnect && hasStagedEdits(id)
      if (dropStaged && !(await askDiscardStagedEdits(id))) {
        throw new Error('Kept the pending table edits; the connection was not changed.')
      }
      const updated = await dataProjectsApi.update(id, patch)
      if (dropStaged) sqlWorkspace?.useDataWorkspaceStore.getState().discardStagedEdits(id)
      set((state) => ({
        projects: state.projects.map((p) => (p.id === id ? updated : p)),
        ...(reconnect
          ? {
              // The server closed the project's connections; the view reconnects on the epoch.
              statuses: { ...state.statuses, [id]: { dataProjectId: id, state: 'disconnected' } },
              credentialsRequired: without(state.credentialsRequired, id),
              everConnected: without(state.everConnected, id),
              connectionEpoch: {
                ...state.connectionEpoch,
                [id]: (state.connectionEpoch[id] ?? 0) + 1
              }
            }
          : {})
      }))
      return updated
    },

    remove: async (id) => {
      const removed = get().projects.find((p) => p.id === id)
      try {
        const result = await dataProjectsApi.delete(id)
        if (!result?.success) {
          toast.error('Failed to remove the database connection')
          return false
        }
      } catch (error) {
        toast.error(
          `Failed to remove the database connection: ${errorText(error, 'unknown error')}`
        )
        return false
      }
      inflightConnects.delete(id)
      forgetProjectWorkspaces([id])
      // The server deletes `<id>.*` icons; wizard uploads are stored under their own key.
      if (removed?.icon?.kind === 'image') {
        projectApi.removeProjectIcon(removed.icon.fileName.replace(/\.[^.]+$/, '')).catch(() => {})
      }
      set((state) => ({
        projects: state.projects.filter((p) => p.id !== id),
        statuses: without(state.statuses, id),
        credentialsRequired: without(state.credentialsRequired, id),
        everConnected: without(state.everConnected, id),
        connectionEpoch: without(state.connectionEpoch, id),
        assistantOpenById: without(state.assistantOpenById, id),
        selectedDataProjectId:
          state.selectedDataProjectId === id ? null : state.selectedDataProjectId,
        credentialsPrompt:
          state.credentialsPrompt?.projectId === id ? null : state.credentialsPrompt,
        iconDialogProjectId: state.iconDialogProjectId === id ? null : state.iconDialogProjectId,
        wizard: state.wizard?.mode === 'edit' && state.wizard.projectId === id ? null : state.wizard
      }))
      return true
    },

    duplicate: async (id) => {
      try {
        const copy = await dataProjectsApi.duplicate(id)
        insertOnTop(copy)
        return copy
      } catch (error) {
        toast.error(`Failed to duplicate: ${errorText(error, 'unknown error')}`)
        return null
      }
    },

    connect: (id) => {
      const existing = inflightConnects.get(id)
      if (existing) return existing
      const run = (async (): Promise<boolean> => {
        set((state) => ({
          statuses: {
            ...state.statuses,
            [id]: {
              ...state.statuses[id],
              dataProjectId: id,
              state: 'connecting',
              error: undefined
            }
          },
          credentialsRequired: without(state.credentialsRequired, id)
        }))
        try {
          let status = await dataProjectsApi.connect(id)
          // A server that answers nothing useful: ask again rather than guessing.
          if (!status || typeof status !== 'object') status = await dataProjectsApi.status(id)
          if (status.state === 'connected' || status.state === 'error') {
            get().applyStatus({ ...status, dataProjectId: id })
            return status.state === 'connected'
          }
          // connect() resolved without a connection: never leave the view spinning on it.
          get().applyStatus({
            ...status,
            dataProjectId: id,
            state: 'error',
            error: status.error ?? 'The server did not open the connection'
          })
          return false
        } catch (error) {
          const code = errorCode(error)
          const message = errorText(error, 'Could not connect')
          if (code === DATA_ERROR_CODES.credentialsRequired) {
            set((state) => ({
              statuses: { ...state.statuses, [id]: { dataProjectId: id, state: 'disconnected' } },
              credentialsRequired: { ...state.credentialsRequired, [id]: message },
              credentialsPrompt: { projectId: id, message }
            }))
            return false
          }
          if (code === DATA_ERROR_CODES.notFound) {
            // Deleted elsewhere: refresh the list so the view shows the "removed" state.
            void get().load()
          }
          set((state) => ({
            statuses: {
              ...state.statuses,
              [id]: { dataProjectId: id, state: 'error', error: message }
            }
          }))
          return false
        } finally {
          inflightConnects.delete(id)
        }
      })()
      inflightConnects.set(id, run)
      return run
    },

    ensureConnected: async (id) => {
      const inflight = inflightConnects.get(id)
      if (inflight) return inflight
      if (get().statuses[id]?.state === 'connected') return true
      // The prompt is open (or was dismissed): don't hammer the server with the same failure.
      if (get().credentialsRequired[id] !== undefined) return false
      return get().connect(id)
    },

    disconnect: async (id) => {
      try {
        const status = await dataProjectsApi.disconnect(id)
        get().applyStatus(
          status && typeof status === 'object'
            ? { ...status, dataProjectId: id }
            : { dataProjectId: id, state: 'disconnected' }
        )
      } catch (error) {
        toast.error(`Failed to disconnect: ${errorText(error, 'unknown error')}`)
      }
    },

    applyStatus: (status) => {
      const id = status.dataProjectId
      set((state) => ({
        statuses: { ...state.statuses, [id]: status },
        ...(status.state === 'connected'
          ? {
              everConnected: state.everConnected[id]
                ? state.everConnected
                : { ...state.everConnected, [id]: true as const },
              credentialsRequired: without(state.credentialsRequired, id)
            }
          : {})
      }))
    },

    setSafeMode: (id, mode) => patchProject(id, { safeMode: mode }, 'Failed to change safe mode'),

    setEnvironment: async (id, environment) => {
      const project = get().projects.find((p) => p.id === id)
      if (!project) return false
      // Never leave a connection less guarded than its new environment's default (moving a
      // connection to production with safe mode off would make writes run unconfirmed).
      const floor = DATA_ENVIRONMENT_DEFAULTS[environment].safeMode
      const raise = SAFE_MODE_RANK[project.safeMode] < SAFE_MODE_RANK[floor]
      const ok = await patchProject(
        id,
        raise ? { environment, safeMode: floor } : { environment },
        'Failed to change the environment'
      )
      if (ok && raise) {
        toast.info(
          `Safe mode raised to ${floor} for ${DATA_ENVIRONMENT_DEFAULTS[environment].label}`
        )
      }
      return ok
    },

    setPinned: (id, pinned) =>
      patchProject(id, { pinned }, pinned ? 'Failed to pin' : 'Failed to unpin'),

    setIcon: (id, icon, iconColor) =>
      patchProject(id, { icon, iconColor }, 'Failed to change the icon'),

    toggleAssistant: (id) =>
      set((state) => ({
        assistantOpenById: { ...state.assistantOpenById, [id]: !state.assistantOpenById[id] }
      })),

    setAssistantOpen: (id, open) =>
      set((state) =>
        !!state.assistantOpenById[id] === open
          ? state
          : { assistantOpenById: { ...state.assistantOpenById, [id]: open } }
      ),

    applySidebarOrder: (entries) => {
      const indexOf = new Map(entries.map((entry, index) => [`${entry.kind}:${entry.id}`, index]))
      set((state) => ({
        projects: state.projects
          .map((p) => {
            const index = indexOf.get(`data:${p.id}`)
            return index === undefined ? p : { ...p, sortOrder: index }
          })
          .sort(bySortOrder)
      }))
      useProjectStore.setState((state) => {
        const ordered = state.projects
          .map((p, position) => ({ p, index: indexOf.get(`project:${p.id}`), position }))
          // Projects missing from the entries keep their place after the ordered ones.
          .sort(
            (a, b) =>
              (a.index ?? Number.MAX_SAFE_INTEGER) - (b.index ?? Number.MAX_SAFE_INTEGER) ||
              a.position - b.position
          )
          .map(({ p, index }) => (index === undefined ? p : { ...p, sort_order: index }))
        return { projects: ordered }
      })
      dataProjectsApi.reorderSidebar(entries).catch((error) => {
        toast.error(`Failed to save the sidebar order: ${errorText(error, 'unknown error')}`)
        // Re-read both lists so the sidebar shows what is actually stored.
        void get().load()
        void useProjectStore.getState().loadProjects()
      })
    },

    openWizard: (request) => set({ wizard: request ?? { mode: 'create' } }),
    closeWizard: () => set({ wizard: null }),

    openCredentialsPrompt: (projectId, message) =>
      set((state) => ({
        credentialsPrompt: {
          projectId,
          message: message ?? state.credentialsRequired[projectId]
        }
      })),
    closeCredentialsPrompt: () => set({ credentialsPrompt: null }),

    submitCredentials: async (projectId, secrets, remember) => {
      try {
        const updated = await dataProjectsApi.provideSessionSecrets(projectId, secrets, remember)
        set((state) => ({
          projects: state.projects.map((p) => (p.id === projectId ? updated : p)),
          credentialsRequired: without(state.credentialsRequired, projectId),
          credentialsPrompt:
            state.credentialsPrompt?.projectId === projectId ? null : state.credentialsPrompt
        }))
      } catch (error) {
        toast.error(`Failed to save the credentials: ${errorText(error, 'unknown error')}`)
        return false
      }
      return get().connect(projectId)
    },

    openIconDialog: (projectId) => set({ iconDialogProjectId: projectId }),
    closeIconDialog: () => set({ iconDialogProjectId: null }),

    loadDefaults: async () => {
      try {
        const raw = await dbApi.setting.get(DATA_PROJECT_DEFAULTS_KEY)
        const defaults = parseDataProjectDefaults(raw)
        set({ defaults, defaultsLoaded: true })
        return defaults
      } catch {
        set({ defaultsLoaded: true })
        return get().defaults
      }
    },

    saveDefaults: async (patch) => {
      const before = get().defaults
      const next = { ...before, ...patch }
      set({ defaults: next })
      try {
        const ok = await dbApi.setting.set(DATA_PROJECT_DEFAULTS_KEY, JSON.stringify(next))
        if (ok === false) throw new Error('the setting was not written')
        return true
      } catch (error) {
        set({ defaults: before })
        toast.error(`Failed to save the database defaults: ${errorText(error, 'unknown error')}`)
        return false
      }
    },

    reset: () => {
      inflightConnects.clear()
      loadSeq++
      workspacesPruned = false
      leaveQuestion = null
      set({ ...initialState, defaults: { ...BUILTIN_DATA_PROJECT_DEFAULTS } })
    }
  }
})

// Leaving the data project with staged table edits asks first (see leaveDataProjectThen).
registerDataProjectLeaveGuard((proceed) => {
  const current = useDataProjectStore.getState().selectedDataProjectId
  if (current === null || !hasStagedEdits(current)) return false
  void askToLeave(current).then((leave) => {
    if (leave) proceed()
  })
  return true
})

// Git project / worktree / connection selection clears the data project (same tick), unless
// table edits are staged: then it stays until the user answered.
registerDataProjectClear(() => {
  const current = useDataProjectStore.getState().selectedDataProjectId
  if (current === null) return
  if (!hasStagedEdits(current)) {
    useDataProjectStore.setState({ selectedDataProjectId: null })
    return
  }
  // Pinned mode as it is now: the new selection may switch it off right after this call.
  const pinnedBoardOn = useKanbanStore.getState().isPinnedBoardActive
  stayUntilAnswered(current, () => {
    takeMainPane()
    if (pinnedBoardOn && !useKanbanStore.getState().isPinnedBoardActive) {
      useKanbanStore.setState({ isPinnedBoardActive: true, isPinnedBoardBehindSession: true })
    }
  })
})

// The Pinned Board coming back to the front (sidebar row, Cmd+P, the palette) or the board
// view being switched on means "show the board": the data project steps aside. The store's
// toggles ask first when edits are staged; any other way waits for the answer here and puts
// the board back behind the data project on "Keep editing".
useKanbanStore.subscribe((state, prev) => {
  const current = useDataProjectStore.getState().selectedDataProjectId
  if (current === null) return
  const showing = state.isPinnedBoardActive && !state.isPinnedBoardBehindSession
  const wasShowing = prev.isPinnedBoardActive && !prev.isPinnedBoardBehindSession
  const pinnedShown = showing && !wasShowing
  const boardOpened = state.isBoardViewActive && !prev.isBoardViewActive
  if (!pinnedShown && !boardOpened) return
  if (!hasStagedEdits(current)) {
    useDataProjectStore.setState({ selectedDataProjectId: null })
    return
  }
  const pinnedWasOn = prev.isPinnedBoardActive
  stayUntilAnswered(current, () => {
    const kanban = useKanbanStore.getState()
    if (boardOpened) kanban.closeBoardView()
    if (pinnedShown) {
      if (pinnedWasOn) kanban.showContentOverPinnedBoard()
      else kanban.closePinnedBoard()
    }
  })
})

/** Selected data project (or undefined) — for components that need the whole DTO. */
export const selectSelectedDataProject = (state: DataProjectState): DataProject | undefined =>
  state.selectedDataProjectId
    ? state.projects.find((p) => p.id === state.selectedDataProjectId)
    : undefined
