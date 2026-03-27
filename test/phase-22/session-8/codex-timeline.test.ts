import { describe, expect, it } from 'vitest'

import {
  deriveCodexTimelineMessages,
  mergeCodexActivityMessages
} from '../../../src/renderer/src/lib/codex-timeline'

describe('codex timeline derivation', () => {
  it('renders tool activities inside the turn block instead of collapsing them above the transcript', () => {
    const messages: SessionMessage[] = [
      {
        id: 'db-user-1',
        session_id: 'session-1',
        role: 'user',
        content: 'Please inspect the repo',
        opencode_message_id: 'turn-1:user',
        opencode_message_json: null,
        opencode_parts_json: JSON.stringify([
          { type: 'text', text: 'Please inspect the repo', timestamp: '2026-03-14T10:00:00.000Z' }
        ]),
        opencode_timeline_json: null,
        created_at: '2026-03-14T10:00:00.000Z'
      },
      {
        id: 'db-assistant-1',
        session_id: 'session-1',
        role: 'assistant',
        content: 'I checked the repo and found the issue.',
        opencode_message_id: 'turn-1:assistant',
        opencode_message_json: null,
        opencode_parts_json: JSON.stringify([
          {
            type: 'text',
            text: 'I checked the repo and found the issue.',
            timestamp: '2026-03-14T10:00:10.000Z'
          }
        ]),
        opencode_timeline_json: null,
        created_at: '2026-03-14T10:00:10.000Z'
      }
    ]

    const activities: SessionActivity[] = [
      {
        id: 'activity-1',
        session_id: 'session-1',
        agent_session_id: 'thread-1',
        thread_id: 'thread-1',
        turn_id: null,
        item_id: 'tool-1',
        request_id: null,
        kind: 'tool.completed',
        tone: 'tool',
        summary: 'Read',
        payload_json: JSON.stringify({
          item: {
            toolName: 'Read',
            input: { filePath: 'src/index.ts' },
            output: 'ok'
          }
        }),
        sequence: null,
        created_at: '2026-03-14T10:00:03.000Z'
      }
    ]

    const timeline = deriveCodexTimelineMessages(messages, activities)

    expect(timeline).toHaveLength(3)
    expect(timeline[0]?.id).toBe('turn-1:user')
    expect(timeline[1]?.id).toBe('turn-1:assistant')
    expect(timeline[2]?.id).toBe('tool:tool-1')
    expect(timeline[2]?.parts?.some((part) => part.type === 'tool_use')).toBe(true)
  })

  it('projects persisted plan.ready activity into an ExitPlanMode tool card', () => {
    const messages: SessionMessage[] = [
      {
        id: 'db-user-1',
        session_id: 'session-1',
        role: 'user',
        content: 'Plan this change',
        opencode_message_id: 'turn-1:user',
        opencode_message_json: null,
        opencode_parts_json: JSON.stringify([
          { type: 'text', text: 'Plan this change', timestamp: '2026-03-14T10:00:00.000Z' }
        ]),
        opencode_timeline_json: null,
        created_at: '2026-03-14T10:00:00.000Z'
      },
      {
        id: 'db-assistant-1',
        session_id: 'session-1',
        role: 'assistant',
        content: 'Here is the plan.',
        opencode_message_id: 'turn-1:assistant',
        opencode_message_json: null,
        opencode_parts_json: JSON.stringify([
          {
            type: 'text',
            text: 'Here is the plan.',
            timestamp: '2026-03-14T10:00:10.000Z'
          }
        ]),
        opencode_timeline_json: null,
        created_at: '2026-03-14T10:00:10.000Z'
      }
    ]

    const activities: SessionActivity[] = [
      {
        id: 'plan-ready-1',
        session_id: 'session-1',
        agent_session_id: 'thread-1',
        thread_id: 'thread-1',
        turn_id: null,
        item_id: null,
        request_id: 'codex-plan:thread-1',
        kind: 'plan.ready',
        tone: 'info',
        summary: 'Plan ready',
        payload_json: JSON.stringify({
          plan: 'Plan\n\n1. Add the function\n2. Add tests',
          toolUseID: 'codex-exitplan-tool-1'
        }),
        sequence: null,
        created_at: '2026-03-14T10:00:11.000Z'
      }
    ]

    const timeline = deriveCodexTimelineMessages(messages, activities)
    const planRow = timeline.find((message) => message.id === 'tool:codex-exitplan-tool-1')

    expect(
      planRow?.parts?.some(
        (part) =>
          part.type === 'tool_use' &&
          part.toolUse?.name === 'ExitPlanMode' &&
          String(part.toolUse.input?.plan) === 'Plan\n\n1. Add the function\n2. Add tests' &&
          part.toolUse.status === 'pending'
      )
    ).toBe(true)
  })

  it('anchors later-turn tool activities to the matching assistant turn', () => {
    const messages: SessionMessage[] = [
      {
        id: 'db-user-1',
        session_id: 'session-1',
        role: 'user',
        content: 'First prompt',
        opencode_message_id: 'turn-1:user',
        opencode_message_json: null,
        opencode_parts_json: JSON.stringify([{ type: 'text', text: 'First prompt' }]),
        opencode_timeline_json: null,
        created_at: '2026-03-14T10:00:00.000Z'
      },
      {
        id: 'db-assistant-1',
        session_id: 'session-1',
        role: 'assistant',
        content: 'First answer',
        opencode_message_id: 'turn-1:assistant',
        opencode_message_json: null,
        opencode_parts_json: JSON.stringify([{ type: 'text', text: 'First answer' }]),
        opencode_timeline_json: null,
        created_at: '2026-03-14T10:00:05.000Z'
      },
      {
        id: 'db-user-2',
        session_id: 'session-1',
        role: 'user',
        content: 'Second prompt',
        opencode_message_id: 'turn-2:user',
        opencode_message_json: null,
        opencode_parts_json: JSON.stringify([{ type: 'text', text: 'Second prompt' }]),
        opencode_timeline_json: null,
        created_at: '2026-03-14T10:01:00.000Z'
      },
      {
        id: 'db-assistant-2',
        session_id: 'session-1',
        role: 'assistant',
        content: 'Second answer',
        opencode_message_id: 'turn-2:assistant',
        opencode_message_json: null,
        opencode_parts_json: JSON.stringify([{ type: 'text', text: 'Second answer' }]),
        opencode_timeline_json: null,
        created_at: '2026-03-14T10:01:08.000Z'
      }
    ]

    const activities: SessionActivity[] = [
      {
        id: 'activity-2',
        session_id: 'session-1',
        agent_session_id: 'thread-1',
        thread_id: 'thread-1',
        turn_id: 'turn-2',
        item_id: 'tool-2',
        request_id: null,
        kind: 'tool.completed',
        tone: 'tool',
        summary: 'Read',
        payload_json: JSON.stringify({
          item: {
            toolName: 'Read',
            input: { filePath: 'src/second.ts' },
            output: 'ok'
          }
        }),
        sequence: null,
        created_at: '2026-03-14T10:01:03.000Z'
      }
    ]

    const timeline = deriveCodexTimelineMessages(messages, activities)

    expect(timeline.map((message) => message.id)).toEqual([
      'turn-1:user',
      'turn-1:assistant',
      'turn-2:user',
      'turn-2:tool:tool-2',
      'turn-2:assistant'
    ])
    expect(
      timeline[3]?.parts?.some((part) => part.type === 'tool_use' && part.toolUse?.id === 'tool-2')
    ).toBe(true)
  })

  it('keeps unanchored activities as standalone assistant rows when multiple turns exist', () => {
    const messages: SessionMessage[] = [
      {
        id: 'db-user-1',
        session_id: 'session-1',
        role: 'user',
        content: 'First prompt',
        opencode_message_id: 'turn-1:user',
        opencode_message_json: null,
        opencode_parts_json: JSON.stringify([{ type: 'text', text: 'First prompt' }]),
        opencode_timeline_json: null,
        created_at: '2026-03-14T10:00:00.000Z'
      },
      {
        id: 'db-assistant-1',
        session_id: 'session-1',
        role: 'assistant',
        content: 'First answer',
        opencode_message_id: 'turn-1:assistant',
        opencode_message_json: null,
        opencode_parts_json: JSON.stringify([{ type: 'text', text: 'First answer' }]),
        opencode_timeline_json: null,
        created_at: '2026-03-14T10:00:05.000Z'
      },
      {
        id: 'db-user-2',
        session_id: 'session-1',
        role: 'user',
        content: 'Second prompt',
        opencode_message_id: 'turn-2:user',
        opencode_message_json: null,
        opencode_parts_json: JSON.stringify([{ type: 'text', text: 'Second prompt' }]),
        opencode_timeline_json: null,
        created_at: '2026-03-14T10:01:00.000Z'
      },
      {
        id: 'db-assistant-2',
        session_id: 'session-1',
        role: 'assistant',
        content: 'Second answer',
        opencode_message_id: 'turn-2:assistant',
        opencode_message_json: null,
        opencode_parts_json: JSON.stringify([{ type: 'text', text: 'Second answer' }]),
        opencode_timeline_json: null,
        created_at: '2026-03-14T10:01:08.000Z'
      }
    ]

    const activities: SessionActivity[] = [
      {
        id: 'activity-unanchored',
        session_id: 'session-1',
        agent_session_id: 'thread-1',
        thread_id: 'thread-1',
        turn_id: null,
        item_id: 'tool-unanchored',
        request_id: null,
        kind: 'tool.completed',
        tone: 'tool',
        summary: 'Read',
        payload_json: JSON.stringify({
          item: {
            toolName: 'Read',
            input: { filePath: 'src/unanchored.ts' },
            output: 'ok'
          }
        }),
        sequence: null,
        created_at: '2026-03-14T10:01:03.000Z'
      }
    ]

    const timeline = deriveCodexTimelineMessages(messages, activities)
    const synthetic = timeline.find((message) => message.id === 'tool:tool-unanchored')

    expect(timeline.map((message) => message.id)).toEqual([
      'turn-1:user',
      'turn-1:assistant',
      'turn-2:user',
      'turn-2:assistant',
      'tool:tool-unanchored'
    ])
    expect(
      synthetic?.parts?.some(
        (part) => part.type === 'tool_use' && part.toolUse?.id === 'tool-unanchored'
      )
    ).toBe(true)
  })

  it('infers turn-scoped message ids for legacy item-based Codex transcripts', () => {
    const messages: SessionMessage[] = [
      {
        id: 'db-user-1',
        session_id: 'session-1',
        role: 'user',
        content: 'First prompt',
        opencode_message_id: 'item-1',
        opencode_message_json: null,
        opencode_parts_json: JSON.stringify([{ type: 'text', text: 'First prompt' }]),
        opencode_timeline_json: null,
        created_at: '2026-03-14T10:00:00.000Z'
      },
      {
        id: 'db-assistant-1',
        session_id: 'session-1',
        role: 'assistant',
        content: 'First answer',
        opencode_message_id: 'item-2',
        opencode_message_json: null,
        opencode_parts_json: JSON.stringify([{ type: 'text', text: 'First answer' }]),
        opencode_timeline_json: null,
        created_at: '2026-03-14T10:00:01.000Z'
      },
      {
        id: 'db-user-2',
        session_id: 'session-1',
        role: 'user',
        content: 'Second prompt',
        opencode_message_id: 'item-8',
        opencode_message_json: null,
        opencode_parts_json: JSON.stringify([{ type: 'text', text: 'Second prompt' }]),
        opencode_timeline_json: null,
        created_at: '2026-03-14T10:00:02.000Z'
      },
      {
        id: 'db-assistant-2',
        session_id: 'session-1',
        role: 'assistant',
        content: 'Second answer',
        opencode_message_id: 'item-9',
        opencode_message_json: null,
        opencode_parts_json: JSON.stringify([{ type: 'text', text: 'Second answer' }]),
        opencode_timeline_json: null,
        created_at: '2026-03-14T10:00:03.000Z'
      }
    ]

    const activities: SessionActivity[] = [
      {
        id: 'activity-turn-1',
        session_id: 'session-1',
        agent_session_id: 'thread-1',
        thread_id: 'thread-1',
        turn_id: 'turn-1',
        item_id: 'tool-1',
        request_id: null,
        kind: 'tool.completed',
        tone: 'tool',
        summary: 'Read',
        payload_json: JSON.stringify({
          item: {
            toolName: 'Read',
            input: { filePath: 'src/first.ts' },
            output: 'ok'
          }
        }),
        sequence: null,
        created_at: '2026-03-14T10:00:00.500Z'
      },
      {
        id: 'activity-turn-2',
        session_id: 'session-1',
        agent_session_id: 'thread-1',
        thread_id: 'thread-1',
        turn_id: 'turn-2',
        item_id: 'tool-2',
        request_id: null,
        kind: 'tool.completed',
        tone: 'tool',
        summary: 'Write',
        payload_json: JSON.stringify({
          item: {
            toolName: 'Write',
            input: { filePath: 'src/second.ts' },
            output: 'ok'
          }
        }),
        sequence: null,
        created_at: '2026-03-14T10:00:02.500Z'
      }
    ]

    const timeline = deriveCodexTimelineMessages(messages, activities)

    expect(timeline.map((message) => message.id)).toEqual([
      'turn-1:user',
      'turn-1:tool:tool-1',
      'turn-1:assistant',
      'turn-2:user',
      'turn-2:tool:tool-2',
      'turn-2:assistant'
    ])
    expect(
      timeline[1]?.parts?.some((part) => part.type === 'tool_use' && part.toolUse?.id === 'tool-1')
    ).toBe(true)
    expect(
      timeline[4]?.parts?.some((part) => part.type === 'tool_use' && part.toolUse?.id === 'tool-2')
    ).toBe(true)
  })

  it('normalizes live item-based Codex messages before merging activities', () => {
    const messages = [
      {
        id: 'item-1',
        role: 'user' as const,
        content: 'First prompt',
        timestamp: '2026-03-14T10:00:00.000Z'
      },
      {
        id: 'item-2',
        role: 'assistant' as const,
        content: 'First answer',
        timestamp: '2026-03-14T10:00:01.000Z'
      },
      {
        id: 'item-8',
        role: 'user' as const,
        content: 'Second prompt',
        timestamp: '2026-03-14T10:00:02.000Z'
      },
      {
        id: 'item-9',
        role: 'assistant' as const,
        content: 'Second answer',
        timestamp: '2026-03-14T10:00:03.000Z'
      }
    ]

    const activities: SessionActivity[] = [
      {
        id: 'activity-turn-1',
        session_id: 'session-1',
        agent_session_id: 'thread-1',
        thread_id: 'thread-1',
        turn_id: 'turn-1',
        item_id: 'tool-1',
        request_id: null,
        kind: 'tool.completed',
        tone: 'tool',
        summary: 'Read',
        payload_json: JSON.stringify({
          item: {
            toolName: 'Read',
            input: { filePath: 'src/first.ts' },
            output: 'ok'
          }
        }),
        sequence: null,
        created_at: '2026-03-14T10:00:00.500Z'
      },
      {
        id: 'activity-turn-2',
        session_id: 'session-1',
        agent_session_id: 'thread-1',
        thread_id: 'thread-1',
        turn_id: 'turn-2',
        item_id: 'tool-2',
        request_id: null,
        kind: 'tool.completed',
        tone: 'tool',
        summary: 'Write',
        payload_json: JSON.stringify({
          item: {
            toolName: 'Write',
            input: { filePath: 'src/second.ts' },
            output: 'ok'
          }
        }),
        sequence: null,
        created_at: '2026-03-14T10:00:02.500Z'
      }
    ]

    const timeline = mergeCodexActivityMessages(messages, activities)

    expect(timeline.map((message) => message.id)).toEqual([
      'turn-1:user',
      'turn-1:tool:tool-1',
      'turn-1:assistant',
      'turn-2:user',
      'turn-2:tool:tool-2',
      'turn-2:assistant'
    ])
    expect(
      timeline[1]?.parts?.some((part) => part.type === 'tool_use' && part.toolUse?.id === 'tool-1')
    ).toBe(true)
    expect(
      timeline[4]?.parts?.some((part) => part.type === 'tool_use' && part.toolUse?.id === 'tool-2')
    ).toBe(true)
  })

  it('normalizes mixed canonical and raw Codex messages without pushing later tools to the edges', () => {
    const messages = [
      {
        id: 'turn-1:user',
        role: 'user' as const,
        content: 'First prompt',
        timestamp: '2026-03-14T10:00:00.000Z'
      },
      {
        id: 'turn-1:assistant',
        role: 'assistant' as const,
        content: 'First answer',
        timestamp: '2026-03-14T10:00:01.000Z'
      },
      {
        id: 'item-8',
        role: 'user' as const,
        content: 'Second prompt',
        timestamp: '2026-03-14T10:00:02.000Z'
      },
      {
        id: 'item-9',
        role: 'assistant' as const,
        content: 'Second answer',
        timestamp: '2026-03-14T10:00:03.000Z'
      }
    ]

    const activities: SessionActivity[] = [
      {
        id: 'activity-turn-2',
        session_id: 'session-1',
        agent_session_id: 'thread-1',
        thread_id: 'thread-1',
        turn_id: 'turn-2',
        item_id: 'tool-2',
        request_id: null,
        kind: 'tool.completed',
        tone: 'tool',
        summary: 'Write',
        payload_json: JSON.stringify({
          item: {
            toolName: 'Write',
            input: { filePath: 'src/second.ts' },
            output: 'ok'
          }
        }),
        sequence: null,
        created_at: '2026-03-14T10:00:02.500Z'
      }
    ]

    const timeline = mergeCodexActivityMessages(messages, activities)

    expect(timeline.map((message) => message.id)).toEqual([
      'turn-1:user',
      'turn-1:assistant',
      'turn-2:user',
      'turn-2:tool:tool-2',
      'turn-2:assistant'
    ])
  })
})
