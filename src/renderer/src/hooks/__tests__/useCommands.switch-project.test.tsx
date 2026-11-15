// Command palette › "Switch to Project" opens the "Go to project" switcher (every project on
// this Mac, reachable with the sidebar collapsed) instead of a nested list of project names.

import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setRendererRpcClient } from '@/api/rpc-client'
import { useCommands } from '@/hooks/useCommands'
import { commandRegistry } from '@/lib/command-registry'
import { useCommandPaletteStore } from '@/stores/useCommandPaletteStore'
import { useDataProjectStore } from '@/stores/useDataProjectStore'
import { useLayoutStore } from '@/stores/useLayoutStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { useProjectSwitcherStore } from '@/stores/useProjectSwitcherStore'
import { sampleDataProject, sampleGitProject } from '@/components/data-projects/data-project.sample'

vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }
}))

function CommandsHarness(): null {
  useCommands()
  return null
}

const switchProject = () => {
  const found = commandRegistry.get('nav:switch-project')
  if (!found) throw new Error('nav:switch-project is not registered')
  return found
}

beforeEach(() => {
  setRendererRpcClient({
    request: (async () => undefined) as never,
    subscribe: () => () => {}
  })
  useDataProjectStore.getState().reset()
  useProjectStore.setState({
    projects: [sampleGitProject('a', 0), sampleGitProject('b', 1)] as never,
    selectedProjectId: 'a',
    expandedProjectIds: new Set(['a'])
  })
  useProjectSwitcherStore.setState({ isOpen: false })
  useCommandPaletteStore.setState({ isOpen: true, commandStack: [], currentParent: null })
})

afterEach(() => {
  cleanup()
  useCommandPaletteStore.setState({ isOpen: false })
  useProjectSwitcherStore.setState({ isOpen: false })
})

describe('"Switch to Project"', () => {
  it('opens the switcher and closes the palette, with no nested list', async () => {
    await act(async () => {
      render(<CommandsHarness />)
    })
    const command = switchProject()
    expect(command.label).toBe('Switch to Project')
    expect(command.hasChildren).toBeFalsy()
    expect(command.getChildren).toBeUndefined()

    await act(async () => {
      await command.action()
    })
    expect(useProjectSwitcherStore.getState().isOpen).toBe(true)
    expect(useCommandPaletteStore.getState().isOpen).toBe(false)
    expect(useCommandPaletteStore.getState().commandStack).toEqual([])
    // Choosing the entry navigates nowhere and collapses nothing by itself.
    expect(useProjectStore.getState().selectedProjectId).toBe('a')
    expect(useProjectStore.getState().expandedProjectIds.has('a')).toBe(true)
  })

  it('works with the sidebar collapsed', async () => {
    useLayoutStore.setState({ leftSidebarCollapsed: true })
    try {
      await act(async () => {
        render(<CommandsHarness />)
      })
      await act(async () => {
        await switchProject().action()
      })
      expect(useProjectSwitcherStore.getState().isOpen).toBe(true)
      expect(useLayoutStore.getState().leftSidebarCollapsed).toBe(true)
    } finally {
      useLayoutStore.setState({ leftSidebarCollapsed: false })
    }
  })

  it('is offered when the only projects are databases, and hidden with none at all', async () => {
    useProjectStore.setState({ projects: [] })
    await act(async () => {
      render(<CommandsHarness />)
    })
    expect(switchProject().isVisible?.()).toBe(false)

    act(() => {
      useDataProjectStore.setState({ projects: [sampleDataProject({ id: 'db' })] })
    })
    expect(switchProject().isVisible?.()).toBe(true)
  })
})
