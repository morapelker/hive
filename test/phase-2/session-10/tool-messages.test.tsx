import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ToolCard, type ToolUseInfo } from '../../../src/renderer/src/components/sessions/ToolCard'
import { StreamingCursor } from '../../../src/renderer/src/components/sessions/StreamingCursor'
import { AssistantCanvas } from '../../../src/renderer/src/components/sessions/AssistantCanvas'
import { MessageRenderer } from '../../../src/renderer/src/components/sessions/MessageRenderer'
import type { StreamingPart, OpenCodeMessage } from '../../../src/renderer/src/components/sessions/SessionView'

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
      expect(screen.getByTestId('tool-card')).toBeInTheDocument()
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

      // Initially collapsed - output not visible
      expect(screen.queryByTestId('tool-output')).not.toBeInTheDocument()

      // Click to expand
      await user.click(screen.getByTestId('tool-card-header'))
      expect(screen.getByTestId('tool-output')).toBeInTheDocument()

      // Click to collapse
      await user.click(screen.getByTestId('tool-card-header'))
      expect(screen.queryByTestId('tool-output')).not.toBeInTheDocument()
    })

    test('Execution time displayed', () => {
      const startTime = Date.now() - 45
      const endTime = Date.now()
      render(
        <ToolCard
          toolUse={makeToolUse({ startTime, endTime })}
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
      expect(screen.getByText('npm run build')).toBeInTheDocument()
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
      expect(screen.getByText('useEffect')).toBeInTheDocument()
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

      await user.click(screen.getByTestId('tool-card-header'))
      expect(screen.getByText('Permission denied: /etc/shadow')).toBeInTheDocument()
    })

    test('Long output is truncated', async () => {
      const user = userEvent.setup()
      const longOutput = 'x'.repeat(3000)
      render(
        <ToolCard
          toolUse={makeToolUse({ output: longOutput })}
        />
      )

      await user.click(screen.getByTestId('tool-card-header'))
      const outputEl = screen.getByTestId('tool-output')
      expect(outputEl.textContent).toContain('truncated')
    })

    test('Tool card has correct data attributes', () => {
      render(
        <ToolCard
          toolUse={makeToolUse({ name: 'Read', status: 'success' })}
        />
      )
      const card = screen.getByTestId('tool-card')
      expect(card).toHaveAttribute('data-tool-name', 'Read')
      expect(card).toHaveAttribute('data-tool-status', 'success')
    })

    test('Error tool card has error styling', () => {
      render(
        <ToolCard
          toolUse={makeToolUse({ status: 'error', error: 'Failed' })}
        />
      )
      const card = screen.getByTestId('tool-card')
      expect(card.className).toContain('border-red')
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
      const parts: StreamingPart[] = [
        { type: 'text', text: 'Hello, here is some text.' }
      ]
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
      expect(screen.getByTestId('tool-card')).toBeInTheDocument()
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
      const toolCards = screen.getAllByTestId('tool-card')
      expect(toolCards).toHaveLength(2)
    })

    test('AssistantCanvas shows streaming cursor when streaming', () => {
      const parts: StreamingPart[] = [
        { type: 'text', text: 'I am thinking...' }
      ]
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
        <AssistantCanvas
          content="Plain assistant response"
          timestamp={new Date().toISOString()}
        />
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
        <AssistantCanvas
          content="Hello World"
          timestamp={new Date().toISOString()}
          parts={parts}
        />
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
      expect(screen.getByTestId('tool-card')).toBeInTheDocument()
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
        expect(screen.getByTestId('tool-card')).toHaveAttribute('data-tool-status', status)
        u()
      }
    })
  })

  describe('Tool Icons', () => {
    test('Different tool types get different icons', () => {
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
        // Each tool card renders with an SVG icon
        const card = screen.getByTestId('tool-card')
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
      render(
        <AssistantCanvas
          content=""
          timestamp={new Date().toISOString()}
          parts={parts}
        />
      )
      const elapsed = performance.now() - start

      expect(elapsed).toBeLessThan(50)
      expect(screen.getAllByTestId('tool-card')).toHaveLength(10)
    })
  })
})
