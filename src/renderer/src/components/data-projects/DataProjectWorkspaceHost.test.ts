// The workspace actions behind DataProjectView's keyboard: a new query / Shell tab (⌘T), tab
// cycling (⌃Tab), stepping a table tab through Data / Structure / DDL and a collection tab
// through its sub-tabs (⌃⌘] / ⌃⌘[), and the cancelable table command (⌘R / ⌘F) — against the
// real SQL and Mongo workspace stores.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { sampleDataProject } from './data-project.sample'

vi.mock('@/api/data-projects-api', () => ({ dataProjectsApi: {} }))

const {
  DATA_TABLE_COMMAND_EVENT,
  cycleWorkspaceTab,
  openWorkspaceNewTab,
  sendTableCommand,
  stepWorkspaceView
} = await import('./DataProjectWorkspaceHost')
const { useDataWorkspaceStore } = await import('@/stores/useDataWorkspaceStore')
const { useMongoWorkspaceStore } = await import('@/stores/useMongoWorkspaceStore')

const sql = sampleDataProject({ id: 'dp-sql', engine: 'postgres' })
const mongo = sampleDataProject({ id: 'dp-mongo', engine: 'mongodb' })

afterEach(() => {
  useDataWorkspaceStore.getState().reset()
  useMongoWorkspaceStore.getState().reset()
})

describe('SQL workspace', () => {
  const store = () => useDataWorkspaceStore.getState()

  it('opens a new query tab and cycles the tabs', async () => {
    store().openTable(sql.id, { name: 'users', kind: 'table' })
    await openWorkspaceNewTab(sql)
    const [table, query] = store().getWorkspace(sql.id)!.tabs
    expect(query.kind).toBe('query')
    expect(store().getActiveTab(sql.id)?.id).toBe(query.id)

    await cycleWorkspaceTab(sql, 1)
    expect(store().getActiveTab(sql.id)?.id).toBe(table.id)
    await cycleWorkspaceTab(sql, -1)
    expect(store().getActiveTab(sql.id)?.id).toBe(query.id)
  })

  it('steps a table tab through Data / Structure / DDL, clamped at the ends', async () => {
    const id = store().openTable(sql.id, { name: 'users', kind: 'table' })
    const view = () => (store().getActiveTab(sql.id) as { view: string }).view

    await stepWorkspaceView(sql, -1)
    expect(view()).toBe('data')
    await stepWorkspaceView(sql, 1)
    expect(view()).toBe('structure')
    await stepWorkspaceView(sql, 1)
    await stepWorkspaceView(sql, 1)
    expect(view()).toBe('ddl')
    await stepWorkspaceView(sql, -1)
    expect(view()).toBe('structure')
    expect(store().getActiveTab(sql.id)?.id).toBe(id)
  })

  it('leaves objects without rows on DDL and query tabs alone', async () => {
    store().openTable(sql.id, { name: 'next_id', kind: 'sequence' }, 'ddl')
    await stepWorkspaceView(sql, -1)
    expect((store().getActiveTab(sql.id) as { view: string }).view).toBe('ddl')

    const queryId = store().openQuery(sql.id, 'select 1')
    await stepWorkspaceView(sql, 1)
    expect(store().getActiveTab(sql.id)).toMatchObject({ id: queryId, kind: 'query' })
  })
})

describe('Mongo workspace', () => {
  const store = () => useMongoWorkspaceStore.getState()
  const active = () => {
    const ws = store().workspaces[mongo.id]
    return ws?.tabs.find((t) => t.id === ws.activeTabId)
  }

  it('opens a new Shell tab and cycles the tabs', async () => {
    const collection = store().openCollection(mongo.id, 'shop', 'users')
    await openWorkspaceNewTab(mongo)
    expect(active()?.kind).toBe('shell')
    await cycleWorkspaceTab(mongo, 1)
    expect(active()?.id).toBe(collection)
  })

  it('steps a collection tab through its sub-tabs; a view has no Indexes', async () => {
    store().openCollection(mongo.id, 'shop', 'users')
    const subTab = () => (active() as { subTab: string }).subTab
    for (const expected of ['aggregations', 'schema', 'indexes', 'indexes']) {
      await stepWorkspaceView(mongo, 1)
      expect(subTab()).toBe(expected)
    }

    store().openCollection(mongo.id, 'shop', 'active_users', { collectionType: 'view' })
    await stepWorkspaceView(mongo, 1)
    await stepWorkspaceView(mongo, 1)
    await stepWorkspaceView(mongo, 1)
    expect(subTab()).toBe('schema')
  })
})

describe('table commands (⌘R / ⌘F)', () => {
  it('report whether a table view answered', () => {
    expect(sendTableCommand({ projectId: sql.id, command: 'refresh' })).toBe(false)

    const listener = vi.fn((event: Event) => {
      const { projectId, command } = (event as CustomEvent).detail
      if (projectId === sql.id && command === 'filter') event.preventDefault()
    })
    window.addEventListener(DATA_TABLE_COMMAND_EVENT, listener)
    try {
      expect(sendTableCommand({ projectId: sql.id, command: 'filter' })).toBe(true)
      expect(sendTableCommand({ projectId: 'other', command: 'filter' })).toBe(false)
    } finally {
      window.removeEventListener(DATA_TABLE_COMMAND_EVENT, listener)
    }
  })
})
