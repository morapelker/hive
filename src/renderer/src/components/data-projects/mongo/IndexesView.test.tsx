// Indexes tab: lists the collection's indexes once, and not again when only the project object
// is replaced (pin, safe-mode change, touch) — only a different collection re-lists.
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DataProject } from '@shared/data-projects/types'

const mocks = vi.hoisted(() => ({
  indexes: vi.fn(async (..._args: string[]) => [
    { name: '_id_', keys: { _id: 1 }, unique: true, sparse: false, hidden: false }
  ])
}))

vi.mock('@/api/data-projects-api', () => ({
  dataProjectsApi: {
    mongo: { indexes: mocks.indexes },
    completionSchema: vi.fn(async () => ({ databases: [], tables: [] }))
  }
}))
vi.mock('@/stores/useDataProjectStore', () => {
  const state = { statuses: {}, openCredentialsPrompt: vi.fn() }
  const hook = (selector: (s: typeof state) => unknown) => selector(state)
  hook.getState = () => state
  return { useDataProjectStore: hook }
})
vi.mock('./MongoCodeEditor', () => ({
  escapeClosesCompletionFirst: () => undefined,
  MongoCodeEditor: () => <textarea />
}))

const { useMongoWorkspaceStore } = await import('@/stores/useMongoWorkspaceStore')
const { IndexesView } = await import('./IndexesView')
type CollectionTab = import('@/stores/useMongoWorkspaceStore').MongoCollectionTab

const project = {
  id: 'dp-i',
  name: 'Mongo',
  engine: 'mongodb',
  config: { database: 'shop' },
  safeMode: 'off',
  pinned: false
} as unknown as DataProject

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  useMongoWorkspaceStore.getState().reset()
})

describe('IndexesView', () => {
  it('re-lists for another collection, not for a replaced project object', async () => {
    const store = useMongoWorkspaceStore.getState()
    const id = store.openCollection(project.id, 'shop', 'orders', { subTab: 'indexes' })
    const tab = (): CollectionTab =>
      useMongoWorkspaceStore
        .getState()
        .workspaces[project.id].tabs.find((t) => t.id === id) as CollectionTab
    const { rerender } = render(<IndexesView project={project} tab={tab()} />)
    await screen.findByTestId('data-project-mongo-index-_id_')
    expect(mocks.indexes).toHaveBeenCalledTimes(1)

    rerender(<IndexesView project={{ ...project, pinned: true }} tab={tab()} />)
    rerender(<IndexesView project={{ ...project, safeMode: 'read-only' }} tab={tab()} />)
    await new Promise((r) => setTimeout(r, 20))
    expect(mocks.indexes).toHaveBeenCalledTimes(1)

    rerender(
      <IndexesView project={{ ...project, pinned: true }} tab={{ ...tab(), collection: 'users' }} />
    )
    await new Promise((r) => setTimeout(r, 20))
    expect(mocks.indexes).toHaveBeenCalledTimes(2)
    expect(mocks.indexes).toHaveBeenLastCalledWith('dp-i', 'shop', 'users')
  })
})
