// SQL workspace state per data project: the tab strip (query tabs with their drafts, table tabs,
// Processes / History / Saved queries / Console), the active tab, the explorer's database/schema, and the
// last run of each query tab.
//
// Persisted (localStorage, per project): tabs, drafts, active tab, explorer database/schema and
// layout sizes. Never persisted: run results (can be huge), running query ids, completion
// schemas, staged table edits. Drafts go through `maskSqlSecrets` before they are written
// (`IDENTIFIED BY '…'`, `PASSWORD '…'` → '***'), the same masking history uses, and are
// size-capped so a pasted dump cannot blow the localStorage quota (a failed write is swallowed:
// persistence is best effort). Writes are throttled (drafts change per keystroke) and flushed on
// page hide / unload.
//
// Staged table edits live in TableDataView (component state); it reports how many it holds per
// table tab (`setStagedEditCount`) so closing a tab, closing others, switching projects or
// editing the connection can ask before they are dropped.
//
// Other agents use: `getActiveContext(projectId)` (AI assistant: active database/schema/editor
// text), `openSpecialTab(projectId, 'processes' | 'history' | 'saved' | 'console')` (toolbar
// buttons), `openTable`,
// `openQuery`, `applyInsertion` / `consumeBridge` (the editor bridge: assistant proposals,
// history, saved queries and schema actions land in the active query tab or a new one),
// `hasPendingEdits` + `confirmDiscardPendingEdits` (before leaving a project or applying a
// connection edit) and `forgetDataWorkspace` (project removed).

import { create } from 'zustand'
import { persist, type PersistStorage, type StorageValue } from 'zustand/middleware'
import type {
  DataCompletionSchema,
  DataObjectRef,
  DataStatementResult
} from '@shared/data-projects/types'
import { maskSqlSecrets } from '@shared/sql'
import { dataProjectsApi } from '@/api/data-projects-api'
import {
  selectPendingFor,
  useDataEditorBridge,
  type DataEditorInsertion
} from '@/components/data-projects/editor-bridge'

// ---------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------

export type DataSpecialTabKind = 'processes' | 'history' | 'saved' | 'console'
export type DataTableView = 'data' | 'structure' | 'ddl'
export type DataTabOrigin = NonNullable<DataEditorInsertion['origin']>

export interface DataQueryTab {
  id: string
  kind: 'query'
  title: string
  text: string
  /** Text when opened / last saved: the tab shows a dirty dot while `text` differs. */
  baseline: string
  /** Database the tab runs in; undefined = the explorer's database. */
  database?: string
  /** PG schema (search_path head); undefined = the explorer's schema. */
  schema?: string
  /** Auto-limit of this tab (0 = none); undefined = the project's default limit. */
  limit?: number
  /** Badge until the text is edited or run ("AI", "History", ...). */
  origin?: DataTabOrigin
  /** Linked saved query (Save updates it instead of creating a new one). */
  savedQueryId?: string
}

export interface DataTableTab {
  id: string
  kind: 'table'
  title: string
  ref: DataObjectRef
  view: DataTableView
}

export interface DataSpecialTab {
  id: string
  kind: DataSpecialTabKind
  title: string
}

export type DataWorkspaceTab = DataQueryTab | DataTableTab | DataSpecialTab

export interface DataProjectWorkspace {
  tabs: DataWorkspaceTab[]
  activeTabId: string | null
  /** Most recently active query tab (its text is the assistant's editor context). */
  lastQueryTabId: string | null
  /** Next "Query N" number. */
  queryCounter: number
  /** Database / schema picked in the explorer; new query tabs start there. */
  database?: string
  schema?: string
}

export type QueryRunStatus = 'running' | 'ok' | 'cancelled' | 'declined' | 'blocked' | 'error'

export interface QueryRunTarget {
  text: string
  from: number
  to: number
  mode: 'current' | 'selection' | 'all'
}

export interface QueryTabRun {
  /** Increases per run; late completions of an older run are ignored. */
  runId: number
  status: QueryRunStatus
  target: QueryRunTarget
  /** The queryId of the request in flight (for Cancel), null when none. */
  queryId: string | null
  /** Date.now() when the run started / finished. */
  startedAt: number
  finishedAt?: number
  database?: string
  /** PG schema (search_path head) the run used; a full export re-runs the text with it. */
  schema?: string
  limit: number | null
  explain?: boolean
  statements: DataStatementResult[]
  durationMs?: number
  inTransaction?: boolean
  /** Request-level error (connection lost, invalid input...). */
  error?: string
  /** Why a run was refused (read-only mode / never-allowed statement). */
  blockedReason?: string
  /** Index into the result sets (rows outputs); -1 = Messages. */
  activeResult: number
  /** Cancel was requested and has not been answered yet. */
  cancelRequested?: boolean
}

export interface CompletionEntry {
  status: 'loading' | 'ready' | 'error'
  schema: DataCompletionSchema | null
  error?: string
}

export interface DataActiveContext {
  database?: string
  schema?: string
  editorText?: string
}

/** "Discard the staged edits?" asked from outside the workspace (project switch, connection edit). */
export interface DataDiscardEditsRequest {
  id: number
  projectId: string
  /** Staged edits when asked (what the question shows). */
  count: number
  /** False: a Discard answer only resolves true; the caller drops the edits once its change went through. */
  discard: boolean
  resolve: (discard: boolean) => void
}

interface DataWorkspaceState {
  workspaces: Record<string, DataProjectWorkspace>
  /** Explorer (schema tree) width, px. */
  explorerWidth: number
  /** Share of a query tab's height taken by the editor (0.15–0.85). */
  editorFraction: number
  runs: Record<string, QueryTabRun>
  /** Bumped after every run/clear so History panels refetch. */
  historyVersion: Record<string, number>
  /** `${projectId}\u0000${database}` → completion schema. */
  completion: Record<string, CompletionEntry>
  /** Staged (uncommitted) edits per table tab id; absent = none. Memory only. */
  stagedEdits: Record<string, number>
  /** Bumped when the user chose to discard a project's staged edits: table views drop them. */
  discardEpoch: Record<string, number>
  /** Bumped after a query tab ran DDL: the explorer reloads its objects. */
  schemaVersion: Record<string, number>
  /** Bumped after rows were added outside a table view (an import): open table views reload. */
  tableDataVersion: Record<string, number>
  /** Open "discard staged edits?" question (rendered by the project's SqlWorkspace). */
  discardRequest: DataDiscardEditsRequest | null
  /** Mounted SqlWorkspaces per project (who can answer a discard request). */
  discardHosts: Record<string, number>

  ensureWorkspace: (projectId: string, defaults?: { database?: string; schema?: string }) => void
  openQuery: (
    projectId: string,
    text?: string,
    database?: string,
    options?: { title?: string; origin?: DataTabOrigin; savedQueryId?: string; schema?: string }
  ) => string
  openTable: (projectId: string, ref: DataObjectRef, view?: DataTableView) => string
  openSpecialTab: (projectId: string, kind: DataSpecialTabKind) => string
  closeTab: (projectId: string, tabId: string) => void
  closeOtherTabs: (projectId: string, tabId: string) => void
  closeTabsToRight: (projectId: string, tabId: string) => void
  /** Closes the given tabs (Close others / Close to the right after the workspace asked). */
  closeTabs: (projectId: string, tabIds: Iterable<string>) => void
  setActiveTab: (projectId: string, tabId: string) => void
  /** Activates the next (+1) / previous (-1) tab. */
  cycleTab: (projectId: string, step: 1 | -1) => void
  updateQueryText: (projectId: string, tabId: string, text: string) => void
  patchQueryTab: (
    projectId: string,
    tabId: string,
    patch: Partial<
      Pick<
        DataQueryTab,
        'database' | 'schema' | 'limit' | 'title' | 'origin' | 'savedQueryId' | 'baseline'
      >
    >
  ) => void
  setTableView: (projectId: string, tabId: string, view: DataTableView) => void
  setWorkspaceDatabase: (projectId: string, database: string | undefined, schema?: string) => void
  setWorkspaceSchema: (projectId: string, schema: string | undefined) => void
  setExplorerWidth: (width: number) => void
  setEditorFraction: (fraction: number) => void
  /** Places bridge text in the active query tab ('replace') or a new one; returns the tab id. */
  applyInsertion: (insertion: DataEditorInsertion) => string
  /**
   * Applies every editor-bridge insertion waiting for the project, oldest first, and consumes
   * them. Reads the live bridge, so calling it twice (StrictMode effects) applies nothing twice.
   * Returns how many were applied.
   */
  consumeBridge: (projectId: string) => number

  /** TableDataView reports its staged edit count (0 = none, also on unmount). */
  setStagedEditCount: (tabId: string, count: number) => void
  /** Staged edits across the project's table tabs. */
  pendingEditCount: (projectId: string) => number
  /** Asks the project's workspace "discard N staged edits?"; true = discard (or nothing staged). */
  requestDiscardEdits: (projectId: string, options?: { discard?: boolean }) => Promise<boolean>
  /** Answers the open discard request (the dialog's Discard / Keep editing). */
  answerDiscardEdits: (id: number, discard: boolean) => void
  /** Table views of the project drop their staged edits. */
  discardStagedEdits: (projectId: string) => void
  /** A SqlWorkspace of the project mounted (returns the unregister function). */
  registerDiscardHost: (projectId: string) => () => void
  /** A query tab ran DDL: reload the explorer and the project's completion schemas. */
  notifySchemaChanged: (projectId: string) => void
  /** An import (or another write outside the table views) changed a project's rows. */
  notifyTableDataChanged: (projectId: string) => void
  /** Drops everything about a project (removed): tabs, drafts, runs, staged-edit flags. */
  forgetWorkspace: (projectId: string) => void

  startRun: (tabId: string, run: Omit<QueryTabRun, 'runId'>) => number
  /** Patches a run; ignored when `runId` is no longer the tab's current run. */
  updateRun: (tabId: string, runId: number, patch: Partial<QueryTabRun>) => void
  setActiveResult: (tabId: string, index: number) => void
  clearRun: (tabId: string) => void
  bumpHistory: (projectId: string) => void

  loadCompletion: (
    projectId: string,
    database: string | undefined,
    refresh?: boolean
  ) => Promise<void>

  getWorkspace: (projectId: string) => DataProjectWorkspace | undefined
  getActiveTab: (projectId: string) => DataWorkspaceTab | undefined
  getActiveContext: (projectId: string) => DataActiveContext
  reset: () => void
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

export const EXPLORER_MIN_WIDTH = 180
export const EXPLORER_MAX_WIDTH = 520
const DEFAULT_EXPLORER_WIDTH = 260
const DEFAULT_EDITOR_FRACTION = 0.45
/** Persisted drafts: max characters per tab and max tabs per project. */
export const MAX_PERSISTED_DRAFT = 200_000
export const MAX_PERSISTED_TABS = 40

let idCounter = 0
const newTabId = (kind: string): string =>
  `${kind}-${Date.now().toString(36)}-${(idCounter++).toString(36)}-${Math.random().toString(36).slice(2, 7)}`

const SPECIAL_TITLES: Record<DataSpecialTabKind, string> = {
  processes: 'Processes',
  history: 'History',
  saved: 'Saved queries',
  console: 'Console'
}

const emptyWorkspace = (): DataProjectWorkspace => ({
  tabs: [],
  activeTabId: null,
  lastQueryTabId: null,
  queryCounter: 1
})

export const completionKey = (projectId: string, database: string | undefined): string =>
  `${projectId}\u0000${database ?? ''}`

const sameRef = (a: DataObjectRef, b: DataObjectRef): boolean =>
  a.name === b.name &&
  (a.schema ?? '') === (b.schema ?? '') &&
  (a.database ?? '') === (b.database ?? '')

/** True when the query tab has unsaved edits. */
export const isQueryTabDirty = (tab: DataWorkspaceTab): boolean =>
  tab.kind === 'query' && tab.text !== tab.baseline && tab.text.trim() !== ''

function withActive(ws: DataProjectWorkspace, tabId: string): DataProjectWorkspace {
  const tab = ws.tabs.find((t) => t.id === tabId)
  if (!tab) return ws
  return {
    ...ws,
    activeTabId: tabId,
    lastQueryTabId: tab.kind === 'query' ? tabId : ws.lastQueryTabId
  }
}

function makeQueryTab(
  ws: DataProjectWorkspace,
  text: string,
  database: string | undefined,
  options: { title?: string; origin?: DataTabOrigin; savedQueryId?: string; schema?: string } = {}
): { tab: DataQueryTab; counter: number } {
  const counter = ws.queryCounter
  const tab: DataQueryTab = {
    id: newTabId('query'),
    kind: 'query',
    title: options.title?.trim() || `Query ${counter}`,
    text,
    // Text that arrives from elsewhere (AI, history, a saved query) starts clean: closing the
    // tab loses nothing that is not stored somewhere already.
    baseline: text,
    ...(database !== undefined ? { database } : {}),
    ...(options.schema !== undefined ? { schema: options.schema } : {}),
    ...(options.origin ? { origin: options.origin } : {}),
    ...(options.savedQueryId ? { savedQueryId: options.savedQueryId } : {})
  }
  return { tab, counter: counter + 1 }
}

function removeTabs(ws: DataProjectWorkspace, remove: Set<string>): DataProjectWorkspace {
  if (!remove.size) return ws
  const index = ws.tabs.findIndex((t) => t.id === ws.activeTabId)
  const tabs = ws.tabs.filter((t) => !remove.has(t.id))
  let activeTabId = ws.activeTabId
  if (activeTabId && remove.has(activeTabId)) {
    // Activate the neighbour to the right of the closed tab, else the one to its left.
    const after = ws.tabs.slice(index + 1).find((t) => !remove.has(t.id))
    const before = ws.tabs
      .slice(0, Math.max(0, index))
      .reverse()
      .find((t) => !remove.has(t.id))
    activeTabId = (after ?? before)?.id ?? null
  }
  const lastQueryTabId =
    ws.lastQueryTabId && !remove.has(ws.lastQueryTabId)
      ? ws.lastQueryTabId
      : ([...tabs].reverse().find((t) => t.kind === 'query')?.id ?? null)
  const next = { ...ws, tabs, activeTabId, lastQueryTabId }
  return activeTabId ? withActive(next, activeTabId) : next
}

/** What is written to localStorage for one project (secrets masked, sizes capped). */
export function sanitizeWorkspaceForStorage(ws: DataProjectWorkspace): DataProjectWorkspace {
  const keep = ws.tabs.slice(-MAX_PERSISTED_TABS)
  const tabs = keep.map((tab): DataWorkspaceTab => {
    if (tab.kind !== 'query') return tab
    const mask = (s: string): string => {
      const masked = maskSqlSecrets(s)
      return masked.length > MAX_PERSISTED_DRAFT ? masked.slice(0, MAX_PERSISTED_DRAFT) : masked
    }
    return { ...tab, text: mask(tab.text), baseline: mask(tab.baseline) }
  })
  const ids = new Set(tabs.map((t) => t.id))
  return {
    ...ws,
    tabs,
    activeTabId:
      ws.activeTabId && ids.has(ws.activeTabId)
        ? ws.activeTabId
        : (tabs[tabs.length - 1]?.id ?? null),
    lastQueryTabId: ws.lastQueryTabId && ids.has(ws.lastQueryTabId) ? ws.lastQueryTabId : null
  }
}

interface PersistedWorkspaceState {
  workspaces: Record<string, DataProjectWorkspace>
  explorerWidth: number
  editorFraction: number
}

const PERSIST_KEY = 'hive-data-workspace'
/** Drafts change on every keystroke: write at most this often (and on page hide/unload). */
const WRITE_THROTTLE_MS = 400
let pendingWrite: { name: string; value: StorageValue<PersistedWorkspaceState> } | null = null
let writeTimer: ReturnType<typeof setTimeout> | null = null

/**
 * Writes the latest pending state now: drafts masked and capped here (not per keystroke), and
 * a storage failure (quota, disabled storage) is swallowed: persistence is best effort.
 */
export function flushDataWorkspacePersistence(): void {
  if (writeTimer !== null) {
    clearTimeout(writeTimer)
    writeTimer = null
  }
  const write = pendingWrite
  pendingWrite = null
  if (!write) return
  try {
    const state = write.value.state
    const sanitized: StorageValue<PersistedWorkspaceState> = {
      ...write.value,
      state: {
        ...state,
        workspaces: Object.fromEntries(
          Object.entries(state.workspaces).map(([id, ws]) => [id, sanitizeWorkspaceForStorage(ws)])
        )
      }
    }
    localStorage.setItem(write.name, JSON.stringify(sanitized))
  } catch {
    // Best effort: a full quota must not break the workspace.
  }
}

const workspaceStorage: PersistStorage<PersistedWorkspaceState> = {
  getItem: (name) => {
    try {
      const raw = localStorage.getItem(name)
      return raw ? (JSON.parse(raw) as StorageValue<PersistedWorkspaceState>) : null
    } catch {
      return null
    }
  },
  setItem: (name, value) => {
    pendingWrite = { name, value }
    if (writeTimer === null)
      writeTimer = setTimeout(flushDataWorkspacePersistence, WRITE_THROTTLE_MS)
  },
  removeItem: (name) => {
    pendingWrite = null
    try {
      localStorage.removeItem(name)
    } catch {
      // ignore
    }
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', flushDataWorkspacePersistence)
  window.addEventListener('beforeunload', flushDataWorkspacePersistence)
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value))

const OPTIONAL_QUERY_TAB_KEYS = ['database', 'schema', 'limit', 'origin', 'savedQueryId'] as const

let runCounter = 0
let discardRequestCounter = 0
const completionRequests = new Map<string, number>()

const bump = (map: Record<string, number>, key: string): Record<string, number> => ({
  ...map,
  [key]: (map[key] ?? 0) + 1
})

/** The tabs "Close others" / "Close to the right" of `tabId` would close. */
export function tabsClosedBy(
  tabs: DataWorkspaceTab[],
  tabId: string,
  which: 'others' | 'right'
): DataWorkspaceTab[] {
  if (which === 'others') return tabs.filter((t) => t.id !== tabId)
  const index = tabs.findIndex((t) => t.id === tabId)
  return index < 0 ? [] : tabs.slice(index + 1)
}

const initialState = () => ({
  workspaces: {} as Record<string, DataProjectWorkspace>,
  explorerWidth: DEFAULT_EXPLORER_WIDTH,
  editorFraction: DEFAULT_EDITOR_FRACTION,
  runs: {} as Record<string, QueryTabRun>,
  historyVersion: {} as Record<string, number>,
  completion: {} as Record<string, CompletionEntry>,
  stagedEdits: {} as Record<string, number>,
  discardEpoch: {} as Record<string, number>,
  schemaVersion: {} as Record<string, number>,
  tableDataVersion: {} as Record<string, number>,
  discardRequest: null as DataDiscardEditsRequest | null,
  discardHosts: {} as Record<string, number>
})

// ---------------------------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------------------------

export const useDataWorkspaceStore = create<DataWorkspaceState>()(
  persist(
    (set, get) => {
      /** Applies `fn` to the project's workspace (created on demand). */
      const update = (
        projectId: string,
        fn: (ws: DataProjectWorkspace) => DataProjectWorkspace
      ): void => {
        set((state) => {
          const current = state.workspaces[projectId] ?? emptyWorkspace()
          const next = fn(current)
          return next === current && state.workspaces[projectId]
            ? state
            : { workspaces: { ...state.workspaces, [projectId]: next } }
        })
      }

      /** Forgets per-tab memory (runs, staged-edit counts) of closed tabs. */
      const dropRuns = (ids: Iterable<string>): void => {
        set((state) => {
          const runs = { ...state.runs }
          const stagedEdits = { ...state.stagedEdits }
          let changed = false
          for (const id of ids) {
            if (id in runs) {
              delete runs[id]
              changed = true
            }
            for (const key of [id, `${id}::structure`]) {
              if (key in stagedEdits) {
                delete stagedEdits[key]
                changed = true
              }
            }
          }
          return changed ? { runs, stagedEdits } : state
        })
      }

      return {
        ...initialState(),

        ensureWorkspace: (projectId, defaults) => {
          const ws = get().workspaces[projectId]
          if (ws && ws.tabs.length > 0) return
          update(projectId, (current) => {
            const base: DataProjectWorkspace = {
              ...current,
              database: current.database ?? defaults?.database,
              schema: current.schema ?? defaults?.schema
            }
            if (base.tabs.length > 0) return base
            const { tab, counter } = makeQueryTab(base, '', undefined)
            return withActive({ ...base, tabs: [tab], queryCounter: counter }, tab.id)
          })
        },

        openQuery: (projectId, text = '', database, options) => {
          let id = ''
          update(projectId, (ws) => {
            const { tab, counter } = makeQueryTab(ws, text, database, options)
            id = tab.id
            return withActive({ ...ws, tabs: [...ws.tabs, tab], queryCounter: counter }, tab.id)
          })
          return id
        },

        openTable: (projectId, ref, view = 'data') => {
          let id = ''
          update(projectId, (ws) => {
            const existing = ws.tabs.find(
              (t): t is DataTableTab => t.kind === 'table' && sameRef(t.ref, ref)
            )
            if (existing) {
              id = existing.id
              const tabs =
                existing.view === view
                  ? ws.tabs
                  : ws.tabs.map((t) => (t.id === existing.id ? { ...existing, view } : t))
              return withActive({ ...ws, tabs }, existing.id)
            }
            const tab: DataTableTab = {
              id: newTabId('table'),
              kind: 'table',
              title: ref.schema && ref.schema !== 'public' ? `${ref.schema}.${ref.name}` : ref.name,
              ref,
              view
            }
            id = tab.id
            return withActive({ ...ws, tabs: [...ws.tabs, tab] }, tab.id)
          })
          return id
        },

        openSpecialTab: (projectId, kind) => {
          let id = ''
          update(projectId, (ws) => {
            const existing = ws.tabs.find((t) => t.kind === kind)
            if (existing) {
              id = existing.id
              return withActive(ws, existing.id)
            }
            const tab: DataSpecialTab = { id: newTabId(kind), kind, title: SPECIAL_TITLES[kind] }
            id = tab.id
            return withActive({ ...ws, tabs: [...ws.tabs, tab] }, tab.id)
          })
          return id
        },

        closeTab: (projectId, tabId) => {
          update(projectId, (ws) => removeTabs(ws, new Set([tabId])))
          dropRuns([tabId])
        },

        closeOtherTabs: (projectId, tabId) => {
          const ws = get().workspaces[projectId]
          if (!ws) return
          const remove = new Set(ws.tabs.filter((t) => t.id !== tabId).map((t) => t.id))
          update(projectId, (current) => withActive(removeTabs(current, remove), tabId))
          dropRuns(remove)
        },

        closeTabsToRight: (projectId, tabId) => {
          const ws = get().workspaces[projectId]
          if (!ws) return
          const index = ws.tabs.findIndex((t) => t.id === tabId)
          if (index < 0) return
          const remove = new Set(ws.tabs.slice(index + 1).map((t) => t.id))
          update(projectId, (current) => removeTabs(current, remove))
          dropRuns(remove)
        },

        closeTabs: (projectId, tabIds) => {
          const remove = new Set(tabIds)
          if (!remove.size || !get().workspaces[projectId]) return
          update(projectId, (current) => removeTabs(current, remove))
          dropRuns(remove)
        },

        setActiveTab: (projectId, tabId) => update(projectId, (ws) => withActive(ws, tabId)),

        cycleTab: (projectId, step) =>
          update(projectId, (ws) => {
            if (ws.tabs.length < 2) return ws
            const index = ws.tabs.findIndex((t) => t.id === ws.activeTabId)
            const next = ws.tabs[(index + step + ws.tabs.length) % ws.tabs.length]
            return withActive(ws, next.id)
          }),

        updateQueryText: (projectId, tabId, text) =>
          update(projectId, (ws) => {
            let changed = false
            const tabs = ws.tabs.map((t) => {
              if (t.id !== tabId || t.kind !== 'query' || t.text === text) return t
              changed = true
              const next: DataQueryTab = { ...t, text }
              delete next.origin
              return next
            })
            return changed ? { ...ws, tabs } : ws
          }),

        patchQueryTab: (projectId, tabId, patch) =>
          update(projectId, (ws) => ({
            ...ws,
            tabs: ws.tabs.map((t) => {
              if (t.id !== tabId || t.kind !== 'query') return t
              const next: DataQueryTab = {
                ...t,
                ...patch,
                title: patch.title ?? t.title,
                baseline: patch.baseline ?? t.baseline
              }
              // `origin: undefined` / `limit: undefined` in a patch mean "clear".
              for (const key of OPTIONAL_QUERY_TAB_KEYS) {
                if (key in patch && patch[key] === undefined) delete next[key]
              }
              return next
            })
          })),

        setTableView: (projectId, tabId, view) =>
          update(projectId, (ws) => ({
            ...ws,
            tabs: ws.tabs.map((t) => (t.id === tabId && t.kind === 'table' ? { ...t, view } : t))
          })),

        setWorkspaceDatabase: (projectId, database, schema) =>
          update(projectId, (ws) =>
            ws.database === database && (schema === undefined || ws.schema === schema)
              ? ws
              : {
                  ...ws,
                  database,
                  schema: schema ?? (ws.database === database ? ws.schema : undefined)
                }
          ),

        setWorkspaceSchema: (projectId, schema) =>
          update(projectId, (ws) => (ws.schema === schema ? ws : { ...ws, schema })),

        setExplorerWidth: (width) =>
          set({ explorerWidth: clamp(Math.round(width), EXPLORER_MIN_WIDTH, EXPLORER_MAX_WIDTH) }),

        setEditorFraction: (fraction) => set({ editorFraction: clamp(fraction, 0.15, 0.85) }),

        applyInsertion: (insertion) => {
          const projectId = insertion.dataProjectId
          const ws = get().workspaces[projectId]
          const active = ws?.tabs.find((t) => t.id === ws.activeTabId)
          if (insertion.mode === 'replace' && active?.kind === 'query') {
            update(projectId, (current) =>
              withActive(
                {
                  ...current,
                  tabs: current.tabs.map((t) => {
                    if (t.id !== active.id || t.kind !== 'query') return t
                    const next: DataQueryTab = { ...t, text: insertion.text }
                    if (insertion.origin) next.origin = insertion.origin
                    else delete next.origin
                    if (insertion.database) next.database = insertion.database
                    return next
                  })
                },
                active.id
              )
            )
            return active.id
          }
          return get().openQuery(projectId, insertion.text, insertion.database, {
            title: insertion.title,
            origin: insertion.origin
          })
        },

        consumeBridge: (projectId) => {
          const select = selectPendingFor(projectId)
          let applied = 0
          for (
            let next = select(useDataEditorBridge.getState());
            next;
            next = select(useDataEditorBridge.getState())
          ) {
            // Consume first: an insertion that throws while being applied is not retried forever.
            useDataEditorBridge.getState().consume(next.seq)
            get().applyInsertion(next)
            applied++
          }
          return applied
        },

        setStagedEditCount: (tabId, count) =>
          set((state) => {
            const current = state.stagedEdits[tabId] ?? 0
            const next = Math.max(0, Math.floor(count))
            if (current === next) return state
            const stagedEdits = { ...state.stagedEdits }
            if (next) stagedEdits[tabId] = next
            else delete stagedEdits[tabId]
            return { stagedEdits }
          }),

        pendingEditCount: (projectId) => {
          const { workspaces, stagedEdits } = get()
          return (workspaces[projectId]?.tabs ?? []).reduce(
            (sum, t) => sum + (t.kind === 'table' ? tabStagedEditCount(stagedEdits, t.id) : 0),
            0
          )
        },

        requestDiscardEdits: (projectId, options) => {
          const state = get()
          // Nothing staged, or no workspace on screen that could ask (nothing to lose then).
          const count = state.pendingEditCount(projectId)
          if (count === 0 || !state.discardHosts[projectId]) return Promise.resolve(true)
          return new Promise<boolean>((resolve) => {
            const previous = get().discardRequest
            const request: DataDiscardEditsRequest = {
              id: ++discardRequestCounter,
              projectId,
              count,
              discard: options?.discard !== false,
              resolve
            }
            set({ discardRequest: request })
            // A newer question replaces an unanswered one: the older action does not happen.
            previous?.resolve(false)
          })
        },

        answerDiscardEdits: (id, discard) => {
          const request = get().discardRequest
          if (!request || request.id !== id) return
          set({ discardRequest: null })
          if (discard && request.discard) get().discardStagedEdits(request.projectId)
          request.resolve(discard)
        },

        discardStagedEdits: (projectId) =>
          set((state) => {
            // The flags go now (whoever asked may re-check hasPendingEdits right away); the
            // table views drop the edits themselves when they see the new epoch.
            const tabIds = new Set((state.workspaces[projectId]?.tabs ?? []).map((t) => t.id))
            const stagedEdits = Object.fromEntries(
              Object.entries(state.stagedEdits).filter(([id]) => !tabIds.has(id.split('::')[0]))
            )
            return { discardEpoch: bump(state.discardEpoch, projectId), stagedEdits }
          }),

        registerDiscardHost: (projectId) => {
          set((state) => ({ discardHosts: bump(state.discardHosts, projectId) }))
          return () => {
            const left = Math.max(0, (get().discardHosts[projectId] ?? 0) - 1)
            set((state) => {
              const discardHosts = { ...state.discardHosts }
              if (left) discardHosts[projectId] = left
              else delete discardHosts[projectId]
              return { discardHosts }
            })
            // Nobody left to answer: whoever asked may go ahead (the staged edits are gone).
            const request = get().discardRequest
            if (!left && request?.projectId === projectId)
              get().answerDiscardEdits(request.id, true)
          }
        },

        notifyTableDataChanged: (projectId) =>
          set((state) => ({ tableDataVersion: bump(state.tableDataVersion, projectId) })),

        notifySchemaChanged: (projectId) => {
          set((state) => ({ schemaVersion: bump(state.schemaVersion, projectId) }))
          // The server dropped its cached completion schemas on DDL; reload the ones the editors
          // use (other databases of the project included: DDL may name them explicitly).
          for (const key of Object.keys(get().completion)) {
            const [id, database] = key.split('\u0000')
            if (id === projectId) void get().loadCompletion(projectId, database || undefined, true)
          }
        },

        forgetWorkspace: (projectId) => {
          const tabIds = (get().workspaces[projectId]?.tabs ?? []).map((t) => t.id)
          const request = get().discardRequest
          if (request?.projectId === projectId) get().answerDiscardEdits(request.id, true)
          set((state) => {
            const strip = <T>(map: Record<string, T>): Record<string, T> => {
              if (!(projectId in map)) return map
              const next = { ...map }
              delete next[projectId]
              return next
            }
            const completion = Object.fromEntries(
              Object.entries(state.completion).filter(
                ([key]) => key.split('\u0000')[0] !== projectId
              )
            )
            return {
              workspaces: strip(state.workspaces),
              historyVersion: strip(state.historyVersion),
              discardEpoch: strip(state.discardEpoch),
              schemaVersion: strip(state.schemaVersion),
              tableDataVersion: strip(state.tableDataVersion),
              discardHosts: strip(state.discardHosts),
              completion
            }
          })
          dropRuns(tabIds)
          for (const key of [...completionRequests.keys()]) {
            if (key.split('\u0000')[0] === projectId) completionRequests.delete(key)
          }
          useDataEditorBridge.getState().clear(projectId)
        },

        startRun: (tabId, run) => {
          const runId = ++runCounter
          set((state) => ({ runs: { ...state.runs, [tabId]: { ...run, runId } } }))
          return runId
        },

        updateRun: (tabId, runId, patch) =>
          set((state) => {
            const run = state.runs[tabId]
            if (!run || run.runId !== runId) return state
            return { runs: { ...state.runs, [tabId]: { ...run, ...patch } } }
          }),

        setActiveResult: (tabId, index) =>
          set((state) => {
            const run = state.runs[tabId]
            if (!run || run.activeResult === index) return state
            return { runs: { ...state.runs, [tabId]: { ...run, activeResult: index } } }
          }),

        clearRun: (tabId) => dropRuns([tabId]),

        bumpHistory: (projectId) =>
          set((state) => ({
            historyVersion: {
              ...state.historyVersion,
              [projectId]: (state.historyVersion[projectId] ?? 0) + 1
            }
          })),

        loadCompletion: async (projectId, database, refresh = false) => {
          const key = completionKey(projectId, database)
          const existing = get().completion[key]
          if (!refresh && existing && existing.status !== 'error') return
          const seq = (completionRequests.get(key) ?? 0) + 1
          completionRequests.set(key, seq)
          set((state) => ({
            completion: {
              ...state.completion,
              [key]: { status: 'loading', schema: state.completion[key]?.schema ?? null }
            }
          }))
          try {
            const schema = await dataProjectsApi.completionSchema(projectId, database, refresh)
            if (completionRequests.get(key) !== seq) return
            set((state) => ({
              completion: { ...state.completion, [key]: { status: 'ready', schema } }
            }))
          } catch (error) {
            if (completionRequests.get(key) !== seq) return
            const message = error instanceof Error ? error.message : String(error)
            set((state) => ({
              completion: {
                ...state.completion,
                [key]: {
                  status: 'error',
                  schema: state.completion[key]?.schema ?? null,
                  error: message
                }
              }
            }))
          }
        },

        getWorkspace: (projectId) => get().workspaces[projectId],

        getActiveTab: (projectId) => {
          const ws = get().workspaces[projectId]
          return ws?.tabs.find((t) => t.id === ws.activeTabId)
        },

        getActiveContext: (projectId) => {
          const ws = get().workspaces[projectId]
          if (!ws) return {}
          const active = ws.tabs.find((t) => t.id === ws.activeTabId)
          const lastQuery = ws.tabs.find(
            (t): t is DataQueryTab => t.kind === 'query' && t.id === ws.lastQueryTabId
          )
          const strip = (ctx: DataActiveContext): DataActiveContext =>
            Object.fromEntries(Object.entries(ctx).filter(([, v]) => v !== undefined))
          if (active?.kind === 'query') {
            return strip({
              database: active.database ?? ws.database,
              schema: active.schema ?? ws.schema,
              editorText: active.text
            })
          }
          if (active?.kind === 'table') {
            return strip({
              database: active.ref.database ?? ws.database,
              schema: active.ref.schema ?? ws.schema,
              editorText: lastQuery?.text ?? ''
            })
          }
          return strip({
            database: lastQuery?.database ?? ws.database,
            schema: lastQuery?.schema ?? ws.schema,
            editorText: lastQuery?.text ?? ''
          })
        },

        reset: () => {
          completionRequests.clear()
          get().discardRequest?.resolve(false)
          set(initialState())
        }
      }
    },
    {
      name: PERSIST_KEY,
      version: 1,
      storage: workspaceStorage,
      // References only: masking and serialisation happen in the throttled flush.
      partialize: (state): PersistedWorkspaceState => ({
        workspaces: state.workspaces,
        explorerWidth: state.explorerWidth,
        editorFraction: state.editorFraction
      }),
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<DataWorkspaceState>
        const workspaces: Record<string, DataProjectWorkspace> = {}
        for (const [id, ws] of Object.entries(p.workspaces ?? {})) {
          if (!ws || !Array.isArray(ws.tabs)) continue
          workspaces[id] = {
            ...emptyWorkspace(),
            ...ws,
            tabs: ws.tabs.filter(
              (t): t is DataWorkspaceTab =>
                !!t &&
                typeof t.id === 'string' &&
                (t.kind === 'query'
                  ? typeof t.text === 'string'
                  : t.kind === 'table'
                    ? !!t.ref && typeof t.ref.name === 'string'
                    : t.kind === 'processes' ||
                      t.kind === 'history' ||
                      t.kind === 'saved' ||
                      t.kind === 'console')
            )
          }
        }
        return {
          ...current,
          workspaces,
          explorerWidth: clamp(
            typeof p.explorerWidth === 'number' ? p.explorerWidth : DEFAULT_EXPLORER_WIDTH,
            EXPLORER_MIN_WIDTH,
            EXPLORER_MAX_WIDTH
          ),
          editorFraction: clamp(
            typeof p.editorFraction === 'number' ? p.editorFraction : DEFAULT_EDITOR_FRACTION,
            0.15,
            0.85
          )
        }
      }
    }
  )
)

/** Active database / schema / editor text of a project's SQL workspace (AI assistant context). */
export const getActiveContext = (projectId: string): DataActiveContext =>
  useDataWorkspaceStore.getState().getActiveContext(projectId)

/** Opens (or focuses) the Processes / History / Saved queries / Console tab of a project's workspace. */
export const openSpecialTab = (projectId: string, kind: DataSpecialTabKind): string =>
  useDataWorkspaceStore.getState().openSpecialTab(projectId, kind)

/**
 * Staged changes of one table tab: row edits (key = tab id) plus the structure editor's
 * (`<tab id>::structure`, see sql/structure/staged-key.ts).
 */
export const tabStagedEditCount = (stagedEdits: Record<string, number>, tabId: string): number =>
  (stagedEdits[tabId] ?? 0) + (stagedEdits[`${tabId}::structure`] ?? 0)

/** True while a table tab of the project holds staged (uncommitted) edits. */
export const hasPendingEdits = (projectId: string): boolean =>
  useDataWorkspaceStore.getState().pendingEditCount(projectId) > 0

/**
 * Call before leaving a project's workspace (selecting another project, applying a connection
 * edit, closing it): resolves true at once when nothing is staged, otherwise asks "Discard N
 * pending changes?" in the workspace and resolves with the answer (true = go ahead; the staged
 * edits are dropped). False = the user kept editing: do not leave.
 */
export const confirmDiscardPendingEdits = (projectId: string): Promise<boolean> =>
  useDataWorkspaceStore.getState().requestDiscardEdits(projectId)

/**
 * Like confirmDiscardPendingEdits, but a Discard answer leaves the staged edits in place: the
 * caller drops them (useDataWorkspaceStore.getState().discardStagedEdits) once its own change
 * went through, so a failed change keeps them.
 */
export const askDiscardPendingEdits = (projectId: string): Promise<boolean> =>
  useDataWorkspaceStore.getState().requestDiscardEdits(projectId, { discard: false })

/**
 * Forgets a removed project's SQL workspace: its tabs and drafts (also in localStorage, written
 * at once), runs, staged-edit flags, completion schemas and waiting editor-bridge insertions.
 */
export function forgetDataWorkspace(projectId: string): void {
  useDataWorkspaceStore.getState().forgetWorkspace(projectId)
  flushDataWorkspacePersistence()
}
