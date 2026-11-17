// What the file tree holds by worktree path, after a project moved to another folder: the
// expanded folders and the filter follow the worktree to its new path, what was scanned under
// the old one is dropped, and nothing of a worktree that did not move is touched.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FlatFile } from '@/lib/file-search-utils'
import { useFileTreeStore } from './useFileTreeStore'

const STORAGE_KEY = 'hive-file-tree'

const node = (
  path: string
): {
  name: string
  path: string
  relativePath: string
  isDirectory: boolean
  extension: string | null
} => ({
  name: path.split('/').pop() ?? path,
  path,
  relativePath: path.split('/').pop() ?? path,
  isDirectory: true,
  extension: null
})

const file = (path: string): FlatFile => ({
  name: path.split('/').pop() ?? path,
  path,
  relativePath: path.split('/').pop() ?? path,
  extension: '.ts'
})

const expandedOf = (worktreePath: string): string[] | undefined => {
  const paths = useFileTreeStore.getState().expandedPathsByWorktree.get(worktreePath)
  return paths ? Array.from(paths).sort() : undefined
}

const persistedExpanded = (): [string, string[]][] => {
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) return []
  return (JSON.parse(raw) as { state: { expandedPathsByWorktree: [string, string[]][] } }).state
    .expandedPathsByWorktree
}

// Writes to localStorage from here on. jsdom's storage keeps `setItem` on its prototype; the
// stand-in test/setup.ts installs where there is no storage keeps a mock on the object.
const countStorageWrites = (): { count: () => number; restore: () => void } => {
  const prototype = Object.getPrototypeOf(window.localStorage) as Storage
  if (typeof prototype.setItem === 'function') {
    const spy = vi.spyOn(prototype, 'setItem')
    return { count: () => spy.mock.calls.length, restore: () => spy.mockRestore() }
  }
  const mock = vi.mocked(window.localStorage.setItem)
  mock.mockClear()
  return { count: () => mock.mock.calls.length, restore: () => {} }
}

describe('useFileTreeStore.rekeyWorktreePaths', () => {
  beforeEach(() => {
    useFileTreeStore.setState({
      fileTreeByWorktree: new Map(),
      fileIndexByWorktree: new Map(),
      fileIndexLoadingByWorktree: new Map(),
      expandedPathsByWorktree: new Map(),
      filterByWorktree: new Map(),
      isLoading: false,
      error: null
    })
  })

  it('files the expanded folders of a moved worktree under its new path, entries included', () => {
    useFileTreeStore.setState({
      expandedPathsByWorktree: new Map([
        ['/old/app', new Set(['/old/app/src', '/old/app/src/components'])]
      ])
    })

    useFileTreeStore.getState().rekeyWorktreePaths([{ from: '/old/app', to: '/new/app' }])

    expect(expandedOf('/old/app')).toBeUndefined()
    expect(expandedOf('/new/app')).toEqual(['/new/app/src', '/new/app/src/components'])
    expect(useFileTreeStore.getState().isExpanded('/new/app', '/new/app/src')).toBe(true)
  })

  it('follows the worktrees inside the moved project and those that moved next to it', () => {
    useFileTreeStore.setState({
      expandedPathsByWorktree: new Map([
        ['/old/app', new Set(['/old/app/src'])],
        ['/old/app/.worktrees/fix', new Set(['/old/app/.worktrees/fix/docs'])],
        ['/old/app-feature', new Set(['/old/app-feature/lib'])]
      ])
    })

    useFileTreeStore.getState().rekeyWorktreePaths([
      { from: '/old/app', to: '/new/app' },
      { from: '/old/app/.worktrees/fix', to: '/new/app/.worktrees/fix' },
      { from: '/old/app-feature', to: '/new/app-feature' }
    ])

    expect(Array.from(useFileTreeStore.getState().expandedPathsByWorktree.keys()).sort()).toEqual([
      '/new/app',
      '/new/app-feature',
      '/new/app/.worktrees/fix'
    ])
    expect(expandedOf('/new/app/.worktrees/fix')).toEqual(['/new/app/.worktrees/fix/docs'])
    expect(expandedOf('/new/app-feature')).toEqual(['/new/app-feature/lib'])
  })

  it('leaves a worktree alone whose path only starts with the same characters', () => {
    const neighbour = new Set(['/old/app2/src'])
    const dashed = new Set(['/old/app-feature/src'])
    useFileTreeStore.setState({
      expandedPathsByWorktree: new Map([
        ['/old/app', new Set(['/old/app/src'])],
        ['/old/app2', neighbour],
        ['/old/app-feature', dashed]
      ]),
      filterByWorktree: new Map([
        ['/old/app', 'index'],
        ['/old/app2', 'readme']
      ]),
      fileTreeByWorktree: new Map([
        ['/old/app', [node('/old/app/src')]],
        ['/old/app2', [node('/old/app2/src')]]
      ]),
      fileIndexByWorktree: new Map([
        ['/old/app', [file('/old/app/a.ts')]],
        ['/old/app2', [file('/old/app2/a.ts')]]
      ]),
      fileIndexLoadingByWorktree: new Map([
        ['/old/app', false],
        ['/old/app2', true]
      ])
    })

    useFileTreeStore.getState().rekeyWorktreePaths([{ from: '/old/app', to: '/new/app' }])

    const state = useFileTreeStore.getState()
    // The very same sets: a worktree that did not move is not even copied.
    expect(state.expandedPathsByWorktree.get('/old/app2')).toBe(neighbour)
    expect(state.expandedPathsByWorktree.get('/old/app-feature')).toBe(dashed)
    expect(expandedOf('/old/app2')).toEqual(['/old/app2/src'])
    expect(expandedOf('/old/app-feature')).toEqual(['/old/app-feature/src'])
    expect(state.filterByWorktree.get('/old/app2')).toBe('readme')
    expect(state.fileTreeByWorktree.get('/old/app2')).toEqual([node('/old/app2/src')])
    expect(state.fileIndexByWorktree.get('/old/app2')).toEqual([file('/old/app2/a.ts')])
    expect(state.fileIndexLoadingByWorktree.get('/old/app2')).toBe(true)
  })

  it('merges into what the new path already holds', () => {
    useFileTreeStore.setState({
      expandedPathsByWorktree: new Map([
        ['/new/app', new Set(['/new/app/docs'])],
        ['/old/app', new Set(['/old/app/src', '/old/app/docs'])]
      ])
    })

    useFileTreeStore.getState().rekeyWorktreePaths([{ from: '/old/app', to: '/new/app' }])

    expect(expandedOf('/old/app')).toBeUndefined()
    expect(expandedOf('/new/app')).toEqual(['/new/app/docs', '/new/app/src'])
  })

  it('merges the same way when the moved worktree comes first in the map', () => {
    useFileTreeStore.setState({
      expandedPathsByWorktree: new Map([
        ['/old/app', new Set(['/old/app/src'])],
        ['/new/app', new Set(['/new/app/docs'])]
      ])
    })

    useFileTreeStore.getState().rekeyWorktreePaths([{ from: '/old/app', to: '/new/app' }])

    expect(expandedOf('/new/app')).toEqual(['/new/app/docs', '/new/app/src'])
  })

  it('moves the filter, replacing what the new path held', () => {
    useFileTreeStore.setState({
      filterByWorktree: new Map([
        ['/new/app', 'stale'],
        ['/old/app', 'index'],
        ['/other', 'keep']
      ])
    })

    useFileTreeStore.getState().rekeyWorktreePaths([{ from: '/old/app', to: '/new/app' }])

    const { filterByWorktree, getFilter } = useFileTreeStore.getState()
    expect(filterByWorktree.has('/old/app')).toBe(false)
    expect(getFilter('/new/app')).toBe('index')
    expect(getFilter('/other')).toBe('keep')
  })

  it('drops the tree and the file index scanned under the old path', () => {
    useFileTreeStore.setState({
      fileTreeByWorktree: new Map([
        ['/old/app', [node('/old/app/src')]],
        ['/old/app/.worktrees/fix', [node('/old/app/.worktrees/fix/src')]],
        ['/other', [node('/other/src')]]
      ]),
      fileIndexByWorktree: new Map([
        ['/old/app', [file('/old/app/a.ts')]],
        ['/other', [file('/other/a.ts')]]
      ]),
      fileIndexLoadingByWorktree: new Map([
        ['/old/app', true],
        ['/other', false]
      ])
    })

    useFileTreeStore.getState().rekeyWorktreePaths([{ from: '/old/app', to: '/new/app' }])

    const state = useFileTreeStore.getState()
    expect(Array.from(state.fileTreeByWorktree.keys())).toEqual(['/other'])
    expect(Array.from(state.fileIndexByWorktree.keys())).toEqual(['/other'])
    expect(Array.from(state.fileIndexLoadingByWorktree.keys())).toEqual(['/other'])
    // Nothing is filed under the new path: the views scan it when they show it.
    expect(state.fileTreeByWorktree.has('/new/app')).toBe(false)
    expect(state.getFileTree('/new/app')).toEqual([])
  })

  it('writes the re-keyed expanded folders to localStorage', () => {
    useFileTreeStore.setState({
      expandedPathsByWorktree: new Map([
        ['/old/app', new Set(['/old/app/src'])],
        ['/other', new Set(['/other/src'])]
      ])
    })

    useFileTreeStore.getState().rekeyWorktreePaths([{ from: '/old/app', to: '/new/app' }])

    expect(persistedExpanded()).toEqual([
      ['/new/app', ['/new/app/src']],
      ['/other', ['/other/src']]
    ])
  })

  it('changes nothing, and writes nothing, when no path it holds moved', () => {
    useFileTreeStore.setState({
      expandedPathsByWorktree: new Map([['/other', new Set(['/other/src'])]]),
      filterByWorktree: new Map([['/other', 'keep']]),
      fileTreeByWorktree: new Map([['/other', [node('/other/src')]]])
    })
    const before = useFileTreeStore.getState()
    const listener = vi.fn()
    const unsubscribe = useFileTreeStore.subscribe(listener)
    const writes = countStorageWrites()

    useFileTreeStore.getState().rekeyWorktreePaths([{ from: '/old/app', to: '/new/app' }])
    useFileTreeStore.getState().rekeyWorktreePaths([])
    useFileTreeStore.getState().rekeyWorktreePaths([{ from: '/other', to: '/other' }])
    useFileTreeStore.getState().rekeyWorktreePaths([{ from: '', to: '/new/app' }])
    unsubscribe()

    expect(listener).not.toHaveBeenCalled()
    expect(writes.count()).toBe(0)
    expect(useFileTreeStore.getState()).toBe(before)

    // The counter does count: a move of something that is held writes once.
    useFileTreeStore.getState().rekeyWorktreePaths([{ from: '/other', to: '/moved' }])
    expect(writes.count()).toBe(1)
    writes.restore()
  })
})
