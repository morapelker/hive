import { describe, expect, test } from 'vitest'

import {
  appendStreamedAssistantFallback,
  type TranscriptMessage,
  type TranscriptStreamingPart
} from '../../../src/renderer/src/lib/transcript-refresh'

describe('transcript refresh fallback', () => {
  test('appends a local assistant fallback when canonical transcript is stale', () => {
    const messages: TranscriptMessage[] = [
      {
        id: 'assistant-old-1',
        role: 'assistant',
        content: 'Previous canonical message',
        timestamp: '2026-03-12T10:00:00.000Z'
      }
    ]

    const streamedParts: TranscriptStreamingPart[] = [
      { type: 'text', text: 'New streamed response' }
    ]

    const next = appendStreamedAssistantFallback(messages, {
      streamedContent: 'New streamed response',
      streamedParts,
      createId: () => 'local-stream-1',
      now: () => '2026-03-12T10:00:01.000Z'
    })

    expect(next).toHaveLength(2)
    expect(next[1]).toMatchObject({
      id: 'local-stream-1',
      role: 'assistant',
      content: 'New streamed response',
      parts: streamedParts
    })
  })

  test('does not append a fallback when canonical transcript already includes streamed text', () => {
    const messages: TranscriptMessage[] = [
      {
        id: 'assistant-new-1',
        role: 'assistant',
        content: 'New streamed response',
        timestamp: '2026-03-12T10:00:01.000Z'
      }
    ]

    const next = appendStreamedAssistantFallback(messages, {
      streamedContent: 'New streamed response',
      streamedParts: [{ type: 'text', text: 'New streamed response' }],
      createId: () => 'local-stream-1',
      now: () => '2026-03-12T10:00:02.000Z'
    })

    expect(next).toEqual(messages)
  })

  test('does not append a fallback when canonical transcript already includes streamed tool ids', () => {
    const messages: TranscriptMessage[] = [
      {
        id: 'assistant-new-1',
        role: 'assistant',
        content: '',
        timestamp: '2026-03-12T10:00:01.000Z',
        parts: [
          {
            type: 'tool_use',
            toolUse: {
              id: 'tool-123',
              name: 'bash',
              input: {},
              status: 'success',
              startTime: 1
            }
          }
        ]
      }
    ]

    const next = appendStreamedAssistantFallback(messages, {
      streamedContent: '',
      streamedParts: [
        {
          type: 'tool_use',
          toolUse: {
            id: 'tool-123',
            name: 'bash',
            input: {},
            status: 'success',
            startTime: 1
          }
        }
      ],
      createId: () => 'local-stream-1',
      now: () => '2026-03-12T10:00:02.000Z'
    })

    expect(next).toEqual(messages)
  })
})
