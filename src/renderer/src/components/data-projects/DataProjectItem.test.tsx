// The sidebar row of a data project: a click opens it (in front of the Pinned Board), the
// context menu offers the connection actions (open, edit, icon, safe mode, environment, pin,
// duplicate, copy URL without the password, connect/disconnect, remove with a confirmation), and
// loosening a production connection's safe mode asks first. Also the pinned card.

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { sampleDataProject } from './data-project.sample'
import type { DataProject } from '@shared/data-projects/types'

const api = vi.hoisted(() => ({
  update: vi.fn(),
  delete: vi.fn(),
  duplicate: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
  touch: vi.fn(),
  status: vi.fn(),
  onStatus: vi.fn(() => () => {}),
  reorderSidebar: vi.fn()
}))
vi.mock('@/api/data-projects-api', () => ({ dataProjectsApi: api }))

const projectApiMock = vi.hoisted(() => ({
  copyToClipboard: vi.fn(),
  getProjectIconPath: vi.fn(),
  removeProjectIcon: vi.fn()
}))
vi.mock('@/api/project-api', () => ({ projectApi: projectApiMock }))

vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }
}))

const { DataProjectItem, PinnedDataProjectItem } = await import('./DataProjectItem')
const { useDataProjectStore } = await import('@/stores/useDataProjectStore')
const { useKanbanStore } = await import('@/stores/useKanbanStore')

// floating-ui probes positioned elements with matches(':popover-open') / matches(':modal');
// jsdom's selector engine recurses on those for seconds per opened menu (see
// ProjectItem.shell-commands.test.tsx). Answer them directly: false is the fallback anyway.
const TOP_LAYER_PROBES = new Set([':popover-open', ':modal'])
const originalMatches = Element.prototype.matches

beforeAll(() => {
  Element.prototype.hasPointerCapture = vi.fn()
  Element.prototype.releasePointerCapture = vi.fn()
  Element.prototype.scrollIntoView = vi.fn()
  Element.prototype.matches = function (this: Element, selectors: string): boolean {
    return TOP_LAYER_PROBES.has(selectors) ? false : originalMatches.call(this, selectors)
  }
})

afterAll(() => {
  Element.prototype.matches = originalMatches
})

const initialKanban = useKanbanStore.getState()

beforeEach(() => {
  vi.clearAllMocks()
  useDataProjectStore.getState().reset()
  api.touch.mockResolvedValue(undefined)
  api.update.mockImplementation(async (id: string, patch: Partial<DataProject>) => ({
    ...useDataProjectStore.getState().projects.find((p) => p.id === id)!,
    ...patch
  }))
  projectApiMock.copyToClipboard.mockResolvedValue(undefined)
  projectApiMock.getProjectIconPath.mockResolvedValue(null)
})

afterEach(() => {
  cleanup()
  useKanbanStore.setState(initialKanban, true)
})

function renderItem(overrides: Partial<DataProject> = {}): DataProject {
  const project = sampleDataProject({
    config: { host: 'db.example.com', port: 5433, database: 'shop', user: 'app' },
    ...overrides
  })
  useDataProjectStore.setState({ projects: [project] })
  render(<DataProjectItem project={project} isFirst />)
  return project
}

const openMenu = async (): Promise<HTMLElement> => {
  fireEvent.contextMenu(screen.getByTestId('data-project-item-dp-1'))
  return screen.findByTestId('data-project-menu-dp-1')
}

describe('DataProjectItem', () => {
  it('opens the project on click, in front of the Pinned Board', () => {
    useKanbanStore.setState({ isPinnedBoardActive: true, isPinnedBoardBehindSession: false })
    renderItem()
    fireEvent.click(screen.getByTestId('data-project-item-dp-1'))
    expect(useDataProjectStore.getState().selectedDataProjectId).toBe('dp-1')
    expect(useKanbanStore.getState().isPinnedBoardActive).toBe(true)
    expect(useKanbanStore.getState().isPinnedBoardBehindSession).toBe(true)
  })

  it('shows the engine logo, a production edge and badge, and the live status dot', () => {
    useDataProjectStore.setState({
      statuses: { 'dp-1': { dataProjectId: 'dp-1', state: 'connected' } }
    })
    renderItem({ environment: 'production' })
    const row = screen.getByTestId('data-project-item-dp-1')
    expect(within(row).getByTestId('data-project-icon')).toHaveAttribute('data-icon-kind', 'engine')
    expect(within(row).getByTestId('data-project-environment-badge')).toHaveTextContent('Prod')
    expect(within(row).getByTestId('data-project-environment-dot')).toBeInTheDocument()
    expect(within(row).getByTestId('data-project-status-dot')).toHaveAttribute(
      'data-state',
      'connected'
    )
    expect(row.style.boxShadow).toContain('inset 2px 0 0')
  })

  it('lists every connection action in the context menu', async () => {
    renderItem()
    const menu = await openMenu()
    for (const testId of [
      'data-project-menu-open',
      'data-project-menu-edit',
      'data-project-menu-icon',
      'data-project-menu-safe-mode',
      'data-project-menu-environment',
      'data-project-menu-pin',
      'data-project-menu-duplicate',
      'data-project-menu-copy-url',
      'data-project-menu-connect',
      'data-project-menu-remove'
    ]) {
      expect(within(menu).getByTestId(testId)).toBeInTheDocument()
    }
  })

  it('copies the connection URL without the password', async () => {
    renderItem()
    await userEvent.click(within(await openMenu()).getByTestId('data-project-menu-copy-url'))
    await waitFor(() => expect(projectApiMock.copyToClipboard).toHaveBeenCalledTimes(1))
    const url = projectApiMock.copyToClipboard.mock.calls[0][0] as string
    expect(url).toBe('postgresql://app@db.example.com:5433/shop')
  })

  it('opens the edit wizard and the icon dialog', async () => {
    renderItem()
    await userEvent.click(within(await openMenu()).getByTestId('data-project-menu-edit'))
    expect(useDataProjectStore.getState().wizard).toEqual({ mode: 'edit', projectId: 'dp-1' })
    await userEvent.click(within(await openMenu()).getByTestId('data-project-menu-icon'))
    expect(useDataProjectStore.getState().iconDialogProjectId).toBe('dp-1')
  })

  it('pins and disconnects', async () => {
    useDataProjectStore.setState({
      statuses: { 'dp-1': { dataProjectId: 'dp-1', state: 'connected' } }
    })
    api.disconnect.mockResolvedValue({ dataProjectId: 'dp-1', state: 'disconnected' })
    renderItem()
    await userEvent.click(within(await openMenu()).getByTestId('data-project-menu-pin'))
    await waitFor(() => expect(api.update).toHaveBeenCalledWith('dp-1', { pinned: true }))
    await userEvent.click(within(await openMenu()).getByTestId('data-project-menu-disconnect'))
    await waitFor(() => expect(api.disconnect).toHaveBeenCalledWith('dp-1'))
  })

  it('removes only after the confirmation', async () => {
    api.delete.mockResolvedValue({ success: true })
    renderItem()
    await userEvent.click(within(await openMenu()).getByTestId('data-project-menu-remove'))
    const dialog = await screen.findByTestId('data-project-remove-dialog')
    expect(dialog).toHaveTextContent('The database itself is not touched.')
    // Tab moves between its buttons even with a worktree session behind it (global shortcuts).
    expect(dialog).toHaveAttribute('data-db-dialog')
    expect(api.delete).not.toHaveBeenCalled()
    await userEvent.click(screen.getByTestId('data-project-remove-confirm'))
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('dp-1'))
    await waitFor(() => expect(useDataProjectStore.getState().projects).toEqual([]))
  })

  it('asks before loosening safe mode on production', async () => {
    renderItem({ environment: 'production', safeMode: 'safe' })
    const menu = await openMenu()
    await userEvent.click(within(menu).getByTestId('data-project-menu-safe-mode'))
    await userEvent.click(await screen.findByTestId('data-project-menu-safe-mode-off'))

    expect(await screen.findByTestId('data-project-safe-mode-confirm')).toHaveAttribute(
      'data-db-dialog'
    )
    expect(api.update).not.toHaveBeenCalled()
    await userEvent.click(screen.getByTestId('data-project-safe-mode-confirm-accept'))
    await waitFor(() => expect(api.update).toHaveBeenCalledWith('dp-1', { safeMode: 'off' }))
  })

  it('tightening safe mode on production needs no confirmation', async () => {
    renderItem({ environment: 'production', safeMode: 'half-safe' })
    const menu = await openMenu()
    await userEvent.click(within(menu).getByTestId('data-project-menu-safe-mode'))
    await userEvent.click(await screen.findByTestId('data-project-menu-safe-mode-read-only'))
    await waitFor(() => expect(api.update).toHaveBeenCalledWith('dp-1', { safeMode: 'read-only' }))
    expect(screen.queryByTestId('data-project-safe-mode-confirm')).not.toBeInTheDocument()
  })
})

describe('PinnedDataProjectItem', () => {
  it('opens on click and unpins from its hover action', async () => {
    const project = sampleDataProject({ pinned: true })
    useDataProjectStore.setState({ projects: [project] })
    render(<PinnedDataProjectItem project={project} />)

    fireEvent.click(screen.getByTestId('pinned-data-project-dp-1'))
    expect(useDataProjectStore.getState().selectedDataProjectId).toBe('dp-1')

    fireEvent.click(screen.getByTestId('pinned-data-project-unpin-dp-1'))
    await waitFor(() => expect(api.update).toHaveBeenCalledWith('dp-1', { pinned: false }))
  })
})
