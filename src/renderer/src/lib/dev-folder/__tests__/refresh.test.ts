// What the window reloads after a project moved to the dev folder, in which order, and what it
// leaves alone. The stores are the real ones. Their loads are replaced by recorders, except
// where a test is about a real load (the worktrees load that was already under way).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const board = vi.hoisted(() => ({ reloadBoard: vi.fn() }))
vi.mock('@/lib/board-reload', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/board-reload')>()),
  reloadBoard: board.reloadBoard
}))

import { getRendererRpcClient, setRendererRpcClient } from '@/api/rpc-client'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { useDataProjectStore } from '@/stores/useDataProjectStore'
import { useDocumentFlowStore } from '@/stores/useDocumentFlowStore'
import { useFileTreeStore } from '@/stores/useFileTreeStore'
import { useFileViewerStore, type ActiveDiff } from '@/stores/useFileViewerStore'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { usePinnedStore } from '@/stores/usePinnedStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import type { DevFolderMoveResult } from '@shared/types/dev-folder'
import type { DocumentRun, DocumentRunDetail } from '@shared/types/document-flow'
import {
  isSameOrInsidePath,
  movedPathFor,
  refreshAfterDevFolderRun,
  refreshAfterProjectMove
} from '../refresh'

type ProjectRow = ReturnType<typeof useProjectStore.getState>['projects'][number]
type WorktreeRow = NonNullable<
  ReturnType<ReturnType<typeof useWorktreeStore.getState>['worktreesByProject']['get']>
>[number]

const defaultClient = getRendererRpcClient()

const originals = {
  loadProjects: useProjectStore.getState().loadProjects,
  loadWorktrees: useWorktreeStore.getState().loadWorktrees,
  loadConnections: useConnectionStore.getState().loadConnections,
  loadPinned: usePinnedStore.getState().loadPinned,
  loadRuns: useDocumentFlowStore.getState().loadRuns,
  refreshRun: useDocumentFlowStore.getState().refreshRun,
  rekeyWorktreePaths: useFileTreeStore.getState().rekeyWorktreePaths,
  closeTabsWhere: useFileViewerStore.getState().closeTabsWhere,
  loadDataProjects: useDataProjectStore.getState().load
}

/** Every reload, in the order it started. */
const calls: string[] = []

const loadWorktrees = vi.fn<(projectId: string, opts?: { force?: boolean }) => Promise<void>>()

const movedResult = (overrides: Partial<DevFolderMoveResult> = {}): DevFolderMoveResult => ({
  projectId: 'p1',
  projectName: 'app',
  action: 'moved',
  fromPath: '/old/app',
  toPath: '/new/app',
  skipReason: null,
  detail: null,
  warnings: [],
  movedPaths: [{ from: '/old/app', to: '/new/app' }],
  ...overrides
})

const project = (overrides: Partial<ProjectRow> & { id: string }): ProjectRow => ({
  name: overrides.id,
  path: `/somewhere/${overrides.id}`,
  description: null,
  tags: null,
  language: null,
  custom_icon: null,
  detected_icon: null,
  setup_script: null,
  run_script: null,
  archive_script: null,
  worktree_create_script: null,
  custom_commands: null,
  auto_assign_port: false,
  sort_order: 0,
  created_at: '2026-01-01T00:00:00.000Z',
  last_accessed_at: '2026-01-01T00:00:00.000Z',
  ...overrides
})

const worktree = (overrides: Partial<WorktreeRow> & { id: string; path: string }): WorktreeRow => ({
  project_id: 'p1',
  name: 'main',
  branch_name: 'main',
  status: 'active',
  is_default: true,
  branch_renamed: 0,
  last_message_at: null,
  session_titles: '[]',
  last_model_provider_id: null,
  last_model_id: null,
  last_model_variant: null,
  attachments: '[]',
  created_at: '2026-01-01T00:00:00.000Z',
  last_accessed_at: '2026-01-01T00:00:00.000Z',
  github_pr_number: null,
  github_pr_url: null,
  ...overrides
})

// Only the fields the refresh reads; the rest of a run does not matter to it.
const runDetail = (run: Partial<DocumentRun> & { id: string }): DocumentRunDetail =>
  ({
    run: {
      project_id: 'p1',
      source_path: '',
      integration_worktree_path: null,
      members: null,
      ...run
    },
    items: [],
    events: []
  }) as unknown as DocumentRunDetail

const openTabs = (): string[] => Array.from(useFileViewerStore.getState().openFiles.keys())
const dirtyTabs = (): string[] => Array.from(useFileViewerStore.getState().dirtyFiles)

const diffOf = (worktreePath: string, filePath: string): ActiveDiff => ({
  worktreePath,
  filePath,
  fileName: filePath.split('/').pop() ?? filePath,
  staged: false,
  isUntracked: false
})

beforeEach(() => {
  calls.length = 0

  useProjectStore.setState({
    projects: [],
    loadProjects: async () => {
      calls.push('loadProjects')
    }
  })
  loadWorktrees.mockReset()
  loadWorktrees.mockImplementation(async (projectId, opts) => {
    calls.push(`loadWorktrees:${projectId}:${opts?.force === true ? 'force' : 'cached'}`)
  })
  useWorktreeStore.setState({ worktreesByProject: new Map(), loadWorktrees })
  useConnectionStore.setState({
    loadConnections: async () => {
      calls.push('loadConnections')
    }
  })
  usePinnedStore.setState({
    loadPinned: async () => {
      calls.push('loadPinned')
    }
  })
  useFileTreeStore.setState({
    expandedPathsByWorktree: new Map(),
    filterByWorktree: new Map(),
    fileTreeByWorktree: new Map(),
    fileIndexByWorktree: new Map(),
    fileIndexLoadingByWorktree: new Map(),
    rekeyWorktreePaths: (moves) => {
      calls.push('rekeyWorktreePaths')
      originals.rekeyWorktreePaths(moves)
    }
  })
  useFileViewerStore.setState({
    openFiles: new Map(),
    activeFilePath: null,
    activeDiff: null,
    contextEditorWorktreeId: null,
    dirtyFiles: new Set(),
    originalContents: new Map(),
    pendingClose: null,
    externallyChanged: new Set(),
    closeTabsWhere: (matches) => {
      calls.push('closeTabsWhere')
      originals.closeTabsWhere(matches)
    }
  })
  useDataProjectStore.setState({
    loaded: false,
    load: async () => {
      calls.push('loadDataProjects')
    }
  })
  useKanbanStore.setState({ tickets: new Map() })
  useDocumentFlowStore.setState({
    runsById: {},
    loadedProjects: {},
    loadRuns: async (projectId) => {
      calls.push(`loadRuns:${projectId}`)
    },
    refreshRun: async (runId) => {
      calls.push(`refreshRun:${runId}`)
      return null
    }
  })
  board.reloadBoard.mockReset()
  board.reloadBoard.mockImplementation(async (projectId: string) => {
    calls.push(`reloadBoard:${projectId}`)
  })
})

afterEach(() => {
  useProjectStore.setState({ projects: [], loadProjects: originals.loadProjects })
  useWorktreeStore.setState({
    worktreesByProject: new Map(),
    loadWorktrees: originals.loadWorktrees
  })
  useConnectionStore.setState({ loadConnections: originals.loadConnections })
  usePinnedStore.setState({ loadPinned: originals.loadPinned })
  useFileTreeStore.setState({ rekeyWorktreePaths: originals.rekeyWorktreePaths })
  useFileViewerStore.setState({ closeTabsWhere: originals.closeTabsWhere })
  useFileViewerStore.getState().closeAllFiles()
  useDataProjectStore.setState({ loaded: false, load: originals.loadDataProjects })
  useDocumentFlowStore.setState({
    runsById: {},
    loadedProjects: {},
    loadRuns: originals.loadRuns,
    refreshRun: originals.refreshRun
  })
  setRendererRpcClient(defaultClient)
  vi.restoreAllMocks()
})

describe('refreshAfterProjectMove', () => {
  it('reloads in the order the views need: file tree, rows, tabs, board, runs', async () => {
    useKanbanStore.setState({ tickets: new Map([['p1', []]]) })
    useDocumentFlowStore.setState({ loadedProjects: { p1: true } })
    useFileViewerStore.getState().openFile('/old/app/src/a.ts', 'a.ts', 'wt-1')

    await refreshAfterProjectMove(movedResult())

    expect(calls).toEqual([
      'rekeyWorktreePaths',
      'loadProjects',
      'loadWorktrees:p1:force',
      'loadConnections',
      'closeTabsWhere',
      'reloadBoard:p1',
      'loadRuns:p1'
    ])
  })

  it('re-keys the file tree in the same tick as the call, before any reload starts', async () => {
    useFileTreeStore.setState({
      expandedPathsByWorktree: new Map([['/old/app', new Set(['/old/app/src'])]])
    })

    const done = refreshAfterProjectMove(movedResult())

    expect(calls).toEqual(['rekeyWorktreePaths'])
    expect(useFileTreeStore.getState().expandedPathsByWorktree.get('/new/app')).toEqual(
      new Set(['/new/app/src'])
    )
    expect(useFileTreeStore.getState().expandedPathsByWorktree.has('/old/app')).toBe(false)
    await done
  })

  it('does not touch the pinned list: that is read once, when the whole run is over', async () => {
    await refreshAfterProjectMove(movedResult())

    expect(calls).not.toContain('loadPinned')
  })

  describe('the worktrees', () => {
    it('are read once when the rows show the new folder', async () => {
      loadWorktrees.mockImplementation(async (projectId) => {
        calls.push(`loadWorktrees:${projectId}`)
        useWorktreeStore.setState({
          worktreesByProject: new Map([[projectId, [worktree({ id: 'wt-1', path: '/new/app' })]]])
        })
      })

      await refreshAfterProjectMove(movedResult())

      expect(loadWorktrees).toHaveBeenCalledTimes(1)
      expect(loadWorktrees).toHaveBeenCalledWith('p1', { force: true })
    })

    it('are read once more, and only once, while a row still shows a folder that moved', async () => {
      useWorktreeStore.setState({
        worktreesByProject: new Map([
          [
            'p1',
            [
              worktree({ id: 'wt-1', path: '/new/app' }),
              worktree({ id: 'wt-2', path: '/old/app/.worktrees/fix', is_default: false })
            ]
          ]
        ])
      })

      await refreshAfterProjectMove(
        movedResult({
          movedPaths: [
            { from: '/old/app', to: '/new/app' },
            { from: '/old/app/.worktrees/fix', to: '/new/app/.worktrees/fix' }
          ]
        })
      )

      expect(loadWorktrees).toHaveBeenCalledTimes(2)
      expect(loadWorktrees).toHaveBeenNthCalledWith(2, 'p1', { force: true })
    })

    it('are not read again because of a row of a neighbouring folder', async () => {
      useWorktreeStore.setState({
        worktreesByProject: new Map([['p1', [worktree({ id: 'wt-1', path: '/old/app2' })]]])
      })

      await refreshAfterProjectMove(movedResult())

      expect(loadWorktrees).toHaveBeenCalledTimes(1)
    })

    it('end up with the rows from after the move when a load from before it was still under way', async () => {
      // The store's own load this time: it answers a forced load with the one already in flight.
      useWorktreeStore.setState({ loadWorktrees: originals.loadWorktrees })
      const pending: Array<(rows: WorktreeRow[]) => void> = []
      const request: ReturnType<typeof vi.fn> = vi.fn(
        (method: string, params?: unknown): Promise<unknown> => {
          if (method !== 'db.worktree.getActiveByProject') {
            return defaultClient.request(method, params)
          }
          return new Promise((resolve) => pending.push(resolve))
        }
      )
      setRendererRpcClient({ request, subscribe: vi.fn(() => () => {}) })
      const worktreeReads = (): number =>
        request.mock.calls.filter(([method]) => method === 'db.worktree.getActiveByProject').length

      // Started before the move; it will answer with the rows as they were.
      const early = useWorktreeStore.getState().loadWorktrees('p-inflight')
      const done = refreshAfterProjectMove(movedResult({ projectId: 'p-inflight' }))
      await vi.waitFor(() => expect(calls).toContain('loadProjects'))
      await Promise.resolve()
      // The refresh joined the load that was under way: still one read.
      expect(worktreeReads()).toBe(1)

      pending[0]([worktree({ id: 'wt-1', project_id: 'p-inflight', path: '/old/app' })])
      await early
      await vi.waitFor(() => expect(worktreeReads()).toBe(2))
      pending[1]([worktree({ id: 'wt-1', project_id: 'p-inflight', path: '/new/app' })])
      await done

      expect(
        useWorktreeStore
          .getState()
          .worktreesByProject.get('p-inflight')
          ?.map((row) => row.path)
      ).toEqual(['/new/app'])
      expect(worktreeReads()).toBe(2)
      expect(calls).toContain('loadConnections')
    })
  })

  describe('the file tabs', () => {
    it('of a folder that moved are closed, and every other tab stays open', async () => {
      const viewer = useFileViewerStore.getState()
      viewer.openFile('/elsewhere/readme.md', 'readme.md', 'wt-9')
      viewer.openFile('/old/app/src/a.ts', 'a.ts', 'wt-1')

      await refreshAfterProjectMove(movedResult())

      expect(calls).toContain('closeTabsWhere')
      expect(openTabs()).toEqual(['/elsewhere/readme.md'])
      // The tab on screen was closed: the one that is left takes its place.
      expect(useFileViewerStore.getState().activeFilePath).toBe('/elsewhere/readme.md')
    })

    it('of another folder keep their unsaved edits; those of the moved folder lose theirs', async () => {
      const viewer = useFileViewerStore.getState()
      viewer.openFile('/old/app/src/a.ts', 'a.ts', 'wt-1')
      viewer.markDirty('/old/app/src/a.ts')
      viewer.setOriginalContent('/old/app/src/a.ts', 'a before')
      viewer.openFile('/elsewhere/notes.md', 'notes.md', 'wt-9')
      viewer.markDirty('/elsewhere/notes.md')
      viewer.setOriginalContent('/elsewhere/notes.md', 'notes before')

      await refreshAfterProjectMove(movedResult())

      expect(openTabs()).toEqual(['/elsewhere/notes.md'])
      expect(dirtyTabs()).toEqual(['/elsewhere/notes.md'])
      expect(Array.from(useFileViewerStore.getState().originalContents.keys())).toEqual([
        '/elsewhere/notes.md'
      ])
      expect(useFileViewerStore.getState().activeFilePath).toBe('/elsewhere/notes.md')
    })

    it('opened through a connection folder stay open and unsaved when another member moves', async () => {
      // In a connection, a file is opened through the connection's own folder, and a diff
      // carries the real folder of the member it belongs to.
      const edited = '/Users/me/.hive/connections/shop/web/src/cart.ts'
      const viewer = useFileViewerStore.getState()
      viewer.setActiveDiff(diffOf('/old/app', 'src/server.ts'))
      viewer.openFile(edited, 'cart.ts', 'conn-1')
      viewer.markDirty(edited)

      await refreshAfterProjectMove(movedResult())

      expect(openTabs()).toEqual([edited])
      expect(dirtyTabs()).toEqual([edited])
      expect(useFileViewerStore.getState().activeFilePath).toBe(edited)
      expect(useFileViewerStore.getState().activeDiff).toBeNull()
    })

    it('are closed for a file of a worktree inside the project, and of one that moved with it', async () => {
      const viewer = useFileViewerStore.getState()
      viewer.openFile('/old/app/.worktrees/fix/c.ts', 'c.ts', 'wt-3')
      viewer.openFile('/old/app-feature/lib/b.ts', 'b.ts', 'wt-2')
      viewer.markDirty('/old/app-feature/lib/b.ts')
      viewer.openFile('/old/app-other/d.ts', 'd.ts', 'wt-4')

      await refreshAfterProjectMove(
        movedResult({
          movedPaths: [
            { from: '/old/app', to: '/new/app' },
            { from: '/old/app-feature', to: '/new/app-feature' }
          ]
        })
      )

      expect(openTabs()).toEqual(['/old/app-other/d.ts'])
      expect(dirtyTabs()).toEqual([])
    })

    it('are closed for a diff of a worktree that moved, whatever worktree is selected', async () => {
      useFileViewerStore.getState().setActiveDiff(diffOf('/old/app', 'src/a.ts'))

      await refreshAfterProjectMove(movedResult())

      expect(openTabs()).toEqual([])
      expect(useFileViewerStore.getState().activeDiff).toBeNull()
    })

    it('leave the diff of another folder on screen', async () => {
      const viewer = useFileViewerStore.getState()
      viewer.openFile('/old/app/src/a.ts', 'a.ts', 'wt-1')
      viewer.setActiveDiff(diffOf('/elsewhere', 'src/kept.ts'))
      const shown = useFileViewerStore.getState().activeDiff

      await refreshAfterProjectMove(movedResult())

      expect(openTabs()).toHaveLength(1)
      expect(useFileViewerStore.getState().activeDiff).toBe(shown)
    })

    it('take a diff of a moved folder off the screen when it has no tab of its own', async () => {
      const viewer = useFileViewerStore.getState()
      viewer.openFile('/elsewhere/readme.md', 'readme.md', 'wt-9')
      useFileViewerStore.setState({ activeDiff: diffOf('/old/app', 'src/a.ts') })

      await refreshAfterProjectMove(movedResult())

      expect(openTabs()).toEqual(['/elsewhere/readme.md'])
      expect(useFileViewerStore.getState().activeDiff).toBeNull()
    })

    it('stay open when none of them is inside a folder that moved', async () => {
      const viewer = useFileViewerStore.getState()
      viewer.openFile('/old/app2/src/a.ts', 'a.ts', 'wt-7')
      viewer.openFile('/old/app-feature/b.ts', 'b.ts', 'wt-8')
      viewer.markDirty('/old/app-feature/b.ts')
      viewer.openContextEditor('wt-1')

      await refreshAfterProjectMove(movedResult())

      expect(openTabs()).toEqual(['/old/app2/src/a.ts', '/old/app-feature/b.ts', 'context:wt-1'])
      expect(dirtyTabs()).toEqual(['/old/app-feature/b.ts'])
      expect(useFileViewerStore.getState().activeFilePath).toBe('context:wt-1')
    })
  })

  describe('a folder the answer did not name', () => {
    const unanswered = (): DevFolderMoveResult =>
      movedResult({ action: 'failed', toPath: null, detail: 'no answer', movedPaths: [] })

    /** The rows before the move, and loads that answer with the rows after it. */
    const rowsThatMoved = (): void => {
      useProjectStore.setState({
        projects: [project({ id: 'p1', path: '/old/app' })],
        loadProjects: async () => {
          calls.push('loadProjects')
          useProjectStore.setState({ projects: [project({ id: 'p1', path: '/new/app' })] })
        }
      })
      useWorktreeStore.setState({
        worktreesByProject: new Map([
          [
            'p1',
            [
              worktree({ id: 'wt-1', path: '/old/app' }),
              worktree({ id: 'wt-2', path: '/old/app/.worktrees/fix', is_default: false }),
              worktree({ id: 'wt-3', path: '/old/app-feature', is_default: false }),
              worktree({ id: 'wt-4', path: '/Users/me/.hive-worktrees/app/x', is_default: false })
            ]
          ]
        ])
      })
      loadWorktrees.mockImplementation(async (projectId, opts) => {
        calls.push(`loadWorktrees:${projectId}:${opts?.force === true ? 'force' : 'cached'}`)
        useWorktreeStore.setState({
          worktreesByProject: new Map([
            [
              projectId,
              [
                worktree({ id: 'wt-1', path: '/new/app' }),
                worktree({ id: 'wt-2', path: '/new/app/.worktrees/fix', is_default: false }),
                worktree({ id: 'wt-3', path: '/new/app-feature', is_default: false }),
                worktree({ id: 'wt-4', path: '/Users/me/.hive-worktrees/app/x', is_default: false })
              ]
            ]
          ])
        })
      })
    }

    it('is followed when the reloaded rows show it somewhere else', async () => {
      rowsThatMoved()
      const rekeyed: unknown[] = []
      useFileTreeStore.setState({
        rekeyWorktreePaths: (moves) => {
          calls.push('rekeyWorktreePaths')
          rekeyed.push(moves)
          originals.rekeyWorktreePaths(moves)
        }
      })
      useFileTreeStore.setState({
        expandedPathsByWorktree: new Map([
          ['/old/app', new Set(['/old/app/src'])],
          ['/old/app-feature', new Set(['/old/app-feature/lib'])],
          ['/Users/me/.hive-worktrees/app/x', new Set(['/Users/me/.hive-worktrees/app/x/src'])]
        ])
      })
      const viewer = useFileViewerStore.getState()
      viewer.openFile('/old/app/src/a.ts', 'a.ts', 'wt-1')
      viewer.openFile('/old/app-feature/lib/b.ts', 'b.ts', 'wt-3')
      viewer.openFile('/elsewhere/readme.md', 'readme.md', 'wt-9')
      useDocumentFlowStore.setState({
        runsById: {
          'run-doc': runDetail({ id: 'run-doc', project_id: 'p2', source_path: '/old/app/spec.md' })
        }
      })

      await refreshAfterProjectMove(unanswered())

      // The first pass has nothing to file; the second one, after the rows, has.
      expect(calls).toEqual([
        'rekeyWorktreePaths',
        'loadProjects',
        'loadWorktrees:p1:force',
        'rekeyWorktreePaths',
        'loadConnections',
        'closeTabsWhere',
        'refreshRun:run-doc'
      ])
      // One entry per folder: the project row and its first worktree name the same one, and
      // the worktree inside the checkout went where the checkout went.
      expect(rekeyed).toEqual([
        [],
        [
          { from: '/old/app', to: '/new/app' },
          { from: '/old/app-feature', to: '/new/app-feature' }
        ]
      ])
      const expanded = useFileTreeStore.getState().expandedPathsByWorktree
      expect(Array.from(expanded.keys()).sort()).toEqual([
        '/Users/me/.hive-worktrees/app/x',
        '/new/app',
        '/new/app-feature'
      ])
      expect(expanded.get('/new/app')).toEqual(new Set(['/new/app/src']))
      expect(expanded.get('/new/app-feature')).toEqual(new Set(['/new/app-feature/lib']))
      expect(openTabs()).toEqual(['/elsewhere/readme.md'])
    })

    it('is left alone while the rows still show it where it was', async () => {
      useProjectStore.setState({ projects: [project({ id: 'p1', path: '/old/app' })] })
      useWorktreeStore.setState({
        worktreesByProject: new Map([['p1', [worktree({ id: 'wt-1', path: '/old/app' })]]])
      })
      useFileViewerStore.getState().openFile('/old/app/src/a.ts', 'a.ts', 'wt-1')

      await refreshAfterProjectMove(unanswered())

      expect(calls).toEqual([
        'rekeyWorktreePaths',
        'loadProjects',
        'loadWorktrees:p1:force',
        'loadConnections'
      ])
      expect(openTabs()).toEqual(['/old/app/src/a.ts'])
    })

    it('is filed once when the answer named it too', async () => {
      rowsThatMoved()

      await refreshAfterProjectMove(
        movedResult({
          movedPaths: [
            { from: '/old/app', to: '/new/app' },
            { from: '/old/app-feature', to: '/new/app-feature' }
          ]
        })
      )

      expect(calls.filter((call) => call === 'rekeyWorktreePaths')).toHaveLength(1)
    })

    it('is added to what the answer named when the answer left it out', async () => {
      rowsThatMoved()
      const rekeyed: unknown[] = []
      useFileTreeStore.setState({
        rekeyWorktreePaths: (moves) => {
          rekeyed.push(moves)
          originals.rekeyWorktreePaths(moves)
        }
      })
      useFileViewerStore.getState().openFile('/old/app-feature/lib/b.ts', 'b.ts', 'wt-3')

      await refreshAfterProjectMove(movedResult())

      expect(rekeyed).toEqual([
        [{ from: '/old/app', to: '/new/app' }],
        [{ from: '/old/app-feature', to: '/new/app-feature' }]
      ])
      expect(openTabs()).toEqual([])
    })

    // The end of a run reads the database connections; a move that ended after it, or that
    // is found on "Check again", has no run to do that.
    it('has the database connections read again when this window had listed them', async () => {
      rowsThatMoved()
      useDataProjectStore.setState({ loaded: true })

      await refreshAfterProjectMove(unanswered())

      expect(calls.filter((call) => call === 'loadDataProjects')).toHaveLength(1)
      expect(calls[calls.length - 1]).toBe('loadDataProjects')
    })

    it('leaves the database connections alone while the rows show nothing new', async () => {
      useProjectStore.setState({ projects: [project({ id: 'p1', path: '/old/app' })] })
      useDataProjectStore.setState({ loaded: true })

      await refreshAfterProjectMove(unanswered())

      expect(calls).not.toContain('loadDataProjects')
    })

    it('leaves the database connections to the end of the run when the answer named the folders', async () => {
      rowsThatMoved()
      useDataProjectStore.setState({ loaded: true })

      await refreshAfterProjectMove(
        movedResult({
          movedPaths: [
            { from: '/old/app', to: '/new/app' },
            { from: '/old/app-feature', to: '/new/app-feature' }
          ]
        })
      )

      expect(calls).not.toContain('loadDataProjects')
    })
  })

  describe('the boards', () => {
    it('are reloaded when they are loaded: a ticket of any project can name the folder', async () => {
      useKanbanStore.setState({
        tickets: new Map([
          ['another-project', []],
          ['p1', []]
        ])
      })

      await refreshAfterProjectMove(movedResult())

      // The board of the project that moved first, then the others.
      expect(board.reloadBoard.mock.calls).toEqual([['p1'], ['another-project']])
    })

    it('are left alone when none was opened', async () => {
      await refreshAfterProjectMove(movedResult())

      expect(board.reloadBoard).not.toHaveBeenCalled()
    })

    it('of the connection projects the moved project is a member of come before the others', async () => {
      useProjectStore.setState({
        projects: [
          project({ id: 'p1' }),
          project({ id: 'with-p1', kind: 'connection', member_project_ids: '["p0","p1"]' }),
          project({ id: 'without-p1', kind: 'connection', member_project_ids: '["p0","p2"]' }),
          project({ id: 'not-opened', kind: 'connection', member_project_ids: '["p1"]' })
        ]
      })
      useKanbanStore.setState({
        tickets: new Map([
          ['without-p1', []],
          ['with-p1', []]
        ])
      })

      await refreshAfterProjectMove(movedResult())

      expect(board.reloadBoard.mock.calls).toEqual([['with-p1'], ['without-p1']])
    })

    it('of other projects are left to the end of the run for a project that moved inside one', async () => {
      useProjectStore.setState({
        projects: [
          project({ id: 'p1' }),
          project({ id: 'with-p1', kind: 'connection', member_project_ids: '["p0","p1"]' })
        ]
      })
      useKanbanStore.setState({
        tickets: new Map([
          ['another-project', []],
          ['with-p1', []],
          ['p1', []]
        ])
      })

      await refreshAfterProjectMove(movedResult({ boardProjectIds: ['p1'] }), { inRun: true })

      // The boards that name the project, and no other: a run over hundreds of projects would
      // reload every open board once per project.
      expect(board.reloadBoard.mock.calls).toEqual([['p1'], ['with-p1']])
    })

    it('that the move rewrote a ticket of are reloaded at once, inside a run as well', async () => {
      useKanbanStore.setState({
        tickets: new Map([
          ['untouched', []],
          ['names-the-folder', []],
          ['p1', []]
        ])
      })

      // A launch that starts from that board while the run goes on must not send the old
      // folder: it cannot wait for the end of the run. A board that is not loaded is not.
      await refreshAfterProjectMove(
        movedResult({ boardProjectIds: ['names-the-folder', 'not-loaded'] }),
        { inRun: true }
      )

      expect(board.reloadBoard.mock.calls).toEqual([['p1'], ['names-the-folder']])
    })

    it('are all reloaded inside a run when the move does not say which it rewrote', async () => {
      useKanbanStore.setState({
        tickets: new Map([
          ['another-project', []],
          ['p1', []]
        ])
      })

      await refreshAfterProjectMove(movedResult(), { inRun: true })

      expect(board.reloadBoard.mock.calls).toEqual([['p1'], ['another-project']])
    })

    it('are reloaded after a move that named no folder as well', async () => {
      useKanbanStore.setState({ tickets: new Map([['another-project', []]]) })

      await refreshAfterProjectMove(
        movedResult({ action: 'failed', toPath: null, detail: 'no answer', movedPaths: [] })
      )

      expect(board.reloadBoard.mock.calls).toEqual([['another-project']])
    })
  })

  describe('the document runs', () => {
    it('of the project are reloaded when its list was fetched', async () => {
      useDocumentFlowStore.setState({ loadedProjects: { p1: true, other: true } })

      await refreshAfterProjectMove(movedResult())

      expect(calls.filter((call) => call.startsWith('loadRuns'))).toEqual(['loadRuns:p1'])
    })

    it('are left alone when no list was fetched', async () => {
      await refreshAfterProjectMove(movedResult())

      expect(calls.some((call) => call.startsWith('loadRuns'))).toBe(false)
      expect(calls.some((call) => call.startsWith('refreshRun'))).toBe(false)
    })

    it('that still name a moved folder are read again one by one', async () => {
      useDocumentFlowStore.setState({
        runsById: {
          'run-doc': runDetail({
            id: 'run-doc',
            project_id: 'p2',
            source_path: '/old/app/spec.md'
          }),
          'run-member': runDetail({
            id: 'run-member',
            project_id: 'cp',
            members: [
              {
                project_id: 'p1',
                project_name: 'app',
                project_path: '/old/app',
                symlink_name: 'app',
                base_branch: 'main',
                base_sha: 'abc',
                integration_branch: 'run/x',
                integration_worktree_id: 'wt-int',
                integration_worktree_path: '/Users/me/.hive-worktrees/app/run-x'
              }
            ]
          }),
          'run-neighbour': runDetail({
            id: 'run-neighbour',
            project_id: 'p3',
            source_path: '/old/app2/spec.md'
          })
        }
      })

      await refreshAfterProjectMove(movedResult())

      expect(calls.filter((call) => call.startsWith('refreshRun'))).toEqual([
        'refreshRun:run-doc',
        'refreshRun:run-member'
      ])
    })
  })

  describe('never rejects', () => {
    it('when every load throws or rejects, and still runs the steps after a failed one', async () => {
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
      useProjectStore.setState({
        loadProjects: () => {
          throw new Error('projects exploded')
        }
      })
      loadWorktrees.mockRejectedValue(new Error('worktrees exploded'))
      useConnectionStore.setState({
        loadConnections: async () => {
          calls.push('loadConnections')
          throw new Error('connections exploded')
        }
      })
      useKanbanStore.setState({ tickets: new Map([['p1', []]]) })
      board.reloadBoard.mockRejectedValue(new Error('board exploded'))
      useDocumentFlowStore.setState({
        loadedProjects: { p1: true },
        loadRuns: async (projectId) => {
          calls.push(`loadRuns:${projectId}`)
          throw new Error('runs exploded')
        }
      })

      await expect(refreshAfterProjectMove(movedResult())).resolves.toBeUndefined()

      expect(calls).toEqual([
        'rekeyWorktreePaths',
        'loadConnections',
        'closeTabsWhere',
        'loadRuns:p1'
      ])
      expect(board.reloadBoard).toHaveBeenCalledWith('p1')
      expect(errors).toHaveBeenCalled()
    })

    it('for an answer that is not a move result at all', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})

      await expect(
        refreshAfterProjectMove(undefined as unknown as DevFolderMoveResult)
      ).resolves.toBeUndefined()
      await expect(
        refreshAfterProjectMove({ ok: true } as unknown as DevFolderMoveResult)
      ).resolves.toBeUndefined()
    })

    it('and reloads the rows of the project when the result names no moved folder', async () => {
      useFileViewerStore.getState().openFile('/old/app/src/a.ts', 'a.ts', 'wt-1')

      await refreshAfterProjectMove(
        movedResult({ action: 'failed', toPath: null, detail: 'no answer', movedPaths: [] })
      )

      expect(calls).toEqual([
        'rekeyWorktreePaths',
        'loadProjects',
        'loadWorktrees:p1:force',
        'loadConnections'
      ])
      expect(openTabs()).toEqual(['/old/app/src/a.ts'])
    })
  })
})

describe('refreshAfterDevFolderRun', () => {
  it('reads the projects, the connections and the pinned list, in that order', async () => {
    await refreshAfterDevFolderRun()

    expect(calls).toEqual(['loadProjects', 'loadConnections', 'loadPinned'])
  })

  it('reloads every loaded board once: a ticket of any project can name a folder that moved', async () => {
    useKanbanStore.setState({
      tickets: new Map([
        ['another-project', []],
        ['p1', []]
      ])
    })

    await refreshAfterDevFolderRun()

    expect(board.reloadBoard.mock.calls).toEqual([['another-project'], ['p1']])
  })

  it('reloads no board when none was opened', async () => {
    await refreshAfterDevFolderRun()

    expect(board.reloadBoard).not.toHaveBeenCalled()
  })

  it('reads the database connections again when this window had listed them', async () => {
    useDataProjectStore.setState({ loaded: true })

    await refreshAfterDevFolderRun()

    expect(calls).toEqual(['loadProjects', 'loadConnections', 'loadPinned', 'loadDataProjects'])
  })

  it('does not list the database connections for a window that never showed them', async () => {
    useDataProjectStore.setState({ loaded: false })

    await refreshAfterDevFolderRun()

    expect(calls).not.toContain('loadDataProjects')
  })

  it('resolves when the database connections cannot be read', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    useDataProjectStore.setState({
      loaded: true,
      load: async () => {
        throw new Error('data projects exploded')
      }
    })

    await expect(refreshAfterDevFolderRun()).resolves.toBeUndefined()

    expect(calls).toEqual(['loadProjects', 'loadConnections', 'loadPinned'])
    expect(errors).toHaveBeenCalled()
  })

  it('never rejects, and a failed read does not cost the ones after it', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    useProjectStore.setState({
      loadProjects: async () => {
        throw new Error('projects exploded')
      }
    })
    useConnectionStore.setState({
      loadConnections: () => {
        throw new Error('connections exploded')
      }
    })

    await expect(refreshAfterDevFolderRun()).resolves.toBeUndefined()

    expect(calls).toEqual(['loadPinned'])
  })
})

describe('what the module hands on', () => {
  it('exports the helpers that decide what is inside a moved folder', () => {
    expect(isSameOrInsidePath('/old/app/src', '/old/app')).toBe(true)
    expect(isSameOrInsidePath('/old/app2', '/old/app')).toBe(false)
    expect(movedPathFor('/old/app/src', [{ from: '/old/app', to: '/new/app' }])).toBe(
      '/new/app/src'
    )
  })
})
