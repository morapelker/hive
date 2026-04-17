import { describe, it, expect } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useLatestTodoList } from '../../src/renderer/src/components/sessions/useLatestTodoList'
import type {
  OpenCodeMessage,
  StreamingPart
} from '../../src/renderer/src/components/sessions/SessionView'
import type { TodoItem } from '../../src/renderer/src/components/sessions/tools/todoIcons'

function makeTodo(
  id: string,
  content: string,
  status: TodoItem['status'] = 'pending',
  priority: TodoItem['priority'] = 'medium'
): TodoItem {
  return { id, content, status, priority }
}

function makeTodoWritePart(
  todos: unknown,
  opts: { id?: string; name?: string } = {}
): StreamingPart {
  return {
    type: 'tool_use',
    toolUse: {
      id: opts.id ?? 'tool-1',
      name: opts.name ?? 'TodoWrite',
      input: { todos } as Record<string, unknown>,
      status: 'success',
      startTime: 0
    }
  }
}

function makeTextPart(text: string): StreamingPart {
  return { type: 'text', text }
}

function makeOtherToolPart(name: string, input: Record<string, unknown> = {}): StreamingPart {
  return {
    type: 'tool_use',
    toolUse: {
      id: 'tool-other',
      name,
      input,
      status: 'success',
      startTime: 0
    }
  }
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

describe('useLatestTodoList', () => {
  it('returns null todos when there are no messages and no streaming message', () => {
    const { result } = renderHook(() => useLatestTodoList([], null))
    expect(result.current.todos).toBeNull()
    expect(result.current.isIncomplete).toBe(false)
  })

  it('returns null when no TodoWrite tool_use exists anywhere', () => {
    const messages: OpenCodeMessage[] = [
      makeMessage('m1', [makeTextPart('hello'), makeOtherToolPart('Bash', { command: 'ls' })]),
      makeMessage('m2', [makeTextPart('world')])
    ]
    const { result } = renderHook(() => useLatestTodoList(messages, null))
    expect(result.current.todos).toBeNull()
    expect(result.current.isIncomplete).toBe(false)
  })

  it('returns todos from the latest TodoWrite in committed messages when no streaming', () => {
    const todos = [makeTodo('1', 'Do thing', 'pending')]
    const messages: OpenCodeMessage[] = [
      makeMessage('m1', [makeTextPart('hi'), makeTodoWritePart(todos)])
    ]
    const { result } = renderHook(() => useLatestTodoList(messages, null))
    expect(result.current.todos).toEqual(todos)
    expect(result.current.isIncomplete).toBe(true)
  })

  it('prefers streaming message TodoWrite over committed messages', () => {
    const committedTodos = [makeTodo('c1', 'Committed', 'completed')]
    const streamingTodos = [makeTodo('s1', 'Streaming', 'in_progress')]

    const messages: OpenCodeMessage[] = [
      makeMessage('m1', [makeTodoWritePart(committedTodos)])
    ]
    const streamingMessage = makeMessage('stream', [makeTodoWritePart(streamingTodos)])

    const { result } = renderHook(() => useLatestTodoList(messages, streamingMessage))
    expect(result.current.todos).toEqual(streamingTodos)
    expect(result.current.isIncomplete).toBe(true)
  })

  it('returns the latest TodoWrite when there are multiple in committed messages', () => {
    const olderTodos = [makeTodo('o1', 'Older', 'completed')]
    const newerTodos = [makeTodo('n1', 'Newer', 'pending')]
    const messages: OpenCodeMessage[] = [
      makeMessage('m1', [makeTodoWritePart(olderTodos, { id: 'older' })]),
      makeMessage('m2', [makeTextPart('separator')]),
      makeMessage('m3', [makeTodoWritePart(newerTodos, { id: 'newer' })])
    ]
    const { result } = renderHook(() => useLatestTodoList(messages, null))
    expect(result.current.todos).toEqual(newerTodos)
    expect(result.current.isIncomplete).toBe(true)
  })

  it('returns the latest TodoWrite within the last message when multiple are present', () => {
    const older = [makeTodo('o1', 'Older')]
    const newer = [makeTodo('n1', 'Newer')]
    const messages: OpenCodeMessage[] = [
      makeMessage('m1', [
        makeTodoWritePart(older, { id: 'older' }),
        makeTextPart('mid'),
        makeTodoWritePart(newer, { id: 'newer' })
      ])
    ]
    const { result } = renderHook(() => useLatestTodoList(messages, null))
    expect(result.current.todos).toEqual(newer)
  })

  it('marks isIncomplete=true when any todo is pending', () => {
    const todos = [makeTodo('1', 'Done', 'completed'), makeTodo('2', 'Waiting', 'pending')]
    const messages: OpenCodeMessage[] = [makeMessage('m1', [makeTodoWritePart(todos)])]
    const { result } = renderHook(() => useLatestTodoList(messages, null))
    expect(result.current.isIncomplete).toBe(true)
  })

  it('marks isIncomplete=true when any todo is in_progress', () => {
    const todos = [
      makeTodo('1', 'Done', 'completed'),
      makeTodo('2', 'Working', 'in_progress')
    ]
    const messages: OpenCodeMessage[] = [makeMessage('m1', [makeTodoWritePart(todos)])]
    const { result } = renderHook(() => useLatestTodoList(messages, null))
    expect(result.current.isIncomplete).toBe(true)
  })

  it('marks isIncomplete=false when all todos are completed and/or cancelled', () => {
    const todos = [
      makeTodo('1', 'Done', 'completed'),
      makeTodo('2', 'Skipped', 'cancelled'),
      makeTodo('3', 'Also done', 'completed')
    ]
    const messages: OpenCodeMessage[] = [makeMessage('m1', [makeTodoWritePart(todos)])]
    const { result } = renderHook(() => useLatestTodoList(messages, null))
    expect(result.current.todos).toEqual(todos)
    expect(result.current.isIncomplete).toBe(false)
  })

  it('skips TodoWrite parts whose input.todos is not an array and keeps walking back', () => {
    const goodTodos = [makeTodo('g1', 'Good', 'pending')]
    const messages: OpenCodeMessage[] = [
      // Older message: has a valid TodoWrite
      makeMessage('m1', [makeTodoWritePart(goodTodos, { id: 'good' })]),
      // Newer messages: malformed inputs that should all be skipped
      makeMessage('m2', [makeTodoWritePart('not-an-array', { id: 'bad-string' })]),
      makeMessage('m3', [makeTodoWritePart({ foo: 'bar' }, { id: 'bad-object' })]),
      makeMessage('m4', [makeTodoWritePart(undefined, { id: 'bad-undefined' })])
    ]
    const { result } = renderHook(() => useLatestTodoList(messages, null))
    expect(result.current.todos).toEqual(goodTodos)
    expect(result.current.isIncomplete).toBe(true)
  })

  it('falls back to committed messages when streaming has no tool_use parts', () => {
    const committedTodos = [makeTodo('c1', 'Committed', 'pending')]
    const streamingMessage = makeMessage('stream', [makeTextPart('partial response')])
    const messages: OpenCodeMessage[] = [
      makeMessage('m1', [makeTodoWritePart(committedTodos)])
    ]
    const { result } = renderHook(() => useLatestTodoList(messages, streamingMessage))
    expect(result.current.todos).toEqual(committedTodos)
    expect(result.current.isIncomplete).toBe(true)
  })

  it('falls back to committed messages when streaming has non-TodoWrite tool_use', () => {
    const committedTodos = [makeTodo('c1', 'Committed', 'completed')]
    const streamingMessage = makeMessage('stream', [
      makeOtherToolPart('Bash', { command: 'echo hi' })
    ])
    const messages: OpenCodeMessage[] = [
      makeMessage('m1', [makeTodoWritePart(committedTodos)])
    ]
    const { result } = renderHook(() => useLatestTodoList(messages, streamingMessage))
    expect(result.current.todos).toEqual(committedTodos)
    expect(result.current.isIncomplete).toBe(false)
  })
})
