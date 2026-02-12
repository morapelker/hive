import { describe, expect, test, vi } from 'vitest'
import {
  extractTextContentFromParts,
  mapOpencodeMessagesToSessionViewMessages,
  mapOpencodePartToStreamingPart
} from '../../../src/renderer/src/lib/opencode-transcript'

describe('OpenCode transcript adapter', () => {
  test('preserves id, role, timestamp, and text content', () => {
    const input = [
      {
        info: {
          id: 'msg-b',
          role: 'assistant',
          time: { created: 2000 }
        },
        parts: [{ type: 'text', text: 'Second' }]
      },
      {
        info: {
          id: 'msg-a',
          role: 'user',
          time: { created: 1000 }
        },
        parts: [{ type: 'text', text: 'First' }]
      }
    ]

    const result = mapOpencodeMessagesToSessionViewMessages(input)

    expect(result).toHaveLength(2)
    expect(result[0]).toMatchObject({
      id: 'msg-a',
      role: 'user',
      timestamp: new Date(1000).toISOString(),
      content: 'First'
    })
    expect(result[1]).toMatchObject({
      id: 'msg-b',
      role: 'assistant',
      timestamp: new Date(2000).toISOString(),
      content: 'Second'
    })
  })

  test('maps supported part types into StreamingPart[]', () => {
    const input = [
      {
        info: {
          id: 'msg-1',
          role: 'assistant',
          time: { created: '2026-02-11T00:00:00.000Z' }
        },
        parts: [
          { type: 'text', text: 'hello' },
          {
            type: 'tool',
            callID: 'tool-1',
            tool: 'Read',
            state: {
              status: 'completed',
              input: { file: 'README.md' },
              output: { ok: true },
              time: { start: 10, end: 20 }
            }
          },
          {
            type: 'subtask',
            id: 'sub-1',
            sessionID: 'child-1',
            prompt: 'Investigate',
            description: 'Inspect files',
            agent: 'task',
            status: 'completed',
            parts: [{ type: 'text', text: 'child work' }]
          },
          { type: 'step-start', snapshot: 'step-1' },
          {
            type: 'step-finish',
            reason: 'done',
            cost: 0.1,
            tokens: { input: 10, output: 20, reasoning: 5 }
          },
          { type: 'reasoning', text: 'thinking' },
          { type: 'compaction', auto: true }
        ]
      }
    ]

    const [message] = mapOpencodeMessagesToSessionViewMessages(input)
    expect(message.parts).toBeDefined()
    expect(message.parts).toHaveLength(7)

    expect(message.parts?.[0]).toEqual({ type: 'text', text: 'hello' })
    expect(message.parts?.[1]).toMatchObject({
      type: 'tool_use',
      toolUse: {
        id: 'tool-1',
        name: 'Read',
        status: 'success'
      }
    })
    expect(message.parts?.[2]).toMatchObject({
      type: 'subtask',
      subtask: {
        id: 'sub-1',
        sessionID: 'child-1',
        status: 'completed'
      }
    })
    expect(message.parts?.[3]).toEqual({ type: 'step_start', stepStart: { snapshot: 'step-1' } })
    expect(message.parts?.[4]).toEqual({
      type: 'step_finish',
      stepFinish: {
        reason: 'done',
        cost: 0.1,
        tokens: { input: 10, output: 20, reasoning: 5 }
      }
    })
    expect(message.parts?.[5]).toEqual({ type: 'reasoning', reasoning: 'thinking' })
    expect(message.parts?.[6]).toEqual({ type: 'compaction', compactionAuto: true })
  })

  test('handles missing or malformed fields without throwing', () => {
    const input = [
      {},
      { info: null, parts: 'not-an-array' },
      {
        info: {
          id: 123,
          role: 'unknown-role',
          time: { created: 'bad-time' }
        },
        parts: [null, undefined, { type: 'text' }, { type: 'tool', state: null }]
      }
    ]

    expect(() => mapOpencodeMessagesToSessionViewMessages(input)).not.toThrow()
    const result = mapOpencodeMessagesToSessionViewMessages(input)
    expect(result).toHaveLength(3)
    expect(result.every((message) => typeof message.id === 'string')).toBe(true)
    expect(result.every((message) => typeof message.timestamp === 'string')).toBe(true)
  })

  test('orders deterministically by time then id', () => {
    const input = [
      { info: { id: 'msg-z' }, parts: [{ type: 'text', text: 'Z' }] },
      {
        info: { id: 'msg-b', time: { created: 3000 } },
        parts: [{ type: 'text', text: 'B' }]
      },
      {
        info: { id: 'msg-a', time: { created: 3000 } },
        parts: [{ type: 'text', text: 'A' }]
      },
      { info: { id: 'msg-c' }, parts: [{ type: 'text', text: 'C' }] }
    ]

    const result = mapOpencodeMessagesToSessionViewMessages(input)
    expect(result.map((message) => message.id)).toEqual(['msg-a', 'msg-b', 'msg-c', 'msg-z'])
  })
})

describe('OpenCode transcript helpers', () => {
  test('extractTextContentFromParts concatenates text parts only', () => {
    const result = extractTextContentFromParts([
      { type: 'tool', tool: 'Read' },
      { type: 'text', text: 'Hello ' },
      { type: 'text', text: 'world' },
      { type: 'reasoning', text: 'ignored' }
    ])

    expect(result).toBe('Hello world')
  })

  test('mapOpencodePartToStreamingPart returns null for unsupported part', () => {
    const result = mapOpencodePartToStreamingPart({ type: 'unknown-part' }, 1)
    expect(result).toBeNull()
  })

  test('falls back to Date.now() when tool_use startTime is missing or invalid', () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(123456)

    const missingStartTime = mapOpencodePartToStreamingPart(
      {
        type: 'tool_use',
        toolUse: {
          id: 'tool-missing',
          name: 'Read',
          input: {},
          status: 'running'
        }
      },
      1
    )

    const invalidStartTime = mapOpencodePartToStreamingPart(
      {
        type: 'tool_use',
        toolUse: {
          id: 'tool-invalid',
          name: 'Read',
          input: {},
          status: 'running',
          startTime: 'not-a-time'
        }
      },
      2
    )

    expect(missingStartTime?.type).toBe('tool_use')
    expect(missingStartTime?.toolUse?.startTime).toBe(123456)
    expect(invalidStartTime?.type).toBe('tool_use')
    expect(invalidStartTime?.toolUse?.startTime).toBe(123456)

    nowSpy.mockRestore()
  })

  test('falls back to Date.now() when tool state.time.start is missing or invalid', () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(987654)

    const missingStartTime = mapOpencodePartToStreamingPart(
      {
        type: 'tool',
        callID: 'tool-state-missing',
        tool: 'Read',
        state: {
          status: 'running',
          input: {}
        }
      },
      3
    )

    const invalidStartTime = mapOpencodePartToStreamingPart(
      {
        type: 'tool',
        callID: 'tool-state-invalid',
        tool: 'Read',
        state: {
          status: 'running',
          input: {},
          time: { start: 'still-not-a-time' }
        }
      },
      4
    )

    expect(missingStartTime?.type).toBe('tool_use')
    expect(missingStartTime?.toolUse?.startTime).toBe(987654)
    expect(invalidStartTime?.type).toBe('tool_use')
    expect(invalidStartTime?.toolUse?.startTime).toBe(987654)

    nowSpy.mockRestore()
  })
})
