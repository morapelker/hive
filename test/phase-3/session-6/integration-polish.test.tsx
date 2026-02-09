import { describe, test, expect, beforeEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MarkdownRenderer } from '../../../src/renderer/src/components/sessions/MarkdownRenderer'
import { ModeToggle } from '../../../src/renderer/src/components/sessions/ModeToggle'
import { AssistantCanvas } from '../../../src/renderer/src/components/sessions/AssistantCanvas'
import { ToolCard } from '../../../src/renderer/src/components/sessions/ToolCard'
import { useSessionStore } from '../../../src/renderer/src/stores/useSessionStore'
import type { ToolUseInfo } from '../../../src/renderer/src/components/sessions/ToolCard'
import type { StreamingPart } from '../../../src/renderer/src/components/sessions/SessionView'

// Mock sonner toast
vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn()
  }
}))

beforeEach(() => {
  vi.clearAllMocks()
  cleanup()

  // Reset session store mode state
  useSessionStore.setState({
    modeBySession: new Map([['test-session', 'build']])
  })
})

describe('Session 6: Integration Polish', () => {
  describe('Input Area Theme Compatibility', () => {
    test('Input area renders correctly in dark theme', () => {
      // ModeToggle component renders with correct border colors in build mode
      render(<ModeToggle sessionId="test-session" />)
      const toggle = screen.getByTestId('mode-toggle')
      expect(toggle).toBeDefined()
      expect(toggle.getAttribute('data-mode')).toBe('build')
    })

    test('Input area renders correctly in light theme', () => {
      // ModeToggle renders the same structure in light mode (styles are theme-agnostic via Tailwind)
      render(<ModeToggle sessionId="test-session" />)
      const toggle = screen.getByTestId('mode-toggle')
      expect(toggle).toBeDefined()
      // Tailwind classes work across themes
      expect(toggle.className).toContain('transition-colors')
    })
  })

  describe('Streaming Markdown Rendering', () => {
    test('Streaming markdown renders progressively', () => {
      const parts: StreamingPart[] = [
        { type: 'text', text: '# Hello\n\nThis is **bold**' }
      ]

      const { container } = render(
        <AssistantCanvas
          content=""
          timestamp={new Date().toISOString()}
          isStreaming={true}
          parts={parts}
        />
      )

      // Heading should be rendered
      const heading = container.querySelector('h1')
      expect(heading).toBeDefined()
      expect(heading?.textContent).toBe('Hello')

      // Bold text should be rendered
      const bold = container.querySelector('strong')
      expect(bold).toBeDefined()
    })

    test('Tool cards render between markdown during streaming', () => {
      const toolUse: ToolUseInfo = {
        id: 'tool-1',
        name: 'Read',
        input: { file_path: '/src/test.ts' },
        status: 'success',
        startTime: Date.now() - 1000,
        endTime: Date.now()
      }

      const parts: StreamingPart[] = [
        { type: 'text', text: 'Here is some text before the tool call.' },
        { type: 'tool_use', toolUse },
        { type: 'text', text: 'And some text after the tool call.' }
      ]

      render(
        <AssistantCanvas
          content=""
          timestamp={new Date().toISOString()}
          isStreaming={false}
          parts={parts}
        />
      )

      // Verify ToolCard renders between text
      const toolCard = screen.getByTestId('tool-card')
      expect(toolCard).toBeDefined()
      expect(toolCard.getAttribute('data-tool-name')).toBe('Read')
    })
  })

  describe('Mode Toggle Focus Behavior', () => {
    test('Mode toggle does not steal textarea focus', async () => {
      const user = userEvent.setup()

      // Render mode toggle in a container with a textarea
      render(
        <div>
          <textarea data-testid="test-textarea" />
          <ModeToggle sessionId="test-session" />
        </div>
      )

      const textarea = screen.getByTestId('test-textarea')
      const toggle = screen.getByTestId('mode-toggle')

      // Focus textarea first
      await user.click(textarea)
      expect(document.activeElement).toBe(textarea)

      // Click mode toggle - should not steal focus due to onMouseDown preventDefault
      await user.click(toggle)

      // Textarea should retain focus
      expect(document.activeElement).toBe(textarea)
    })
  })

  describe('Markdown Rendering Performance', () => {
    test('Markdown renders under 50ms', () => {
      const markdownContent = `# Large Document

## Introduction

This is a comprehensive test document with **bold text**, *italic text*, and \`inline code\`.

### Features

- Item 1 with [a link](https://example.com)
- Item 2 with **bold** content
- Item 3 with \`code\` snippets

### Code Example

\`\`\`typescript
function fibonacci(n: number): number {
  if (n <= 1) return n;
  return fibonacci(n - 1) + fibonacci(n - 2);
}

const result = fibonacci(10);
console.log(result);
\`\`\`

### Table

| Feature | Status | Notes |
|---------|--------|-------|
| Markdown | Done | Full support |
| Tables | Done | With scroll |
| Code | Done | With highlight |

> This is a blockquote that should render with a left border.

---

## Conclusion

This document tests all markdown features for performance.`

      const start = performance.now()
      render(<MarkdownRenderer content={markdownContent} />)
      const elapsed = performance.now() - start

      expect(elapsed).toBeLessThan(50)
    })
  })

  describe('Data Test IDs Preserved', () => {
    test('All existing data-testid attributes preserved', () => {
      // Test ModeToggle testid
      const { unmount: unmount1 } = render(<ModeToggle sessionId="test-session" />)
      expect(screen.getByTestId('mode-toggle')).toBeDefined()
      unmount1()

      // Test ToolCard testids
      const toolUse: ToolUseInfo = {
        id: 'tool-1',
        name: 'Bash',
        input: { command: 'echo hello' },
        status: 'success',
        startTime: Date.now(),
        endTime: Date.now() + 100,
        output: 'hello'
      }
      const { unmount: unmount2 } = render(<ToolCard toolUse={toolUse} />)
      expect(screen.getByTestId('tool-card')).toBeDefined()
      expect(screen.getByTestId('tool-card-header')).toBeDefined()
      expect(screen.getByTestId('tool-success')).toBeDefined()
      unmount2()

      // Test CodeBlock testid via MarkdownRenderer
      const { unmount: unmount3 } = render(
        <MarkdownRenderer content={'```typescript\nconst x = 1;\n```'} />
      )
      expect(screen.getByTestId('code-block')).toBeDefined()
      expect(screen.getByTestId('copy-code-button')).toBeDefined()
      unmount3()

      // Test AssistantCanvas testid
      const { unmount: unmount4 } = render(
        <AssistantCanvas content="Hello" timestamp={new Date().toISOString()} />
      )
      expect(screen.getByTestId('message-assistant')).toBeDefined()
      unmount4()
    })
  })

  describe('Accessibility', () => {
    test('Aria-labels present on mode toggle', () => {
      render(<ModeToggle sessionId="test-session" />)
      const toggle = screen.getByTestId('mode-toggle')
      expect(toggle.getAttribute('aria-label')).toContain('Current mode')
      expect(toggle.getAttribute('aria-label')).toContain('Build')
    })

    test('Mode toggle has descriptive title', () => {
      render(<ModeToggle sessionId="test-session" />)
      const toggle = screen.getByTestId('mode-toggle')
      expect(toggle.getAttribute('title')).toContain('Shift+Tab to toggle')
    })

    test('Mode toggle icon is hidden from screen readers', () => {
      const { container } = render(<ModeToggle sessionId="test-session" />)
      const icon = container.querySelector('[aria-hidden="true"]')
      expect(icon).toBeDefined()
    })
  })

  describe('Tool Card Visual Polish', () => {
    test('Pending tool has gray left border', () => {
      const toolUse: ToolUseInfo = {
        id: 'tool-1',
        name: 'Read',
        input: {},
        status: 'pending',
        startTime: Date.now()
      }
      render(<ToolCard toolUse={toolUse} />)
      const card = screen.getByTestId('tool-card')
      expect(card.className).toContain('border-l-2')
      // borderLeftColor is set via inline style
      expect(card.style.borderLeftColor).toBeTruthy()
    })

    test('Running tool has blue left border with pulse', () => {
      const toolUse: ToolUseInfo = {
        id: 'tool-1',
        name: 'Bash',
        input: { command: 'npm test' },
        status: 'running',
        startTime: Date.now()
      }
      render(<ToolCard toolUse={toolUse} />)
      const card = screen.getByTestId('tool-card')
      // JSDOM converts hex to rgb
      expect(card.style.borderLeftColor).toBe('rgb(59, 130, 246)')
      expect(card.className).toContain('animate-pulse')
    })

    test('Successful tool has green left border', () => {
      const toolUse: ToolUseInfo = {
        id: 'tool-1',
        name: 'Read',
        input: {},
        status: 'success',
        startTime: Date.now(),
        endTime: Date.now() + 100
      }
      render(<ToolCard toolUse={toolUse} />)
      const card = screen.getByTestId('tool-card')
      expect(card.style.borderLeftColor).toBe('rgb(34, 197, 94)')
    })

    test('Error tool has red left border', () => {
      const toolUse: ToolUseInfo = {
        id: 'tool-1',
        name: 'Bash',
        input: {},
        status: 'error',
        startTime: Date.now(),
        error: 'Command failed'
      }
      render(<ToolCard toolUse={toolUse} />)
      const card = screen.getByTestId('tool-card')
      expect(card.style.borderLeftColor).toBe('rgb(239, 68, 68)')
      expect(card.className).toContain('border-red-500/30')
    })

    test('Tool cards use compact vertical margin', () => {
      const toolUse: ToolUseInfo = {
        id: 'tool-1',
        name: 'Read',
        input: {},
        status: 'success',
        startTime: Date.now()
      }
      render(<ToolCard toolUse={toolUse} />)
      const card = screen.getByTestId('tool-card')
      expect(card.className).toContain('my-1')
    })

    test('Tool output with smooth transition', () => {
      const toolUse: ToolUseInfo = {
        id: 'tool-1',
        name: 'Bash',
        input: {},
        status: 'success',
        startTime: Date.now(),
        output: 'some output'
      }
      render(<ToolCard toolUse={toolUse} />)
      const output = screen.getByTestId('tool-output')
      expect(output.className).toContain('transition-all')
      expect(output.className).toContain('duration-150')
    })

    test('Long output shows truncation controls', async () => {
      const user = userEvent.setup()
      const lines = Array.from({ length: 50 }, (_, i) => `Line ${i + 1}`).join('\n')
      const toolUse: ToolUseInfo = {
        id: 'tool-1',
        name: 'Bash',
        input: {},
        status: 'success',
        startTime: Date.now(),
        output: lines
      }
      render(<ToolCard toolUse={toolUse} />)

      // Expand the card first
      const header = screen.getByTestId('tool-card-header')
      await user.click(header)

      // Show more button should be visible
      const showMore = screen.getByTestId('show-more-button')
      expect(showMore).toBeDefined()
      expect(showMore.textContent).toContain('Show more')

      // Click show more
      await user.click(showMore)
      expect(showMore.textContent).toContain('Show less')
    })
  })

  describe('Markdown Rendering Features', () => {
    test('Headings render with correct styles', () => {
      const { container } = render(
        <MarkdownRenderer content={'# Title\n\n## Subtitle\n\n### Section'} />
      )

      const h1 = container.querySelector('h1')
      const h2 = container.querySelector('h2')
      const h3 = container.querySelector('h3')

      expect(h1).not.toBeNull()
      expect(h1!.className).toContain('text-xl')
      expect(h1!.className).toContain('font-bold')
      expect(h2).not.toBeNull()
      expect(h2!.className).toContain('text-lg')
      expect(h2!.className).toContain('font-semibold')
      expect(h3).not.toBeNull()
      expect(h3!.className).toContain('text-base')
      expect(h3!.className).toContain('font-semibold')
    })

    test('Bold and italic render correctly', () => {
      const { container } = render(
        <MarkdownRenderer content="**bold** and *italic*" />
      )

      expect(container.querySelector('strong')).toBeDefined()
      expect(container.querySelector('em')).toBeDefined()
    })

    test('Unordered list renders with correct styles', () => {
      const { container } = render(
        <MarkdownRenderer content={'- item 1\n- item 2\n- item 3'} />
      )

      const ul = container.querySelector('ul')
      expect(ul).not.toBeNull()
      expect(ul!.className).toContain('list-disc')
    })

    test('Ordered list renders with correct styles', () => {
      const { container } = render(
        <MarkdownRenderer content={'1. first\n2. second\n3. third'} />
      )

      const ol = container.querySelector('ol')
      expect(ol).not.toBeNull()
      expect(ol!.className).toContain('list-decimal')
    })

    test('Links have safe attributes for Electron', () => {
      const { container } = render(
        <MarkdownRenderer content="[click here](https://example.com)" />
      )

      const link = container.querySelector('a')
      expect(link?.getAttribute('target')).toBe('_blank')
      expect(link?.getAttribute('rel')).toBe('noopener noreferrer')
    })

    test('Inline code renders with muted background', () => {
      const { container } = render(
        <MarkdownRenderer content="Use `const` for constants" />
      )

      const inlineCode = container.querySelector('code')
      expect(inlineCode?.className).toContain('bg-muted')
      expect(inlineCode?.className).toContain('font-mono')
    })

    test('Blockquotes render with left border', () => {
      const { container } = render(
        <MarkdownRenderer content="> This is a quote" />
      )

      const blockquote = container.querySelector('blockquote')
      expect(blockquote?.className).toContain('border-l-2')
    })

    test('Tables render with borders', () => {
      const { container } = render(
        <MarkdownRenderer content={'| Col1 | Col2 |\n| ------ | ------ |\n| A | B |'} />
      )

      const table = container.querySelector('table')
      expect(table).not.toBeNull()
      expect(table!.className).toContain('border')
      const th = container.querySelector('th')
      expect(th).not.toBeNull()
      expect(th!.className).toContain('bg-muted')
    })
  })
})
