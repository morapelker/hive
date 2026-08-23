/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockQuery } = vi.hoisted(() => ({
  mockQuery: vi.fn()
}))
vi.mock('../../../src/main/services/claude-sdk-loader', () => ({
  loadClaudeSDK: vi.fn().mockResolvedValue({ query: mockQuery })
}))

vi.mock('../../../src/main/services/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}))

vi.mock('../../../src/main/services/agent-event-bus', () => ({
  agentEventBus: { publish: vi.fn() }
}))

vi.mock('../../../src/main/desktop/backend-event-publisher', () => ({
  publishDesktopBackendEvent: vi.fn()
}))

import { ClaudeCodeImplementer } from '../../../src/main/services/claude-code-implementer'
import { agentEventBus } from '../../../src/main/services/agent-event-bus'

/**
 * Query stub whose output stream stays open until endStream() is called, so a
 * test can keep feeding messages after a `result` the way the CLI does while
 * background subagents are still running.
 */
function createOpenQueryIterator() {
  const pending: Array<Record<string, unknown>> = []
  let deliver: (() => void) | null = null
  let ended = false

  const iterator = {
    interrupt: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
    async next(): Promise<IteratorResult<Record<string, unknown>>> {
      while (pending.length === 0 && !ended) {
        await new Promise<void>((resolve) => {
          deliver = resolve
        })
      }
      if (pending.length > 0) return { done: false, value: pending.shift()! }
      return { done: true, value: undefined }
    },
    return: vi.fn().mockResolvedValue({ done: true, value: undefined }),
    [Symbol.asyncIterator]() {
      return iterator
    }
  }

  return {
    iterator,
    emit(message: Record<string, unknown>) {
      pending.push(message)
      deliver?.()
      deliver = null
    },
    endStream() {
      ended = true
      deliver?.()
      deliver = null
    }
  }
}

/** Reads the prompt AsyncIterable the implementer handed to sdk.query(). */
function readPromptInput() {
  const prompt = mockQuery.mock.calls[0][0].prompt as AsyncIterable<Record<string, unknown>>
  const iterator = prompt[Symbol.asyncIterator]()
  let closed = false
  const first = iterator.next()
  const drained = first
    .then(() => iterator.next())
    .then(() => {
      closed = true
    })
  return { first, isClosed: () => closed, drained }
}

const backgroundTasks = (...ids: string[]) => ({
  type: 'system',
  subtype: 'background_tasks_changed',
  session_id: 'sdk-1',
  tasks: ids.map((id) => ({ task_id: id }))
})

const result = () => ({ type: 'result', subtype: 'success', session_id: 'sdk-1', result: 'done' })

/** The CLI announcing a follow-up turn it queued while the last one ran. */
const followUpTurn = () => ({ type: 'system', subtype: 'init', session_id: 'sdk-1', tools: [] })

/** stdin closes a moment after the result, so give the grace period room. */
const expectClosed = (input: { isClosed: () => boolean }) =>
  vi.waitFor(() => expect(input.isClosed()).toBe(true), { timeout: 5000, interval: 25 })

const publishedEvents = (): Array<Record<string, any>> =>
  (agentEventBus.publish as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[0])

describe('ClaudeCodeImplementer – prompt stdin lifetime', () => {
  let impl: ClaudeCodeImplementer

  beforeEach(() => {
    vi.clearAllMocks()
    impl = new ClaudeCodeImplementer()
  })

  it('sends the prompt as an AsyncIterable, never as a plain string', async () => {
    const { sessionId } = await impl.connect('/proj', 'hive-1')
    const stream = createOpenQueryIterator()
    mockQuery.mockReturnValue(stream.iterator)

    await impl.prompt('/proj', sessionId, 'hello there')

    const prompt = mockQuery.mock.calls[0][0].prompt
    expect(typeof prompt).not.toBe('string')

    const { first } = readPromptInput()
    expect((await first).value).toMatchObject({
      type: 'user',
      parent_tool_use_id: null,
      message: { role: 'user', content: [{ type: 'text', text: 'hello there' }] }
    })

    stream.endStream()
  })

  it('closes stdin on a result that leaves no background work', async () => {
    const { sessionId } = await impl.connect('/proj', 'hive-1')
    const stream = createOpenQueryIterator()
    mockQuery.mockReturnValue(stream.iterator)

    await impl.prompt('/proj', sessionId, 'hi')
    const input = readPromptInput()

    stream.emit(result())
    await expectClosed(input)

    stream.endStream()
  })

  it('keeps stdin open when the CLI starts a follow-up turn after the result', async () => {
    const { sessionId } = await impl.connect('/proj', 'hive-1')
    const stream = createOpenQueryIterator()
    mockQuery.mockReturnValue(stream.iterator)

    await impl.prompt('/proj', sessionId, 'hi')
    const input = readPromptInput()

    // A background task finished mid-turn, so the set is already empty here.
    stream.emit(result())
    stream.emit(followUpTurn())

    await new Promise((resolve) => setTimeout(resolve, 2500))
    expect(input.isClosed()).toBe(false)

    stream.emit(result())
    await expectClosed(input)

    stream.endStream()
  })

  it('keeps stdin open while background work runs, and closes on the result after it ends', async () => {
    const { sessionId } = await impl.connect('/proj', 'hive-1')
    const stream = createOpenQueryIterator()
    mockQuery.mockReturnValue(stream.iterator)

    await impl.prompt('/proj', sessionId, 'launch a background agent')
    const input = readPromptInput()

    stream.emit(backgroundTasks('task-1'))
    stream.emit(result())
    await vi.waitFor(() => {
      expect((impl as any).getSession('/proj', 'sdk-1')?.liveBackgroundTasks.size).toBe(1)
    })
    expect(input.isClosed()).toBe(false)

    // The background agent finishes and wakes the CLI for one more turn.
    stream.emit(backgroundTasks())
    stream.emit(result())
    await expectClosed(input)

    stream.endStream()
  })

  it('reports background work as gone when the turn is torn down with work still live', async () => {
    const { sessionId } = await impl.connect('/proj', 'hive-1')
    const stream = createOpenQueryIterator()
    mockQuery.mockReturnValue(stream.iterator)

    await impl.prompt('/proj', sessionId, 'launch a background agent')
    readPromptInput()

    stream.emit(backgroundTasks('task-1'))
    await vi.waitFor(() => {
      expect((impl as any).getSession('/proj', 'sdk-1')?.liveBackgroundTasks.size).toBe(1)
    })

    // Stop kills the CLI process, so nothing it reported is running any more.
    // Without a terminal zero the renderer keeps the indicator and the kanban
    // badges forever: the store only drops the entry on all-zero counts.
    await impl.abort('/proj', 'sdk-1')

    const last = publishedEvents()
      .filter((e) => e.type === 'session.background_work')
      .pop()
    expect(last.data).toEqual({
      runningSubagents: 0,
      runningShells: 0,
      runningMonitors: 0
    })
    expect((impl as any).getSession('/proj', 'sdk-1')?.liveBackgroundTasks.size).toBe(0)

    stream.endStream()
  })

  it('does not let a retired turn report idle over the prompt that replaced it', async () => {
    const { sessionId } = await impl.connect('/proj', 'hive-1')
    const first = createOpenQueryIterator()
    mockQuery.mockReturnValue(first.iterator)

    await impl.prompt('/proj', sessionId, 'launch a background agent')
    first.emit(backgroundTasks('task-1'))
    first.emit(result())
    await vi.waitFor(() => {
      expect((impl as any).getSession('/proj', 'sdk-1')?.liveBackgroundTasks.size).toBe(1)
    })

    // Ownership has to change hands before the old stream is torn down. If it
    // does not, the retired finisher wakes from the interrupt still owning the
    // session and reports idle over the turn that is starting. Record what the
    // session held at the moment of teardown, which is when the finisher wakes.
    const session = (impl as any).getSession('/proj', 'sdk-1')
    const retiredController = session.abortController
    let stillOwnedAtTeardown: boolean | null = null
    first.iterator.return = vi.fn(async () => {
      stillOwnedAtTeardown = session.abortController === retiredController
      return { done: true, value: undefined }
    })

    const second = createOpenQueryIterator()
    mockQuery.mockReturnValue(second.iterator)
    await impl.prompt('/proj', 'sdk-1', 'a new prompt while it runs')
    await new Promise((resolve) => setTimeout(resolve, 200))

    expect(stillOwnedAtTeardown).toBe(false)
    expect(retiredController.signal.aborted).toBe(true)

    const statuses = publishedEvents()
      .filter((e) => e.type === 'session.status')
      .map((e) => e.statusPayload?.type)
    expect(statuses[statuses.length - 1]).toBe('busy')

    first.endStream()
    second.endStream()
  })

  it('holds stdin open past the silence watchdog while a request waits on the user', async () => {
    const { sessionId } = await impl.connect('/proj', 'hive-1')
    const stream = createOpenQueryIterator()
    mockQuery.mockReturnValue(stream.iterator)

    await impl.prompt('/proj', sessionId, 'launch a background agent')
    const input = readPromptInput()

    // Fake timers have to be installed before the watchdog is armed, or it is
    // left on a real timer that fake time never reaches.
    vi.useFakeTimers()
    try {
      stream.emit(backgroundTasks('task-1'))
      stream.emit(result())
      await vi.advanceTimersByTimeAsync(10)

      const session = (impl as any).getSession('/proj', 'sdk-1')
      expect(session.backgroundWorkWatchdog).toBeTruthy()

      // The CLI is silent because it is waiting for an answer, not because it
      // is wedged, and with a window attached that wait may last hours.
      // Closing stdin here would break the very request being waited on.
      session.pendingQuestion = { requestId: 'q-1', questions: [], resolve: vi.fn() }
      await vi.advanceTimersByTimeAsync(45 * 60_000)
      expect(input.isClosed()).toBe(false)
      expect(session.backgroundWorkWatchdog).toBeTruthy()

      // Once it is answered, the watchdog is free to end a silent turn again.
      session.pendingQuestion = null
      await vi.advanceTimersByTimeAsync(45 * 60_000)
      expect(input.isClosed()).toBe(true)
    } finally {
      vi.useRealTimers()
    }

    stream.endStream()
  })

  it('retires the previous turn in the same order the stop path uses', async () => {
    const { sessionId } = await impl.connect('/proj', 'hive-1')
    const first = createOpenQueryIterator()
    mockQuery.mockReturnValue(first.iterator)

    await impl.prompt('/proj', sessionId, 'launch a background agent')
    first.emit(backgroundTasks('task-1'))
    first.emit(result())
    await vi.waitFor(() => {
      expect((impl as any).getSession('/proj', 'sdk-1')?.liveBackgroundTasks.size).toBe(1)
    })

    // Mirrors test/claude-code-abort-ordering.test.ts. The deny has to land
    // while the stream is still up, or the CLI reports the reply as
    // "Tool permission request failed: AbortError: Stream closed".
    const order: string[] = []
    const session = (impl as any).getSession('/proj', 'sdk-1')
    session.pendingQuestion = {
      requestId: 'q-1',
      questions: [],
      resolve: () => order.push('question-rejected')
    }
    session.abortController.signal.addEventListener('abort', () => order.push('controller-abort'))
    session.subscription = {
      abort: vi.fn(async () => {
        order.push('subscription-abort')
      }),
      awaitDone: vi.fn()
    }
    session.query = {
      close: vi.fn(() => order.push('query-close')),
      interrupt: vi.fn()
    }

    mockQuery.mockReturnValue(createOpenQueryIterator().iterator)
    await impl.prompt('/proj', 'sdk-1', 'a new prompt while it runs')

    expect(order).toEqual([
      'question-rejected',
      'controller-abort',
      'subscription-abort',
      'query-close'
    ])

    first.endStream()
  })

  it('starts the new prompt even when the retired turn refuses to tear down', async () => {
    const { sessionId } = await impl.connect('/proj', 'hive-1')
    const first = createOpenQueryIterator()
    mockQuery.mockReturnValue(first.iterator)

    await impl.prompt('/proj', sessionId, 'launch a background agent')
    first.emit(backgroundTasks('task-1'))
    first.emit(result())
    await vi.waitFor(() => {
      expect((impl as any).getSession('/proj', 'sdk-1')?.liveBackgroundTasks.size).toBe(1)
    })

    // A wedged child process must not stop the replacement prompt from being
    // dispatched, the same reason the stop path bounds every teardown step.
    const session = (impl as any).getSession('/proj', 'sdk-1')
    session.subscription = { abort: vi.fn(() => new Promise(() => {})), awaitDone: vi.fn() }

    const second = createOpenQueryIterator()
    mockQuery.mockReturnValue(second.iterator)

    vi.useFakeTimers()
    try {
      const pending = impl.prompt('/proj', 'sdk-1', 'a new prompt while it runs')
      await vi.advanceTimersByTimeAsync(10_000)
      await expect(pending).resolves.toBeUndefined()
    } finally {
      vi.useRealTimers()
    }

    expect(mockQuery).toHaveBeenCalledTimes(2)

    first.endStream()
    second.endStream()
  })

  it('reports live background work to the renderer, split by kind', async () => {
    const { sessionId } = await impl.connect('/proj', 'hive-1')
    const stream = createOpenQueryIterator()
    mockQuery.mockReturnValue(stream.iterator)

    await impl.prompt('/proj', sessionId, 'launch a background agent')
    const input = readPromptInput()

    stream.emit({
      type: 'system',
      subtype: 'background_tasks_changed',
      session_id: 'sdk-1',
      tasks: [
        { task_id: 'agent-1', task_type: 'local_agent' },
        { task_id: 'shell-1', task_type: 'local_bash' }
      ]
    })

    await vi.waitFor(() => {
      expect(
        publishedEvents().find((event) => event.type === 'session.background_work')
      ).toBeDefined()
    })

    const event = publishedEvents().find((e) => e.type === 'session.background_work')!
    expect(event.sessionId).toBe('hive-1')
    expect(event.data).toEqual({
      runningSubagents: 1,
      runningShells: 1,
      runningMonitors: 0
    })

    // Draining reports zeros, which is what clears the renderer's indicator.
    stream.emit(backgroundTasks())
    await vi.waitFor(() => {
      const all = publishedEvents().filter((e) => e.type === 'session.background_work')
      expect(all[all.length - 1].data).toEqual({
        runningSubagents: 0,
        runningShells: 0,
        runningMonitors: 0
      })
    })

    stream.emit(result())
    await expectClosed(input)
    stream.endStream()
  })

  it('stays silent for CLI builds that never report background work', async () => {
    const { sessionId } = await impl.connect('/proj', 'hive-1')
    const stream = createOpenQueryIterator()
    mockQuery.mockReturnValue(stream.iterator)

    await impl.prompt('/proj', sessionId, 'hi')
    const input = readPromptInput()

    stream.emit(result())
    await expectClosed(input)

    expect(publishedEvents().some((e) => e.type === 'session.background_work')).toBe(false)

    stream.endStream()
  })

  it('closes stdin when the session is aborted mid background work', async () => {
    const { sessionId } = await impl.connect('/proj', 'hive-1')
    const stream = createOpenQueryIterator()
    mockQuery.mockReturnValue(stream.iterator)

    await impl.prompt('/proj', sessionId, 'hi')
    const input = readPromptInput()

    stream.emit(backgroundTasks('task-1'))
    stream.emit(result())
    await vi.waitFor(() => {
      expect((impl as any).getSession('/proj', 'sdk-1')?.liveBackgroundTasks.size).toBe(1)
    })
    expect(input.isClosed()).toBe(false)

    await impl.abort('/proj', 'sdk-1')
    await expectClosed(input)

    stream.endStream()
  })
})
