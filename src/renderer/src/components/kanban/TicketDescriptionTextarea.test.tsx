import { useState } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/platform', () => ({ isMac: () => true }))

import { useSettingsStore } from '@/stores/useSettingsStore'
import { isInlineSuggestionTarget } from '@/lib/inline-suggestion'
import { TicketDescriptionTextarea } from './TicketDescriptionTextarea'

type Suggest = (before: string) => Promise<{
  text: string
  confidence: number
  support: number
  contextLength: number
} | null>

function Harness({ suggest, initial = '' }: { suggest: Suggest; initial?: string }) {
  const [value, setValue] = useState(initial)
  return (
    <TicketDescriptionTextarea
      data-testid="description"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      suggest={suggest}
    />
  )
}

const fromTable =
  (table: Record<string, string>): Suggest =>
  async (before) =>
    table[before] ? { text: table[before], confidence: 1, support: 3, contextLength: 2 } : null

function type(el: HTMLTextAreaElement, value: string): void {
  act(() => {
    fireEvent.change(el, { target: { value } })
    el.setSelectionRange(value.length, value.length)
    fireEvent.select(el)
  })
}

/** Let the debounce and any pending suggestion request run. */
const settle = (): Promise<void> =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 100))
  })

function tab(el: HTMLTextAreaElement): boolean {
  const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
  act(() => {
    el.dispatchEvent(event)
  })
  return event.defaultPrevented
}

describe('TicketDescriptionTextarea', () => {
  beforeEach(() => {
    useSettingsStore.setState({ ticketAutocompleteEnabled: true })
  })

  it('shows the suggestion as ghost text and accepts it with Tab', async () => {
    render(<Harness suggest={fromTable({ 'ask me any clar': 'ifying questions' })} />)
    const el = screen.getByTestId('description') as HTMLTextAreaElement
    act(() => el.focus())
    type(el, 'ask me any clar')

    const ghost = await screen.findByTestId('ticket-description-suggestion')
    expect(ghost.textContent).toBe('ask me any clarifying questions')
    expect(isInlineSuggestionTarget(el)).toBe(true)

    expect(tab(el)).toBe(true)
    expect(el.value).toBe('ask me any clarifying questions')
    await waitFor(() => expect(screen.queryByTestId('ticket-description-suggestion')).toBeNull())
    // Still owns Tab: an accidental press must not move focus.
    expect(isInlineSuggestionTarget(el)).toBe(true)
  })

  it('keeps the rest visible while typing through the suggestion', async () => {
    const suggest = vi.fn(fromTable({ 'use sub': 'agents to read' }))
    render(<Harness suggest={suggest} />)
    const el = screen.getByTestId('description') as HTMLTextAreaElement
    act(() => el.focus())
    type(el, 'use sub')
    await screen.findByTestId('ticket-description-suggestion')

    type(el, 'use suba')
    expect(screen.getByTestId('ticket-description-suggestion').textContent).toBe(
      'use subagents to read'
    )
    await settle()
    expect(suggest).toHaveBeenCalledTimes(1)
  })

  it('accepts one word with Cmd+Right', async () => {
    render(<Harness suggest={fromTable({ 'use ': 'subagents to read' })} />)
    const el = screen.getByTestId('description') as HTMLTextAreaElement
    act(() => el.focus())
    type(el, 'use ')
    await screen.findByTestId('ticket-description-suggestion')

    act(() => {
      el.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowRight', metaKey: true, bubbles: true })
      )
    })
    expect(el.value).toBe('use subagents')
    expect(screen.getByTestId('ticket-description-suggestion').textContent).toBe(
      'use subagents to read'
    )
  })

  it('dismisses with Escape without letting the dialog see it', async () => {
    render(<Harness suggest={fromTable({ 'use ': 'subagents' })} />)
    const el = screen.getByTestId('description') as HTMLTextAreaElement
    const outer = vi.fn()
    document.addEventListener('keydown', outer)
    act(() => el.focus())
    type(el, 'use ')
    await screen.findByTestId('ticket-description-suggestion')

    act(() => {
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(screen.queryByTestId('ticket-description-suggestion')).toBeNull()
    expect(outer).not.toHaveBeenCalled()
    document.removeEventListener('keydown', outer)
  })

  it('swallows Tab when there is no suggestion so focus stays in the field', async () => {
    render(<Harness suggest={fromTable({})} />)
    const el = screen.getByTestId('description') as HTMLTextAreaElement
    const outer = vi.fn()
    document.addEventListener('keydown', outer)
    act(() => el.focus())
    type(el, 'nothing to see ')
    await settle()
    expect(isInlineSuggestionTarget(el)).toBe(true)
    expect(tab(el)).toBe(true)
    expect(outer).not.toHaveBeenCalled()
    expect(el.value).toBe('nothing to see ')
    expect(document.activeElement).toBe(el)
    document.removeEventListener('keydown', outer)
  })

  it('lets Shift+Tab and other keys through when there is no suggestion', async () => {
    render(<Harness suggest={fromTable({})} />)
    const el = screen.getByTestId('description') as HTMLTextAreaElement
    act(() => el.focus())
    type(el, 'nothing to see ')
    await settle()
    for (const init of [
      { key: 'Tab', shiftKey: true },
      { key: 'Escape' },
      { key: 'ArrowRight', metaKey: true }
    ]) {
      const event = new KeyboardEvent('keydown', { ...init, bubbles: true, cancelable: true })
      act(() => {
        el.dispatchEvent(event)
      })
      expect(event.defaultPrevented).toBe(false)
    }
  })

  it('does nothing when the setting is off', async () => {
    useSettingsStore.setState({ ticketAutocompleteEnabled: false })
    const suggest = vi.fn(fromTable({ 'use ': 'subagents' }))
    render(<Harness suggest={suggest} />)
    const el = screen.getByTestId('description') as HTMLTextAreaElement
    act(() => el.focus())
    type(el, 'use ')
    await settle()
    expect(suggest).not.toHaveBeenCalled()
    expect(screen.queryByTestId('ticket-description-suggestion')).toBeNull()
    expect(isInlineSuggestionTarget(el)).toBe(false)
    expect(tab(el)).toBe(false)
  })

  it('mirrors the text after the caret so the overlay scrolls like the textarea', async () => {
    const value = ['one', 'two', 'three', 'four', 'five', 'six', ''].join('\n')
    render(<Harness suggest={fromTable({ 'one\ntwo': ' more' })} initial={value} />)
    const el = screen.getByTestId('description') as HTMLTextAreaElement
    act(() => {
      el.focus()
      el.setSelectionRange(7, 7)
      fireEvent.select(el)
    })
    const overlay = await screen.findByTestId('ticket-description-suggestion')
    const ghost = overlay.querySelector('span')
    expect(ghost?.textContent).toBe(' more')
    expect(ghost?.previousSibling?.textContent).toBe('one\ntwo')
    // The trailing newline makes an empty row in the textarea; the zero-width
    // space makes the overlay render one too.
    expect(overlay.textContent).toBe('one\ntwo more\nthree\nfour\nfive\nsix\n\u200b')
  })

  it('only suggests with the caret at the end of a line', async () => {
    const suggest = vi.fn(fromTable({ 'use ': 'subagents' }))
    render(<Harness suggest={suggest} initial="use tail" />)
    const el = screen.getByTestId('description') as HTMLTextAreaElement
    act(() => {
      el.focus()
      el.setSelectionRange(4, 4)
      fireEvent.select(el)
    })
    await settle()
    expect(suggest).not.toHaveBeenCalled()
  })
})
