// MongoWorkspace wiring: connects on mount, lists databases (sizes) and, on expand, collections
// with counts and type badges (not again when only the project object changes); clicking a
// collection opens its tab; an editor-bridge insertion for this project becomes a Shell tab (and
// is consumed, even behind another project's); Processes / History / Saved queries open as tabs;
// the tab strip closes tabs, asking first for Shell tabs with unsaved text (×, Close others,
// ⌘W). Heavy children (collection views, the shell editor, shared panels) are stubbed — they
// have their own tests.
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DataProject } from '@shared/data-projects/types'

const mocks = vi.hoisted(() => ({
  closeShortcut: null as null | (() => void),
  ensureConnected: vi.fn(async () => true),
  databases: vi.fn(async () => [
    { name: 'shop', sizeBytes: 2_200_000 },
    { name: 'admin', sizeBytes: 40_960, isSystem: true }
  ]),
  objects: vi.fn(async () => ({
    objects: [
      {
        name: 'orders',
        kind: 'collection',
        engine: 'collection',
        rowEstimate: 1284,
        sizeBytes: 900_000
      },
      { name: 'daily', kind: 'collection', engine: 'view', rowEstimate: null, sizeBytes: null }
    ]
  }))
}))

vi.mock('@/api/data-projects-api', () => ({
  dataProjectsApi: {
    databases: mocks.databases,
    objects: mocks.objects,
    completionSchema: vi.fn(async () => ({ databases: ['shop'], tables: [] })),
    mongo: { collection: vi.fn() },
    cancel: vi.fn(async () => ({ cancelled: true }))
  }
}))

// Context menus as plain (hidden) elements: Radix's closing menu keeps jsdom busy for seconds
// after every selection, and the menu primitive has its own tests.
vi.mock('@/components/ui/context-menu', () => {
  const Pass = ({ children }: { children?: React.ReactNode }) => <>{children}</>
  const Hidden = ({ children }: { children?: React.ReactNode }) => <div hidden>{children}</div>
  return {
    ContextMenu: Pass,
    ContextMenuTrigger: Pass,
    ContextMenuSub: Pass,
    ContextMenuSubTrigger: Pass,
    ContextMenuContent: Hidden,
    ContextMenuSubContent: Hidden,
    ContextMenuSeparator: () => null,
    ContextMenuItem: ({
      children,
      onSelect,
      disabled,
      'data-testid': testId
    }: {
      children?: React.ReactNode
      onSelect?: () => void
      disabled?: boolean
      'data-testid'?: string
    }) => (
      <button type="button" disabled={disabled} onClick={() => onSelect?.()} data-testid={testId}>
        {children}
      </button>
    )
  }
})

vi.mock('@/api/system-api', () => ({
  systemApi: {
    onCloseSessionShortcut: (cb: () => void) => {
      mocks.closeShortcut = cb
      return () => {
        mocks.closeShortcut = null
      }
    }
  }
}))

vi.mock('@/stores/useDataProjectStore', () => {
  const state = {
    statuses: { 'dp-w': { dataProjectId: 'dp-w', state: 'connected', serverVersion: '8.0.4' } },
    connectionEpoch: {},
    ensureConnected: mocks.ensureConnected,
    openCredentialsPrompt: vi.fn()
  }
  const hook = (selector: (s: typeof state) => unknown) => selector(state)
  hook.getState = () => state
  return { useDataProjectStore: hook }
})

vi.mock('@/components/data-projects/shared', () => ({
  ProcessesPanel: ({ projectId }: { projectId: string }) => (
    <div data-testid="processes-stub">{projectId}</div>
  ),
  HistoryPanel: ({ onOpen }: { onOpen: (text: string, db?: string) => void }) => (
    <button data-testid="history-stub" onClick={() => onOpen('db.orders.find()', 'shop')}>
      history
    </button>
  ),
  SavedQueriesPanel: ({ onOpen }: { onOpen: (query: unknown) => void }) => (
    <button
      data-testid="saved-stub"
      onClick={() =>
        onOpen({
          id: 'sq-1',
          dataProjectId: 'dp-w',
          name: 'Daily orders',
          text: 'db.orders.find({ day: 1 })',
          database: null,
          createdAt: '',
          updatedAt: ''
        })
      }
    >
      saved
    </button>
  ),
  runWithConfirmation: vi.fn(),
  startFullExport: vi.fn(),
  safeFileStem: (s: string) => s
}))

vi.mock('./CollectionTab', () => ({
  CollectionTab: ({
    tab
  }: {
    tab: { database: string; collection: string; collectionType?: string }
  }) => (
    <div data-testid="collection-stub">
      {tab.database}.{tab.collection}:{tab.collectionType}
    </div>
  )
}))

vi.mock('./ShellTab', () => ({
  ShellTab: ({ tab }: { tab: { text: string; database: string } }) => (
    <div data-testid="shell-stub">
      {tab.database}|{tab.text}
    </div>
  )
}))

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 26,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        start: index * 26,
        size: 26,
        key: index
      }))
  })
}))

const { useMongoWorkspaceStore } = await import('@/stores/useMongoWorkspaceStore')
const { useDataEditorBridge } = await import('@/components/data-projects/editor-bridge')
const { MongoWorkspace } = await import('./MongoWorkspace')
const defaultExport = (await import('./MongoWorkspace')).default

const project: DataProject = {
  id: 'dp-w',
  name: 'Mongo',
  engine: 'mongodb',
  config: { host: '127.0.0.1', port: 27018, database: 'shop' },
  icon: null,
  iconColor: null,
  environment: 'local',
  color: null,
  safeMode: 'off',
  defaultLimit: 1000,
  allowAiDataAccess: false,
  pinned: false,
  secretState: 'stored',
  sortOrder: 0,
  createdAt: '2026-10-01T00:00:00.000Z',
  lastAccessedAt: '2026-10-01T00:00:00.000Z'
}

beforeAll(() => {
  Element.prototype.hasPointerCapture = () => false
  Element.prototype.releasePointerCapture = () => undefined
  Element.prototype.scrollIntoView = () => undefined
})

beforeEach(() => {
  useMongoWorkspaceStore.getState().reset()
  useDataEditorBridge.setState({ pending: null })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  useMongoWorkspaceStore.getState().reset()
})

describe('MongoWorkspace', () => {
  it('is the default and the named export', () => {
    expect(defaultExport).toBe(MongoWorkspace)
  })

  it('connects, lists databases and opens a collection tab from the explorer', async () => {
    render(<MongoWorkspace project={project} />)
    expect(mocks.ensureConnected).toHaveBeenCalledWith('dp-w')
    expect(screen.getByTestId('data-project-mongo-empty')).toBeInTheDocument()
    // The default database starts expanded, so its collections load right away.
    const orders = await screen.findByTestId('data-project-mongo-coll-shop-orders')
    expect(screen.getByTestId('data-project-mongo-db-shop')).toHaveTextContent('2.1 MB')
    expect(mocks.objects).toHaveBeenCalledWith('dp-w', 'shop')
    expect(orders).toHaveTextContent('1,284')
    expect(screen.getByTestId('data-project-mongo-coll-shop-daily')).toHaveTextContent('view')
    await userEvent.click(orders)
    expect(await screen.findByTestId('collection-stub')).toHaveTextContent('shop.orders:collection')
  })

  it('filters the explorer by collection name', async () => {
    render(<MongoWorkspace project={project} />)
    await screen.findByTestId('data-project-mongo-coll-shop-orders')
    await userEvent.type(screen.getByTestId('data-project-mongo-explorer-filter'), 'dai')
    expect(screen.queryByTestId('data-project-mongo-coll-shop-orders')).toBeNull()
    expect(screen.getByTestId('data-project-mongo-coll-shop-daily')).toBeInTheDocument()
    expect(screen.queryByTestId('data-project-mongo-db-admin')).toBeNull()
  })

  it('turns an assistant proposal for this project into a Shell tab', async () => {
    render(<MongoWorkspace project={project} />)
    act(() => {
      useDataEditorBridge.getState().insert({
        dataProjectId: 'dp-w',
        text: "db.orders.find({ status: 'A' })",
        mode: 'replace',
        origin: 'assistant'
      })
    })
    expect(await screen.findByTestId('shell-stub')).toHaveTextContent(
      "shop|db.orders.find({ status: 'A' })"
    )
    await waitFor(() => expect(useDataEditorBridge.getState().pending).toBeNull())
  })

  it('opens Processes and History tabs and History entries open in a shell', async () => {
    render(<MongoWorkspace project={project} />)
    act(() => {
      useMongoWorkspaceStore.getState().openSpecialTab('dp-w', 'processes')
    })
    expect(await screen.findByTestId('processes-stub')).toHaveTextContent('dp-w')
    act(() => {
      useMongoWorkspaceStore.getState().openSpecialTab('dp-w', 'history')
    })
    await userEvent.click(await screen.findByTestId('history-stub'))
    expect(await screen.findByTestId('shell-stub')).toHaveTextContent('shop|db.orders.find()')
    const tabs = useMongoWorkspaceStore.getState().workspaces['dp-w'].tabs
    expect(tabs.map((t) => t.kind)).toEqual(['processes', 'history', 'shell'])
    // Close the shell tab from the strip.
    const shell = tabs[2]
    await userEvent.click(screen.getByTestId(`data-project-mongo-tab-close-${shell.id}`))
    expect(useMongoWorkspaceStore.getState().workspaces['dp-w'].tabs).toHaveLength(2)
  })
})

describe('MongoWorkspace: closing tabs, saved queries, bridge, catalog', () => {
  const store = () => useMongoWorkspaceStore.getState()
  const tabs = () => store().workspaces['dp-w']?.tabs ?? []

  it('asks before closing a Shell tab with unsaved text, and not for a clean one', async () => {
    render(<MongoWorkspace project={project} />)
    let dirty = ''
    let clean = ''
    act(() => {
      dirty = store().openShell('dp-w')
      store().updateShell('dp-w', dirty, { text: 'db.orders.find({ a: 1 })' })
      clean = store().openShell('dp-w', { text: 'db.users.find()', origin: 'history' })
    })
    expect(await screen.findByTestId(`data-project-mongo-tab-dirty-${dirty}`)).toBeInTheDocument()

    await userEvent.click(screen.getByTestId(`data-project-mongo-tab-close-${clean}`))
    expect(tabs().map((t) => t.id)).toEqual([dirty])

    await userEvent.click(screen.getByTestId(`data-project-mongo-tab-close-${dirty}`))
    expect(await screen.findByTestId('data-project-mongo-close-dirty-dialog')).toHaveTextContent(
      'Close “Shell 1”?'
    )
    await userEvent.click(screen.getByText('Keep'))
    expect(tabs().map((t) => t.id)).toEqual([dirty])

    await userEvent.click(screen.getByTestId(`data-project-mongo-tab-close-${dirty}`))
    await userEvent.click(await screen.findByTestId('data-project-mongo-close-dirty-confirm'))
    expect(tabs()).toEqual([])
  })

  it('asks once before Close others drops unsaved Shell tabs', async () => {
    render(<MongoWorkspace project={project} />)
    let keep = ''
    act(() => {
      const a = store().openShell('dp-w')
      store().updateShell('dp-w', a, { text: 'db.a.find()' })
      const b = store().openShell('dp-w')
      store().updateShell('dp-w', b, { text: 'db.b.find()' })
      keep = store().openSpecialTab('dp-w', 'history')
    })
    await userEvent.click(screen.getByTestId(`data-project-mongo-tab-close-others-${keep}`))
    expect(await screen.findByTestId('data-project-mongo-close-dirty-dialog')).toHaveTextContent(
      'Close 2 shell tabs with unsaved text?'
    )
    expect(tabs()).toHaveLength(3)
    await userEvent.click(screen.getByTestId('data-project-mongo-close-dirty-confirm'))
    expect(tabs().map((t) => t.id)).toEqual([keep])
  })

  it('closes the active tab on ⌘W only while focus is inside the workspace', async () => {
    render(<MongoWorkspace project={project} />)
    let processes = ''
    act(() => {
      store().openSpecialTab('dp-w', 'history')
      processes = store().openSpecialTab('dp-w', 'processes')
    })
    await screen.findByTestId('processes-stub')
    ;(document.activeElement as HTMLElement | null)?.blur()
    act(() => mocks.closeShortcut?.())
    expect(tabs()).toHaveLength(2)
    screen.getByTestId(`data-project-mongo-tab-${processes}`).focus()
    act(() => mocks.closeShortcut?.())
    expect(tabs().map((t) => t.kind)).toEqual(['history'])

    // A dirty Shell tab asks instead.
    let shell = ''
    act(() => {
      shell = store().openShell('dp-w')
      store().updateShell('dp-w', shell, { text: 'db.x.find()' })
    })
    screen.getByTestId(`data-project-mongo-tab-${shell}`).focus()
    act(() => mocks.closeShortcut?.())
    expect(await screen.findByTestId('data-project-mongo-close-dirty-dialog')).toBeInTheDocument()
    expect(tabs()).toHaveLength(2)
  })

  it('opens Saved queries, and a saved query in a linked Shell tab (once)', async () => {
    render(<MongoWorkspace project={project} />)
    await userEvent.click(screen.getByTestId('data-project-mongo-empty-saved'))
    await userEvent.click(await screen.findByTestId('saved-stub'))
    expect(await screen.findByTestId('shell-stub')).toHaveTextContent('|db.orders.find({ day: 1 })')
    const shell = tabs().find((t) => t.kind === 'shell')
    expect(shell).toMatchObject({
      title: 'Daily orders',
      database: '',
      savedQueryId: 'sq-1',
      origin: 'saved'
    })
    act(() => {
      store().openSpecialTab('dp-w', 'saved')
    })
    await userEvent.click(await screen.findByTestId('saved-stub'))
    expect(tabs().filter((t) => t.kind === 'shell')).toHaveLength(1)
    expect(store().workspaces['dp-w'].activeTabId).toBe(shell!.id)

    // Restored after a restart with masked text: opening the saved query takes the real text
    // back (not edited since), and leaves an edited masked copy as it is.
    const masked = "db.orders.find({ day: '***' })"
    const reopen = async (): Promise<void> => {
      act(() => {
        store().openSpecialTab('dp-w', 'saved')
      })
      await userEvent.click(await screen.findByTestId('saved-stub'))
    }
    act(() => {
      store().updateShell('dp-w', shell!.id, { text: masked, baseline: masked, masked: true })
    })
    await reopen()
    expect(tabs().find((t) => t.id === shell!.id)).toMatchObject({
      text: 'db.orders.find({ day: 1 })',
      baseline: 'db.orders.find({ day: 1 })',
      masked: false
    })
    act(() => {
      store().updateShell('dp-w', shell!.id, { text: `${masked} // edited`, masked: true })
    })
    await reopen()
    expect(tabs().find((t) => t.id === shell!.id)).toMatchObject({
      text: `${masked} // edited`,
      masked: true
    })
    expect(store().workspaces['dp-w'].activeTabId).toBe(shell!.id)
  })

  it("applies this project's insertion even behind another project's", async () => {
    render(<MongoWorkspace project={project} />)
    act(() => {
      useDataEditorBridge.getState().insert({ dataProjectId: 'other', text: 'x', mode: 'replace' })
      useDataEditorBridge
        .getState()
        .insert({ dataProjectId: 'dp-w', text: 'db.mine.find()', mode: 'new-tab' })
    })
    expect(await screen.findByTestId('shell-stub')).toHaveTextContent('db.mine.find()')
    expect(useDataEditorBridge.getState().queue.map((i) => i.dataProjectId)).toEqual(['other'])
  })

  it('does not re-list databases or collections when only the project object changes', async () => {
    const { rerender } = render(<MongoWorkspace project={project} />)
    await screen.findByTestId('data-project-mongo-coll-shop-orders')
    expect(mocks.databases).toHaveBeenCalledTimes(1)
    expect(mocks.objects).toHaveBeenCalledTimes(1)
    // A pin / safe-mode change / touch replaces the object, same id and database.
    rerender(<MongoWorkspace project={{ ...project, pinned: true, safeMode: 'read-only' }} />)
    rerender(
      <MongoWorkspace project={{ ...project, lastAccessedAt: '2026-10-02T00:00:00.000Z' }} />
    )
    await new Promise((r) => setTimeout(r, 20))
    expect(mocks.databases).toHaveBeenCalledTimes(1)
    expect(mocks.objects).toHaveBeenCalledTimes(1)
  })
})
