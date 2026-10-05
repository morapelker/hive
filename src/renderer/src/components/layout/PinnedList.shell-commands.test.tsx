import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react'
import { resetRendererRpcClientForTests, setRendererRpcClient } from '@/api/rpc-client'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { ProjectShellCommand } from '@shared/lib/shell-commands'

const mocks = vi.hoisted(() => ({
  runProjectShellCommand: vi.fn()
}))

vi.mock('@/lib/shell-command-launch', () => ({
  runProjectShellCommand: mocks.runProjectShellCommand
}))

vi.mock('@/api/settings-api', () => ({
  settingsApi: {
    onSettingsUpdated: vi.fn(() => vi.fn())
  }
}))

vi.mock('@/api/pet-api', () => ({
  petApi: {
    updateSettings: vi.fn()
  }
}))

import { PinnedList } from './PinnedList'
import { usePinnedStore } from '@/stores/usePinnedStore'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'

type Connection = ReturnType<typeof useConnectionStore.getState>['connections'][number]
type Project = ReturnType<typeof useProjectStore.getState>['projects'][number]
type Worktree = NonNullable<
  ReturnType<ReturnType<typeof useWorktreeStore.getState>['worktreesByProject']['get']>
>[number]

const shellCommands: ProjectShellCommand[] = [
  { id: 'cmd-build', name: 'Build app', commands: 'pnpm build' },
  { id: 'cmd-install', name: 'Install app', commands: 'pnpm install:mac', keepRunningOnQuit: true }
]

const gitProject = {
  id: 'proj-git',
  name: 'git-proj',
  path: '/tmp/git-proj',
  shell_commands: shellCommands
} as unknown as Project

const connectionProject = {
  id: 'proj-conn',
  name: 'conn-proj',
  kind: 'connection',
  shell_commands: shellCommands
} as unknown as Project

const featureWorktree = {
  id: 'wt-feature',
  project_id: 'proj-git',
  name: 'feature',
  branch_name: 'feature',
  path: '/tmp/git-proj-feature',
  status: 'active',
  is_default: false,
  created_at: '2026-01-01',
  last_accessed_at: '2026-01-01',
  attachments: '[]'
} as unknown as Worktree

const baseConnection = {
  id: 'conn-base',
  name: 'connection',
  custom_name: null,
  status: 'active',
  path: '/tmp/conn',
  color: null,
  saved_project_id: 'proj-conn',
  is_base: 1,
  created_at: '2026-01-01',
  updated_at: '2026-01-01',
  members: []
} as unknown as Connection

// Role queries cost seconds per call on this tree under jsdom: read the menu with selectors
const menuItems = (): HTMLElement[] =>
  Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'))

const menuItemNames = (): string[] => menuItems().map((item) => item.textContent ?? '')

// floating-ui probes every positioned element with matches(':popover-open') and
// matches(':modal'). jsdom's selector engine does not know them and recurses until the
// stack overflows before throwing, which costs seconds per opened menu. Answer the two
// probes directly (false is what the fallback returns anyway).
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

describe('PinnedList shell commands', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.runProjectShellCommand.mockResolvedValue({ success: true })
    setRendererRpcClient({
      request: async <T,>(method: string): Promise<T> => {
        if (method === 'db.worktree.getPinned') return [featureWorktree] as T
        if (method === 'connectionOps.getPinned') return [baseConnection] as T
        return null as T
      },
      subscribe: () => () => {}
    })

    usePinnedStore.setState({
      pinnedWorktreeIds: new Set(['wt-feature']),
      pinnedConnectionIds: new Set(['conn-base']),
      pinnedProjectIds: new Set(['proj-conn']),
      loaded: true
    })
    useConnectionStore.setState({ connections: [baseConnection], connectionModeActive: false })
    useProjectStore.setState({ projects: [gitProject, connectionProject] })
    useWorktreeStore.setState({
      worktreesByProject: new Map([['proj-git', [featureWorktree]]])
    })
  })

  afterEach(() => {
    cleanup()
    resetRendererRpcClientForTests()
  })

  async function renderList(): Promise<void> {
    render(
      <TooltipProvider>
        <PinnedList />
      </TooltipProvider>
    )
    // Flush the mount-effect loadPinned() so its state update lands inside act
    await act(async () => {})
  }

  it('lists the project commands on a pinned worktree row and launches in that worktree', async () => {
    await renderList()

    // Radix renders the items synchronously on contextmenu
    fireEvent.contextMenu(screen.getByTestId('pinned-worktree-wt-feature'))

    const names = menuItemNames()
    expect(names).toContain('Build app')
    expect(names).toContain('Install app')
    // The group sits between "Connect to..." and the branch actions
    expect(names.indexOf('Build app')).toBeGreaterThan(names.indexOf('Connect to...'))
    expect(names.indexOf('Install app')).toBeLessThan(names.indexOf('Rename Branch'))

    const installItem = menuItems().find((item) => item.textContent === 'Install app')
    expect(installItem).toBeDefined()
    fireEvent.click(installItem as HTMLElement)

    expect(mocks.runProjectShellCommand).toHaveBeenCalledTimes(1)
    expect(mocks.runProjectShellCommand).toHaveBeenCalledWith({
      projectId: 'proj-git',
      commandId: 'cmd-install',
      worktreeId: 'wt-feature'
    })
  })

  it('does not list commands on a pinned connection row', async () => {
    await renderList()

    fireEvent.contextMenu(screen.getByTestId('pinned-connection-conn-base'))

    const names = menuItemNames()
    expect(names.length).toBeGreaterThan(0)
    expect(names).not.toContain('Build app')
    expect(names).not.toContain('Install app')
    expect(names).not.toContain('Run Command')
  })
})
