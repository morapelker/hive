// Per data project state of the MongoDB workspace: the open tabs (collection tabs with their
// query bar, view, pipeline and schema settings; Shell tabs with their text and database;
// the Processes / History / Saved / Console tabs), the active tab, the explorer's selected database, expanded
// databases and width, and the recent filters per collection. Persisted to localStorage so
// tabs and drafts survive restarts; query results are not (they are re-fetched).
//
// Persistence is best effort and bounded, like the SQL workspace's: writes are throttled (drafts
// change per keystroke) and flushed on page hide / unload; every draft (Shell text, query bar,
// pipeline, stage bodies, recent filters) goes through maskMongoSecrets (pwd / password / … →
// '***') and is capped per draft, per project (tabs) and for the whole store, so a pasted dump
// cannot fill the origin's localStorage quota; a failed write is swallowed. A Shell tab whose
// text was stored masked or cut comes back flagged `masked`: it is not the text that was typed,
// so it never replaces the linked saved query's text (ShellTab reloads that text instead).
//
// Other parts of the app talk to it through:
// - getActiveContext(projectId) — the assistant reads the active database and the text of the
//   active tab (a collection tab is described as the equivalent mongosh statement);
// - openSpecialTab(projectId, 'processes' | 'history' | 'saved' | 'console') — the toolbar
//   buttons;
// - consumeBridge(projectId) — the workspace applies useDataEditorBridge insertions (assistant
//   proposals, history, saved queries) to the active Shell tab or a new one. Nothing here runs
//   a query;
// - forgetMongoWorkspace(projectId) — a removed project's tabs, drafts, recent filters and
//   cached results go (pruneMongoWorkspaces drops every project not in a list).

import { create } from 'zustand'
import { persist, type PersistStorage, type StorageValue } from 'zustand/middleware'
import {
  selectPendingFor,
  useDataEditorBridge,
  type DataEditorInsertion
} from '@/components/data-projects/editor-bridge'
import { maskMongoSecrets } from '@/components/data-projects/mongo/mask'
import { buildPipelineText, type MongoStageDraft } from '@/components/data-projects/mongo/pipeline'
import {
  DEFAULT_PAGE_SIZE,
  EMPTY_QUERY,
  aggregateShellText,
  appendFilterField,
  findShellText,
  type MongoQueryDraft
} from '@/components/data-projects/mongo/requests'
import { forgetMongoCaches } from '@/components/data-projects/mongo/tab-caches'

export type MongoCollectionSubTab = 'documents' | 'aggregations' | 'schema' | 'indexes'
export type MongoDocumentsView = 'list' | 'json' | 'table'
export type MongoSpecialTabKind = 'processes' | 'history' | 'saved' | 'console'

export interface MongoStage extends MongoStageDraft {
  id: string
  /** The preview panel next to the card is expanded. */
  previewOpen: boolean
}

export interface MongoAggregationState {
  stages: MongoStage[]
  /** Text mode: the whole pipeline in one editor (`text`), converted back on leaving it. */
  textMode: boolean
  text: string
  /** Documents returned by Run. */
  limit: number
  /** Re-run a card's preview shortly after it changes. */
  autoPreview: boolean
}

export interface MongoCollectionTab {
  id: string
  kind: 'collection'
  database: string
  collection: string
  /** From the explorer listing: 'collection' | 'view' | 'timeseries' | 'capped'. */
  collectionType?: string
  subTab: MongoCollectionSubTab
  query: MongoQueryDraft
  /** Project / Sort / Collation / Hint / Skip / Limit / maxTimeMS row is shown. */
  optionsOpen: boolean
  view: MongoDocumentsView
  pageSize: number
  aggregation: MongoAggregationState
  aggregationView: MongoDocumentsView
  schemaSampleSize: number
  /**
   * Set when something outside the query bar wrote the filter (Schema tab field click): the
   * Documents view focuses the filter editor and puts the cursor at `cursor`. Not persisted.
   */
  filterFocus?: { seq: number; cursor: number }
}

export interface MongoShellTab {
  id: string
  kind: 'shell'
  title: string
  /** '' = the connection's default database. */
  database: string
  text: string
  /** Text when opened / last saved: closing asks first while `text` differs. */
  baseline: string
  /** Linked saved query (Save updates it instead of creating a new one). */
  savedQueryId?: string
  /**
   * The text was restored from storage with secrets masked ('***') or cut short, so it is not
   * the text that was typed: Save never writes it over the linked saved query, and a linked tab
   * not edited since reloads the saved text. Cleared once the tab holds a saved query's real
   * text again (reloaded, or saved).
   */
  masked?: boolean
  /** Auto-limit for documents results (0 = none; the hard cap still applies). */
  limit: number
  /** Badge until the text is edited or run ('assistant', 'history', ...). */
  origin?: DataEditorInsertion['origin'] | null
  resultView: MongoDocumentsView
}

export interface MongoSpecialTab {
  id: string
  kind: MongoSpecialTabKind
}

export type MongoWorkspaceTab = MongoCollectionTab | MongoShellTab | MongoSpecialTab

export interface MongoProjectWorkspace {
  tabs: MongoWorkspaceTab[]
  activeTabId: string | null
  /** Database selected in the explorer: the default for new Shell tabs. */
  database: string | null
  /** Databases expanded in the explorer. */
  expanded: string[]
  explorerWidth: number
  /** Numbering of "Shell N" titles. */
  shellCounter: number
}

export interface MongoActiveContext {
  database?: string
  schema?: string
  /** Text of the active tab (a collection tab is described as its mongosh statement). */
  editorText?: string
  collection?: string
}

export const MONGO_EXPLORER_WIDTH = { min: 180, max: 520, default: 260 } as const
export const SHELL_LIMITS = [20, 50, 100, 500, 1000, 0] as const
export const DEFAULT_SHELL_LIMIT = 100
export const SCHEMA_SAMPLE_SIZES = [100, 1000, 5000] as const
const FILTER_HISTORY_MAX = 15
const TITLE_MAX = 40
/** Persisted drafts: max characters per draft and max tabs per project (as in the SQL store). */
export const MAX_PERSISTED_DRAFT = 200_000
export const MAX_PERSISTED_TABS = 40
/** Whole persisted store, in JSON characters: the largest drafts are cut beyond it. */
export const MAX_PERSISTED_TOTAL = 1_500_000
/** Recent filters: longer ones are not remembered; at most this many collections keep theirs. */
const FILTER_HISTORY_TEXT_MAX = 10_000
const FILTER_HISTORY_KEYS_MAX = 200

let idSeq = 0
const newId = (prefix: string): string =>
  `${prefix}-${Date.now().toString(36)}-${(++idSeq).toString(36)}${Math.random().toString(36).slice(2, 6)}`

export const newStageId = (): string => newId('stage')

export function defaultAggregation(): MongoAggregationState {
  return {
    stages: [
      { id: newStageId(), operator: '$match', body: '{}', enabled: true, previewOpen: true }
    ],
    textMode: false,
    text: '',
    limit: 20,
    autoPreview: true
  }
}

function emptyWorkspace(database: string | null = null): MongoProjectWorkspace {
  return {
    tabs: [],
    activeTabId: null,
    database,
    expanded: database ? [database] : [],
    explorerWidth: MONGO_EXPLORER_WIDTH.default,
    shellCounter: 0
  }
}

function newCollectionTab(
  database: string,
  collection: string,
  subTab: MongoCollectionSubTab,
  collectionType?: string
): MongoCollectionTab {
  return {
    id: newId('coll'),
    kind: 'collection',
    database,
    collection,
    ...(collectionType ? { collectionType } : {}),
    subTab,
    query: { ...EMPTY_QUERY },
    optionsOpen: false,
    view: 'list',
    pageSize: DEFAULT_PAGE_SIZE,
    aggregation: defaultAggregation(),
    aggregationView: 'list',
    schemaSampleSize: 1000
  }
}

const shortTitle = (title: string): string =>
  title.length > TITLE_MAX ? `${title.slice(0, TITLE_MAX - 1).trimEnd()}…` : title

/** True when the Shell tab holds text that is neither saved nor came from elsewhere unchanged. */
export const isShellTabDirty = (tab: MongoWorkspaceTab): boolean =>
  tab.kind === 'shell' && tab.text !== tab.baseline && tab.text.trim() !== ''

/** Database of a tab, when it has one. */
const tabDatabase = (tab: MongoWorkspaceTab | undefined): string | undefined =>
  tab && (tab.kind === 'collection' || tab.kind === 'shell') && tab.database
    ? tab.database
    : undefined

/** Text the assistant sees for the active tab. */
function tabEditorText(tab: MongoWorkspaceTab): string {
  if (tab.kind === 'shell') return tab.text
  if (tab.kind !== 'collection') return ''
  if (tab.subTab === 'aggregations') {
    const agg = tab.aggregation
    const pipeline = agg.textMode ? agg.text : buildPipelineText(agg.stages)
    return aggregateShellText(tab.collection, pipeline)
  }
  return findShellText(tab.collection, tab.query)
}

// ---------------------------------------------------------------------------------------------
// Persisted-state validation (localStorage may hold anything: older versions, manual edits)
// ---------------------------------------------------------------------------------------------

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback)
const num = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback
const oneOf = <T extends string>(v: unknown, values: readonly T[], fallback: T): T =>
  values.includes(v as T) ? (v as T) : fallback
const VIEWS = ['list', 'json', 'table'] as const
const SUBTABS = ['documents', 'aggregations', 'schema', 'indexes'] as const

function normalizeStage(raw: unknown): MongoStage | null {
  if (!isRecord(raw) || typeof raw.operator !== 'string') return null
  return {
    id: str(raw.id) || newStageId(),
    operator: raw.operator,
    body: str(raw.body, '{}'),
    enabled: raw.enabled !== false,
    previewOpen: raw.previewOpen !== false
  }
}

function normalizeTab(raw: unknown): MongoWorkspaceTab | null {
  if (!isRecord(raw) || typeof raw.id !== 'string') return null
  if (
    raw.kind === 'processes' ||
    raw.kind === 'history' ||
    raw.kind === 'saved' ||
    raw.kind === 'console'
  )
    return { id: raw.id, kind: raw.kind }
  if (raw.kind === 'shell') {
    const text = str(raw.text)
    return {
      id: raw.id,
      kind: 'shell',
      title: str(raw.title, 'Shell'),
      database: str(raw.database),
      text,
      // Not written when equal to the text (and absent in older snapshots): clean.
      baseline: str(raw.baseline, text),
      ...(typeof raw.savedQueryId === 'string' && raw.savedQueryId
        ? { savedQueryId: raw.savedQueryId }
        : {}),
      ...(raw.masked === true ? { masked: true } : {}),
      limit: num(raw.limit, DEFAULT_SHELL_LIMIT),
      origin: (['assistant', 'history', 'saved', 'schema'] as const).includes(
        raw.origin as 'assistant'
      )
        ? (raw.origin as MongoShellTab['origin'])
        : null,
      resultView: oneOf(raw.resultView, VIEWS, 'list')
    }
  }
  if (
    raw.kind !== 'collection' ||
    typeof raw.database !== 'string' ||
    typeof raw.collection !== 'string'
  )
    return null
  const base = newCollectionTab(
    raw.database,
    raw.collection,
    oneOf(raw.subTab, SUBTABS, 'documents')
  )
  const query = isRecord(raw.query) ? raw.query : {}
  const agg = isRecord(raw.aggregation) ? raw.aggregation : {}
  const stages = Array.isArray(agg.stages)
    ? agg.stages.map(normalizeStage).filter((s): s is MongoStage => s !== null)
    : base.aggregation.stages
  return {
    ...base,
    id: raw.id,
    ...(typeof raw.collectionType === 'string' ? { collectionType: raw.collectionType } : {}),
    query: Object.fromEntries(
      Object.keys(EMPTY_QUERY).map((k) => [k, str(query[k])])
    ) as unknown as MongoQueryDraft,
    optionsOpen: raw.optionsOpen === true,
    view: oneOf(raw.view, VIEWS, 'list'),
    pageSize: num(raw.pageSize, DEFAULT_PAGE_SIZE),
    aggregation: {
      stages,
      textMode: agg.textMode === true,
      text: str(agg.text),
      limit: num(agg.limit, 20),
      autoPreview: agg.autoPreview !== false
    },
    aggregationView: oneOf(raw.aggregationView, VIEWS, 'list'),
    schemaSampleSize: num(raw.schemaSampleSize, 1000)
  }
}

function normalizeWorkspace(raw: unknown): MongoProjectWorkspace | null {
  if (!isRecord(raw)) return null
  const tabs = Array.isArray(raw.tabs)
    ? raw.tabs.map(normalizeTab).filter((t): t is MongoWorkspaceTab => t !== null)
    : []
  const activeTabId =
    typeof raw.activeTabId === 'string' && tabs.some((t) => t.id === raw.activeTabId)
      ? raw.activeTabId
      : (tabs[0]?.id ?? null)
  return {
    tabs,
    activeTabId,
    database: typeof raw.database === 'string' ? raw.database : null,
    expanded: Array.isArray(raw.expanded)
      ? raw.expanded.filter((d): d is string => typeof d === 'string')
      : [],
    explorerWidth: Math.min(
      MONGO_EXPLORER_WIDTH.max,
      Math.max(MONGO_EXPLORER_WIDTH.min, num(raw.explorerWidth, MONGO_EXPLORER_WIDTH.default))
    ),
    shellCounter: num(raw.shellCounter, 0)
  }
}

// ---------------------------------------------------------------------------------------------
// Persistence: masked, capped, throttled, best effort
// ---------------------------------------------------------------------------------------------

interface PersistedMongoState {
  workspaces: Record<string, MongoProjectWorkspace>
  filterHistory: Record<string, string[]>
}

/** A draft as written: cut to MAX_PERSISTED_DRAFT, secrets masked (a cut string is masked too). */
function storedDraft(text: string): string {
  if (!text) return text
  const head = text.length > MAX_PERSISTED_DRAFT ? text.slice(0, MAX_PERSISTED_DRAFT) : text
  const masked = maskMongoSecrets(head)
  return masked.length > MAX_PERSISTED_DRAFT ? masked.slice(0, MAX_PERSISTED_DRAFT) : masked
}

/**
 * Stored form per tab object: the store replaces a tab object only when the tab changes, so a
 * flush re-masks just the tab being typed in, not every draft of every project.
 */
const storedTabs = new WeakMap<MongoWorkspaceTab, MongoWorkspaceTab>()

function storedTab(tab: MongoWorkspaceTab): MongoWorkspaceTab {
  let stored = storedTabs.get(tab)
  if (!stored) {
    stored = computeStoredTab(tab)
    storedTabs.set(tab, stored)
  }
  return stored
}

function computeStoredTab(tab: MongoWorkspaceTab): MongoWorkspaceTab {
  if (tab.kind === 'shell') {
    const text = storedDraft(tab.text)
    const baseline = storedDraft(tab.baseline)
    // `baseline` is left out when equal to the text: rehydration reads that as clean.
    const stored: Partial<MongoShellTab> = { ...tab, text, baseline }
    if (baseline === text) delete stored.baseline
    // Comes back as something other than what was typed (see MongoShellTab.masked).
    if (text !== tab.text) stored.masked = true
    return stored as MongoShellTab
  }
  if (tab.kind !== 'collection') return tab
  const { filterFocus: _drop, ...rest } = tab
  return {
    ...rest,
    query: Object.fromEntries(
      Object.entries(tab.query).map(([k, v]) => [k, storedDraft(v)])
    ) as unknown as MongoQueryDraft,
    aggregation: {
      ...tab.aggregation,
      text: storedDraft(tab.aggregation.text),
      stages: tab.aggregation.stages.map((stage) => ({ ...stage, body: storedDraft(stage.body) }))
    }
  }
}

function storedWorkspace(ws: MongoProjectWorkspace): MongoProjectWorkspace {
  // The last MAX_PERSISTED_TABS tabs, and always the active one.
  const keep = new Set(ws.tabs.slice(-MAX_PERSISTED_TABS).map((t) => t.id))
  if (ws.activeTabId && !keep.has(ws.activeTabId) && ws.tabs.some((t) => t.id === ws.activeTabId)) {
    keep.delete(ws.tabs[ws.tabs.length - MAX_PERSISTED_TABS].id)
    keep.add(ws.activeTabId)
  }
  const tabs = ws.tabs.filter((t) => keep.has(t.id)).map(storedTab)
  return {
    ...ws,
    tabs,
    activeTabId:
      ws.activeTabId && keep.has(ws.activeTabId) ? ws.activeTabId : (tabs.at(-1)?.id ?? null)
  }
}

/** Every persisted draft string, as a getter/setter pair (to cut the largest under the budget). */
function draftSlots(
  state: PersistedMongoState
): Array<{ get: () => string; set: (v: string) => void }> {
  const slots: Array<{ get: () => string; set: (v: string) => void }> = []
  const slot = <T extends object, K extends keyof T>(obj: T, key: K, onCut?: () => void): void => {
    if (typeof obj[key] === 'string' && (obj[key] as string).length)
      slots.push({
        get: () => obj[key] as string,
        set: (v) => {
          obj[key] = v as T[K]
          onCut?.()
        }
      })
  }
  for (const ws of Object.values(state.workspaces)) {
    for (const tab of ws.tabs) {
      if (tab.kind === 'shell') {
        slot(tab, 'text', () => (tab.masked = true))
        slot(tab, 'baseline')
      } else if (tab.kind === 'collection') {
        for (const key of Object.keys(tab.query) as Array<keyof MongoQueryDraft>)
          slot(tab.query, key)
        slot(tab.aggregation, 'text')
        for (const stage of tab.aggregation.stages) slot(stage, 'body')
      }
    }
  }
  return slots
}

/**
 * What is written to localStorage: drafts masked and capped, at most MAX_PERSISTED_TABS tabs per
 * project, recent filters masked (most recently used collections only), and the whole thing kept
 * under `budget` JSON characters by cutting the largest drafts first.
 */
export function sanitizeMongoStateForStorage(
  state: PersistedMongoState,
  budget = MAX_PERSISTED_TOTAL
): PersistedMongoState {
  const out: PersistedMongoState = {
    workspaces: Object.fromEntries(
      Object.entries(state.workspaces).map(([id, ws]) => [id, storedWorkspace(ws)])
    ),
    filterHistory: Object.fromEntries(
      Object.entries(state.filterHistory)
        .slice(-FILTER_HISTORY_KEYS_MAX)
        .map(([key, list]): [string, string[]] => [
          key,
          list.filter((f) => f.length <= FILTER_HISTORY_TEXT_MAX).map(maskMongoSecrets)
        ])
        .filter(([, list]) => list.length > 0)
    )
  }
  const json = JSON.stringify(out)
  let size = json.length
  if (size <= budget) return out
  // Over budget: cut the largest drafts (a cut draft keeps its beginning) until it fits, on a
  // copy (the stored tabs are memoized). JSON escaping makes lengths approximate, hence the
  // re-measure.
  const cut = JSON.parse(json) as PersistedMongoState
  for (let pass = 0; pass < 4 && size > budget; pass++) {
    let excess = size - budget
    const slots = draftSlots(cut).sort((a, b) => b.get().length - a.get().length)
    for (const s of slots) {
      if (excess <= 0) break
      const value = s.get()
      const drop = Math.min(value.length, excess + 64)
      s.set(value.slice(0, value.length - drop))
      excess -= drop
    }
    size = JSON.stringify(cut).length
  }
  if (size > budget) {
    // Only structure is left (hundreds of projects): drop the recent filters as a last resort.
    cut.filterHistory = {}
  }
  return cut
}

const PERSIST_KEY = 'hive-mongo-workspace'
/** Drafts change on every keystroke: write at most this often (and on page hide/unload). */
const WRITE_THROTTLE_MS = 400
let pendingWrite: { name: string; value: StorageValue<PersistedMongoState> } | null = null
let writeTimer: ReturnType<typeof setTimeout> | null = null

/**
 * Writes the latest pending state now (masked and capped here, not per keystroke). A storage
 * failure (quota, disabled storage) is retried once with a much smaller budget, then swallowed:
 * persistence is best effort and must never break the workspace or other stores.
 */
export function flushMongoWorkspacePersistence(): void {
  if (writeTimer !== null) {
    clearTimeout(writeTimer)
    writeTimer = null
  }
  const write = pendingWrite
  pendingWrite = null
  if (!write) return
  for (const budget of [MAX_PERSISTED_TOTAL, MAX_PERSISTED_TOTAL / 10]) {
    try {
      const state = sanitizeMongoStateForStorage(write.value.state, budget)
      localStorage.setItem(write.name, JSON.stringify({ ...write.value, state }))
      return
    } catch {
      // Quota: try once more with less, else give up silently.
    }
  }
}

const mongoStorage: PersistStorage<PersistedMongoState> = {
  getItem: (name) => {
    try {
      const raw = localStorage.getItem(name)
      return raw ? (JSON.parse(raw) as StorageValue<PersistedMongoState>) : null
    } catch {
      return null
    }
  },
  setItem: (name, value) => {
    pendingWrite = { name, value }
    if (writeTimer === null)
      writeTimer = setTimeout(flushMongoWorkspacePersistence, WRITE_THROTTLE_MS)
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
  window.addEventListener('pagehide', flushMongoWorkspacePersistence)
  window.addEventListener('beforeunload', flushMongoWorkspacePersistence)
}

// ---------------------------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------------------------

export interface OpenShellOptions {
  database?: string
  text?: string
  title?: string
  origin?: DataEditorInsertion['origin'] | null
  savedQueryId?: string
}

interface MongoWorkspaceState {
  workspaces: Record<string, MongoProjectWorkspace>
  /** Recent filters per `projectId\u0000database\u0000collection`, newest first. */
  filterHistory: Record<string, string[]>

  /** Creates the project's workspace on first open (default database from the connection). */
  ensureWorkspace: (projectId: string, defaults?: { database?: string | null }) => void
  /** Focuses the collection's tab (opening it when needed); returns its id. */
  openCollection: (
    projectId: string,
    database: string,
    collection: string,
    options?: { subTab?: MongoCollectionSubTab; collectionType?: string; newTab?: boolean }
  ) => string
  openShell: (projectId: string, options?: OpenShellOptions) => string
  /** Focuses (or opens) the project's Processes / History / Saved queries tab. */
  openSpecialTab: (projectId: string, kind: MongoSpecialTabKind) => string
  /** Closes without asking (the workspace confirms dirty Shell tabs first) and cancels its run. */
  closeTab: (projectId: string, tabId: string) => void
  closeOtherTabs: (projectId: string, tabId: string) => void
  activateTab: (projectId: string, tabId: string) => void
  /** Cycles the active tab (direction 1 = next, -1 = previous). */
  cycleTab: (projectId: string, direction: 1 | -1) => void
  setDatabase: (projectId: string, database: string | null) => void
  setExpanded: (projectId: string, database: string, expanded: boolean) => void
  setExplorerWidth: (projectId: string, width: number) => void
  updateCollectionTab: (
    projectId: string,
    tabId: string,
    patch: Partial<Omit<MongoCollectionTab, 'id' | 'kind'>>
  ) => void
  updateQuery: (projectId: string, tabId: string, patch: Partial<MongoQueryDraft>) => void
  updateAggregation: (
    projectId: string,
    tabId: string,
    update:
      Partial<MongoAggregationState> | ((prev: MongoAggregationState) => MongoAggregationState)
  ) => void
  updateShell: (
    projectId: string,
    tabId: string,
    patch: Partial<Omit<MongoShellTab, 'id' | 'kind'>>
  ) => void
  /** Schema tab: adds `path: ` to the Documents filter and switches to Documents. */
  addFilterField: (projectId: string, tabId: string, path: string) => void
  rememberFilter: (projectId: string, database: string, collection: string, filter: string) => void
  /** Keeps open tabs pointing at a renamed collection. */
  renameCollection: (projectId: string, database: string, from: string, to: string) => void
  /** Closes the tabs of a dropped collection (or of every collection of a dropped database). */
  closeCollectionTabs: (projectId: string, database: string, collection?: string) => void
  /** Applies an editor-bridge insertion: active Shell tab ('replace') or a new Shell tab. */
  applyInsertion: (insertion: DataEditorInsertion) => string
  /** Applies and consumes the bridge's pending insertion when it targets this project. */
  consumeBridge: (projectId: string) => boolean
  getActiveContext: (projectId: string) => MongoActiveContext
  /** Drops the project's workspace, recent filters and cached results (project removed). */
  forgetProject: (projectId: string) => void
  reset: () => void
}

export const filterHistoryKey = (projectId: string, database: string, collection: string): string =>
  `${projectId}\u0000${database}\u0000${collection}`

export const useMongoWorkspaceStore = create<MongoWorkspaceState>()(
  persist(
    (set, get) => {
      /** Applies `fn` to the project's workspace (creating it when missing). */
      const mutate = (
        projectId: string,
        fn: (ws: MongoProjectWorkspace) => MongoProjectWorkspace
      ): void => {
        set((state) => {
          const current = state.workspaces[projectId] ?? emptyWorkspace()
          const next = fn(current)
          return next === current
            ? state
            : { workspaces: { ...state.workspaces, [projectId]: next } }
        })
      }

      const mapTab = <K extends MongoWorkspaceTab['kind']>(
        projectId: string,
        tabId: string,
        kind: K,
        fn: (
          tab: Extract<MongoWorkspaceTab, { kind: K }>
        ) => Extract<MongoWorkspaceTab, { kind: K }>
      ): void =>
        mutate(projectId, (ws) => {
          let changed = false
          const tabs = ws.tabs.map((tab) => {
            if (tab.id !== tabId || tab.kind !== kind) return tab
            const next = fn(tab as Extract<MongoWorkspaceTab, { kind: K }>)
            if (next !== tab) changed = true
            return next
          })
          return changed ? { ...ws, tabs } : ws
        })

      const openShell = (projectId: string, options: OpenShellOptions = {}): string => {
        let id = ''
        mutate(projectId, (ws) => {
          const counter = ws.shellCounter + 1
          const active = ws.tabs.find((t) => t.id === ws.activeTabId)
          const tab: MongoShellTab = {
            id: newId('shell'),
            kind: 'shell',
            title: shortTitle(options.title?.trim() || `Shell ${counter}`),
            database: options.database ?? tabDatabase(active) ?? ws.database ?? '',
            text: options.text ?? '',
            // Text that arrives from elsewhere (assistant, history, a saved query, "Open in
            // shell") starts clean: closing the tab loses nothing stored nowhere else.
            baseline: options.text ?? '',
            ...(options.savedQueryId ? { savedQueryId: options.savedQueryId } : {}),
            limit: DEFAULT_SHELL_LIMIT,
            origin: options.origin ?? null,
            resultView: 'list'
          }
          id = tab.id
          return { ...ws, tabs: [...ws.tabs, tab], activeTabId: tab.id, shellCounter: counter }
        })
        return id
      }

      return {
        workspaces: {},
        filterHistory: {},

        ensureWorkspace: (projectId, defaults) => {
          if (get().workspaces[projectId]) {
            // A workspace created before the connection knew its default database.
            const ws = get().workspaces[projectId]
            if (ws.database === null && defaults?.database)
              mutate(projectId, (w) => ({ ...w, database: defaults.database ?? null }))
            return
          }
          set((state) => ({
            workspaces: {
              ...state.workspaces,
              [projectId]: emptyWorkspace(defaults?.database ?? null)
            }
          }))
        },

        openCollection: (projectId, database, collection, options = {}) => {
          let id = ''
          mutate(projectId, (ws) => {
            const existing = options.newTab
              ? undefined
              : ws.tabs.find(
                  (t): t is MongoCollectionTab =>
                    t.kind === 'collection' &&
                    t.database === database &&
                    t.collection === collection
                )
            if (existing) {
              id = existing.id
              const tabs = ws.tabs.map((t) =>
                t.id === existing.id
                  ? {
                      ...existing,
                      ...(options.subTab ? { subTab: options.subTab } : {}),
                      ...(options.collectionType ? { collectionType: options.collectionType } : {})
                    }
                  : t
              )
              return { ...ws, tabs, activeTabId: existing.id, database }
            }
            const tab = newCollectionTab(
              database,
              collection,
              options.subTab ?? 'documents',
              options.collectionType
            )
            id = tab.id
            return { ...ws, tabs: [...ws.tabs, tab], activeTabId: tab.id, database }
          })
          return id
        },

        openShell,

        openSpecialTab: (projectId, kind) => {
          let id = ''
          mutate(projectId, (ws) => {
            const existing = ws.tabs.find((t) => t.kind === kind)
            if (existing) {
              id = existing.id
              return ws.activeTabId === existing.id ? ws : { ...ws, activeTabId: existing.id }
            }
            const tab: MongoSpecialTab = { id: newId(kind), kind }
            id = tab.id
            return { ...ws, tabs: [...ws.tabs, tab], activeTabId: tab.id }
          })
          return id
        },

        closeTab: (projectId, tabId) => {
          let closed = false
          mutate(projectId, (ws) => {
            const index = ws.tabs.findIndex((t) => t.id === tabId)
            if (index < 0) return ws
            closed = true
            const tabs = ws.tabs.filter((t) => t.id !== tabId)
            let activeTabId = ws.activeTabId
            if (activeTabId === tabId) activeTabId = (tabs[index] ?? tabs[index - 1])?.id ?? null
            return { ...ws, tabs, activeTabId }
          })
          if (closed) forgetMongoCaches({ tabIds: [tabId] })
        },

        closeOtherTabs: (projectId, tabId) => {
          let closed: string[] = []
          mutate(projectId, (ws) => {
            if (!ws.tabs.some((t) => t.id === tabId)) return ws
            closed = ws.tabs.filter((t) => t.id !== tabId).map((t) => t.id)
            if (!closed.length) return ws
            return { ...ws, tabs: ws.tabs.filter((t) => t.id === tabId), activeTabId: tabId }
          })
          forgetMongoCaches({ tabIds: closed })
        },

        activateTab: (projectId, tabId) =>
          mutate(projectId, (ws) => {
            if (ws.activeTabId === tabId || !ws.tabs.some((t) => t.id === tabId)) return ws
            const tab = ws.tabs.find((t) => t.id === tabId)
            const database = tabDatabase(tab)
            return { ...ws, activeTabId: tabId, ...(database ? { database } : {}) }
          }),

        cycleTab: (projectId, direction) =>
          mutate(projectId, (ws) => {
            if (ws.tabs.length < 2) return ws
            const index = Math.max(
              0,
              ws.tabs.findIndex((t) => t.id === ws.activeTabId)
            )
            const next = ws.tabs[(index + direction + ws.tabs.length) % ws.tabs.length]
            return { ...ws, activeTabId: next.id }
          }),

        setDatabase: (projectId, database) =>
          mutate(projectId, (ws) => (ws.database === database ? ws : { ...ws, database })),

        setExpanded: (projectId, database, expanded) =>
          mutate(projectId, (ws) => {
            const has = ws.expanded.includes(database)
            if (has === expanded) return ws
            return {
              ...ws,
              expanded: expanded
                ? [...ws.expanded, database]
                : ws.expanded.filter((d) => d !== database)
            }
          }),

        setExplorerWidth: (projectId, width) =>
          mutate(projectId, (ws) => {
            const clamped = Math.round(
              Math.min(MONGO_EXPLORER_WIDTH.max, Math.max(MONGO_EXPLORER_WIDTH.min, width))
            )
            return clamped === ws.explorerWidth ? ws : { ...ws, explorerWidth: clamped }
          }),

        updateCollectionTab: (projectId, tabId, patch) =>
          mapTab(projectId, tabId, 'collection', (tab) => ({ ...tab, ...patch })),

        updateQuery: (projectId, tabId, patch) =>
          mapTab(projectId, tabId, 'collection', (tab) => ({
            ...tab,
            query: { ...tab.query, ...patch }
          })),

        updateAggregation: (projectId, tabId, update) =>
          mapTab(projectId, tabId, 'collection', (tab) => ({
            ...tab,
            aggregation:
              typeof update === 'function'
                ? update(tab.aggregation)
                : { ...tab.aggregation, ...update }
          })),

        updateShell: (projectId, tabId, patch) =>
          mapTab(projectId, tabId, 'shell', (tab) => ({
            ...tab,
            ...patch,
            ...(patch.title !== undefined
              ? { title: shortTitle(patch.title.trim() || tab.title) }
              : {})
          })),

        addFilterField: (projectId, tabId, path) =>
          mapTab(projectId, tabId, 'collection', (tab) => {
            const { text, cursor } = appendFilterField(tab.query.filter, path)
            return {
              ...tab,
              subTab: 'documents',
              query: { ...tab.query, filter: text },
              filterFocus: { seq: (tab.filterFocus?.seq ?? 0) + 1, cursor }
            }
          }),

        rememberFilter: (projectId, database, collection, filter) => {
          const text = filter.trim()
          if (!text || text.replace(/\s+/g, '') === '{}' || text.length > FILTER_HISTORY_TEXT_MAX)
            return
          const key = filterHistoryKey(projectId, database, collection)
          set((state) => {
            const previous = state.filterHistory[key] ?? []
            if (previous[0] === text) return state
            const next = [text, ...previous.filter((f) => f !== text)].slice(0, FILTER_HISTORY_MAX)
            // Re-inserted last: key order is recency (persistence keeps the most recent ones).
            const filterHistory = { ...state.filterHistory }
            delete filterHistory[key]
            filterHistory[key] = next
            return { filterHistory }
          })
        },

        renameCollection: (projectId, database, from, to) =>
          mutate(projectId, (ws) => {
            let changed = false
            const tabs = ws.tabs.map((t) => {
              if (t.kind !== 'collection' || t.database !== database || t.collection !== from)
                return t
              changed = true
              return { ...t, collection: to }
            })
            return changed ? { ...ws, tabs } : ws
          }),

        closeCollectionTabs: (projectId, database, collection) => {
          let closed: string[] = []
          mutate(projectId, (ws) => {
            const doomed = (t: MongoWorkspaceTab): boolean =>
              t.kind === 'collection' &&
              t.database === database &&
              (collection === undefined || t.collection === collection)
            if (!ws.tabs.some(doomed)) return ws
            closed = ws.tabs.filter(doomed).map((t) => t.id)
            const activeIndex = ws.tabs.findIndex((t) => t.id === ws.activeTabId)
            const tabs = ws.tabs.filter((t) => !doomed(t))
            let activeTabId = ws.activeTabId
            if (!tabs.some((t) => t.id === activeTabId)) {
              const after = ws.tabs.slice(activeIndex + 1).find((t) => !doomed(t))
              const before = ws.tabs
                .slice(0, Math.max(0, activeIndex))
                .reverse()
                .find((t) => !doomed(t))
              activeTabId = (after ?? before)?.id ?? null
            }
            return { ...ws, tabs, activeTabId }
          })
          forgetMongoCaches({ tabIds: closed })
        },

        applyInsertion: (insertion) => {
          const projectId = insertion.dataProjectId
          const ws = get().workspaces[projectId]
          const active = ws?.tabs.find((t) => t.id === ws.activeTabId)
          if (insertion.mode === 'replace' && active?.kind === 'shell') {
            mapTab(projectId, active.id, 'shell', (tab) => ({
              ...tab,
              text: insertion.text,
              origin: insertion.origin ?? null,
              ...(insertion.database ? { database: insertion.database } : {})
            }))
            return active.id
          }
          return openShell(projectId, {
            text: insertion.text,
            ...(insertion.database ? { database: insertion.database } : {}),
            ...(insertion.title ? { title: insertion.title } : {}),
            origin: insertion.origin ?? null
          })
        },

        consumeBridge: (projectId) => {
          // The live queue (not a rendered snapshot): applied once even when an effect re-runs.
          const bridge = useDataEditorBridge.getState()
          const pending = selectPendingFor(projectId)(bridge)
          if (!pending) return false
          get().applyInsertion(pending)
          bridge.consume(pending.seq)
          return true
        },

        getActiveContext: (projectId) => {
          const ws = get().workspaces[projectId]
          if (!ws) return {}
          const active = ws.tabs.find((t) => t.id === ws.activeTabId)
          const database = tabDatabase(active) ?? ws.database ?? undefined
          const context: MongoActiveContext = {}
          if (database) context.database = database
          if (active) context.editorText = tabEditorText(active)
          if (active?.kind === 'collection') context.collection = active.collection
          return context
        },

        forgetProject: (projectId) => {
          const tabIds = get().workspaces[projectId]?.tabs.map((t) => t.id) ?? []
          const prefix = `${projectId}\u0000`
          set((state) => {
            const workspaces = { ...state.workspaces }
            delete workspaces[projectId]
            const filterHistory = Object.fromEntries(
              Object.entries(state.filterHistory).filter(([key]) => !key.startsWith(prefix))
            )
            return { workspaces, filterHistory }
          })
          forgetMongoCaches({ tabIds, projectId })
          useDataEditorBridge.getState().clear(projectId)
          // The drafts leave the disk now, not on the next throttled write.
          flushMongoWorkspacePersistence()
        },

        reset: () => set({ workspaces: {}, filterHistory: {} })
      }
    },
    {
      name: PERSIST_KEY,
      version: 1,
      storage: mongoStorage,
      // References only: masking, caps and serialisation happen in the throttled flush.
      partialize: (state): PersistedMongoState => ({
        workspaces: state.workspaces,
        filterHistory: state.filterHistory
      }),
      merge: (persisted, current) => {
        const raw = isRecord(persisted) ? persisted : {}
        const workspaces: Record<string, MongoProjectWorkspace> = {}
        if (isRecord(raw.workspaces)) {
          for (const [id, value] of Object.entries(raw.workspaces)) {
            const ws = normalizeWorkspace(value)
            if (ws) workspaces[id] = ws
          }
        }
        const filterHistory: Record<string, string[]> = {}
        if (isRecord(raw.filterHistory)) {
          for (const [key, value] of Object.entries(raw.filterHistory)) {
            if (Array.isArray(value))
              filterHistory[key] = value
                .filter((f): f is string => typeof f === 'string')
                .slice(0, FILTER_HISTORY_MAX)
          }
        }
        return { ...current, workspaces, filterHistory }
      }
    }
  )
)

/** The active database / tab text of a project's Mongo workspace (assistant context). */
export function getActiveContext(projectId: string): MongoActiveContext {
  return useMongoWorkspaceStore.getState().getActiveContext(projectId)
}

/** Opens (or focuses) the Processes / History / Saved / Console tab — the toolbar's buttons. */
export function openSpecialTab(projectId: string, kind: MongoSpecialTabKind): string {
  return useMongoWorkspaceStore.getState().openSpecialTab(projectId, kind)
}

/**
 * Forgets a removed data project: its tabs and drafts (in memory and on disk), recent filters,
 * cached results and waiting editor insertions; a Shell statement still running is cancelled.
 */
export function forgetMongoWorkspace(projectId: string): void {
  useMongoWorkspaceStore.getState().forgetProject(projectId)
}

/**
 * Forgets every project not in `existingProjectIds` (workspaces left behind by projects removed
 * elsewhere). Call it only with a complete, successfully loaded project list.
 */
export function pruneMongoWorkspaces(existingProjectIds: Iterable<string>): void {
  const keep = new Set(existingProjectIds)
  const state = useMongoWorkspaceStore.getState()
  const known = new Set(Object.keys(state.workspaces))
  for (const key of Object.keys(state.filterHistory)) known.add(key.split('\u0000')[0])
  for (const id of known) if (!keep.has(id)) state.forgetProject(id)
}
