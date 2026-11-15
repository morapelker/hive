// The sidebar's filter field is click-to-type: no shortcut focuses it any more (Cmd+G is
// "Go to Project") and it shows no key hint. Everything it does once clicked is unchanged.

import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./LanguageIcon', () => ({ LanguageIcon: () => <span data-testid="language-icon" /> }))
vi.mock('@/lib/hint-utils', () => ({ dispatchHintAction: vi.fn() }))

import { ProjectFilter } from './ProjectFilter'
import { dispatchHintAction } from '@/lib/hint-utils'
import { useFilterStore } from '@/stores/useFilterStore'
import { useHintStore } from '@/stores/useHintStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { useSpaceStore } from '@/stores/useSpaceStore'
import { sampleGitProject } from '@/components/data-projects/data-project.sample'

function Field({ initial = '' }: { initial?: string }): React.JSX.Element {
  const [value, setValue] = useState(initial)
  return (
    <>
      <textarea data-testid="chat-input" />
      <ProjectFilter value={value} onChange={setValue} />
      <output data-testid="filter-value">{value}</output>
    </>
  )
}

const field = (): HTMLInputElement => screen.getByTestId('project-filter-input') as HTMLInputElement

beforeEach(() => {
  useProjectStore.setState({
    projects: [
      sampleGitProject('ledger-api', 0, { language: 'TypeScript' }),
      sampleGitProject('ledger-worker', 1, { language: 'Go' })
    ] as never
  })
  useSpaceStore.setState({ activeSpaceId: null, projectSpaceMap: {} })
  useFilterStore.setState({ activeLanguages: [] })
  useHintStore.setState({
    mode: 'idle',
    pendingChar: null,
    inputFocused: false,
    hintMap: new Map([['project:ledger-worker', 'Aa']])
  } as never)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('the Cmd+G hint is gone', () => {
  it('shows no key hint, empty, focused or filled', () => {
    const { container } = render(<Field />)
    expect(container.querySelector('kbd')).toBeNull()
    expect(container.textContent).not.toContain('⌘')

    act(() => field().focus())
    expect(container.querySelector('kbd')).toBeNull()

    fireEvent.change(field(), { target: { value: 'ledg' } })
    expect(container.querySelector('kbd')).toBeNull()
    expect(field().getAttribute('title')).toBeNull()
    expect(field().placeholder).toBe('Filter projects...')
  })

  it('is not focused by the old "Filter Projects" request', () => {
    vi.useFakeTimers()
    render(<Field />)
    const chat = screen.getByTestId('chat-input')
    act(() => chat.focus())

    act(() => {
      window.dispatchEvent(new CustomEvent('hive:focus-project-filter'))
      vi.advanceTimersByTime(500)
    })
    expect(document.activeElement).toBe(chat)
  })
})

describe('what the field does when clicked is unchanged', () => {
  it('takes the focus and filters as you type', () => {
    render(<Field />)
    fireEvent.click(field())
    act(() => field().focus())
    expect(document.activeElement).toBe(field())
    expect(useHintStore.getState().inputFocused).toBe(true)

    fireEvent.change(field(), { target: { value: 'ledg' } })
    expect(screen.getByTestId('filter-value').textContent).toBe('ledg')
    expect(field().value).toBe('ledg')
  })

  it('starts a two-letter jump hint on a capital letter and follows it', () => {
    render(<Field initial="ledg" />)
    act(() => field().focus())

    // "A" then "a" is the hint of ledger-worker (hintMap above).
    expect(fireEvent.keyDown(field(), { key: 'A' })).toBe(false)
    expect(useHintStore.getState().mode).toBe('pending')
    expect(useHintStore.getState().pendingChar).toBe('A')

    expect(fireEvent.keyDown(field(), { key: 'a' })).toBe(false)
    expect(dispatchHintAction).toHaveBeenCalledWith('project:ledger-worker', 'select')
    expect(useHintStore.getState().mode).toBe('idle')
    // Neither key reached the text.
    expect(field().value).toBe('ledg')
  })

  it('offers the ":" commands', () => {
    render(<Field />)
    act(() => field().focus())
    fireEvent.change(field(), { target: { value: ':' } })
    expect(screen.getByTestId('colon-command-popover')).toBeInTheDocument()
    expect(screen.getByTestId('colon-item-lang')).toBeInTheDocument()

    fireEvent.change(field(), { target: { value: ':lang=' } })
    expect(screen.getByTestId('colon-item-Go')).toBeInTheDocument()
    expect(screen.getByTestId('colon-item-TypeScript')).toBeInTheDocument()
  })

  it('clears the text and leaves the field on Escape', () => {
    render(<Field initial="ledg" />)
    act(() => field().focus())
    expect(document.activeElement).toBe(field())

    fireEvent.keyDown(field(), { key: 'Escape' })
    expect(screen.getByTestId('filter-value').textContent).toBe('')
    expect(field().value).toBe('')
    expect(document.activeElement).not.toBe(field())
    expect(useHintStore.getState().inputFocused).toBe(false)
  })

  it('shows the clear button only with text, and it keeps the focus in the field', () => {
    render(<Field />)
    expect(screen.queryByTestId('project-filter-clear')).toBeNull()

    fireEvent.change(field(), { target: { value: 'ledg' } })
    fireEvent.click(screen.getByTestId('project-filter-clear'))
    expect(field().value).toBe('')
    expect(document.activeElement).toBe(field())
    expect(screen.queryByTestId('project-filter-clear')).toBeNull()
  })
})
