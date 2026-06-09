import { afterEach, describe, expect, test, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import React from 'react'
import {
  RunOutputLine,
  SearchHighlight
} from '../../src/renderer/src/components/layout/RunOutputLine'
import { useSettingsStore } from '../../src/renderer/src/stores/useSettingsStore'
import { systemApi } from '@/api/system-api'

// Mock ansi-to-react so we can verify the raw text is passed through
vi.mock('ansi-to-react', () => ({
  default: ({ children }: { children: string }) => <code data-testid="ansi">{children}</code>
}))

vi.mock('@/api/system-api', () => ({
  systemApi: {
    openInChrome: vi.fn().mockResolvedValue({ success: true })
  }
}))

describe('RunOutputLine', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.mocked(systemApi.openInChrome).mockClear()
  })

  describe('marker lines', () => {
    test('renders truncation marker with \x00TRUNC: prefix', () => {
      const { container } = render(<RunOutputLine line={'\x00TRUNC:[older output truncated]'} />)
      const div = container.firstChild as HTMLElement
      expect(div.textContent).toBe('[older output truncated]')
      expect(div.className).toContain('text-center')
      expect(div.className).toContain('text-muted-foreground')
      expect(div.className).toContain('border-b')
    })

    test('renders custom truncation message', () => {
      const { container } = render(<RunOutputLine line={'\x00TRUNC:500 lines omitted'} />)
      expect(container.textContent).toBe('500 lines omitted')
    })

    test('renders CMD marker with $ prefix', () => {
      const { container } = render(<RunOutputLine line={'\x00CMD:npm run dev'} />)
      const div = container.firstChild as HTMLElement
      expect(div.textContent).toBe('$ npm run dev')
      expect(div.className).toContain('font-semibold')
      expect(div.className).toContain('text-muted-foreground')
    })

    test('renders ERR marker correctly', () => {
      const { container } = render(
        <RunOutputLine line={'\x00ERR:Command failed with exit code 1'} />
      )
      const div = container.firstChild as HTMLElement
      expect(div.textContent).toBe('Command failed with exit code 1')
      expect(div.className).toContain('text-destructive')
    })
  })

  describe('normal ANSI line (no highlight)', () => {
    test('renders using Ansi component', () => {
      render(<RunOutputLine line="hello world" />)
      const ansi = screen.getByTestId('ansi')
      expect(ansi.textContent).toBe('hello world')
    })

    test('wraps Ansi in div with correct classes', () => {
      const { container } = render(<RunOutputLine line="output text" />)
      const wrapper = container.firstChild as HTMLElement
      expect(wrapper.className).toContain('whitespace-pre-wrap')
      expect(wrapper.className).toContain('break-all')
      expect(wrapper.className).toContain('[&_code]:all-unset')
    })

    test('passes ANSI codes through to Ansi component', () => {
      const ansiLine = '\x1b[31mred text\x1b[0m'
      render(<RunOutputLine line={ansiLine} />)
      const ansi = screen.getByTestId('ansi')
      expect(ansi.textContent).toBe(ansiLine)
    })
  })

  describe('highlighted lines', () => {
    test('wraps matched text in <mark>', () => {
      const highlight: SearchHighlight = {
        matchStart: 6,
        matchEnd: 11,
        isCurrent: false
      }
      const { container } = render(<RunOutputLine line="hello world foo" highlight={highlight} />)
      const marks = container.querySelectorAll('mark')
      expect(marks).toHaveLength(1)
      expect(marks[0].textContent).toBe('world')
    })

    test('current match gets brighter highlight styling', () => {
      const highlight: SearchHighlight = {
        matchStart: 0,
        matchEnd: 5,
        isCurrent: true
      }
      const { container } = render(<RunOutputLine line="hello world" highlight={highlight} />)
      const mark = container.querySelector('mark')!
      expect(mark.className).toContain('bg-yellow-400/80')
    })

    test('non-current match gets dimmer highlight styling', () => {
      const highlight: SearchHighlight = {
        matchStart: 0,
        matchEnd: 5,
        isCurrent: false
      }
      const { container } = render(<RunOutputLine line="hello world" highlight={highlight} />)
      const mark = container.querySelector('mark')!
      expect(mark.className).toContain('bg-yellow-400/40')
    })

    test('handles highlight spanning the entire text', () => {
      const highlight: SearchHighlight = {
        matchStart: 0,
        matchEnd: 11,
        isCurrent: false
      }
      const { container } = render(<RunOutputLine line="hello world" highlight={highlight} />)
      const mark = container.querySelector('mark')!
      expect(mark.textContent).toBe('hello world')
      // No text outside the mark
      const spans = container.querySelectorAll('span')
      expect(spans).toHaveLength(0)
    })

    test('handles highlight at start of text', () => {
      const highlight: SearchHighlight = {
        matchStart: 0,
        matchEnd: 5,
        isCurrent: false
      }
      const { container } = render(<RunOutputLine line="hello world" highlight={highlight} />)
      const mark = container.querySelector('mark')!
      expect(mark.textContent).toBe('hello')
      // The rest should be in a span
      const spans = container.querySelectorAll('span')
      expect(spans).toHaveLength(1)
      expect(spans[0].textContent).toBe(' world')
    })

    test('handles highlight at end of text', () => {
      const highlight: SearchHighlight = {
        matchStart: 6,
        matchEnd: 11,
        isCurrent: false
      }
      const { container } = render(<RunOutputLine line="hello world" highlight={highlight} />)
      const mark = container.querySelector('mark')!
      expect(mark.textContent).toBe('world')
      const spans = container.querySelectorAll('span')
      expect(spans).toHaveLength(1)
      expect(spans[0].textContent).toBe('hello ')
    })

    test('handles highlight in line with ANSI codes', () => {
      // "\x1b[31m" is an ANSI code, "red text" is the visible text
      const line = '\x1b[31mred text\x1b[0m'
      const highlight: SearchHighlight = {
        matchStart: 0,
        matchEnd: 3,
        isCurrent: false
      }
      const { container } = render(<RunOutputLine line={line} highlight={highlight} />)
      const mark = container.querySelector('mark')!
      expect(mark.textContent).toBe('red')
      // "red" is highlighted, " text" is not
      const fullText = container.textContent
      expect(fullText).toBe('red text')
    })

    test('highlighted line does not use Ansi component', () => {
      const highlight: SearchHighlight = {
        matchStart: 0,
        matchEnd: 5,
        isCurrent: false
      }
      render(<RunOutputLine line="hello world" highlight={highlight} />)
      expect(screen.queryByTestId('ansi')).toBeNull()
    })
  })

  describe('URL linkification', () => {
    test('plain line still uses Ansi component', () => {
      render(<RunOutputLine line="plain output" />)
      const ansi = screen.getByTestId('ansi')
      expect(ansi.textContent).toBe('plain output')
    })

    test('line with one URL renders a data-url span', () => {
      const { container } = render(<RunOutputLine line="Local: http://localhost:5173/" />)
      const span = container.querySelector('[data-url="http://localhost:5173/"]')
      expect(span).not.toBeNull()
      expect(span?.textContent).toBe('http://localhost:5173/')
    })

    test('Cmd+click opens URL with custom Chrome command', () => {
      vi.spyOn(useSettingsStore, 'getState').mockReturnValue({
        customChromeCommand: 'open -a Firefox {url}'
      } as ReturnType<typeof useSettingsStore.getState>)

      const { container } = render(<RunOutputLine line="Local: http://localhost:5173/" />)
      const span = container.querySelector('[data-url="http://localhost:5173/"]')!

      fireEvent.click(span, { metaKey: true, button: 0 })

      expect(systemApi.openInChrome).toHaveBeenCalledWith(
        'http://localhost:5173/',
        'open -a Firefox {url}'
      )
    })

    test('plain click does not open URL', () => {
      const { container } = render(<RunOutputLine line="Local: http://localhost:5173/" />)
      const span = container.querySelector('[data-url="http://localhost:5173/"]')!

      fireEvent.click(span, { button: 0 })

      expect(systemApi.openInChrome).not.toHaveBeenCalled()
    })

    test('right-click context menu is suppressed without opening URL', () => {
      const { container } = render(<RunOutputLine line="Local: http://localhost:5173/" />)
      const span = container.querySelector('[data-url="http://localhost:5173/"]')!
      const event = new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        button: 2
      })

      span.dispatchEvent(event)

      expect(event.defaultPrevented).toBe(true)
      expect(systemApi.openInChrome).not.toHaveBeenCalled()
    })

    test('empty custom Chrome command is passed as undefined', () => {
      vi.spyOn(useSettingsStore, 'getState').mockReturnValue({
        customChromeCommand: ''
      } as ReturnType<typeof useSettingsStore.getState>)

      const { container } = render(<RunOutputLine line="Local: http://localhost:5173/" />)
      const span = container.querySelector('[data-url="http://localhost:5173/"]')!

      fireEvent.click(span, { metaKey: true, button: 0 })

      expect(systemApi.openInChrome).toHaveBeenCalledWith('http://localhost:5173/', undefined)
    })

    test('highlighted URL line is not linkified', () => {
      const highlight: SearchHighlight = {
        matchStart: 7,
        matchEnd: 11,
        isCurrent: true
      }
      const { container } = render(
        <RunOutputLine line="Local: http://localhost:5173/" highlight={highlight} />
      )

      expect(container.querySelector('[data-url]')).toBeNull()
    })
  })

  describe('React.memo', () => {
    test('does not re-render when props are unchanged', () => {
      // Render twice with same props and verify the DOM is identical
      // (React.memo skips re-render when shallow comparison passes)
      const { rerender } = render(<RunOutputLine line="stable" />)
      const firstHtml = document.body.innerHTML

      rerender(<RunOutputLine line="stable" />)
      const secondHtml = document.body.innerHTML

      expect(firstHtml).toBe(secondHtml)
    })

    test('re-renders when line changes', () => {
      const { container, rerender } = render(<RunOutputLine line="first" />)
      expect(container.textContent).toBe('first')

      rerender(<RunOutputLine line="second" />)
      expect(container.textContent).toBe('second')
    })

    test('re-renders when highlight changes', () => {
      const hl1: SearchHighlight = {
        matchStart: 0,
        matchEnd: 3,
        isCurrent: false
      }
      const hl2: SearchHighlight = {
        matchStart: 0,
        matchEnd: 3,
        isCurrent: true
      }

      const { container, rerender } = render(<RunOutputLine line="hello" highlight={hl1} />)
      const mark1 = container.querySelector('mark')!
      expect(mark1.className).toContain('bg-yellow-400/40')

      rerender(<RunOutputLine line="hello" highlight={hl2} />)
      const mark2 = container.querySelector('mark')!
      expect(mark2.className).toContain('bg-yellow-400/80')
    })
  })
})
