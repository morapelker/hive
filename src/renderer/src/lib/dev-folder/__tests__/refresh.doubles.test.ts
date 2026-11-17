// The refresh is reached from Settings › General (the dev folder row starts "Move projects"),
// and the suites that mount that section replace the settings store, the theme store, the
// shortcut store, the theme list and the toasts with bare stand-ins, under an RPC client that
// answers undefined to what it does not know. This suite installs the same stand-ins and runs
// both refreshes with every real loader, under that client, under one that answers
// `{ ok: true }` to everything, under one that refuses every call, and with no client at all:
// the module has to import, and neither refresh may reject or leave a rejection behind.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockSettingsState: Record<string, unknown> = {
  updateSetting: vi.fn(),
  resetToDefaults: vi.fn()
}

vi.mock('@/stores/useSettingsStore', () => ({
  useSettingsStore: Object.assign(
    (selector?: (state: unknown) => unknown) =>
      selector ? selector(mockSettingsState) : mockSettingsState,
    { getState: () => mockSettingsState }
  )
}))
vi.mock('@/stores/useThemeStore', () => ({ useThemeStore: () => ({ setTheme: vi.fn() }) }))
vi.mock('@/stores/useShortcutStore', () => ({
  useShortcutStore: () => ({ resetToDefaults: vi.fn() })
}))
vi.mock('@/lib/themes', () => ({ DEFAULT_THEME_ID: 'default' }))
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import {
  getRendererRpcClient,
  resetRendererRpcClientForTests,
  setRendererRpcClient,
  type RendererRpcClient
} from '@/api/rpc-client'
import { useDocumentFlowStore } from '@/stores/useDocumentFlowStore'
import { useFileViewerStore } from '@/stores/useFileViewerStore'
import { useKanbanStore } from '@/stores/useKanbanStore'
import type { DevFolderMoveResult } from '@shared/types/dev-folder'
import type { DocumentRunDetail } from '@shared/types/document-flow'
import { refreshAfterDevFolderRun, refreshAfterProjectMove } from '../refresh'

const defaultClient = getRendererRpcClient()

const result: DevFolderMoveResult = {
  projectId: 'p1',
  projectName: 'app',
  action: 'moved',
  fromPath: '/old/app',
  toPath: '/new/app',
  skipReason: null,
  detail: null,
  warnings: [],
  movedPaths: [{ from: '/old/app', to: '/new/app' }]
}

const staleRun = {
  run: {
    id: 'run-1',
    project_id: 'p1',
    source_path: '/old/app/spec.md',
    integration_worktree_path: null,
    members: null
  },
  items: [],
  events: []
} as unknown as DocumentRunDetail

const clients: [string, () => RendererRpcClient | null][] = [
  ['the default test client, which answers undefined', () => defaultClient],
  [
    'a client that answers { ok: true } to everything',
    () => ({ request: async <T>() => ({ ok: true }) as T, subscribe: () => () => {} })
  ],
  [
    'a client that refuses every call',
    () => ({
      request: async <T>(method: string): Promise<T> => {
        throw new Error(`unexpected method ${method}`)
      },
      subscribe: () => () => {}
    })
  ],
  ['no client at all', () => null]
]

describe.each(clients)('the refresh after a move, under %s', (_label, makeClient) => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const client = makeClient()
    if (client) setRendererRpcClient(client)
    else resetRendererRpcClientForTests()

    // Everything the refresh only touches when it is loaded: a board, a run list, a run that
    // names the moved folder, a tab of a file in it.
    useKanbanStore.setState({ tickets: new Map([['p1', []]]) })
    useDocumentFlowStore.setState({
      loadedProjects: { p1: true },
      runsById: { 'run-1': staleRun }
    })
    useFileViewerStore.getState().openFile('/old/app/src/a.ts', 'a.ts', 'wt-1')
  })

  afterEach(() => {
    useKanbanStore.setState({ tickets: new Map() })
    useDocumentFlowStore.setState({ loadedProjects: {}, runsById: {} })
    useFileViewerStore.getState().closeAllFiles()
    setRendererRpcClient(defaultClient)
    vi.restoreAllMocks()
  })

  it('resolves after a moved project, with the stale tab closed', async () => {
    await expect(refreshAfterProjectMove(result)).resolves.toBeUndefined()

    expect(useFileViewerStore.getState().openFiles.size).toBe(0)
  })

  it('resolves at the end of the run', async () => {
    await expect(refreshAfterDevFolderRun()).resolves.toBeUndefined()
  })
})
