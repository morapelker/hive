import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { act } from 'react'

// -----------------------------------------------------------------------------
// Test strategy: Option B — mount the real SessionStreamPanel with
// useSessionStream mocked. This exercises the actual integration site in
// SessionStreamPanel (import, useMemo streaming message, useLatestTodoList,
// TaskListWidget render gate) rather than a stand-in harness. The mock is
// tiny (~10 lines) and the hook has no side effects on the rendered subtree
// once its return value is fixed.
// -----------------------------------------------------------------------------

type MockStreamResult = {
  messages: unknown[]
  streamingParts: unknown[]
  streamingContent: string
  isStreaming: boolean
  isLoading: boolean
}

const mockReturnRef: { current: MockStreamResult } = {
  current: {
    messages: [],
    streamingParts: [],
    streamingContent: '',
    isStreaming: false,
    isLoading: false
  }
}

vi.mock('@/hooks/useSessionStream', () => ({
  useSessionStream: () => mockReturnRef.current
}))

// Mock MessageRenderer to keep the test focused on widget gating (MessageRenderer
// itself has heavy dependencies on stores, theming, etc.).
vi.mock('@/components/sessions/MessageRenderer', () => ({
  MessageRenderer: ({ message }: { message: { id: string } }) => (
    <div data-testid={`message-${message.id}`} />
  )
}))

// Mock ScrollToBottomFab — irrelevant to this test but pulls in icons etc.
vi.mock('@/components/sessions/ScrollToBottomFab', () => ({
  ScrollToBottomFab: () => null
}))

import { SessionStreamPanel } from '@/components/kanban/SessionStreamPanel'
import { useSettingsStore } from '@/stores/useSettingsStore'
import type {
  OpenCodeMessage,
  StreamingPart
} from '@/components/sessions/SessionView'
import type { TodoItem } from '@/components/sessions/tools/todoIcons'

const originalSettingsState = useSettingsStore.getState()

function setMockStream(partial: Partial<MockStreamResult>): void {
  mockReturnRef.current = {
    messages: [],
    streamingParts: [],
    streamingContent: '',
    isStreaming: false,
    isLoading: false,
    ...partial
  }
}

function makeTodo(
  id: string,
  content: string,
  status: TodoItem['status'] = 'pending',
  priority: TodoItem['priority'] = 'medium'
): TodoItem {
  return { id, content, status, priority }
}

function makeTodoWritePart(todos: TodoItem[]): StreamingPart {
  return {
    type: 'tool_use',
    toolUse: {
      id: 'tool-todo-1',
      name: 'TodoWrite',
      input: { todos } as unknown as Record<string, unknown>,
      status: 'success',
      startTime: 0
    }
  }
}

function makeTextPart(text: string): StreamingPart {
  return { type: 'text', text }
}

function makeMessage(id: string, parts: StreamingPart[]): OpenCodeMessage {
  return {
    id,
    role: 'assistant',
    content: '',
    timestamp: new Date(0).toISOString(),
    parts
  }
}

function renderPanel(): ReturnType<typeof render> {
  return render(
    <SessionStreamPanel
      sessionId="session-1"
      worktreePath="/tmp/wt"
      opencodeSessionId="opc-1"
    />
  )
}

describe('SessionStreamPanel TaskListWidget integration', () => {
  beforeEach(() => {
    // jsdom doesn't implement Element.scrollIntoView — SessionStreamPanel's
    // auto-scroll effect calls it unconditionally once messages are present.
    if (typeof Element.prototype.scrollIntoView !== 'function') {
      Element.prototype.scrollIntoView = vi.fn()
    }

    // Reset the mock stream result + settings store to a clean baseline.
    setMockStream({})
    act(() => {
      useSettingsStore.setState({
        ...originalSettingsState,
        taskListCollapsed: false
      })
    })
  })

  afterEach(() => {
    cleanup()
    act(() => {
      useSettingsStore.setState(originalSettingsState)
    })
  })

  it('does not render TaskListWidget when messages contain no TodoWrite', () => {
    setMockStream({
      messages: [makeMessage('m1', [makeTextPart('hello world')])]
    })

    renderPanel()

    expect(screen.queryByTestId('task-list-widget')).not.toBeInTheDocument()
  })

  it('does not render TaskListWidget when the latest TodoWrite is all completed or cancelled', () => {
    setMockStream({
      messages: [
        makeMessage('m1', [
          makeTodoWritePart([
            makeTodo('a', 'one', 'completed'),
            makeTodo('b', 'two', 'cancelled'),
            makeTodo('c', 'three', 'completed')
          ])
        ])
      ]
    })

    renderPanel()

    expect(screen.queryByTestId('task-list-widget')).not.toBeInTheDocument()
  })

  it('renders TaskListWidget when the latest TodoWrite has any pending or in_progress todo', () => {
    setMockStream({
      messages: [
        makeMessage('m1', [
          makeTodoWritePart([
            makeTodo('a', 'Done one', 'completed'),
            makeTodo('b', 'Still working', 'in_progress'),
            makeTodo('c', 'Queued', 'pending')
          ])
        ])
      ]
    })

    renderPanel()

    const widget = screen.getByTestId('task-list-widget')
    expect(widget).toBeInTheDocument()
  })

  it('positions the widget at the 16px baseline (BASELINE_TOP_PX)', () => {
    setMockStream({
      messages: [
        makeMessage('m1', [
          makeTodoWritePart([makeTodo('a', 'Pending item', 'pending')])
        ])
      ]
    })

    renderPanel()

    const widget = screen.getByTestId('task-list-widget')
    // Design decision: inside the kanban ticket modal we always use the 16px
    // baseline — we do NOT call usePRStackTopOffset because the PR stack is
    // hidden behind the modal backdrop.
    expect(widget.style.top).toBe('16px')
  })
})
