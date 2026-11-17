// The dialog says before a move which unsaved edits will be lost, and the refresh after the
// move closes file tabs. The two are decided in two places (the dialog from the worktree rows,
// the refresh from what the move answered) and must agree: an edit that is lost without a
// warning is the worst outcome, a warning for an edit that stays is noise. One fixture, the
// real dialog, the real refresh and the real file-viewer store, one unsaved file at a time.
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const board = vi.hoisted(() => ({ reloadBoard: vi.fn(async () => undefined) }))
vi.mock('@/lib/board-reload', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/board-reload')>()),
  reloadBoard: board.reloadBoard
}))

import { DevFolderMoveHost } from '@/components/settings/dev-folder/DevFolderMoveHost'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { useDocumentFlowStore } from '@/stores/useDocumentFlowStore'
import { useFileViewerStore } from '@/stores/useFileViewerStore'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import type { DevFolderMovePlan, DevFolderMoveResult } from '@shared/types/dev-folder'
import { refreshAfterProjectMove } from '../refresh'
import { CLOSED_DEV_FOLDER_MOVE, rowsOfDevFolderPlan, useDevFolderMoveStore } from '../store'

const OLD = '/Users/me/hive-projects'
const NEW = '/Users/me/Dev'

const PLAN: DevFolderMovePlan = {
  devFolder: NEW,
  sources: [OLD],
  candidates: [
    {
      projectId: 'p-api',
      projectName: 'api',
      source: OLD,
      fromPath: `${OLD}/api`,
      toPath: `${NEW}/api`,
      skipReason: null,
      detail: null
    }
  ]
}

// What the window holds about the project: its checkout, a worktree inside it, one next to it
// and one kept in another place.
const WORKTREES = [
  { id: 'wt-main', project_id: 'p-api', path: `${OLD}/api` },
  { id: 'wt-inner', project_id: 'p-api', path: `${OLD}/api/.claude/worktrees/inner` },
  { id: 'wt-hotfix', project_id: 'p-api', path: `${OLD}/api-hotfix` },
  { id: 'wt-far', project_id: 'p-api', path: '/Users/me/.hive-worktrees/api/far' }
]

// What the move answers: the checkout and every worktree row whose folder changed.
const MOVED: DevFolderMoveResult = {
  projectId: 'p-api',
  projectName: 'api',
  action: 'moved',
  fromPath: `${OLD}/api`,
  toPath: `${NEW}/api`,
  skipReason: null,
  detail: null,
  warnings: [],
  movedPaths: [
    { from: `${OLD}/api`, to: `${NEW}/api` },
    { from: `${OLD}/api/.claude/worktrees/inner`, to: `${NEW}/api/.claude/worktrees/inner` },
    { from: `${OLD}/api-hotfix`, to: `${NEW}/api-hotfix` }
  ]
}

const originals = {
  loadProjects: useProjectStore.getState().loadProjects,
  loadWorktrees: useWorktreeStore.getState().loadWorktrees,
  loadConnections: useConnectionStore.getState().loadConnections
}

const viewer = (): ReturnType<typeof useFileViewerStore.getState> => useFileViewerStore.getState()

beforeEach(() => {
  viewer().closeAllFiles()
  useProjectStore.setState({ projects: [], loadProjects: async () => undefined })
  useWorktreeStore.setState({
    worktreesByProject: new Map([['p-api', WORKTREES]]) as never,
    loadWorktrees: async () => undefined
  })
  useConnectionStore.setState({ loadConnections: async () => undefined })
  useKanbanStore.setState({ tickets: new Map() })
  useDocumentFlowStore.setState({ runsById: {}, loadedProjects: {} })
})

afterEach(() => {
  cleanup()
  useDevFolderMoveStore.setState({ ...CLOSED_DEV_FOLDER_MOVE })
  useProjectStore.setState({ projects: [], loadProjects: originals.loadProjects })
  useWorktreeStore.setState({
    worktreesByProject: new Map(),
    loadWorktrees: originals.loadWorktrees
  })
  useConnectionStore.setState({ loadConnections: originals.loadConnections })
  viewer().closeAllFiles()
})

describe('unsaved edits: what the dialog warns about is what the move closes', () => {
  it.each([
    ['in the checkout', `${OLD}/api/src/a.ts`, true],
    ['in a worktree inside the checkout', `${OLD}/api/.claude/worktrees/inner/src/a.ts`, true],
    ['in a worktree next to the checkout', `${OLD}/api-hotfix/src/a.ts`, true],
    ['in a worktree kept somewhere else', '/Users/me/.hive-worktrees/api/far/src/a.ts', false],
    ['opened through a connection folder', '/Users/me/.hive/connections/shop/api/a.ts', false],
    ['in a folder whose name only starts the same', `${OLD}/api2/src/a.ts`, false],
    ['in another project', `${OLD}/web/src/a.ts`, false]
  ])('a file %s', async (_where, path, lost) => {
    viewer().openFile(path, 'a.ts', 'wt')
    viewer().markDirty(path)
    act(() => {
      useDevFolderMoveStore.setState({
        ...CLOSED_DEV_FOLDER_MOVE,
        phase: 'confirm',
        plan: PLAN,
        rows: rowsOfDevFolderPlan(PLAN)
      })
    })
    render(<DevFolderMoveHost />)
    const warned = screen.queryByTestId('dev-folder-move-unsaved') !== null

    await act(() => refreshAfterProjectMove(MOVED))

    expect(warned).toBe(lost)
    expect(viewer().openFiles.has(path)).toBe(!lost)
    expect(viewer().dirtyFiles.has(path)).toBe(!lost)
    expect(viewer().activeFilePath).toBe(lost ? null : path)
  })
})
