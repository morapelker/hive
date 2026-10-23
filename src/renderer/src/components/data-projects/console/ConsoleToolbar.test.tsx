// The toolbar's Console entry: the button and ⌃⌘C open (or focus) the workspace's Console tab;
// the shortcut leaves the key alone while a dialog is open or with other modifiers.
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sampleDataProject } from '../data-project.sample'

vi.mock('@/api/data-projects-api', () => ({
  dataProjectsApi: {
    status: vi.fn(async (id: string) => ({ dataProjectId: id, state: 'connected' })),
    onStatus: vi.fn(() => () => {}),
    update: vi.fn()
  }
}))
const host = vi.hoisted(() => ({ openWorkspaceSpecialTab: vi.fn(async () => undefined) }))
vi.mock('../DataProjectWorkspaceHost', () => ({
  openWorkspaceSpecialTab: host.openWorkspaceSpecialTab
}))
vi.mock('@/api/project-api', () => ({
  projectApi: { getProjectIconPath: vi.fn(async () => null), copyToClipboard: vi.fn() }
}))
vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }
}))

const { DataProjectToolbar } = await import('../DataProjectToolbar')
const { isConsoleShortcut } = await import('./console-shortcut')
const { useDataProjectStore } = await import('@/stores/useDataProjectStore')

const mac = /Mac|iPhone|iPad/.test(navigator.platform)
const chord = mac ? { ctrlKey: true, metaKey: true } : { ctrlKey: true, altKey: true }

beforeEach(() => {
  vi.clearAllMocks()
  useDataProjectStore.getState().reset()
})
afterEach(() => cleanup())

describe('Console in the data project toolbar', () => {
  it('opens the Console tab from the button and from ⌃⌘C', () => {
    const project = sampleDataProject()
    useDataProjectStore.setState({ projects: [project], loaded: true })
    render(<DataProjectToolbar project={project} />)
    fireEvent.click(screen.getByTestId('data-project-console'))
    expect(host.openWorkspaceSpecialTab).toHaveBeenLastCalledWith(project, 'console')

    fireEvent.keyDown(window, { key: 'c', code: 'KeyC', ...chord })
    expect(host.openWorkspaceSpecialTab).toHaveBeenCalledTimes(2)
    // Other chords are not ours.
    fireEvent.keyDown(window, { key: 'c', code: 'KeyC', metaKey: true })
    fireEvent.keyDown(window, { key: 'C', code: 'KeyC', shiftKey: true, ...chord })
    expect(host.openWorkspaceSpecialTab).toHaveBeenCalledTimes(2)
  })

  it('leaves the shortcut alone under a dialog', () => {
    const project = sampleDataProject()
    useDataProjectStore.setState({ projects: [project], loaded: true })
    render(
      <>
        <DataProjectToolbar project={project} />
        <div role="dialog" data-state="open" />
      </>
    )
    fireEvent.keyDown(window, { key: 'c', code: 'KeyC', ...chord })
    expect(host.openWorkspaceSpecialTab).not.toHaveBeenCalled()
  })

  it('matches only the console chord', () => {
    const event = (init: KeyboardEventInit): KeyboardEvent => new KeyboardEvent('keydown', init)
    expect(isConsoleShortcut(event({ key: 'c', code: 'KeyC', ...chord }))).toBe(true)
    expect(isConsoleShortcut(event({ key: 'x', code: 'KeyX', ...chord }))).toBe(false)
    expect(isConsoleShortcut(event({ key: 'c', code: 'KeyC', ctrlKey: true }))).toBe(false)
  })
})
