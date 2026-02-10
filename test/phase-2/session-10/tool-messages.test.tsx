import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ToolCard, type ToolUseInfo } from '../../../src/renderer/src/components/sessions/ToolCard'
import { StreamingCursor } from '../../../src/renderer/src/components/sessions/StreamingCursor'
import { AssistantCanvas } from '../../../src/renderer/src/components/sessions/AssistantCanvas'
import { MessageRenderer } from '../../../src/renderer/src/components/sessions/MessageRenderer'
import type {
  StreamingPart,
  OpenCodeMessage
} from '../../../src/renderer/src/components/sessions/SessionView'

// Mock sonner toast
vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn()
  }
}))

// Mock clipboard
const mockClipboard = {
  writeText: vi.fn().mockResolvedValue(undefined),
  readText: vi.fn().mockResolvedValue('')
}

beforeEach(() => {
  vi.clearAllMocks()
  Object.defineProperty(navigator, 'clipboard', {
    value: mockClipboard,
    writable: true,
    configurable: true
  })
})

afterEach(() => {
  cleanup()
})

describe('Session 10: Tool Message Rendering', () => {
  describe('ToolCard Component', () => {
    const makeToolUse = (overrides: Partial<ToolUseInfo> = {}): ToolUseInfo => ({
      id: 'tool-1',
      name: 'Read',
      input: { file_path: '/src/index.ts' },
      status: 'success',
      startTime: Date.now() - 100,
      endTime: Date.now(),
      ...overrides
    })

    test('Tool card renders for tool_use event', () => {
      render(<ToolCard toolUse={makeToolUse()} />)
      // Read is a file tool → compact layout
      expect(screen.getByTestId('compact-file-tool')).toBeInTheDocument()
    })

    test('Tool card displays tool name', () => {
      render(<ToolCard toolUse={makeToolUse({ name: 'Read' })} />)
      expect(screen.getByText('Read')).toBeInTheDocument()
    })

    test('Pending tool shows spinner', () => {
      render(<ToolCard toolUse={makeToolUse({ status: 'pending', endTime: undefined })} />)
      expect(screen.getByTestId('tool-spinner')).toBeInTheDocument()
    })

    test('Running tool shows spinner', () => {
      render(<ToolCard toolUse={makeToolUse({ status: 'running', endTime: undefined })} />)
      expect(screen.getByTestId('tool-spinner')).toBeInTheDocument()
    })

    test('Completed tool shows checkmark', () => {
      render(<ToolCard toolUse={makeToolUse({ status: 'success' })} />)
      expect(screen.getByTestId('tool-success')).toBeInTheDocument()
    })

    test('Failed tool shows error', () => {
      render(<ToolCard toolUse={makeToolUse({ status: 'error', error: 'File not found' })} />)
      expect(screen.getByTestId('tool-error')).toBeInTheDocument()
    })

    test('Tool cards are collapsible', async () => {
      const user = userEvent.setup()
      render(
        <ToolCard
          toolUse={makeToolUse({
            output: 'File contents here...'
          })}
        />
      )

      // Compact file tool uses conditional rendering — output not present initially
      expect(screen.queryByTestId('tool-output')).not.toBeInTheDocument()

      // Click the button inside compact-file-tool to expand
      const compactCard = screen.getByTestId('compact-file-tool')
      const button = compactCard.querySelector('button')!
      await user.click(button)
      expect(screen.getByTestId('tool-output')).toBeInTheDocument()

      // Click again to collapse
      await user.click(button)
      expect(screen.queryByTestId('tool-output')).not.toBeInTheDocument()
    })

    test('Execution time displayed', () => {
      // Use Bash tool which still renders the regular card layout with duration
      const startTime = Date.now() - 45
      const endTime = Date.now()
      render(
        <ToolCard
          toolUse={makeToolUse({ name: 'Bash', input: { command: 'ls' }, startTime, endTime })}
        />
      )
      expect(screen.getByTestId('tool-duration')).toBeInTheDocument()
      // Should show something like "45ms"
      expect(screen.getByTestId('tool-duration').textContent).toMatch(/\d+ms/)
    })

    test('Read tool shows file path', () => {
      render(
        <ToolCard
          toolUse={makeToolUse({
            name: 'Read',
            input: { file_path: '/src/components/App.tsx' }
          })}
        />
      )
      expect(screen.getByText(/App\.tsx/)).toBeInTheDocument()
    })

    test('Bash tool shows command', () => {
      render(
        <ToolCard
          toolUse={makeToolUse({
            name: 'Bash',
            input: { command: 'npm run build' }
          })}
        />
      )
      expect(screen.getAllByText('npm run build').length).toBeGreaterThan(0)
    })

    test('Edit tool shows file path', () => {
      render(
        <ToolCard
          toolUse={makeToolUse({
            name: 'Edit',
            input: { file_path: '/src/utils/helpers.ts' }
          })}
        />
      )
      expect(screen.getByText(/helpers\.ts/)).toBeInTheDocument()
    })

    test('Grep tool shows pattern', () => {
      render(
        <ToolCard
          toolUse={makeToolUse({
            name: 'Grep',
            input: { pattern: 'useEffect' }
          })}
        />
      )
      expect(screen.getByText(/useEffect/)).toBeInTheDocument()
    })

    test('Glob tool shows pattern', () => {
      render(
        <ToolCard
          toolUse={makeToolUse({
            name: 'Glob',
            input: { pattern: '**/*.tsx' }
          })}
        />
      )
      expect(screen.getByText('**/*.tsx')).toBeInTheDocument()
    })

    test('Error tool shows error message when expanded', async () => {
      const user = userEvent.setup()
      render(
        <ToolCard
          toolUse={makeToolUse({
            status: 'error',
            error: 'Permission denied: /etc/shadow'
          })}
        />
      )

      // Compact file tool — click the button inside compact-file-tool
      const compactCard = screen.getByTestId('compact-file-tool')
      const button = compactCard.querySelector('button')!
      await user.click(button)
      expect(screen.getByText('Permission denied: /etc/shadow')).toBeInTheDocument()
    })

    test('Long output is truncated', async () => {
      const user = userEvent.setup()
      // Line-based truncation: output must exceed 10 lines
      const longOutput = Array.from({ length: 50 }, (_, i) => `Line ${i + 1}: output`).join('\n')
      render(<ToolCard toolUse={makeToolUse({ output: longOutput })} />)

      // Compact file tool — click the button inside compact-file-tool
      const compactCard = screen.getByTestId('compact-file-tool')
      const button = compactCard.querySelector('button')!
      await user.click(button)
      // ReadToolView truncates with "Show all".
      expect(screen.getByTestId('show-all-button')).toBeInTheDocument()
      expect(screen.getByTestId('show-all-button').textContent).toContain('Show all')
    })

    test('Tool card has correct data attributes', () => {
      render(<ToolCard toolUse={makeToolUse({ name: 'Read', status: 'success' })} />)
      // Read is a file tool → compact layout
      const card = screen.getByTestId('compact-file-tool')
      expect(card).toHaveAttribute('data-tool-name', 'Read')
      expect(card).toHaveAttribute('data-tool-status', 'success')
    })

    test('Error tool card has error styling', () => {
      render(<ToolCard toolUse={makeToolUse({ status: 'error', error: 'Failed' })} />)
      // Compact file tool — check data-tool-status for error state
      const card = screen.getByTestId('compact-file-tool')
      expect(card).toHaveAttribute('data-tool-status', 'error')
      // The file path span should have text-red-400 class for errors
      const pathSpan = card.querySelector('span.font-mono')
      expect(pathSpan?.className).toContain('text-red-400')
    })
  })

  describe('StreamingCursor Component', () => {
    test('Streaming cursor renders', () => {
      render(<StreamingCursor />)
      expect(screen.getByTestId('streaming-cursor')).toBeInTheDocument()
    })

    test('Streaming cursor has pulse animation', () => {
      render(<StreamingCursor />)
      const cursor = screen.getByTestId('streaming-cursor')
      expect(cursor.className).toContain('animate-pulse')
    })
  })

  describe('AssistantCanvas with Parts', () => {
    test('AssistantCanvas renders text parts', () => {
      const parts: StreamingPart[] = [{ type: 'text', text: 'Hello, here is some text.' }]
      render(
        <AssistantCanvas
          content="Hello, here is some text."
          timestamp={new Date().toISOString()}
          parts={parts}
        />
      )
      expect(screen.getByText('Hello, here is some text.')).toBeInTheDocument()
    })

    test('AssistantCanvas renders tool card parts', () => {
      const parts: StreamingPart[] = [
        { type: 'text', text: 'Let me read the file.' },
        {
          type: 'tool_use',
          toolUse: {
            id: 'tool-1',
            name: 'Read',
            input: { file_path: '/src/main.ts' },
            status: 'success',
            startTime: Date.now() - 50,
            endTime: Date.now()
          }
        }
      ]
      render(
        <AssistantCanvas
          content="Let me read the file."
          timestamp={new Date().toISOString()}
          parts={parts}
        />
      )
      expect(screen.getByText('Let me read the file.')).toBeInTheDocument()
      // Read is a file tool → compact layout
      expect(screen.getByTestId('compact-file-tool')).toBeInTheDocument()
    })

    test('AssistantCanvas handles interleaved text and tool messages', () => {
      const parts: StreamingPart[] = [
        { type: 'text', text: 'First, let me check the file.' },
        {
          type: 'tool_use',
          toolUse: {
            id: 'tool-1',
            name: 'Read',
            input: { file_path: '/src/main.ts' },
            status: 'success',
            startTime: Date.now() - 100,
            endTime: Date.now() - 50
          }
        },
        { type: 'text', text: 'Now let me edit it.' },
        {
          type: 'tool_use',
          toolUse: {
            id: 'tool-2',
            name: 'Edit',
            input: { file_path: '/src/main.ts' },
            status: 'running',
            startTime: Date.now()
          }
        }
      ]
      render(
        <AssistantCanvas
          content="First, let me check the file.Now let me edit it."
          timestamp={new Date().toISOString()}
          parts={parts}
        />
      )

      expect(screen.getByText('First, let me check the file.')).toBeInTheDocument()
      expect(screen.getByText('Now let me edit it.')).toBeInTheDocument()
      // Both Read and Edit are file tools → compact layout
      const compactTools = screen.getAllByTestId('compact-file-tool')
      expect(compactTools).toHaveLength(2)
    })

    test('Two consecutive tool calls render compact cards without grouping', () => {
      const parts: StreamingPart[] = [
        {
          type: 'tool_use',
          toolUse: {
            id: 'tool-1',
            name: 'Read',
            input: { file_path: '/src/a.ts' },
            status: 'success',
            startTime: Date.now() - 100,
            endTime: Date.now() - 50
          }
        },
        {
          type: 'tool_use',
          toolUse: {
            id: 'tool-2',
            name: 'Edit',
            input: { file_path: '/src/b.ts' },
            status: 'success',
            startTime: Date.now() - 40,
            endTime: Date.now()
          }
        }
      ]

      render(<AssistantCanvas content="" timestamp={new Date().toISOString()} parts={parts} />)

      expect(screen.getByTestId('tool-call-inline-group')).toBeInTheDocument()
      expect(screen.queryByTestId('tool-call-group')).not.toBeInTheDocument()
      // Both Read and Edit are file tools → compact layout (no my-0 class on compact cards)
      const compactTools = screen.getAllByTestId('compact-file-tool')
      expect(compactTools).toHaveLength(2)
    })

    test('Whitespace text between consecutive tool calls does not create visual gaps', () => {
      const parts: StreamingPart[] = [
        {
          type: 'tool_use',
          toolUse: {
            id: 'tool-1',
            name: 'Read',
            input: { file_path: '/src/a.ts' },
            status: 'success',
            startTime: Date.now() - 100,
            endTime: Date.now() - 50
          }
        },
        { type: 'text', text: '\n\n   \n' },
        {
          type: 'tool_use',
          toolUse: {
            id: 'tool-2',
            name: 'Edit',
            input: { file_path: '/src/b.ts' },
            status: 'success',
            startTime: Date.now() - 40,
            endTime: Date.now()
          }
        }
      ]

      render(<AssistantCanvas content="" timestamp={new Date().toISOString()} parts={parts} />)

      expect(screen.getByTestId('tool-call-inline-group')).toBeInTheDocument()
      // Both Read and Edit are file tools → compact layout
      const compactTools = screen.getAllByTestId('compact-file-tool')
      expect(compactTools).toHaveLength(2)
      // No markdown paragraph should render for whitespace-only text parts.
      expect(screen.getByTestId('message-assistant').querySelectorAll('p').length).toBe(0)
    })

    test('Zero-width text between consecutive tool calls does not break compact grouping', () => {
      const parts: StreamingPart[] = [
        {
          type: 'tool_use',
          toolUse: {
            id: 'tool-1',
            name: 'Read',
            input: { file_path: '/src/a.ts' },
            status: 'success',
            startTime: Date.now() - 100,
            endTime: Date.now() - 50
          }
        },
        { type: 'text', text: '\u200B\u200C\uFEFF' },
        {
          type: 'tool_use',
          toolUse: {
            id: 'tool-2',
            name: 'Edit',
            input: { file_path: '/src/b.ts' },
            status: 'success',
            startTime: Date.now() - 40,
            endTime: Date.now()
          }
        }
      ]

      render(<AssistantCanvas content="" timestamp={new Date().toISOString()} parts={parts} />)

      expect(screen.getByTestId('tool-call-inline-group')).toBeInTheDocument()
      // Both Read and Edit are file tools → compact layout
      expect(screen.getAllByTestId('compact-file-tool')).toHaveLength(2)
      expect(screen.getByTestId('message-assistant').querySelectorAll('p').length).toBe(0)
    })

    test('Tool-only assistant messages use compact vertical spacing', () => {
      const parts: StreamingPart[] = [
        {
          type: 'tool_use',
          toolUse: {
            id: 'tool-1',
            name: 'Read',
            input: { file_path: '/src/main.ts' },
            status: 'success',
            startTime: Date.now() - 100,
            endTime: Date.now()
          }
        }
      ]

      render(<AssistantCanvas content="" timestamp={new Date().toISOString()} parts={parts} />)

      const assistantCanvas = screen.getByTestId('message-assistant')
      expect(assistantCanvas.className.split(/\s+/)).toContain('py-1')

      // Read is a file tool → compact layout (no my-0 class assertion)
      expect(screen.getByTestId('compact-file-tool')).toBeInTheDocument()
    })

    test('Assistant messages that include tools and text still use compact vertical spacing', () => {
      const parts: StreamingPart[] = [
        { type: 'text', text: 'Running quick checks.' },
        {
          type: 'tool_use',
          toolUse: {
            id: 'tool-1',
            name: 'Grep',
            input: { pattern: 'def foo' },
            status: 'success',
            startTime: Date.now() - 80,
            endTime: Date.now()
          }
        }
      ]

      render(<AssistantCanvas content="" timestamp={new Date().toISOString()} parts={parts} />)

      const assistantCanvas = screen.getByTestId('message-assistant')
      expect(assistantCanvas.className.split(/\s+/)).toContain('py-1')
    })

    test('Assistant messages without tools keep standard vertical spacing', () => {
      const parts: StreamingPart[] = [
        { type: 'text', text: 'Just a normal assistant text response.' }
      ]

      render(
        <AssistantCanvas
          content="Just a normal assistant text response."
          timestamp={new Date().toISOString()}
          parts={parts}
        />
      )

      const assistantCanvas = screen.getByTestId('message-assistant')
      expect(assistantCanvas.className.split(/\s+/)).toContain('py-5')
    })

    test('AssistantCanvas collapses 3+ consecutive tool calls into compact group', () => {
      const parts: StreamingPart[] = [
        { type: 'text', text: 'Running tools...' },
        {
          type: 'tool_use',
          toolUse: {
            id: 'tool-1',
            name: 'Read',
            input: { file_path: '/src/a.ts' },
            status: 'success',
            startTime: Date.now() - 200,
            endTime: Date.now() - 150
          }
        },
        {
          type: 'tool_use',
          toolUse: {
            id: 'tool-2',
            name: 'Read',
            input: { file_path: '/src/b.ts' },
            status: 'success',
            startTime: Date.now() - 140,
            endTime: Date.now() - 90
          }
        },
        {
          type: 'tool_use',
          toolUse: {
            id: 'tool-3',
            name: 'Edit',
            input: { file_path: '/src/c.ts' },
            status: 'success',
            startTime: Date.now() - 80,
            endTime: Date.now() - 40
          }
        }
      ]

      render(
        <AssistantCanvas
          content="Running tools..."
          timestamp={new Date().toISOString()}
          parts={parts}
        />
      )

      expect(screen.getByTestId('tool-call-group')).toBeInTheDocument()
      // Collapsed by default — neither compact-file-tool nor tool-card should be visible
      expect(screen.queryByTestId('compact-file-tool')).not.toBeInTheDocument()
      expect(screen.queryByTestId('tool-card')).not.toBeInTheDocument()
    })

    test('Tool call group expands to show individual tool cards', async () => {
      const user = userEvent.setup()
      const parts: StreamingPart[] = [
        {
          type: 'tool_use',
          toolUse: {
            id: 'tool-1',
            name: 'Read',
            input: { file_path: '/src/a.ts' },
            status: 'success',
            startTime: Date.now() - 200,
            endTime: Date.now() - 150
          }
        },
        {
          type: 'tool_use',
          toolUse: {
            id: 'tool-2',
            name: 'Read',
            input: { file_path: '/src/b.ts' },
            status: 'success',
            startTime: Date.now() - 140,
            endTime: Date.now() - 90
          }
        },
        {
          type: 'tool_use',
          toolUse: {
            id: 'tool-3',
            name: 'Bash',
            input: { command: 'pnpm test' },
            status: 'running',
            startTime: Date.now() - 80
          }
        }
      ]

      render(<AssistantCanvas content="" timestamp={new Date().toISOString()} parts={parts} />)

      await user.click(screen.getByTestId('tool-call-group-header'))
      // After expanding: 2 Read (compact-file-tool) + 1 Bash (tool-card)
      const fileTools = screen.getAllByTestId('compact-file-tool')
      const cardTools = screen.getAllByTestId('tool-card')
      expect(fileTools.length + cardTools.length).toBe(3)
    })

    test('AssistantCanvas shows streaming cursor when streaming', () => {
      const parts: StreamingPart[] = [{ type: 'text', text: 'I am thinking...' }]
      render(
        <AssistantCanvas
          content="I am thinking..."
          timestamp={new Date().toISOString()}
          isStreaming={true}
          parts={parts}
        />
      )
      expect(screen.getByTestId('streaming-cursor')).toBeInTheDocument()
    })

    test('AssistantCanvas falls back to content when no parts', () => {
      render(
        <AssistantCanvas content="Plain assistant response" timestamp={new Date().toISOString()} />
      )
      expect(screen.getByText('Plain assistant response')).toBeInTheDocument()
    })

    test('Streaming text accumulates correctly in parts', () => {
      const parts: StreamingPart[] = [
        { type: 'text', text: 'Hello ' },
        {
          type: 'tool_use',
          toolUse: {
            id: 'tool-1',
            name: 'Read',
            input: {},
            status: 'success',
            startTime: Date.now() - 50,
            endTime: Date.now()
          }
        },
        { type: 'text', text: 'World' }
      ]
      render(
        <AssistantCanvas content="Hello World" timestamp={new Date().toISOString()} parts={parts} />
      )
      expect(screen.getByText(/Hello/)).toBeInTheDocument()
      expect(screen.getByText(/World/)).toBeInTheDocument()
    })
  })

  describe('MessageRenderer with Tool Messages', () => {
    test('MessageRenderer passes parts to AssistantCanvas', () => {
      const message: OpenCodeMessage = {
        id: 'msg-1',
        role: 'assistant',
        content: 'Reading file...',
        timestamp: new Date().toISOString(),
        parts: [
          { type: 'text', text: 'Reading file...' },
          {
            type: 'tool_use',
            toolUse: {
              id: 'tool-1',
              name: 'Read',
              input: { file_path: '/test.ts' },
              status: 'success',
              startTime: Date.now() - 30,
              endTime: Date.now()
            }
          }
        ]
      }
      render(<MessageRenderer message={message} />)

      expect(screen.getByTestId('message-assistant')).toBeInTheDocument()
      // Read is a file tool → compact layout
      expect(screen.getByTestId('compact-file-tool')).toBeInTheDocument()
    })

    test('User messages are unaffected by tool rendering', () => {
      const message: OpenCodeMessage = {
        id: 'msg-1',
        role: 'user',
        content: 'Please read the file',
        timestamp: new Date().toISOString()
      }
      render(<MessageRenderer message={message} />)

      expect(screen.getByTestId('message-user')).toBeInTheDocument()
      expect(screen.queryByTestId('tool-card')).not.toBeInTheDocument()
    })

    test('User and assistant message timestamps are not displayed', () => {
      const timestamp = '2026-02-09T12:34:56.000Z'
      const renderedTime = new Date(timestamp).toLocaleTimeString()

      const userMessage: OpenCodeMessage = {
        id: 'user-1',
        role: 'user',
        content: 'Hello',
        timestamp
      }
      const assistantMessage: OpenCodeMessage = {
        id: 'assistant-1',
        role: 'assistant',
        content: 'Hi there',
        timestamp
      }

      const { rerender } = render(<MessageRenderer message={userMessage} />)
      expect(screen.getByTestId('message-user').textContent).not.toContain(renderedTime)

      rerender(<MessageRenderer message={assistantMessage} />)
      expect(screen.getByTestId('message-assistant').textContent).not.toContain(renderedTime)
    })
  })

  describe('Tool Status States', () => {
    test('All four status states render correctly', () => {
      const statuses = ['pending', 'running', 'success', 'error'] as const
      const { unmount } = render(<div />)
      unmount()

      for (const status of statuses) {
        const { unmount: u } = render(
          <ToolCard
            toolUse={{
              id: `tool-${status}`,
              name: 'Read',
              input: {},
              status,
              startTime: Date.now(),
              ...(status === 'error' ? { error: 'Failed' } : {}),
              ...(status === 'success' ? { endTime: Date.now() } : {})
            }}
          />
        )
        // Read is a file tool → compact layout
        expect(screen.getByTestId('compact-file-tool')).toHaveAttribute('data-tool-status', status)
        u()
      }
    })
  })

  describe('Tool Icons', () => {
    test('Different tool types get different icons', () => {
      const FILE_TOOLS = new Set(['Read', 'Write', 'Edit'])
      const toolNames = ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep']

      for (const name of toolNames) {
        const { unmount } = render(
          <ToolCard
            toolUse={{
              id: `tool-${name}`,
              name,
              input: {},
              status: 'success',
              startTime: Date.now(),
              endTime: Date.now()
            }}
          />
        )
        // File tools use compact layout, others use regular card layout
        const card = FILE_TOOLS.has(name)
          ? screen.getByTestId('compact-file-tool')
          : screen.getByTestId('tool-card')
        const svgs = card.querySelectorAll('svg')
        expect(svgs.length).toBeGreaterThan(0)
        unmount()
      }
    })
  })

  describe('Performance', () => {
    test('Tool messages render within 50ms', () => {
      const parts: StreamingPart[] = []
      // Create 10 tool uses
      for (let i = 0; i < 10; i++) {
        parts.push({
          type: 'tool_use',
          toolUse: {
            id: `tool-${i}`,
            name: 'Read',
            input: { file_path: `/src/file-${i}.ts` },
            status: 'success',
            startTime: Date.now() - 100,
            endTime: Date.now()
          }
        })
      }

      const start = performance.now()
      render(<AssistantCanvas content="" timestamp={new Date().toISOString()} parts={parts} />)
      const elapsed = performance.now() - start

      expect(elapsed).toBeLessThan(50)
      expect(screen.getByTestId('tool-call-group')).toBeInTheDocument()
    })
  })
})
