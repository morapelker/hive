// SQL workspace store: tab lifecycle (query/table/special tabs, close neighbours, dedupe of table
// and special tabs), drafts and dirty state, bridge insertions (replace the active query tab or
// open a new one with an origin badge; draining the project's queue once, StrictMode-safe), the
// assistant context reader, run bookkeeping (stale runs ignored), completion loading, staged-edit
// flags and the "discard them?" question, DDL notifications, forgetting a removed project, and
// what is persisted (masked, capped, no results).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { selectPendingFor, useDataEditorBridge } from '@/components/data-projects/editor-bridge'

const mocks = vi.hoisted(() => ({
  completionSchema: vi.fn()
}))

vi.mock('@/api/data-projects-api', () => ({
  dataProjectsApi: { completionSchema: mocks.completionSchema }
}))

const {
  useDataWorkspaceStore,
  getActiveContext,
  openSpecialTab,
  isQueryTabDirty,
  sanitizeWorkspaceForStorage,
  completionKey,
  flushDataWorkspacePersistence,
  MAX_PERSISTED_DRAFT,
  hasPendingEdits,
  confirmDiscardPendingEdits,
  forgetDataWorkspace,
  tabsClosedBy
} = await import('./useDataWorkspaceStore')

const P = 'dp-1'
const store = () => useDataWorkspaceStore.getState()
const ws = () => store().workspaces[P]

beforeEach(() => {
  store().reset()
  flushDataWorkspacePersistence()
  localStorage.clear()
  mocks.completionSchema.mockReset()
  useDataEditorBridge.getState().clear()
})
afterEach(() => store().reset())

describe('tabs', () => {
  it('creates one empty query tab per new workspace', () => {
    store().ensureWorkspace(P, { database: 'shop' })
    expect(ws().tabs).toHaveLength(1)
    expect(ws().tabs[0]).toMatchObject({ kind: 'query', title: 'Query 1', text: '' })
    expect(ws().database).toBe('shop')
    store().ensureWorkspace(P)
    expect(ws().tabs).toHaveLength(1)
  })

  it('numbers query tabs and activates new ones', () => {
    store().ensureWorkspace(P)
    const id = store().openQuery(P, 'SELECT 1', 'shop')
    expect(ws().activeTabId).toBe(id)
    expect(ws().tabs[1]).toMatchObject({ title: 'Query 2', database: 'shop', text: 'SELECT 1' })
  })

  it('reuses the tab of the same table and the same special tab', () => {
    const a = store().openTable(P, { schema: 'public', name: 'users' })
    store().openQuery(P)
    const b = store().openTable(P, { schema: 'public', name: 'users' }, 'structure')
    expect(b).toBe(a)
    expect(ws().activeTabId).toBe(a)
    expect(ws().tabs.find((t) => t.id === a)).toMatchObject({ kind: 'table', view: 'structure' })
    const p1 = openSpecialTab(P, 'processes')
    store().openQuery(P)
    const p2 = openSpecialTab(P, 'processes')
    expect(p2).toBe(p1)
    expect(ws().tabs.filter((t) => t.kind === 'processes')).toHaveLength(1)
    expect(ws().tabs.find((t) => t.id === p1)?.title).toBe('Processes')
  })

  it('activates the right neighbour (else the left one) when the active tab closes', () => {
    const a = store().openQuery(P)
    const b = store().openQuery(P)
    const c = store().openQuery(P)
    store().setActiveTab(P, b)
    store().closeTab(P, b)
    expect(ws().activeTabId).toBe(c)
    store().closeTab(P, c)
    expect(ws().activeTabId).toBe(a)
    store().closeTab(P, a)
    expect(ws().activeTabId).toBeNull()
    expect(ws().tabs).toEqual([])
  })

  it('closes other tabs and tabs to the right', () => {
    const a = store().openQuery(P)
    const b = store().openQuery(P)
    const c = store().openQuery(P)
    store().closeTabsToRight(P, a)
    expect(ws().tabs.map((t) => t.id)).toEqual([a])
    const d = store().openQuery(P)
    store().closeOtherTabs(P, d)
    expect(ws().tabs.map((t) => t.id)).toEqual([d])
    expect(ws().activeTabId).toBe(d)
    expect([b, c]).not.toContain(ws().activeTabId)
  })

  it('tracks drafts, dirty state and clears the origin badge on edit', () => {
    const id = store().openQuery(P, 'SELECT 1', undefined, { origin: 'assistant' })
    let tab = ws().tabs.find((t) => t.id === id)!
    expect(isQueryTabDirty(tab)).toBe(false)
    expect(tab).toMatchObject({ origin: 'assistant' })
    store().updateQueryText(P, id, 'SELECT 2')
    tab = ws().tabs.find((t) => t.id === id)!
    expect(isQueryTabDirty(tab)).toBe(true)
    expect(tab).not.toHaveProperty('origin')
    store().patchQueryTab(P, id, { baseline: 'SELECT 2', savedQueryId: 's1', title: 'Daily' })
    tab = ws().tabs.find((t) => t.id === id)!
    expect(isQueryTabDirty(tab)).toBe(false)
    expect(tab).toMatchObject({ title: 'Daily', savedQueryId: 's1' })
    store().patchQueryTab(P, id, { limit: 500 })
    store().patchQueryTab(P, id, { limit: undefined })
    expect(ws().tabs.find((t) => t.id === id)).not.toHaveProperty('limit')
  })
})

describe('bridge insertions', () => {
  it('replaces the active query tab text in replace mode', () => {
    const id = store().openQuery(P, 'old')
    const target = store().applyInsertion({
      seq: 1,
      dataProjectId: P,
      text: 'SELECT * FROM orders',
      mode: 'replace',
      origin: 'assistant',
      database: 'shop'
    })
    expect(target).toBe(id)
    expect(ws().tabs.find((t) => t.id === id)).toMatchObject({
      text: 'SELECT * FROM orders',
      origin: 'assistant',
      database: 'shop'
    })
    expect(ws().tabs).toHaveLength(1)
  })

  it('opens a new titled tab for new-tab mode or when the active tab is not a query', () => {
    store().openTable(P, { name: 'users' })
    const replaced = store().applyInsertion({
      seq: 2,
      dataProjectId: P,
      text: 'SELECT 1',
      mode: 'replace',
      origin: 'history'
    })
    expect(ws().tabs.find((t) => t.id === replaced)).toMatchObject({
      kind: 'query',
      origin: 'history'
    })
    const fresh = store().applyInsertion({
      seq: 3,
      dataProjectId: P,
      text: 'SELECT 2',
      mode: 'new-tab',
      title: 'Saved: daily revenue',
      origin: 'saved'
    })
    expect(fresh).not.toBe(replaced)
    expect(ws().activeTabId).toBe(fresh)
    expect(ws().tabs.find((t) => t.id === fresh)).toMatchObject({
      title: 'Saved: daily revenue',
      origin: 'saved'
    })
  })
})

describe('bridge queue', () => {
  it('drains the waiting insertions of the project in order, once', () => {
    store().ensureWorkspace(P)
    const bridge = useDataEditorBridge.getState()
    bridge.insert({ dataProjectId: P, text: 'SELECT 1', mode: 'new-tab', title: 'AI: one' })
    bridge.insert({ dataProjectId: 'other', text: 'theirs', mode: 'new-tab' })
    bridge.insert({ dataProjectId: P, text: 'SELECT 2', mode: 'new-tab', title: 'AI: two' })
    expect(store().consumeBridge(P)).toBe(2)
    // a second call (StrictMode re-running the effect) finds nothing left
    expect(store().consumeBridge(P)).toBe(0)
    expect(ws().tabs.map((t) => t.title)).toEqual(['Query 1', 'AI: one', 'AI: two'])
    expect(selectPendingFor('other')(useDataEditorBridge.getState())?.text).toBe('theirs')
  })
})

describe('active context', () => {
  it('reports the active query tab, falling back to the explorer database', () => {
    expect(getActiveContext('unknown')).toEqual({})
    store().ensureWorkspace(P, { database: 'shop', schema: 'public' })
    const id = ws().tabs[0].id
    store().updateQueryText(P, id, 'SELECT 42')
    expect(getActiveContext(P)).toEqual({
      database: 'shop',
      schema: 'public',
      editorText: 'SELECT 42'
    })
    store().patchQueryTab(P, id, { database: 'analytics' })
    expect(getActiveContext(P).database).toBe('analytics')
  })

  it('uses the table database and the last query text while a table tab is active', () => {
    store().ensureWorkspace(P, { database: 'shop' })
    store().updateQueryText(P, ws().tabs[0].id, 'SELECT 7')
    store().openTable(P, { database: 'other', name: 't' })
    expect(getActiveContext(P)).toEqual({ database: 'other', editorText: 'SELECT 7' })
  })
})

describe('runs', () => {
  it('ignores updates from a superseded run', () => {
    const base = {
      status: 'running' as const,
      target: { text: 'x', from: 0, to: 1, mode: 'current' as const },
      queryId: 'q',
      startedAt: 0,
      limit: 100,
      statements: [],
      activeResult: 0
    }
    const first = store().startRun('t1', base)
    const second = store().startRun('t1', base)
    store().updateRun('t1', first, { status: 'ok' })
    expect(store().runs.t1.status).toBe('running')
    store().updateRun('t1', second, { status: 'ok' })
    expect(store().runs.t1.status).toBe('ok')
  })

  it('drops the run of a closed tab', () => {
    const id = store().openQuery(P)
    store().startRun(id, {
      status: 'ok',
      target: { text: 'x', from: 0, to: 1, mode: 'all' },
      queryId: null,
      startedAt: 0,
      limit: null,
      statements: [],
      activeResult: 0
    })
    store().closeTab(P, id)
    expect(store().runs[id]).toBeUndefined()
  })
})

describe('completion schema', () => {
  it('loads once per database and refreshes on demand', async () => {
    mocks.completionSchema.mockResolvedValue({ databases: ['shop'], tables: [] })
    await store().loadCompletion(P, 'shop')
    await store().loadCompletion(P, 'shop')
    expect(mocks.completionSchema).toHaveBeenCalledTimes(1)
    expect(store().completion[completionKey(P, 'shop')].status).toBe('ready')
    await store().loadCompletion(P, 'shop', true)
    expect(mocks.completionSchema).toHaveBeenLastCalledWith(P, 'shop', true)
  })

  it('records errors and retries them', async () => {
    mocks.completionSchema.mockRejectedValueOnce(new Error('boom'))
    await store().loadCompletion(P, 'shop')
    expect(store().completion[completionKey(P, 'shop')]).toMatchObject({
      status: 'error',
      error: 'boom'
    })
    mocks.completionSchema.mockResolvedValueOnce({ databases: [], tables: [] })
    await store().loadCompletion(P, 'shop')
    expect(store().completion[completionKey(P, 'shop')].status).toBe('ready')
  })
})

describe('persistence', () => {
  it('masks secrets and caps drafts before writing', () => {
    const id = store().openQuery(P, "ALTER USER bob IDENTIFIED BY 'hunter2'")
    store().updateQueryText(
      P,
      id,
      `CREATE USER x IDENTIFIED BY 'pw1'; ${'x'.repeat(MAX_PERSISTED_DRAFT)}`
    )
    const saved = sanitizeWorkspaceForStorage(ws())
    const tab = saved.tabs[0]
    expect(tab.kind).toBe('query')
    if (tab.kind !== 'query') return
    expect(tab.text).not.toContain('pw1')
    expect(tab.baseline).not.toContain('hunter2')
    expect(tab.text.length).toBe(MAX_PERSISTED_DRAFT)
  })

  it('writes tabs but never run results to localStorage', () => {
    const id = store().openQuery(P, 'SELECT 1')
    store().startRun(id, {
      status: 'ok',
      target: { text: 'SELECT 1', from: 0, to: 8, mode: 'all' },
      queryId: null,
      startedAt: 0,
      limit: null,
      statements: [],
      activeResult: 0
    })
    // Writes are throttled: nothing is written synchronously per change.
    flushDataWorkspacePersistence()
    const raw = localStorage.getItem('hive-data-workspace')
    expect(raw).toBeTruthy()
    const parsed = JSON.parse(raw as string)
    expect(parsed.state.workspaces[P].tabs[0].text).toBe('SELECT 1')
    expect(parsed.state.runs).toBeUndefined()
    expect(parsed.state.completion).toBeUndefined()
  })

  it('masks drafts in what is actually written', () => {
    store().openQuery(P, "ALTER USER bob PASSWORD 'hunter2'")
    flushDataWorkspacePersistence()
    const raw = localStorage.getItem('hive-data-workspace') as string
    expect(raw).not.toContain('hunter2')
    expect(raw).toContain('ALTER USER bob')
  })

  it('rehydrates tabs and drops malformed entries', async () => {
    localStorage.setItem(
      'hive-data-workspace',
      JSON.stringify({
        version: 1,
        state: {
          workspaces: {
            [P]: {
              tabs: [
                { id: 'q1', kind: 'query', title: 'Query 1', text: 'SELECT 1', baseline: '' },
                { id: 'bad', kind: 'table' },
                { id: 'h', kind: 'history', title: 'History' }
              ],
              activeTabId: 'q1',
              lastQueryTabId: 'q1',
              queryCounter: 2
            }
          },
          explorerWidth: 9999
        }
      })
    )
    await useDataWorkspaceStore.persist.rehydrate()
    expect(ws().tabs.map((t) => t.id)).toEqual(['q1', 'h'])
    expect(store().explorerWidth).toBe(520)
  })
})

describe('closing several tabs', () => {
  it('lists what Close others / Close to the right would close and closes a set', () => {
    const a = store().openQuery(P, 'a')
    const b = store().openTable(P, { name: 'users' })
    const c = store().openQuery(P, 'c')
    const tabs = ws().tabs
    expect(tabsClosedBy(tabs, b, 'others').map((t) => t.id)).toEqual([a, c])
    expect(tabsClosedBy(tabs, a, 'right').map((t) => t.id)).toEqual([b, c])
    expect(tabsClosedBy(tabs, 'gone', 'right')).toEqual([])
    store().setStagedEditCount(b, 3)
    store().startRun(c, {
      status: 'ok',
      target: { text: 'c', from: 0, to: 1, mode: 'current' },
      queryId: null,
      startedAt: 0,
      limit: null,
      statements: [],
      activeResult: 0
    })
    store().closeTabs(P, [b, c])
    expect(ws().tabs.map((t) => t.id)).toEqual([a])
    expect(store().stagedEdits[b]).toBeUndefined()
    expect(store().runs[c]).toBeUndefined()
  })
})

describe('staged edits', () => {
  it('counts staged edits per project and answers without asking when none', async () => {
    const users = store().openTable(P, { name: 'users' })
    const orders = store().openTable(P, { name: 'orders' })
    expect(hasPendingEdits(P)).toBe(false)
    await expect(confirmDiscardPendingEdits(P)).resolves.toBe(true)
    store().setStagedEditCount(users, 2)
    store().setStagedEditCount(orders, 5)
    expect(store().pendingEditCount(P)).toBe(7)
    expect(hasPendingEdits(P)).toBe(true)
    expect(hasPendingEdits('other')).toBe(false)
    store().setStagedEditCount(orders, 0)
    expect(store().stagedEdits).toEqual({ [users]: 2 })
    // nobody on screen to ask (no SqlWorkspace host): nothing can be lost there
    await expect(confirmDiscardPendingEdits(P)).resolves.toBe(true)
  })

  it('asks the mounted workspace and discards on "Discard"', async () => {
    const users = store().openTable(P, { name: 'users' })
    store().setStagedEditCount(users, 2)
    const unregister = store().registerDiscardHost(P)
    const kept = confirmDiscardPendingEdits(P)
    expect(store().discardRequest?.projectId).toBe(P)
    store().answerDiscardEdits(store().discardRequest!.id, false)
    await expect(kept).resolves.toBe(false)
    expect(store().discardEpoch[P]).toBeUndefined()

    const dropped = confirmDiscardPendingEdits(P)
    store().answerDiscardEdits(store().discardRequest!.id, true)
    await expect(dropped).resolves.toBe(true)
    expect(store().discardEpoch[P]).toBe(1)
    expect(store().discardRequest).toBeNull()
    // the flags are gone at once: a caller re-checking does not ask again
    expect(hasPendingEdits(P)).toBe(false)
    store().setStagedEditCount(users, 2)

    // a newer question replaces an unanswered one; the workspace unmounting lets it go ahead
    const first = confirmDiscardPendingEdits(P)
    const second = confirmDiscardPendingEdits(P)
    await expect(first).resolves.toBe(false)
    unregister()
    await expect(second).resolves.toBe(true)
  })
})

describe('schema changes', () => {
  it('bumps the schema version and reloads the project completion schemas', async () => {
    mocks.completionSchema.mockResolvedValue({ databases: ['shop'], tables: [] })
    await store().loadCompletion(P, 'shop')
    await store().loadCompletion(P, undefined)
    await store().loadCompletion('other', 'shop')
    mocks.completionSchema.mockClear()
    store().notifySchemaChanged(P)
    expect(store().schemaVersion[P]).toBe(1)
    expect(mocks.completionSchema).toHaveBeenCalledTimes(2)
    expect(mocks.completionSchema).toHaveBeenCalledWith(P, 'shop', true)
    expect(mocks.completionSchema).toHaveBeenCalledWith(P, undefined, true)
  })
})

describe('forgetDataWorkspace', () => {
  it('drops the tabs, drafts (also persisted), runs, flags and bridge insertions', async () => {
    mocks.completionSchema.mockResolvedValue({ databases: [], tables: [] })
    const q = store().openQuery(P, 'SELECT secret_draft')
    const t = store().openTable(P, { name: 'users' })
    store().openQuery('keep', 'SELECT kept')
    store().setStagedEditCount(t, 1)
    store().startRun(q, {
      status: 'ok',
      target: { text: 'x', from: 0, to: 1, mode: 'current' },
      queryId: null,
      startedAt: 0,
      limit: null,
      statements: [],
      activeResult: 0
    })
    await store().loadCompletion(P, 'shop')
    useDataEditorBridge.getState().insert({ dataProjectId: P, text: 'later', mode: 'new-tab' })
    flushDataWorkspacePersistence()
    expect(localStorage.getItem('hive-data-workspace')).toContain('secret_draft')

    forgetDataWorkspace(P)
    expect(ws()).toBeUndefined()
    expect(store().runs[q]).toBeUndefined()
    expect(store().stagedEdits[t]).toBeUndefined()
    expect(store().completion[completionKey(P, 'shop')]).toBeUndefined()
    expect(selectPendingFor(P)(useDataEditorBridge.getState())).toBeNull()
    const raw = localStorage.getItem('hive-data-workspace') as string
    expect(raw).not.toContain('secret_draft')
    expect(raw).toContain('SELECT kept')
  })
})
