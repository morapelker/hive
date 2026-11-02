/**
 * The project context menu lists the project's shell commands for git projects and
 * launches them at project level (no worktreeId: the launcher picks the base worktree).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { setRendererRpcClient } from '@/api/rpc-client'
import type { ProjectShellCommand } from '@shared/lib/shell-commands'

const mocks = vi.hoisted(() => ({
  runProjectShellCommand: vi.fn()
}))

vi.mock('@/lib/shell-command-launch', () => ({
  runProjectShellCommand: mocks.runProjectShellCommand
}))

import { ProjectItem } from './ProjectItem'
import { useProjectStore } from '@/stores/useProjectStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { useHintStore } from '@/stores/useHintStore'
import { useSettingsStore } from '@/stores/useSettingsStore'

const makeCommands = (count: number): ProjectShellCommand[] =>
  Array.from({ length: count }, (_, index) => ({
    id: `cmd-${index + 1}`,
    name: `Command ${index + 1}`,
    commands: `echo ${index + 1}`
  }))

const project = (
  id: string,
  shellCommands: ProjectShellCommand[] | null,
  kind?: 'git' | 'connection'
) => ({
  id,
  name: id,
  path: `/tmp/${id}`,
  ...(kind ? { kind } : {}),
  description: null,
  tags: null,
  language: null,
  custom_icon: null,
  detected_icon: 'none',
  setup_script: null,
  run_script: null,
  archive_script: null,
  shell_commands: shellCommands,
  auto_assign_port: false,
  sort_order: 0,
  created_at: '2026-01-01',
  last_accessed_at: '2026-01-01'
})

// Radix renders the items synchronously on contextmenu. Role queries (find* / *ByRole)
// cost seconds per call on this tree under jsdom, so the menu is read with selectors.
const openMenu = (id: string): void => {
  fireEvent.contextMenu(screen.getByTestId(`project-item-${id}`))
}

const menuItems = (): HTMLElement[] =>
  Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'))

const menuItemNames = (): string[] => menuItems().map((item) => item.textContent ?? '')

const menuItem = (name: string): HTMLElement => {
  const item = menuItems().find((candidate) => candidate.textContent === name)
  if (!item) throw new Error(`No menu item named ${name}`)
  return item
}

const separatorCount = (): number => document.querySelectorAll('[role="separator"]').length

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

describe('ProjectItem shell commands in the context menu', () => {
  beforeEach(() => {
    cleanup()
    vi.clearAllMocks()
    mocks.runProjectShellCommand.mockResolvedValue({ success: true })
    setRendererRpcClient({
      request: async <T,>(): Promise<T> => ({ success: true }) as T,
      subscribe: () => () => {}
    })
    useSettingsStore.setState({ tipsEnabled: false })
    useProjectStore.setState({ expandedProjectIds: new Set(), selectedProjectId: null })
    useWorktreeStore.setState({
      worktreesByProject: new Map(),
      loadedProjectIds: new Set(),
      worktreeOrderByProject: new Map()
    })
    useConnectionStore.setState({ connectionModeActive: false })
    useHintStore.setState({ filterActive: false, inputFocused: false })
  })

  it('lists the commands flat for a git project, between the project items and Remove', () => {
    render(<ProjectItem project={project('alpha', makeCommands(2))} />)

    openMenu('alpha')

    const names = menuItemNames()
    expect(names).toContain('Command 1')
    expect(names).toContain('Command 2')
    expect(names.indexOf('Command 1')).toBeGreaterThan(names.indexOf('Manage Skills'))
    expect(names.indexOf('Command 2')).toBeLessThan(names.indexOf('Remove from Hive'))
    expect(names).not.toContain('Run Command')
    // One separator opens the group, the menu's own separator closes it
    expect(separatorCount()).toBe(2)
  })

  it('launches at project level: project and command ids, no worktreeId', () => {
    render(<ProjectItem project={project('alpha', makeCommands(2))} />)

    openMenu('alpha')
    fireEvent.click(menuItem('Command 2'))

    expect(mocks.runProjectShellCommand).toHaveBeenCalledTimes(1)
    const input = mocks.runProjectShellCommand.mock.calls[0][0]
    expect(input).toMatchObject({ projectId: 'alpha', commandId: 'cmd-2' })
    expect(input.worktreeId).toBeUndefined()
  })

  it('shows nothing extra for a project without commands', () => {
    render(<ProjectItem project={project('alpha', [])} />)

    openMenu('alpha')

    const names = menuItemNames()
    expect(names).toContain('Manage Skills')
    expect(names.filter((name) => name.includes('Command'))).toEqual([])
    expect(separatorCount()).toBe(1)
  })

  it('shows nothing for a connection project even when it carries commands', () => {
    render(<ProjectItem project={project('linked', makeCommands(2), 'connection')} />)

    openMenu('linked')

    const names = menuItemNames()
    expect(names).toContain('Copy Path')
    expect(names.filter((name) => name.includes('Command'))).toEqual([])
    expect(separatorCount()).toBe(1)
  })

  it('collapses more than five commands into a "Run Command" submenu', () => {
    render(<ProjectItem project={project('alpha', makeCommands(6))} />)

    openMenu('alpha')

    const names = menuItemNames()
    expect(names).toContain('Run Command')
    expect(names).not.toContain('Command 1')
  })
})
