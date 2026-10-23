// Command palette entries for data projects: "Add database connection" opens the wizard and
// "Switch to database ▸" lists every database connection and opens the picked one (in front of
// the Pinned Board, like the sidebar). While a data project is shown, the hidden worktree's
// session is not "current": Close Session and the worktree/git commands are disabled and never
// touch it.

import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setRendererRpcClient } from '@/api/rpc-client'
import { useCommands } from '@/hooks/useCommands'
import { commandRegistry } from '@/lib/command-registry'
import { useCommandPaletteStore } from '@/stores/useCommandPaletteStore'
import { useDataProjectStore } from '@/stores/useDataProjectStore'
import { useSessionStore } from '@/stores/useSessionStore'
import { sampleDataProject } from '@/components/data-projects/data-project.sample'

vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }
}))

function CommandsHarness(): null {
  useCommands()
  return null
}

const command = (id: string) => {
  const found = commandRegistry.get(id)
  if (!found) throw new Error(`Command ${id} is not registered`)
  return found
}

beforeEach(() => {
  setRendererRpcClient({
    request: (async () => undefined) as never,
    subscribe: () => () => {}
  })
  useDataProjectStore.getState().reset()
  useCommandPaletteStore.setState({ isOpen: true })
})

afterEach(() => {
  cleanup()
  useCommandPaletteStore.setState({ isOpen: false })
})

describe('data project commands', () => {
  it('"Add database connection" opens the wizard and closes the palette', async () => {
    await act(async () => {
      render(<CommandsHarness />)
    })
    await act(async () => {
      await command('action:add-database').action()
    })
    expect(useDataProjectStore.getState().wizard).toEqual({ mode: 'create' })
    expect(useCommandPaletteStore.getState().isOpen).toBe(false)
  })

  it('"Switch to database" is hidden without databases and lists them otherwise', async () => {
    await act(async () => {
      render(<CommandsHarness />)
    })
    expect(command('nav:switch-database').isVisible?.()).toBe(false)

    act(() => {
      useDataProjectStore.setState({
        projects: [
          sampleDataProject({
            id: 'a',
            name: 'Orders',
            config: { host: 'db1', database: 'orders' }
          }),
          sampleDataProject({
            id: 'b',
            name: 'Events',
            engine: 'clickhouse',
            config: { host: 'ch' }
          })
        ]
      })
    })
    const switchCommand = command('nav:switch-database')
    expect(switchCommand.isVisible?.()).toBe(true)
    const children = switchCommand.getChildren?.() ?? []
    expect(children.map((c) => [c.label, c.description])).toEqual([
      ['Orders', 'db1 / orders'],
      ['Events', 'ch']
    ])

    await act(async () => {
      await children[1].action()
    })
    expect(useDataProjectStore.getState().selectedDataProjectId).toBe('b')
    expect(useCommandPaletteStore.getState().isOpen).toBe(false)
  })
})

describe('hidden worktree session while a data project is shown', () => {
  it('disables Close Session and the git commands, and Close Session does nothing', async () => {
    const closeSession = vi.fn(async () => ({ success: true }))
    const initialSession = useSessionStore.getState()
    useSessionStore.setState({ activeWorktreeId: 'wt-1', activeSessionId: 's-1', closeSession })
    try {
      useDataProjectStore.setState({
        projects: [sampleDataProject({ id: 'dp-1', name: 'Orders' })],
        selectedDataProjectId: null
      })
      await act(async () => {
        render(<CommandsHarness />)
      })
      // A worktree session on screen: unchanged behaviour.
      expect(command('action:close-session').isEnabled?.()).toBe(true)
      expect(command('git:stage-all').isEnabled?.()).toBe(true)

      act(() => {
        useDataProjectStore.setState({ selectedDataProjectId: 'dp-1' })
      })
      const close = command('action:close-session')
      expect(close.isEnabled?.()).toBe(false)
      expect(command('git:stage-all').isEnabled?.()).toBe(false)
      expect(command('git:push').isEnabled?.()).toBe(false)
      expect(command('action:open-in-terminal').isEnabled?.()).toBe(false)
      expect(command('nav:switch-session').isVisible?.()).toBe(false)
      await act(async () => {
        await close.action()
      })
      expect(closeSession).not.toHaveBeenCalled()
      expect(useSessionStore.getState().activeSessionId).toBe('s-1')
    } finally {
      useSessionStore.setState({
        activeWorktreeId: initialSession.activeWorktreeId,
        activeSessionId: initialSession.activeSessionId,
        closeSession: initialSession.closeSession
      })
    }
  })
})
