// Settings › Shortcuts after Cmd+G moved from "Filter Projects" to "Go to Project": what is
// listed, rebinding it, and what a user who had already put Cmd+G on another action sees.

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/api/db-api', () => ({
  dbApi: {
    setting: { get: vi.fn().mockResolvedValue(null), set: vi.fn().mockResolvedValue(undefined) }
  }
}))
vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }
}))

import { SettingsShortcuts } from './SettingsShortcuts'
import { useShortcutStore } from '@/stores/useShortcutStore'
import { toast } from '@/lib/toast'

const row = (id: string): HTMLElement => screen.getByTestId(`shortcut-${id}`)
const key = (id: string): HTMLElement => screen.getByTestId(`shortcut-binding-${id}`)

/** The rows under a category heading, as [label, key] pairs. */
const section = (heading: string): [string, string][] => {
  const title = screen.getByRole('heading', { name: heading, level: 4 })
  const rows = within(title.parentElement as HTMLElement).getAllByTestId(/^shortcut-(?!binding-)/)
  return rows.map((r) => [
    r.querySelector('span.text-sm')?.textContent ?? '',
    within(r).getByTestId(/^shortcut-binding-/).textContent ?? ''
  ])
}

beforeEach(() => {
  useShortcutStore.setState({ customBindings: {} })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('Settings › Shortcuts', () => {
  it('lists "Go to Project" with ⌘G under Navigation', () => {
    render(<SettingsShortcuts />)
    expect(section('Navigation')).toContainEqual(['Go to Project', '⌘G'])
    expect(within(row('nav:go-to-project')).getByText('Go to Project')).toBeInTheDocument()
  })

  it('has no "Filter Projects" entry, in any section', () => {
    render(<SettingsShortcuts />)
    expect(screen.queryByText('Filter Projects')).toBeNull()
    expect(screen.queryByTestId('shortcut-nav:filter-projects')).toBeNull()
    expect(screen.queryByText(/project filter/i)).toBeNull()
    // ⌘G is shown once: on Go to Project.
    expect(
      screen.getAllByTestId(/^shortcut-binding-/).filter((b) => b.textContent === '⌘G')
    ).toEqual([key('nav:go-to-project')])
  })

  it('rebinds Go to Project like the others, and resets it', () => {
    render(<SettingsShortcuts />)
    fireEvent.click(key('nav:go-to-project'))
    expect(key('nav:go-to-project').textContent).toBe('Press keys...')

    fireEvent.keyDown(key('nav:go-to-project'), {
      key: 'J',
      code: 'KeyJ',
      metaKey: true,
      shiftKey: true
    })
    expect(key('nav:go-to-project').textContent).toBe('⌘⇧J')
    expect(useShortcutStore.getState().customBindings['nav:go-to-project']).toEqual({
      key: 'j',
      modifiers: ['meta', 'shift']
    })
    expect(toast.success).toHaveBeenCalledWith('Shortcut updated to ⌘⇧J')

    fireEvent.click(within(row('nav:go-to-project')).getByTitle('Reset to default'))
    expect(key('nav:go-to-project').textContent).toBe('⌘G')
  })

  it('refuses ⌘G for another action while Go to Project has it, naming it', () => {
    render(<SettingsShortcuts />)
    fireEvent.click(key('nav:session-history'))
    fireEvent.keyDown(key('nav:session-history'), { key: 'g', code: 'KeyG', metaKey: true })

    expect(screen.getByText('Shortcut conflict')).toBeInTheDocument()
    expect(screen.getByText(/already used by: Go to Project/)).toBeInTheDocument()
    expect(useShortcutStore.getState().customBindings).toEqual({})
  })

  it('ignores a key saved for "Filter Projects": no entry, no error', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    useShortcutStore.setState({
      customBindings: { 'nav:filter-projects': { key: 'f', modifiers: ['meta', 'shift'] } }
    })
    render(<SettingsShortcuts />)

    expect(screen.queryByText('Filter Projects')).toBeNull()
    expect(screen.queryByTestId('shortcut-nav:filter-projects')).toBeNull()
    expect(screen.getAllByTestId(/^shortcut-binding-/).map((b) => b.textContent)).not.toContain(
      '⌘⇧F'
    )
    expect(key('nav:go-to-project').textContent).toBe('⌘G')
    expect(errors).not.toHaveBeenCalled()
    errors.mockRestore()
  })

  it('keeps ⌘G on the action a user gave it to, and still lists Go to Project', () => {
    useShortcutStore.setState({
      customBindings: { 'session:new': { key: 'g', modifiers: ['meta'] } }
    })
    render(<SettingsShortcuts />)

    expect(key('session:new').textContent).toBe('⌘G')
    expect(section('Navigation')).toContainEqual(['Go to Project', 'Not set'])

    // Asking for ⌘G names the action that has it.
    fireEvent.click(key('nav:go-to-project'))
    fireEvent.keyDown(key('nav:go-to-project'), { key: 'g', code: 'KeyG', metaKey: true })
    expect(screen.getByText(/already used by: New Session/)).toBeInTheDocument()

    // Another key is accepted.
    fireEvent.keyDown(key('nav:go-to-project'), { key: 'j', code: 'KeyJ', metaKey: true })
    expect(key('nav:go-to-project').textContent).toBe('⌘J')
    expect(key('session:new').textContent).toBe('⌘G')
  })

  it('gives ⌘G back to Go to Project when that action is reset', () => {
    useShortcutStore.setState({
      customBindings: { 'session:new': { key: 'g', modifiers: ['meta'] } }
    })
    render(<SettingsShortcuts />)
    act(() => {
      fireEvent.click(within(row('session:new')).getByTitle('Reset to default'))
    })
    expect(key('session:new').textContent).toBe('⌘T')
    expect(key('nav:go-to-project').textContent).toBe('⌘G')
  })
})
