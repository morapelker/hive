// The Mongo workspace store: opening/focusing/closing tabs, Shell tabs and the singleton
// Processes/History/Saved tabs; persistence to localStorage (masked, capped, throttled, and
// tolerant rehydration of whatever is stored there); editor-bridge insertions (replace the active
// Shell tab or open a new one, only for this project, consumed once); getActiveContext for the
// assistant; schema → filter; filter history; rename/drop bookkeeping; dirty Shell tabs; and
// forgetting a removed project.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useDataEditorBridge } from '@/components/data-projects/editor-bridge'
import { registerMongoCache } from '@/components/data-projects/mongo/tab-caches'
import {
  MAX_PERSISTED_DRAFT,
  MAX_PERSISTED_TABS,
  filterHistoryKey,
  flushMongoWorkspacePersistence,
  forgetMongoWorkspace,
  getActiveContext,
  isShellTabDirty,
  openSpecialTab,
  pruneMongoWorkspaces,
  sanitizeMongoStateForStorage,
  useMongoWorkspaceStore,
  type MongoCollectionTab,
  type MongoShellTab
} from './useMongoWorkspaceStore'

const P = 'dp-1'
const KEY = 'hive-mongo-workspace'
const store = () => useMongoWorkspaceStore.getState()
const ws = () => store().workspaces[P]
const active = () => ws().tabs.find((t) => t.id === ws().activeTabId)
/** The persisted snapshot as written now (writes are throttled). */
const persisted = (): string => {
  flushMongoWorkspacePersistence()
  return localStorage.getItem(KEY) ?? ''
}

beforeEach(() => {
  flushMongoWorkspacePersistence()
  localStorage.clear()
  store().reset()
  useDataEditorBridge.setState({ pending: null })
})

afterEach(() => {
  store().reset()
  flushMongoWorkspacePersistence()
  localStorage.clear()
})

describe('tabs', () => {
  it('opens a collection once and focuses it again', () => {
    store().ensureWorkspace(P, { database: 'shop' })
    expect(ws().database).toBe('shop')
    expect(ws().expanded).toEqual(['shop'])
    const a = store().openCollection(P, 'shop', 'orders', { collectionType: 'collection' })
    const b = store().openCollection(P, 'shop', 'users')
    expect(store().openCollection(P, 'shop', 'orders', { subTab: 'indexes' })).toBe(a)
    expect(ws().tabs).toHaveLength(2)
    expect(active()).toMatchObject({
      id: a,
      kind: 'collection',
      subTab: 'indexes',
      collectionType: 'collection'
    })
    expect(store().openCollection(P, 'shop', 'orders', { newTab: true })).not.toBe(a)
    store().closeTab(P, b)
    expect(ws().tabs.map((t) => t.id)).not.toContain(b)
  })

  it('numbers Shell tabs, inherits the active database and keeps Processes/History singletons', () => {
    store().ensureWorkspace(P, { database: 'shop' })
    store().openCollection(P, 'analytics', 'events')
    const s1 = store().openShell(P)
    expect(active()).toMatchObject({
      id: s1,
      kind: 'shell',
      title: 'Shell 1',
      database: 'analytics',
      text: ''
    })
    const s2 = store().openShell(P, { database: 'admin', text: 'show dbs' })
    expect(active()).toMatchObject({
      id: s2,
      title: 'Shell 2',
      database: 'admin',
      text: 'show dbs'
    })
    const processes = openSpecialTab(P, 'processes')
    expect(openSpecialTab(P, 'processes')).toBe(processes)
    expect(store().openSpecialTab(P, 'history')).not.toBe(processes)
    expect(ws().tabs.filter((t) => t.kind === 'processes')).toHaveLength(1)
  })

  it('activates a neighbour when the active tab closes, and cycles', () => {
    const a = store().openShell(P)
    const b = store().openShell(P)
    const c = store().openShell(P)
    store().activateTab(P, b)
    store().closeTab(P, b)
    expect(ws().activeTabId).toBe(c)
    store().closeTab(P, c)
    expect(ws().activeTabId).toBe(a)
    const d = store().openShell(P)
    store().cycleTab(P, 1)
    expect(ws().activeTabId).toBe(a)
    store().cycleTab(P, -1)
    expect(ws().activeTabId).toBe(d)
    store().closeOtherTabs(P, a)
    expect(ws().tabs.map((t) => t.id)).toEqual([a])
  })

  it('follows renames and closes tabs of dropped collections / databases', () => {
    const orders = store().openCollection(P, 'shop', 'orders')
    store().openCollection(P, 'shop', 'users')
    const shell = store().openShell(P)
    store().renameCollection(P, 'shop', 'orders', 'orders_v2')
    expect((ws().tabs.find((t) => t.id === orders) as MongoCollectionTab).collection).toBe(
      'orders_v2'
    )
    store().activateTab(P, orders)
    store().closeCollectionTabs(P, 'shop', 'orders_v2')
    expect(ws().tabs.some((t) => t.id === orders)).toBe(false)
    expect(ws().activeTabId).not.toBe(orders)
    store().closeCollectionTabs(P, 'shop')
    expect(ws().tabs.map((t) => t.id)).toEqual([shell])
  })
})

describe('persistence', () => {
  it('writes tabs and drafts to localStorage and rehydrates them', async () => {
    const tab = store().openCollection(P, 'shop', 'orders')
    store().updateQuery(P, tab, { filter: "{ status: 'A' }", limit: '50' })
    store().updateCollectionTab(P, tab, { view: 'table', optionsOpen: true })
    store().addFilterField(P, tab, 'total')
    const shell = store().openShell(P, { text: 'db.orders.find()' })
    store().updateShell(P, shell, { limit: 500 })
    store().rememberFilter(P, 'shop', 'orders', "{ status: 'A' }")

    const snapshot = persisted() || '{}'
    const raw = JSON.parse(snapshot)
    expect(raw.state.workspaces[P].tabs).toHaveLength(2)
    // The one-shot focus request is not persisted.
    expect(raw.state.workspaces[P].tabs[0].filterFocus).toBeUndefined()

    // Simulate a fresh app start: empty memory, the snapshot in storage.
    useMongoWorkspaceStore.setState({ workspaces: {}, filterHistory: {} })
    flushMongoWorkspacePersistence()
    localStorage.setItem(KEY, snapshot)
    await useMongoWorkspaceStore.persist.rehydrate()
    const restored = ws().tabs
    expect(restored[0]).toMatchObject({
      kind: 'collection',
      collection: 'orders',
      view: 'table',
      optionsOpen: true,
      query: { filter: "{ status: 'A', total:  }", limit: '50', sort: '' }
    })
    expect(restored[1]).toMatchObject({ kind: 'shell', text: 'db.orders.find()', limit: 500 })
    expect(ws().activeTabId).toBe(shell)
    expect(store().filterHistory[filterHistoryKey(P, 'shop', 'orders')]).toEqual([
      "{ status: 'A' }"
    ])
  })

  it('drops malformed persisted tabs instead of crashing', async () => {
    localStorage.setItem(
      'hive-mongo-workspace',
      JSON.stringify({
        version: 1,
        state: {
          workspaces: {
            [P]: {
              tabs: [
                { id: 'x', kind: 'collection' },
                {
                  id: 'ok',
                  kind: 'collection',
                  database: 'shop',
                  collection: 'orders',
                  view: 'bogus'
                },
                'garbage',
                { id: 'h', kind: 'history' }
              ],
              activeTabId: 'missing',
              explorerWidth: 99999
            },
            broken: 7
          },
          filterHistory: { k: ['a', 3] }
        }
      })
    )
    await useMongoWorkspaceStore.persist.rehydrate()
    expect(ws().tabs.map((t) => t.id)).toEqual(['ok', 'h'])
    expect(ws().activeTabId).toBe('ok')
    expect((ws().tabs[0] as MongoCollectionTab).view).toBe('list')
    expect((ws().tabs[0] as MongoCollectionTab).aggregation.stages).toHaveLength(1)
    expect(ws().explorerWidth).toBe(520)
    expect(store().workspaces.broken).toBeUndefined()
    expect(store().filterHistory.k).toEqual(['a'])
  })
})

describe('editor bridge', () => {
  it('replaces the active Shell tab for mode replace', () => {
    const shell = store().openShell(P, { database: 'shop', text: 'old' })
    useDataEditorBridge.getState().insert({
      dataProjectId: P,
      text: "db.orders.find({ status: 'A' })",
      mode: 'replace',
      database: 'sales',
      origin: 'assistant'
    })
    expect(store().consumeBridge(P)).toBe(true)
    expect(useDataEditorBridge.getState().pending).toBeNull()
    expect(ws().tabs).toHaveLength(1)
    expect(active()).toMatchObject({
      id: shell,
      text: "db.orders.find({ status: 'A' })",
      database: 'sales',
      origin: 'assistant'
    })
  })

  it('opens a new Shell tab when the active tab is not a shell or for new-tab', () => {
    store().ensureWorkspace(P, { database: 'shop' })
    store().openCollection(P, 'shop', 'orders')
    useDataEditorBridge
      .getState()
      .insert({ dataProjectId: P, text: 'db.users.find()', mode: 'replace' })
    store().consumeBridge(P)
    expect(active()).toMatchObject({ kind: 'shell', text: 'db.users.find()', database: 'shop' })
    useDataEditorBridge.getState().insert({
      dataProjectId: P,
      text: 'db.x.countDocuments()',
      mode: 'new-tab',
      title: 'AI: how many documents are in x right now, roughly speaking?',
      origin: 'history'
    })
    store().consumeBridge(P)
    const tab = active() as MongoShellTab
    expect(ws().tabs.filter((t) => t.kind === 'shell')).toHaveLength(2)
    expect(tab.title.length).toBeLessThanOrEqual(40)
    expect(tab.title.endsWith('…')).toBe(true)
    expect(tab.origin).toBe('history')
  })

  it('ignores insertions for other projects and leaves them pending', () => {
    store().openShell(P, { text: 'mine' })
    useDataEditorBridge
      .getState()
      .insert({ dataProjectId: 'other', text: 'theirs', mode: 'replace' })
    expect(store().consumeBridge(P)).toBe(false)
    expect(useDataEditorBridge.getState().pending?.text).toBe('theirs')
    expect((active() as MongoShellTab).text).toBe('mine')
  })
})

describe('getActiveContext', () => {
  it('returns {} for an unknown project', () => {
    expect(getActiveContext('nope')).toEqual({})
  })

  it('describes Shell, Documents and Aggregations tabs', () => {
    store().ensureWorkspace(P, { database: 'shop' })
    expect(getActiveContext(P)).toEqual({ database: 'shop' })
    store().openShell(P, { database: 'admin', text: 'show dbs' })
    expect(getActiveContext(P)).toEqual({ database: 'admin', editorText: 'show dbs' })
    const tab = store().openCollection(P, 'shop', 'order-items')
    store().updateQuery(P, tab, { filter: '{ qty: { $gt: 1 } }' })
    expect(getActiveContext(P)).toEqual({
      database: 'shop',
      collection: 'order-items',
      editorText: "db.getCollection('order-items').find({ qty: { $gt: 1 } })"
    })
    store().updateCollectionTab(P, tab, { subTab: 'aggregations' })
    store().updateAggregation(P, tab, (agg) => ({
      ...agg,
      stages: [
        ...agg.stages.map((s) => ({ ...s, body: "{ sku: 'A' }" })),
        { id: 's2', operator: '$limit', body: '5', enabled: false, previewOpen: true }
      ]
    }))
    expect(getActiveContext(P).editorText).toBe(
      "db.getCollection('order-items').aggregate([\n  { $match: { sku: 'A' } }\n])"
    )
    store().openSpecialTab(P, 'processes')
    expect(getActiveContext(P)).toEqual({ database: 'shop', editorText: '' })
  })
})

describe('schema → filter and filter history', () => {
  it('appends the field, switches to Documents and asks for focus', () => {
    const tab = store().openCollection(P, 'shop', 'orders', { subTab: 'schema' })
    store().addFilterField(P, tab, 'address.city')
    const t = active() as MongoCollectionTab
    expect(t.subTab).toBe('documents')
    expect(t.query.filter).toBe("{ 'address.city':  }")
    expect(t.filterFocus).toEqual({ seq: 1, cursor: "{ 'address.city': ".length })
  })

  it('keeps recent distinct filters, newest first, ignoring empty ones', () => {
    for (const f of ['{ a: 1 }', '{ b: 1 }', '{ a: 1 }', '{}', '  '])
      store().rememberFilter(P, 'shop', 'orders', f)
    expect(store().filterHistory[filterHistoryKey(P, 'shop', 'orders')]).toEqual([
      '{ a: 1 }',
      '{ b: 1 }'
    ])
  })
})

describe('persistence: masking, caps and failures', () => {
  it('masks passwords in every persisted draft but keeps them in memory', async () => {
    const shell = store().openShell(P)
    store().updateShell(P, shell, {
      text: [
        'db.runCommand({ createUser: "app", pwd: "MongoPlainPw!", roles: [] })',
        "db.changeUserPassword('app', 'Positional9')",
        "db.createUser({ user: 'u', 'password': `Tpl$ecret` })",
        "new Mongo('mongodb://root:UrlSecret7@db.example:27017')"
      ].join('\n')
    })
    const tab = store().openCollection(P, 'shop', 'users')
    store().updateQuery(P, tab, { filter: "{ password: 'FilterPw1' }" })
    store().updateAggregation(P, tab, (agg) => ({
      ...agg,
      text: "[{ $set: { pwd: 'AggTextPw' } }]",
      stages: agg.stages.map((s) => ({ ...s, body: "{ newPassword: 'StagePw' }" }))
    }))
    store().rememberFilter(P, 'shop', 'users', "{ pwd: 'HistoryPw' }")

    const snapshot = persisted()
    for (const secret of [
      'MongoPlainPw!',
      'Positional9',
      'Tpl$ecret',
      'UrlSecret7',
      'FilterPw1',
      'AggTextPw',
      'StagePw',
      'HistoryPw'
    ])
      expect(snapshot).not.toContain(secret)
    expect(snapshot).toContain('pwd: \\"***\\"')
    expect(snapshot).toContain("db.changeUserPassword('app', '***')")
    expect(snapshot).toContain('mongodb://root:***@db.example')
    // The session keeps the real text.
    expect((ws().tabs[0] as MongoShellTab).text).toContain('MongoPlainPw!')

    useMongoWorkspaceStore.setState({ workspaces: {}, filterHistory: {} })
    flushMongoWorkspacePersistence()
    localStorage.setItem(KEY, snapshot)
    await useMongoWorkspaceStore.persist.rehydrate()
    expect((ws().tabs[0] as MongoShellTab).text).toContain('pwd: "***"')
    expect(store().filterHistory[filterHistoryKey(P, 'shop', 'users')]).toEqual(["{ pwd: '***' }"])
  })

  it('throttles writes: keystrokes do not hit localStorage until the flush', () => {
    const shell = store().openShell(P)
    persisted()
    store().updateShell(P, shell, { text: 'db.orders.find()' })
    expect(localStorage.getItem(KEY) ?? '').not.toContain('db.orders.find()')
    expect(persisted()).toContain('db.orders.find()')
  })

  it('caps drafts and tabs, keeps the active tab, and stays under the total budget', () => {
    const big = `db.orders.insertMany([${'{ a: 1 }, '.repeat(40_000)}])`
    expect(big.length).toBeGreaterThan(MAX_PERSISTED_DRAFT)
    const first = store().openShell(P, { text: big })
    for (let i = 0; i < MAX_PERSISTED_TABS + 5; i++) store().openShell(P)
    store().activateTab(P, first)
    const raw = JSON.parse(persisted())
    const tabs = raw.state.workspaces[P].tabs as MongoShellTab[]
    expect(tabs).toHaveLength(MAX_PERSISTED_TABS)
    expect(raw.state.workspaces[P].activeTabId).toBe(first)
    expect(tabs[0].text.length).toBe(MAX_PERSISTED_DRAFT)
    // Equal to the text: the baseline is not written twice.
    expect('baseline' in tabs[0]).toBe(false)

    const budget = 120_000
    const out = sanitizeMongoStateForStorage(
      { workspaces: store().workspaces, filterHistory: store().filterHistory },
      budget
    )
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(budget)
    expect(out.workspaces[P].tabs).toHaveLength(MAX_PERSISTED_TABS)
  })

  it('swallows a full storage quota instead of breaking store actions', () => {
    const shell = store().openShell(P)
    const spy = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError')
    })
    try {
      expect(() => store().updateShell(P, shell, { text: 'x'.repeat(10_000) })).not.toThrow()
      expect(() => flushMongoWorkspacePersistence()).not.toThrow()
      expect(() => store().activateTab(P, shell)).not.toThrow()
      // One retry with a smaller budget, then given up.
      expect(spy).toHaveBeenCalledTimes(2)
    } finally {
      spy.mockRestore()
    }
    expect((ws().tabs[0] as MongoShellTab).text).toHaveLength(10_000)
  })

  it('does not remember huge filters and keeps filter keys in recency order', () => {
    store().rememberFilter(P, 'shop', 'a', '{ a: 1 }')
    store().rememberFilter(P, 'shop', 'b', '{ b: 1 }')
    store().rememberFilter(P, 'shop', 'a', '{ a: 2 }')
    expect(Object.keys(store().filterHistory)).toEqual([
      filterHistoryKey(P, 'shop', 'b'),
      filterHistoryKey(P, 'shop', 'a')
    ])
    store().rememberFilter(P, 'shop', 'c', `{ a: '${'x'.repeat(20_000)}' }`)
    expect(store().filterHistory[filterHistoryKey(P, 'shop', 'c')]).toBeUndefined()
  })
})

describe('dirty Shell tabs and saved queries', () => {
  it('tracks unsaved text against the baseline', async () => {
    const empty = store().openShell(P)
    expect(isShellTabDirty(active()!)).toBe(false)
    store().updateShell(P, empty, { text: 'db.orders.find()' })
    expect(isShellTabDirty(active()!)).toBe(true)
    // Saving moves the baseline (what ShellTab does after dataProjects.saved.save).
    store().updateShell(P, empty, { baseline: 'db.orders.find()', savedQueryId: 'sq-1' })
    expect(isShellTabDirty(active()!)).toBe(false)
    // Whitespace-only text is never worth a prompt.
    store().updateShell(P, empty, { text: '  \n' })
    expect(isShellTabDirty(active()!)).toBe(false)

    // Text from elsewhere starts clean; a 'replace' into the tab keeps the old baseline.
    const fromHistory = store().openShell(P, { text: 'db.users.find()', origin: 'history' })
    expect(isShellTabDirty(active()!)).toBe(false)
    useDataEditorBridge
      .getState()
      .insert({ dataProjectId: P, text: 'db.x.find()', mode: 'replace', origin: 'assistant' })
    store().consumeBridge(P)
    expect(active()!.id).toBe(fromHistory)
    expect(isShellTabDirty(active()!)).toBe(true)

    // Dirty state and the saved-query link survive a restart.
    store().updateShell(P, empty, { text: 'db.orders.find({ a: 1 })' })
    const snapshot = persisted()
    useMongoWorkspaceStore.setState({ workspaces: {}, filterHistory: {} })
    flushMongoWorkspacePersistence()
    localStorage.setItem(KEY, snapshot)
    await useMongoWorkspaceStore.persist.rehydrate()
    const restored = ws().tabs.find((t) => t.id === empty) as MongoShellTab
    expect(restored).toMatchObject({ savedQueryId: 'sq-1', baseline: 'db.orders.find()' })
    expect(isShellTabDirty(restored)).toBe(true)
    expect(isShellTabDirty(ws().tabs.find((t) => t.id === fromHistory)!)).toBe(true)
  })

  it('flags a Shell tab restored with masked or cut text (never clean real text)', async () => {
    const secret = store().openShell(P, {
      text: "db.createUser({ user: 'app', pwd: 'S3cret!', roles: ['readWrite'] })",
      title: 'Create app user',
      savedQueryId: 'sq-1'
    })
    const plain = store().openShell(P, { text: 'db.orders.find()', savedQueryId: 'sq-2' })
    const big = store().openShell(P, { text: `db.x.insertMany([${'{ a: 1 }, '.repeat(40_000)}])` })
    const snapshot = persisted()
    expect(snapshot).not.toContain('S3cret!')
    // The session keeps the real text and is not flagged.
    expect((ws().tabs[0] as MongoShellTab).masked).toBeUndefined()

    useMongoWorkspaceStore.setState({ workspaces: {}, filterHistory: {} })
    flushMongoWorkspacePersistence()
    localStorage.setItem(KEY, snapshot)
    await useMongoWorkspaceStore.persist.rehydrate()
    const restored = (id: string) => ws().tabs.find((t) => t.id === id) as MongoShellTab
    expect(restored(secret)).toMatchObject({
      text: "db.createUser({ user: 'app', pwd: '***', roles: ['readWrite'] })",
      savedQueryId: 'sq-1',
      masked: true
    })
    // Clean (closing it loses nothing), but not the saved text.
    expect(isShellTabDirty(restored(secret))).toBe(false)
    expect(restored(plain).masked).toBeUndefined()
    expect(restored(big).masked).toBe(true)

    // Edits keep the flag; it survives the next restart too.
    store().updateShell(P, secret, { text: `${restored(secret).text}\ndb.orders.find()` })
    expect(restored(secret).masked).toBe(true)
    const again = persisted()
    useMongoWorkspaceStore.setState({ workspaces: {}, filterHistory: {} })
    flushMongoWorkspacePersistence()
    localStorage.setItem(KEY, again)
    await useMongoWorkspaceStore.persist.rehydrate()
    expect(restored(secret).masked).toBe(true)
  })

  it('flags a Shell tab whose text the total budget cut', () => {
    const shell = store().openShell(P, { text: `db.x.find(${'1'.repeat(50_000)})` })
    const out = sanitizeMongoStateForStorage(
      { workspaces: store().workspaces, filterHistory: store().filterHistory },
      20_000
    )
    const tab = out.workspaces[P].tabs.find((t) => t.id === shell) as MongoShellTab
    expect(tab.text.length).toBeLessThan(50_000)
    expect(tab.masked).toBe(true)
  })

  it('opens the Saved queries tab once and restores it', async () => {
    const saved = openSpecialTab(P, 'saved')
    expect(openSpecialTab(P, 'saved')).toBe(saved)
    const snapshot = persisted()
    useMongoWorkspaceStore.setState({ workspaces: {}, filterHistory: {} })
    flushMongoWorkspacePersistence()
    localStorage.setItem(KEY, snapshot)
    await useMongoWorkspaceStore.persist.rehydrate()
    expect(ws().tabs).toEqual([{ id: saved, kind: 'saved' }])
  })

  it('opens a Shell tab linked to a saved query, clean', () => {
    store().openShell(P, {
      text: 'db.orders.countDocuments()',
      title: 'Order count',
      database: '',
      origin: 'saved',
      savedQueryId: 'sq-9'
    })
    expect(active()).toMatchObject({
      title: 'Order count',
      database: '',
      savedQueryId: 'sq-9',
      baseline: 'db.orders.countDocuments()'
    })
  })
})

describe('closing tabs and forgetting projects', () => {
  it('drops the closed tabs from the registered caches', () => {
    const forget = vi.fn()
    const unregister = registerMongoCache(forget)
    try {
      const a = store().openShell(P)
      const b = store().openShell(P)
      const c = store().openCollection(P, 'shop', 'orders')
      const d = store().openShell(P)
      store().closeTab(P, a)
      expect(forget).toHaveBeenLastCalledWith({ tabIds: [a] })
      store().closeCollectionTabs(P, 'shop', 'orders')
      expect(forget).toHaveBeenLastCalledWith({ tabIds: [c] })
      store().closeOtherTabs(P, d)
      expect(forget).toHaveBeenLastCalledWith({ tabIds: [b] })
      forget.mockClear()
      store().closeTab(P, 'missing')
      expect(forget).not.toHaveBeenCalled()
    } finally {
      unregister()
    }
  })

  it('forgets a removed project: tabs, drafts on disk, recent filters, caches, insertions', () => {
    const forget = vi.fn()
    const unregister = registerMongoCache(forget)
    try {
      const shell = store().openShell(P, { text: 'db.secret_stuff.find()' })
      store().rememberFilter(P, 'shop', 'orders', '{ a: 1 }')
      store().openShell('dp-2', { text: 'db.other.find()' })
      store().rememberFilter('dp-2', 'shop', 'orders', '{ b: 1 }')
      useDataEditorBridge.getState().insert({ dataProjectId: P, text: 'x', mode: 'replace' })
      persisted()

      forgetMongoWorkspace(P)
      expect(store().workspaces[P]).toBeUndefined()
      expect(store().workspaces['dp-2']).toBeDefined()
      expect(Object.keys(store().filterHistory)).toEqual([
        filterHistoryKey('dp-2', 'shop', 'orders')
      ])
      expect(forget).toHaveBeenCalledWith({ tabIds: [shell], projectId: P })
      expect(useDataEditorBridge.getState().queue).toEqual([])
      // Written right away, not on the next throttled write.
      const disk = localStorage.getItem(KEY) ?? ''
      expect(disk).not.toContain('secret_stuff')
      expect(disk).toContain('db.other.find()')

      pruneMongoWorkspaces(['dp-3'])
      expect(store().workspaces).toEqual({})
      expect(store().filterHistory).toEqual({})
    } finally {
      unregister()
    }
  })
})

describe('editor bridge queue', () => {
  it("takes this project's insertion even when another project's is queued first", () => {
    store().openShell(P, { text: 'mine' })
    useDataEditorBridge
      .getState()
      .insert({ dataProjectId: 'other', text: 'theirs', mode: 'replace' })
    useDataEditorBridge.getState().insert({ dataProjectId: P, text: 'for me', mode: 'replace' })
    expect(store().consumeBridge(P)).toBe(true)
    expect((active() as MongoShellTab).text).toBe('for me')
    expect(useDataEditorBridge.getState().queue.map((i) => i.text)).toEqual(['theirs'])
    expect(store().consumeBridge(P)).toBe(false)
  })
})
