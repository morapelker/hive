import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { act, useMemo } from 'react'
import { TaskListWidget } from '@/components/sessions/TaskListWidget'
import { useLatestTodoList } from '@/components/sessions/useLatestTodoList'
import { usePRStackTopOffset } from '@/components/sessions/usePRStackTopOffset'
import { usePRNotificationStore } from '@/stores/usePRNotificationStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import type {
  OpenCodeMessage,
  StreamingPart
} from '@/components/sessions/SessionView'
import type { TodoItem } from '@/components/sessions/tools/todoIcons'

// -----------------------------------------------------------------------------
// Test strategy: Option A — lightweight observation wrapper.
//
// Rendering the full SessionView would require ~20 mocks (IPC, routing, many
// stores, etc.). Instead this wrapper mirrors the integration site's wiring:
//   * feeds visibleMessages/streamingMessage into useLatestTodoList
//   * uses usePRStackTopOffset to compute the pixel offset from the measured
//     PR notification stack height
//   * conditionally renders <TaskListWidget> with the resulting topOffsetPx
// That proves the integration semantics (hook result + gating condition +
// measured offset) without needing SessionView itself.
// -----------------------------------------------------------------------------

// jsdom doesn't ship ResizeObserver — stub a minimal version so the measurement
// hook doesn't throw. Tests that want to simulate a size change can reach into
// `observers` and fire the callback manually.

const observers: MockResizeObserver[] = []

class MockResizeObserver {
  observe = vi.fn((target: Element) => {
    this.target = target
  })
  disconnect = vi.fn()
  unobserve = vi.fn()
  private callback: ResizeObserverCallback
  private target: Element | null = null

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback
    observers.push(this)
  }

  trigger(): void {
    if (!this.target) return
    this.callback(
      [
        {
          target: this.target,
          contentRect: this.target.getBoundingClientRect()
        } as ResizeObserverEntry
      ],
      this as unknown as ResizeObserver
    )
  }
}

// Module-level stable reference for the "not streaming" case — mirrors the
// EMPTY_MESSAGE_ARRAY constant used at the real render sites.
const EMPTY_MESSAGE_ARRAY: OpenCodeMessage[] = []

function TestHarness({
  messages,
  streaming = null,
  isStreaming = true
}: {
  messages: OpenCodeMessage[]
  streaming?: OpenCodeMessage | null
  isStreaming?: boolean
}): React.JSX.Element {
  // Mirror the real render sites: gate on isStreaming and only consider the
  // current turn (everything after the most recent user message).
  const currentTurnMessages = useMemo(() => {
    if (!isStreaming) return EMPTY_MESSAGE_ARRAY
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') {
        return messages.slice(i + 1)
      }
    }
    return messages
  }, [isStreaming, messages])

  const { todos: latestTodos, isIncomplete: latestTodosIncomplete } = useLatestTodoList(
    currentTurnMessages,
    streaming
  )
  const taskListTopOffsetPx = usePRStackTopOffset()

  return (
    <div>
      {latestTodos && latestTodosIncomplete && (
        <TaskListWidget todos={latestTodos} topOffsetPx={taskListTopOffsetPx} />
      )}
    </div>
  )
}

// -----------------------------------------------------------------------------
// Store / DOM helpers
// -----------------------------------------------------------------------------

const originalPRState = usePRNotificationStore.getState()
const originalSettingsState = useSettingsStore.getState()

function setPRNotifications(count: number): void {
  const notifications = Array.from({ length: count }, (_, i) => ({
    id: `pr-test-${i}`,
    status: 'info' as const,
    message: `Test notification ${i}`
  }))
  act(() => {
    usePRNotificationStore.setState({ notifications })
  })
}

/**
 * Mount a fake PR notification stack element with the given offsetHeight so the
 * usePRStackTopOffset hook's `document.querySelector` call finds it and
 * `.offsetHeight` returns a known value (jsdom returns 0 by default).
 */
function mountFakeStack(height: number): HTMLElement {
  const stack = document.createElement('div')
  stack.setAttribute('data-testid', 'pr-notification-stack')
  Object.defineProperty(stack, 'offsetHeight', {
    configurable: true,
    value: height
  })
  document.body.appendChild(stack)
  return stack
}

// -----------------------------------------------------------------------------
// Data builders
// -----------------------------------------------------------------------------

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

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe('TaskListWidget SessionView integration', () => {
  beforeEach(() => {
    observers.length = 0
    vi.stubGlobal('ResizeObserver', MockResizeObserver)
    act(() => {
      usePRNotificationStore.setState({ ...originalPRState, notifications: [] })
      useSettingsStore.setState({ ...originalSettingsState, taskListCollapsed: false })
    })
  })

  afterEach(() => {
    cleanup()
    // Clean out any fake stack elements between tests.
    document.body.innerHTML = ''
    vi.unstubAllGlobals()
    act(() => {
      usePRNotificationStore.setState(originalPRState)
      useSettingsStore.setState(originalSettingsState)
    })
  })

  it('does not render TaskListWidget when visibleMessages has no TodoWrite', () => {
    const messages: OpenCodeMessage[] = [makeMessage('m1', [makeTextPart('hello world')])]

    render(<TestHarness messages={messages} />)

    expect(screen.queryByTestId('task-list-widget')).not.toBeInTheDocument()
  })

  it('does not render TaskListWidget when the latest TodoWrite is all completed or cancelled', () => {
    const allDoneMessages: OpenCodeMessage[] = [
      makeMessage('m1', [
        makeTodoWritePart([
          makeTodo('a', 'one', 'completed'),
          makeTodo('b', 'two', 'cancelled'),
          makeTodo('c', 'three', 'completed')
        ])
      ])
    ]

    const { unmount } = render(<TestHarness messages={allDoneMessages} />)
    expect(screen.queryByTestId('task-list-widget')).not.toBeInTheDocument()
    unmount()

    // All cancelled
    const allCancelled: OpenCodeMessage[] = [
      makeMessage('m1', [
        makeTodoWritePart([
          makeTodo('a', 'one', 'cancelled'),
          makeTodo('b', 'two', 'cancelled')
        ])
      ])
    ]
    const second = render(<TestHarness messages={allCancelled} />)
    expect(screen.queryByTestId('task-list-widget')).not.toBeInTheDocument()
    second.unmount()

    // All completed
    const allCompleted: OpenCodeMessage[] = [
      makeMessage('m1', [
        makeTodoWritePart([
          makeTodo('a', 'one', 'completed'),
          makeTodo('b', 'two', 'completed')
        ])
      ])
    ]
    render(<TestHarness messages={allCompleted} />)
    expect(screen.queryByTestId('task-list-widget')).not.toBeInTheDocument()
  })

  it('renders TaskListWidget when the latest TodoWrite has any pending or in_progress todo', () => {
    const messages: OpenCodeMessage[] = [
      makeMessage('m1', [
        makeTodoWritePart([
          makeTodo('a', 'Done one', 'completed'),
          makeTodo('b', 'Still working', 'in_progress'),
          makeTodo('c', 'Queued', 'pending')
        ])
      ])
    ]

    render(<TestHarness messages={messages} />)

    const widget = screen.getByTestId('task-list-widget')
    expect(widget).toBeInTheDocument()
  })

  it('does not render TaskListWidget when isStreaming is false, even with incomplete todos', () => {
    const messages: OpenCodeMessage[] = [
      makeMessage('m1', [
        makeTodoWritePart([
          makeTodo('a', 'Done one', 'completed'),
          makeTodo('b', 'Still working', 'in_progress'),
          makeTodo('c', 'Queued', 'pending')
        ])
      ])
    ]

    render(<TestHarness messages={messages} isStreaming={false} />)

    expect(screen.queryByTestId('task-list-widget')).not.toBeInTheDocument()
  })

  it('positions the widget at the 16px baseline when there are no PR notifications', () => {
    const messages: OpenCodeMessage[] = [
      makeMessage('m1', [makeTodoWritePart([makeTodo('a', 'Pending item', 'pending')])])
    ]

    setPRNotifications(0)
    render(<TestHarness messages={messages} />)
    const widget = screen.getByTestId('task-list-widget')
    expect(widget.style.top).toBe('16px')
  })

  it('positions the widget below the measured PR stack when notifications exist', () => {
    const messages: OpenCodeMessage[] = [
      makeMessage('m1', [makeTodoWritePart([makeTodo('a', 'Pending item', 'pending')])])
    ]

    // A PR stack that's 100px tall — e.g. a single card with a 2-line
    // description and an action row. `top-20` (=80px) alone would have put
    // the widget squarely on top of this stack; the new hook puts it below.
    mountFakeStack(100)
    setPRNotifications(1)
    render(<TestHarness messages={messages} />)
    const widget = screen.getByTestId('task-list-widget')
    // 16 (stack's own top-4) + 100 (measured height) + 8 (gap) = 124
    expect(widget.style.top).toBe('124px')
  })

  it('positions the widget well below a tall stack of multiple notifications (regression for fixed top-20)', () => {
    const messages: OpenCodeMessage[] = [
      makeMessage('m1', [makeTodoWritePart([makeTodo('a', 'Pending item', 'pending')])])
    ]

    // Three stacked notification cards — each ~72px + 8px gaps ≈ 232px.
    // The old `top-20` (=80px) constant would have put the widget roughly in
    // the middle of the stack; the measurement-based approach puts it cleanly
    // below the entire stack.
    mountFakeStack(232)
    setPRNotifications(3)
    render(<TestHarness messages={messages} />)
    const widget = screen.getByTestId('task-list-widget')
    // 16 + 232 + 8 = 256
    expect(widget.style.top).toBe('256px')
  })

  it('returns to the baseline offset when all notifications are dismissed', () => {
    const messages: OpenCodeMessage[] = [
      makeMessage('m1', [makeTodoWritePart([makeTodo('a', 'Pending item', 'pending')])])
    ]

    mountFakeStack(120)
    setPRNotifications(2)
    const { rerender } = render(<TestHarness messages={messages} />)
    expect(screen.getByTestId('task-list-widget').style.top).toBe('144px')

    // User dismisses all notifications.
    setPRNotifications(0)
    rerender(<TestHarness messages={messages} />)
    expect(screen.getByTestId('task-list-widget').style.top).toBe('16px')
  })
})
