// The two ways into the import dialog: the SQL schema tree's table menu ("Import CSV…", tables
// only) and the Mongo explorer's collection menu ("Import JSON / CSV…", not for views).
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { DataProject } from '@shared/data-projects/types'

const mocks = vi.hoisted(() => ({
  objects: vi.fn(async () => ({
    objects: [
      { name: 'orders', kind: 'table', schema: 'public' },
      { name: 'daily', kind: 'view', schema: 'public' }
    ]
  })),
  preview: vi.fn(() => new Promise(() => undefined))
}))

vi.mock('@/api/data-projects-api', () => ({
  dataProjectsApi: {
    objects: mocks.objects,
    import: {
      preview: mocks.preview,
      start: vi.fn(),
      cancel: vi.fn(async () => ({ cancelled: false })),
      onProgress: () => () => undefined
    }
  }
}))
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 24,
    scrollToIndex: () => undefined,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        start: index * 24,
        size: 24,
        key: index
      }))
  })
}))
vi.mock('@/stores/useDataProjectStore', () => {
  const state = { statuses: {}, openCredentialsPrompt: vi.fn() }
  const hook = (selector: (s: typeof state) => unknown) => selector(state)
  hook.getState = () => state
  return { useDataProjectStore: hook }
})

const { SchemaExplorer } = await import('../sql/SchemaExplorer')
const { MongoExplorer } = await import('../mongo/MongoExplorer')
const { useMongoWorkspaceStore } = await import('@/stores/useMongoWorkspaceStore')

// floating-ui probes positioned elements with :popover-open / :modal, which jsdom's selector
// engine recurses on; answer them directly (see PinnedList.implement-document.test.tsx).
const TOP_LAYER_PROBES = new Set([':popover-open', ':modal'])
const originalMatches = Element.prototype.matches
beforeAll(() => {
  Element.prototype.matches = function (this: Element, selectors: string): boolean {
    return TOP_LAYER_PROBES.has(selectors) ? false : originalMatches.call(this, selectors)
  }
})
afterAll(() => {
  Element.prototype.matches = originalMatches
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  useMongoWorkspaceStore.getState().reset()
})

const menuItem = (text: string): HTMLElement | undefined =>
  Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(
    (item) => item.textContent?.trim() === text
  )

describe('import entry points', () => {
  it('SQL: tables offer "Import CSV…", views do not', async () => {
    const project = {
      id: 'dp-pg',
      name: 'Shop',
      engine: 'postgres',
      config: { database: 'shop' },
      safeMode: 'off'
    } as unknown as DataProject
    render(
      <SchemaExplorer
        project={project}
        dialect="postgres"
        connectionState="connected"
        credentialsRequired={false}
        databases={[{ name: 'shop' }]}
        databasesError={null}
        database="shop"
        schema="public"
        onDatabaseChange={vi.fn()}
        onSchemaChange={vi.fn()}
        onRefresh={vi.fn()}
        onReconnect={vi.fn()}
        onEnterCredentials={vi.fn()}
        refreshKey={0}
      />
    )
    fireEvent.contextMenu(await screen.findByTestId('data-project-schema-object-view-daily'))
    expect(menuItem('Import CSV…')).toBeUndefined()
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    cleanup()

    render(
      <SchemaExplorer
        project={project}
        dialect="postgres"
        connectionState="connected"
        credentialsRequired={false}
        databases={[{ name: 'shop' }]}
        databasesError={null}
        database="shop"
        schema="public"
        onDatabaseChange={vi.fn()}
        onSchemaChange={vi.fn()}
        onRefresh={vi.fn()}
        onReconnect={vi.fn()}
        onEnterCredentials={vi.fn()}
        refreshKey={0}
      />
    )
    fireEvent.contextMenu(await screen.findByTestId('data-project-schema-object-table-orders'))
    const item = menuItem('Import CSV…')
    expect(item).toBeDefined()
    fireEvent.click(item!)
    await screen.findByTestId('data-project-import-dialog')
    expect(screen.getByText('Import into public.orders')).toBeTruthy()
  })

  it('Mongo: collections offer "Import JSON / CSV…", views do not', async () => {
    const project = {
      id: 'dp-mg',
      name: 'Mongo',
      engine: 'mongodb',
      config: { database: 'shop' },
      safeMode: 'off'
    } as unknown as DataProject
    useMongoWorkspaceStore.getState().setExpanded(project.id, 'shop', true)
    const catalog = {
      databases: [{ name: 'shop' }],
      databasesError: null,
      loadingDatabases: false,
      collections: {
        shop: {
          status: 'ok' as const,
          objects: [
            { name: 'users', kind: 'collection' as const, engine: 'collection' },
            { name: 'daily', kind: 'collection' as const, engine: 'view' }
          ]
        }
      },
      reloadDatabases: vi.fn(async () => undefined),
      loadCollections: vi.fn(async () => undefined),
      forgetDatabase: vi.fn()
    }
    render(<MongoExplorer project={project} catalog={catalog} active={null} />)
    fireEvent.contextMenu(await screen.findByTestId('data-project-mongo-coll-shop-daily'))
    expect(menuItem('Import JSON / CSV…')).toBeUndefined()
    cleanup()

    render(<MongoExplorer project={project} catalog={catalog} active={null} />)
    fireEvent.contextMenu(await screen.findByTestId('data-project-mongo-coll-shop-users'))
    fireEvent.click(menuItem('Import JSON / CSV…')!)
    await waitFor(() => expect(screen.getByText('Import into shop.users')).toBeTruthy())
  })
})
