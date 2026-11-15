// Cmd+G is "Go to Project": it opens the switcher (and closes it when pressed again) from
// anywhere the app's shortcuts reach, typing included, and leaves the sidebar alone. It used
// to be "Filter Projects", which un-collapsed the sidebar and focused its filter field.
// Rendered with the real switcher and the real filter field.

import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/api/settings-api', () => ({
  settingsApi: {
    onSettingsUpdated: vi.fn(() => vi.fn()),
    loadCustomCommandsFile: vi.fn().mockResolvedValue({ success: false })
  }
}))
vi.mock('@/api/db-api', () => ({
  dbApi: {
    setting: { get: vi.fn().mockResolvedValue(null), set: vi.fn().mockResolvedValue(undefined) }
  }
}))
vi.mock('@/api/pet-api', () => ({
  petApi: { updateSettings: vi.fn().mockResolvedValue(undefined) }
}))
vi.mock('@/api/system-api', () => ({
  systemApi: {
    onNewSessionShortcut: vi.fn(() => vi.fn()),
    onFileSearchShortcut: vi.fn(() => vi.fn()),
    onCloseSessionShortcut: vi.fn(() => vi.fn()),
    onMenuAction: vi.fn(() => vi.fn()),
    updateMenuState: vi.fn().mockResolvedValue(undefined)
  }
}))
vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }
}))
vi.mock('@/components/projects/LanguageIcon', () => ({
  LanguageIcon: () => <span data-testid="language-icon" />
}))
vi.mock('@/components/data-projects/DataProjectIcon', () => ({
  DataProjectIcon: () => <span data-testid="data-project-icon" />
}))

import { setRendererRpcClient } from '@/api/rpc-client'
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts'
import { ProjectSwitcher } from '@/components/project-switcher/ProjectSwitcher'
import { ProjectFilter } from '@/components/projects/ProjectFilter'
import { sampleGitProject } from '@/components/data-projects/data-project.sample'
import { useCommandPaletteStore } from '@/stores/useCommandPaletteStore'
import { useDataProjectStore } from '@/stores/useDataProjectStore'
import { useFileSearchStore } from '@/stores/useFileSearchStore'
import { useLayoutStore } from '@/stores/useLayoutStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { useProjectSwitcherStore } from '@/stores/useProjectSwitcherStore'
import { useShortcutStore } from '@/stores/useShortcutStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'

function Harness(): React.JSX.Element {
  useKeyboardShortcuts()
  const [filter, setFilter] = useState('')
  return (
    <>
      <textarea data-testid="chat-input" />
      <ProjectFilter value={filter} onChange={setFilter} />
      <div className="xterm">
        <textarea data-testid="terminal-input" />
      </div>
      <div data-db-editor="">
        <div contentEditable suppressContentEditableWarning data-testid="db-editor">
          select 1
        </div>
      </div>
      <ProjectSwitcher />
    </>
  )
}

const CMD_G = { key: 'g', metaKey: true }

/** Dispatches the key where the focus is, as the browser does. `true` = the app took it. */
const press = (init: KeyboardEventInit): boolean => {
  const target = document.activeElement ?? document.body
  let notPrevented = true
  act(() => {
    notPrevented = fireEvent.keyDown(target, init)
  })
  return !notPrevented
}

const switcher = (): HTMLElement | null => screen.queryByTestId('project-switcher')
const focusOn = (testId: string): HTMLElement => {
  const element = screen.getByTestId(testId)
  act(() => element.focus())
  expect(document.activeElement).toBe(element)
  return element
}

const initialLayout = useLayoutStore.getState()

beforeEach(() => {
  setRendererRpcClient({
    request: (async () => undefined) as never,
    subscribe: () => () => {}
  })
  useShortcutStore.setState({ customBindings: {} })
  useProjectStore.setState({
    projects: [
      sampleGitProject('checkout-api', 0),
      sampleGitProject('ledger-worker', 1),
      sampleGitProject('orders-web', 2)
    ] as never,
    selectedProjectId: null,
    expandedProjectIds: new Set()
  })
  useDataProjectStore.getState().reset()
  useWorktreeStore.setState({
    worktreesByProject: new Map(),
    selectedWorktreeId: null,
    hydrateAllWorktrees: vi.fn(async () => {})
  })
  useLayoutStore.setState({ leftSidebarCollapsed: false })
  useCommandPaletteStore.setState({ isOpen: false })
  useFileSearchStore.setState({ isOpen: false })
  useProjectSwitcherStore.setState({ isOpen: false })
})

afterEach(() => {
  act(() => useProjectSwitcherStore.getState().close())
  cleanup()
  vi.useRealTimers()
  vi.clearAllMocks()
  useLayoutStore.setState(initialLayout, true)
  useCommandPaletteStore.setState({ isOpen: false })
  useFileSearchStore.setState({ isOpen: false })
  useShortcutStore.setState({ customBindings: {} })
})

describe('Cmd+G opens the switcher', () => {
  it('opens it with the focus in its field, and closes it when pressed again', () => {
    render(<Harness />)
    expect(switcher()).toBeNull()

    expect(press(CMD_G)).toBe(true)
    expect(switcher()).not.toBeNull()
    expect(document.activeElement).toBe(screen.getByTestId('project-switcher-input'))
    expect(screen.getAllByTestId('project-switcher-row')).toHaveLength(3)

    // Pressed again, in the switcher's own field.
    expect(press(CMD_G)).toBe(true)
    expect(switcher()).toBeNull()
    expect(useProjectSwitcherStore.getState().isOpen).toBe(false)
  })

  it('uses Ctrl+G where Ctrl is the command key', () => {
    render(<Harness />)
    expect(press({ key: 'g', ctrlKey: true })).toBe(true)
    expect(switcher()).not.toBeNull()
  })

  it('opens while typing in a chat input, and closing hands the focus back', () => {
    render(<Harness />)
    const chat = focusOn('chat-input')

    expect(press(CMD_G)).toBe(true)
    expect(switcher()).not.toBeNull()

    expect(press(CMD_G)).toBe(true)
    expect(switcher()).toBeNull()
    expect(document.activeElement).toBe(chat)
  })

  it('opens from the filter field, leaving the filter as it is', () => {
    render(<Harness />)
    const filter = focusOn('project-filter-input') as HTMLInputElement
    fireEvent.change(filter, { target: { value: 'ledg' } })

    expect(press(CMD_G)).toBe(true)
    expect(switcher()).not.toBeNull()
    expect(document.activeElement).toBe(screen.getByTestId('project-switcher-input'))
    expect(filter.value).toBe('ledg')

    expect(press(CMD_G)).toBe(true)
    expect(switcher()).toBeNull()
    expect(document.activeElement).toBe(filter)
    expect(filter.value).toBe('ledg')
  })

  it('opens with the focus in a terminal', () => {
    render(<Harness />)
    focusOn('terminal-input')
    expect(press(CMD_G)).toBe(true)
    expect(switcher()).not.toBeNull()
  })

  it('stays out of the database client editor, as Cmd+G did before', () => {
    render(<Harness />)
    const editor = screen.getByTestId('db-editor')
    expect(fireEvent.keyDown(editor, CMD_G)).toBe(true)
    expect(switcher()).toBeNull()
  })

  it('opens with the sidebar collapsed, which stays collapsed', () => {
    vi.useFakeTimers()
    useLayoutStore.setState({ leftSidebarCollapsed: true })
    render(<Harness />)

    expect(press(CMD_G)).toBe(true)
    expect(switcher()).not.toBeNull()
    // "Filter Projects" un-collapsed the sidebar and focused the field a moment later.
    act(() => {
      vi.advanceTimersByTime(500)
    })
    expect(useLayoutStore.getState().leftSidebarCollapsed).toBe(true)
    expect(document.activeElement).toBe(screen.getByTestId('project-switcher-input'))
  })

  it('never moves the focus to the filter field', () => {
    vi.useFakeTimers()
    render(<Harness />)
    const filter = screen.getByTestId('project-filter-input')
    const chat = focusOn('chat-input')

    press(CMD_G)
    act(() => {
      vi.advanceTimersByTime(500)
    })
    expect(document.activeElement).not.toBe(filter)
    press(CMD_G)
    act(() => {
      vi.advanceTimersByTime(500)
    })
    expect(document.activeElement).toBe(chat)
  })

  it('replaces the command palette and the file search', () => {
    render(<Harness />)
    act(() => useCommandPaletteStore.getState().open())
    expect(press(CMD_G)).toBe(true)
    expect(switcher()).not.toBeNull()
    expect(useCommandPaletteStore.getState().isOpen).toBe(false)

    press(CMD_G)
    expect(switcher()).toBeNull()

    act(() => useFileSearchStore.getState().open())
    expect(press(CMD_G)).toBe(true)
    expect(switcher()).not.toBeNull()
    expect(useFileSearchStore.getState().isOpen).toBe(false)
  })
})

describe('rebinding Go to Project', () => {
  it('the new key opens the switcher and Cmd+G no longer does', () => {
    render(<Harness />)
    act(() => {
      useShortcutStore
        .getState()
        .setCustomBinding('nav:go-to-project', { key: 'j', modifiers: ['meta', 'shift'] })
    })
    focusOn('chat-input')

    expect(press(CMD_G)).toBe(false)
    expect(switcher()).toBeNull()

    expect(press({ key: 'J', code: 'KeyJ', metaKey: true, shiftKey: true })).toBe(true)
    expect(switcher()).not.toBeNull()
    expect(press({ key: 'J', code: 'KeyJ', metaKey: true, shiftKey: true })).toBe(true)
    expect(switcher()).toBeNull()
  })
})

describe('keys saved before Cmd+G became Go to Project', () => {
  it('Cmd+G saved on another action still runs that action, not the switcher', () => {
    useShortcutStore.setState({
      customBindings: { 'nav:command-palette': { key: 'g', modifiers: ['meta'] } }
    })
    render(<Harness />)
    focusOn('chat-input')

    expect(press(CMD_G)).toBe(true)
    expect(useCommandPaletteStore.getState().isOpen).toBe(true)
    expect(useProjectSwitcherStore.getState().isOpen).toBe(false)
    expect(switcher()).toBeNull()
  })

  it('a key saved for "Filter Projects" does nothing', () => {
    vi.useFakeTimers()
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    useShortcutStore.setState({
      customBindings: { 'nav:filter-projects': { key: 'f', modifiers: ['meta', 'shift'] } }
    })
    useLayoutStore.setState({ leftSidebarCollapsed: true })
    render(<Harness />)
    const chat = focusOn('chat-input')

    expect(press({ key: 'F', code: 'KeyF', metaKey: true, shiftKey: true })).toBe(false)
    act(() => {
      vi.advanceTimersByTime(500)
    })
    expect(useLayoutStore.getState().leftSidebarCollapsed).toBe(true)
    expect(document.activeElement).toBe(chat)
    expect(switcher()).toBeNull()

    // Cmd+G is Go to Project all the same.
    expect(press(CMD_G)).toBe(true)
    expect(switcher()).not.toBeNull()
    expect(errors).not.toHaveBeenCalled()
    errors.mockRestore()
  })
})
