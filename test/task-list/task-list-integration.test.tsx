import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { act } from 'react'
import { TaskListWidget } from '@/components/sessions/TaskListWidget'
import { useLatestTodoList } from '@/components/sessions/useLatestTodoList'
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
//   * selects prNotificationCount from usePRNotificationStore
//   * conditionally renders <TaskListWidget> with the same topOffsetClass logic
// That proves the integration semantics (hook result + gating condition +
// top-offset toggle) without needing SessionView itself.
// -----------------------------------------------------------------------------

function TestHarness({
  messages,
  streaming = null
}: {
  messages: OpenCodeMessage[]
  streaming?: OpenCodeMessage | null
}): React.JSX.Element {
  const { todos: latestTodos, isIncomplete: latestTodosIncomplete } = useLatestTodoList(
    messages,
    streaming
  )
  const prNotificationCount = usePRNotificationStore((s) => s.notifications.length)
  const taskListTopOffsetClass = prNotificationCount > 0 ? 'top-20' : 'top-4'

  return (
    <div>
      {latestTodos && latestTodosIncomplete && (
        <TaskListWidget todos={latestTodos} topOffsetClass={taskListTopOffsetClass} />
      )}
    </div>
  )
}

// -----------------------------------------------------------------------------
// Store helpers
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
    act(() => {
      usePRNotificationStore.setState({ ...originalPRState, notifications: [] })
      useSettingsStore.setState({ ...originalSettingsState, taskListCollapsed: false })
    })
  })

  afterEach(() => {
    cleanup()
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

  it('toggles topOffsetClass between top-4 (no PR notifications) and top-20 (>=1 PR notification)', () => {
    const messages: OpenCodeMessage[] = [
      makeMessage('m1', [
        makeTodoWritePart([makeTodo('a', 'Pending item', 'pending')])
      ])
    ]

    // Start with zero PR notifications → top-4
    setPRNotifications(0)
    const { rerender } = render(<TestHarness messages={messages} />)
    let widget = screen.getByTestId('task-list-widget')
    expect(widget.className).toContain('top-4')
    expect(widget.className).not.toContain('top-20')

    // One notification → top-20
    setPRNotifications(1)
    rerender(<TestHarness messages={messages} />)
    widget = screen.getByTestId('task-list-widget')
    expect(widget.className).toContain('top-20')
    expect(widget.className).not.toContain('top-4')

    // Several notifications → still top-20
    setPRNotifications(3)
    rerender(<TestHarness messages={messages} />)
    widget = screen.getByTestId('task-list-widget')
    expect(widget.className).toContain('top-20')

    // Back to zero → top-4 again
    setPRNotifications(0)
    rerender(<TestHarness messages={messages} />)
    widget = screen.getByTestId('task-list-widget')
    expect(widget.className).toContain('top-4')
    expect(widget.className).not.toContain('top-20')
  })
})
