import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { act } from 'react'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { TaskListWidget } from '@/components/sessions/TaskListWidget'
import type { TodoItem } from '@/components/sessions/tools/todoIcons'

// Snapshot the store's state before each test so we can restore it.
const originalState = useSettingsStore.getState()

function setCollapsed(value: boolean): void {
  act(() => {
    useSettingsStore.setState({ taskListCollapsed: value })
  })
}

function makeTodo(
  id: string,
  content: string,
  status: TodoItem['status'] = 'pending',
  priority: TodoItem['priority'] = 'medium'
): TodoItem {
  return { id, content, status, priority }
}

describe('TaskListWidget', () => {
  beforeEach(() => {
    // Reset the store to a clean baseline. We preserve the original action
    // implementations so clicks that call updateSetting actually work.
    act(() => {
      useSettingsStore.setState({
        ...originalState,
        taskListCollapsed: false
      })
    })
  })

  afterEach(() => {
    cleanup()
    act(() => {
      useSettingsStore.setState(originalState)
    })
  })

  it('renders the collapsed pill with counter when taskListCollapsed is true', () => {
    setCollapsed(true)
    const todos: TodoItem[] = [
      makeTodo('a', 'First', 'completed'),
      makeTodo('b', 'Second', 'pending'),
      makeTodo('c', 'Third', 'in_progress')
    ]

    render(<TaskListWidget todos={todos} topOffsetClass="top-4" />)

    const widget = screen.getByTestId('task-list-widget')
    expect(widget).toBeInTheDocument()

    const toggle = screen.getByTestId('task-list-widget-toggle')
    expect(toggle).toHaveTextContent('1/3')

    // Body rows are not in the DOM when collapsed
    expect(screen.queryByText('First')).not.toBeInTheDocument()
    expect(screen.queryByText('Second')).not.toBeInTheDocument()
    expect(screen.queryByText('Third')).not.toBeInTheDocument()

    // "Tasks" header should not be present in collapsed state
    expect(screen.queryByText('Tasks')).not.toBeInTheDocument()
  })

  it('renders the expanded header, counter and all todo rows when taskListCollapsed is false', () => {
    setCollapsed(false)
    const todos: TodoItem[] = [
      makeTodo('a', 'First task', 'completed'),
      makeTodo('b', 'Second task', 'in_progress'),
      makeTodo('c', 'Third task', 'pending')
    ]

    render(<TaskListWidget todos={todos} topOffsetClass="top-4" />)

    const widget = screen.getByTestId('task-list-widget')
    expect(widget).toBeInTheDocument()

    // Header shows "Tasks"
    expect(screen.getByText('Tasks')).toBeInTheDocument()

    // Header toggle shows counter
    const toggle = screen.getByTestId('task-list-widget-toggle')
    expect(toggle).toHaveTextContent('1/3')

    // All rows are rendered in the body
    expect(screen.getByText('First task')).toBeInTheDocument()
    expect(screen.getByText('Second task')).toBeInTheDocument()
    expect(screen.getByText('Third task')).toBeInTheDocument()
  })

  it('renders the correct status icon for each status (by lucide color class)', () => {
    setCollapsed(false)
    const todos: TodoItem[] = [
      makeTodo('a', 'Completed', 'completed'),
      makeTodo('b', 'In progress', 'in_progress'),
      makeTodo('c', 'Cancelled', 'cancelled'),
      makeTodo('d', 'Pending', 'pending')
    ]

    const { container } = render(<TaskListWidget todos={todos} topOffsetClass="top-4" />)

    // completed → CircleCheck with text-green-500
    expect(container.querySelector('.text-green-500')).not.toBeNull()
    // in_progress → CircleDot with text-blue-500 AND animate-pulse
    expect(container.querySelector('.animate-pulse')).not.toBeNull()
    // cancelled → CircleX with text-muted-foreground/50 (also shared with completed strikethrough span;
    // we match on the combined shrink-0 icon class which is unique to the status icons)
    expect(container.querySelectorAll('.shrink-0').length).toBeGreaterThanOrEqual(4)
    // pending → Circle with text-muted-foreground/40 (unique class)
    expect(container.querySelector('.text-muted-foreground\\/40')).not.toBeNull()
  })

  it('renders the correct priority chevron for each priority', () => {
    setCollapsed(false)
    const todos: TodoItem[] = [
      makeTodo('a', 'High pri', 'pending', 'high'),
      makeTodo('b', 'Medium pri', 'pending', 'medium'),
      makeTodo('c', 'Low pri', 'pending', 'low')
    ]

    const { container } = render(<TaskListWidget todos={todos} topOffsetClass="top-4" />)

    // high → ChevronsUp with text-red-500
    expect(container.querySelector('.text-red-500')).not.toBeNull()
    // medium → ChevronUp with text-amber-500
    expect(container.querySelector('.text-amber-500')).not.toBeNull()
    // low → ChevronDown with text-blue-500 (also possible via in_progress, but we have no in_progress here)
    expect(container.querySelector('.text-blue-500')).not.toBeNull()
  })

  it('applies strikethrough to completed and cancelled rows but not pending or in_progress', () => {
    setCollapsed(false)
    const todos: TodoItem[] = [
      makeTodo('a', 'Done item', 'completed'),
      makeTodo('b', 'Cancelled item', 'cancelled'),
      makeTodo('c', 'Pending item', 'pending'),
      makeTodo('d', 'In progress item', 'in_progress')
    ]

    render(<TaskListWidget todos={todos} topOffsetClass="top-4" />)

    const doneSpan = screen.getByText('Done item')
    expect(doneSpan.className).toContain('line-through')

    const cancelledSpan = screen.getByText('Cancelled item')
    expect(cancelledSpan.className).toContain('line-through')

    const pendingSpan = screen.getByText('Pending item')
    expect(pendingSpan.className).not.toContain('line-through')

    const inProgressSpan = screen.getByText('In progress item')
    expect(inProgressSpan.className).not.toContain('line-through')
  })

  it('clicking the collapsed pill calls updateSetting("taskListCollapsed", false)', () => {
    setCollapsed(true)
    const updateSetting = vi.fn()
    act(() => {
      useSettingsStore.setState({ updateSetting })
    })

    const todos: TodoItem[] = [makeTodo('a', 'Task')]
    render(<TaskListWidget todos={todos} topOffsetClass="top-4" />)

    const toggle = screen.getByTestId('task-list-widget-toggle')
    fireEvent.click(toggle)

    expect(updateSetting).toHaveBeenCalledTimes(1)
    expect(updateSetting).toHaveBeenCalledWith('taskListCollapsed', false)
  })

  it('clicking the expanded header calls updateSetting("taskListCollapsed", true)', () => {
    setCollapsed(false)
    const updateSetting = vi.fn()
    act(() => {
      useSettingsStore.setState({ updateSetting })
    })

    const todos: TodoItem[] = [makeTodo('a', 'Task')]
    render(<TaskListWidget todos={todos} topOffsetClass="top-4" />)

    const toggle = screen.getByTestId('task-list-widget-toggle')
    fireEvent.click(toggle)

    expect(updateSetting).toHaveBeenCalledTimes(1)
    expect(updateSetting).toHaveBeenCalledWith('taskListCollapsed', true)
  })

  it('applies topOffsetClass prop to the container', () => {
    setCollapsed(false)
    const todos: TodoItem[] = [makeTodo('a', 'Task')]
    render(<TaskListWidget todos={todos} topOffsetClass="top-20" />)

    const widget = screen.getByTestId('task-list-widget')
    expect(widget.className).toContain('top-20')
  })

  it('counter reflects the number of completed vs total todos', () => {
    setCollapsed(true)

    const todosThreeOfFive: TodoItem[] = [
      makeTodo('a', '1', 'completed'),
      makeTodo('b', '2', 'completed'),
      makeTodo('c', '3', 'completed'),
      makeTodo('d', '4', 'pending'),
      makeTodo('e', '5', 'in_progress')
    ]

    const { rerender } = render(
      <TaskListWidget todos={todosThreeOfFive} topOffsetClass="top-4" />
    )
    expect(screen.getByTestId('task-list-widget-toggle')).toHaveTextContent('3/5')

    const todosNoneOfThree: TodoItem[] = [
      makeTodo('a', '1', 'pending'),
      makeTodo('b', '2', 'in_progress'),
      makeTodo('c', '3', 'cancelled')
    ]

    rerender(<TaskListWidget todos={todosNoneOfThree} topOffsetClass="top-4" />)
    expect(screen.getByTestId('task-list-widget-toggle')).toHaveTextContent('0/3')
  })
})
