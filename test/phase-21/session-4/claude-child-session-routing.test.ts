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

vi.mock('../../../src/main/desktop/backend-manager', () => ({
  publishDesktopBackendEvent: vi.fn()
}))

import { ClaudeCodeImplementer } from '../../../src/main/services/claude-code-implementer'
import { agentEventBus } from '../../../src/main/services/agent-event-bus'

function createMockQueryIterator(messages: Array<Record<string, unknown>>) {
  let index = 0
  const iterator = {
    interrupt: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
    next: vi.fn().mockImplementation(async () => {
      if (index < messages.length) {
        return { done: false, value: messages[index++] }
      }
      return { done: true, value: undefined }
    }),
    return: vi.fn().mockResolvedValue({ done: true, value: undefined }),
    [Symbol.asyncIterator]: () => iterator
  }
  return iterator
}

function getStreamEvents(): any[] {
  const publish = agentEventBus.publish as ReturnType<typeof vi.fn>
  return publish.mock.calls.map((call: any[]) => call[0])
}

describe('Claude child session routing', () => {
  let impl: ClaudeCodeImplementer

  beforeEach(() => {
    vi.clearAllMocks()
    impl = new ClaudeCodeImplementer()
  })

  it('forwards childSessionId on assistant message.updated', async () => {
    const { sessionId } = await impl.connect('/proj', 'hive-1')
    mockQuery.mockReturnValue(
      createMockQueryIterator([
        {
          type: 'assistant',
          session_id: 'sdk-1',
          parent_tool_use_id: 'task-tool-1',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'child response' }],
            usage: { input_tokens: 10, output_tokens: 5 }
          }
        }
      ])
    )

    await impl.prompt('/proj', sessionId, 'hello')

    const events = getStreamEvents()
    const event = events.find((e) => e.type === 'message.updated')
    expect(event).toBeDefined()
    expect(event.childSessionId).toBe('task-tool-1')
  })

  it('forwards childSessionId on result message.updated', async () => {
    const { sessionId } = await impl.connect('/proj', 'hive-1')
    mockQuery.mockReturnValue(
      createMockQueryIterator([
        {
          type: 'result',
          session_id: 'sdk-1',
          parent_tool_use_id: 'task-tool-2',
          result: 'ok',
          usage: { input_tokens: 3, output_tokens: 2 }
        }
      ])
    )

    await impl.prompt('/proj', sessionId, 'hello')

    const events = getStreamEvents()
    const event = events.find((e) => e.type === 'message.updated')
    expect(event).toBeDefined()
    expect(event.childSessionId).toBe('task-tool-2')
  })

  it('forwards childSessionId on tool_result message.part.updated', async () => {
    const { sessionId } = await impl.connect('/proj', 'hive-1')
    mockQuery.mockReturnValue(
      createMockQueryIterator([
        {
          type: 'assistant',
          session_id: 'sdk-1',
          message: {
            role: 'assistant',
            content: [
              { type: 'tool_use', id: 'tool-read-1', name: 'Read', input: { path: 'a.ts' } }
            ]
          }
        },
        {
          type: 'user',
          session_id: 'sdk-1',
          parent_tool_use_id: 'task-tool-3',
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'tool-read-1', content: 'file contents' }]
          }
        }
      ])
    )

    await impl.prompt('/proj', sessionId, 'hello')

    const events = getStreamEvents()
    const event = events.find(
      (e) =>
        e.type === 'message.part.updated' &&
        e.data?.part?.callID === 'tool-read-1' &&
        e.data?.part?.state?.status === 'completed'
    )
    expect(event).toBeDefined()
    expect(event.childSessionId).toBe('task-tool-3')
  })
})
