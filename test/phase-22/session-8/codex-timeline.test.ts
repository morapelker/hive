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

  it('normalizes commandExecution activities into Read and Glob tool cards', () => {
    const messages: SessionMessage[] = [
      {
        id: 'db-user-1',
        session_id: 'session-1',
        role: 'user',
        content: 'Inspect the project files',
        opencode_message_id: 'turn-1:user',
        opencode_message_json: null,
        opencode_parts_json: JSON.stringify([{ type: 'text', text: 'Inspect the project files' }]),
        opencode_timeline_json: null,
        created_at: '2026-03-14T10:00:00.000Z'
      },
      {
        id: 'db-assistant-1',
        session_id: 'session-1',
        role: 'assistant',
        content: 'I checked the files.',
        opencode_message_id: 'turn-1:assistant',
        opencode_message_json: null,
        opencode_parts_json: JSON.stringify([{ type: 'text', text: 'I checked the files.' }]),
        opencode_timeline_json: null,
        created_at: '2026-03-14T10:00:05.000Z'
      }
    ]

    const activities: SessionActivity[] = [
      {
        id: 'activity-read',
        session_id: 'session-1',
        agent_session_id: 'thread-1',
        thread_id: 'thread-1',
        turn_id: 'turn-1',
        item_id: 'tool-read',
        request_id: null,
        kind: 'tool.completed',
        tone: 'tool',
        summary: 'Bash',
        payload_json: JSON.stringify({
          item: {
            type: 'commandExecution',
            command: 'sed -n "1,80p" main.py',
            commandActions: [
              {
                type: 'read',
                command: 'sed -n "1,80p" main.py',
                name: 'main.py',
                path: 'main.py'
              }
            ],
            aggregatedOutput: "print('hello')\n"
          }
        }),
        sequence: null,
        created_at: '2026-03-14T10:00:02.000Z'
      },
      {
        id: 'activity-glob',
        session_id: 'session-1',
        agent_session_id: 'thread-1',
        thread_id: 'thread-1',
        turn_id: 'turn-1',
        item_id: 'tool-glob',
        request_id: null,
        kind: 'tool.completed',
        tone: 'tool',
        summary: 'Bash',
        payload_json: JSON.stringify({
          item: {
            type: 'commandExecution',
            command: 'rg --files .',
            commandActions: [
              {
                type: 'listFiles',
                command: 'rg --files .',
                path: '.'
              }
            ],
            aggregatedOutput: 'src/main.py\nsrc/lib/util.py\n'
          }
        }),
        sequence: null,
        created_at: '2026-03-14T10:00:03.000Z'
      }
    ]

    const timeline = deriveCodexTimelineMessages(messages, activities)

    expect(
      timeline.some((message) =>
        message.parts?.some(
          (part) =>
            part.type === 'tool_use' &&
            part.toolUse?.id === 'tool-read' &&
            part.toolUse.name === 'Read' &&
            String(part.toolUse.input?.file_path) === 'main.py'
        )
      )
    ).toBe(true)
    expect(
      timeline.some((message) =>
        message.parts?.some(
          (part) =>
            part.type === 'tool_use' &&
            part.toolUse?.id === 'tool-glob' &&
            part.toolUse.name === 'Glob' &&
            String(part.toolUse.input?.path) === '.'
        )
      )
    ).toBe(true)
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

  it('re-normalizes persisted commandExecution activities from Bash to semantic tools', () => {
    const messages: SessionMessage[] = [
      {
        id: 'db-user-1',
        session_id: 'session-1',
        role: 'user',
        content: 'Inspect the file',
        opencode_message_id: 'turn-1:user',
        opencode_message_json: null,
        opencode_parts_json: JSON.stringify([{ type: 'text', text: 'Inspect the file' }]),
        opencode_timeline_json: null,
        created_at: '2026-03-14T10:00:00.000Z'
      },
      {
        id: 'db-assistant-1',
        session_id: 'session-1',
        role: 'assistant',
        content: 'Done',
        opencode_message_id: 'turn-1:assistant',
        opencode_message_json: null,
        opencode_parts_json: JSON.stringify([{ type: 'text', text: 'Done' }]),
        opencode_timeline_json: null,
        created_at: '2026-03-14T10:00:10.000Z'
      }
    ]

    const activities: SessionActivity[] = [
      {
        id: 'activity-bash-read',
        session_id: 'session-1',
        agent_session_id: 'thread-1',
        thread_id: 'thread-1',
        turn_id: 'turn-1',
        item_id: 'tool-read-1',
        request_id: null,
        kind: 'tool.completed',
        tone: 'tool',
        summary: 'Bash',
        payload_json: JSON.stringify({
          item: {
            type: 'commandExecution',
            command: `sed -n '10,40p' src/index.ts`,
            commandActions: [
              {
                type: 'read',
                command: `sed -n '10,40p' src/index.ts`,
                name: 'index.ts',
                path: 'src/index.ts'
              }
            ],
            aggregatedOutput: 'ok'
          }
        }),
        sequence: null,
        created_at: '2026-03-14T10:00:05.000Z'
      }
    ]

    const timeline = deriveCodexTimelineMessages(messages, activities)
    const toolRow = timeline.find((message) => message.id === 'turn-1:tool:tool-read-1')

    expect(
      toolRow?.parts?.some(
        (part) =>
          part.type === 'tool_use' &&
          part.toolUse?.name === 'Read' &&
          part.toolUse?.input.file_path === 'src/index.ts'
      )
    ).toBe(true)
  })

  it('re-normalizes persisted numbered nl|sed commandExecution activities to Read with exact ranges', () => {
    const messages: SessionMessage[] = [
      {
        id: 'db-user-1',
        session_id: 'session-1',
        role: 'user',
        content: 'Inspect specific file sections',
        opencode_message_id: 'turn-1:user',
        opencode_message_json: null,
        opencode_parts_json: JSON.stringify([{ type: 'text', text: 'Inspect specific file sections' }]),
        opencode_timeline_json: null,
        created_at: '2026-03-14T10:00:00.000Z'
      },
      {
        id: 'db-assistant-1',
        session_id: 'session-1',
        role: 'assistant',
        content: 'Done',
        opencode_message_id: 'turn-1:assistant',
        opencode_message_json: null,
        opencode_parts_json: JSON.stringify([{ type: 'text', text: 'Done' }]),
        opencode_timeline_json: null,
        created_at: '2026-03-14T10:00:10.000Z'
      }
    ]

    const activities: SessionActivity[] = [
      {
        id: 'activity-bash-read-ranges',
        session_id: 'session-1',
        agent_session_id: 'thread-1',
        thread_id: 'thread-1',
        turn_id: 'turn-1',
        item_id: 'tool-read-ranges-1',
        request_id: null,
        kind: 'tool.completed',
        tone: 'tool',
        summary: 'Bash',
        payload_json: JSON.stringify({
          item: {
            type: 'commandExecution',
            command:
              "nl -ba src/renderer/src/components/sessions/ToolCard.tsx | sed -n '40,120p;220,250p;570,620p;875,915p'",
            aggregatedOutput: 'ok'
          }
        }),
        sequence: null,
        created_at: '2026-03-14T10:00:05.000Z'
      }
    ]

    const timeline = deriveCodexTimelineMessages(messages, activities)
    const toolRow = timeline.find((message) => message.id === 'turn-1:tool:tool-read-ranges-1')

    expect(
      toolRow?.parts?.some(
        (part) =>
          part.type === 'tool_use' &&
          part.toolUse?.name === 'Read' &&
          part.toolUse?.input.file_path === 'src/renderer/src/components/sessions/ToolCard.tsx' &&
          JSON.stringify(part.toolUse?.input.line_ranges) ===
            JSON.stringify([
              { start: 40, end: 120 },
              { start: 220, end: 250 },
              { start: 570, end: 620 },
              { start: 875, end: 915 }
            ])
      )
    ).toBe(true)
  })

  it('nests persisted task activities under the matching Task tool when receiverThreadIds are available', () => {
    const messages: SessionMessage[] = [
      {
        id: 'db-user-1',
        session_id: 'session-1',
        role: 'user',
        content: 'Delegate the investigation',
        opencode_message_id: 'turn-1:user',
        opencode_message_json: null,
        opencode_parts_json: JSON.stringify([{ type: 'text', text: 'Delegate the investigation' }]),
        opencode_timeline_json: null,
        created_at: '2026-03-14T10:00:00.000Z'
      },
      {
        id: 'db-assistant-1',
        session_id: 'session-1',
        role: 'assistant',
        content: 'I delegated the investigation.',
        opencode_message_id: 'turn-1:assistant',
        opencode_message_json: null,
        opencode_parts_json: JSON.stringify([
          { type: 'text', text: 'I delegated the investigation.' }
        ]),
        opencode_timeline_json: null,
        created_at: '2026-03-14T10:00:05.000Z'
      }
    ]

    const activities: SessionActivity[] = [
      {
        id: 'tool-activity-1',
        session_id: 'session-1',
        agent_session_id: 'thread-1',
        thread_id: 'thread-1',
        turn_id: 'turn-1',
        item_id: 'task-call-1',
        request_id: null,
        kind: 'tool.completed',
        tone: 'tool',
        summary: 'Task',
        payload_json: JSON.stringify({
          item: {
            id: 'task-call-1',
            type: 'collabAgentToolCall',
            tool: 'wait',
            prompt: 'Investigate the renderer',
            receiverThreadIds: ['child-1']
          }
        }),
        sequence: 9,
        created_at: '2026-03-14T10:00:00.500Z'
      },
      {
        id: 'task-activity-1',
        session_id: 'session-1',
        agent_session_id: 'thread-1',
        thread_id: 'thread-1',
        turn_id: 'turn-1',
        item_id: null,
        request_id: null,
        kind: 'task.started',
        tone: 'info',
        summary: 'Task started',
        payload_json: JSON.stringify({
          task: { id: 'child-1', status: 'running', message: 'Investigating the renderer' },
          threadId: 'child-1'
        }),
        sequence: 10,
        created_at: '2026-03-14T10:00:01.000Z'
      },
      {
        id: 'task-activity-2',
        session_id: 'session-1',
        agent_session_id: 'thread-1',
        thread_id: 'thread-1',
        turn_id: 'turn-1',
        item_id: null,
        request_id: null,
        kind: 'task.completed',
        tone: 'info',
        summary: 'Task completed',
        payload_json: JSON.stringify({
          task: {
            id: 'child-1',
            status: 'completed',
            message: 'Finished investigating the renderer'
          },
          threadId: 'child-1'
        }),
        sequence: 11,
        created_at: '2026-03-14T10:00:04.000Z'
      }
    ]

    const timeline = deriveCodexTimelineMessages(messages, activities)
    const taskRow = timeline.find((message) => message.id === 'turn-1:tool:task-call-1')

    expect(
      taskRow?.parts?.find(
        (part) =>
          part.type === 'tool_use' &&
          part.toolUse?.name === 'Task' &&
          Array.isArray(part.toolUse.input?.receiverThreadIds)
      )
    ).toEqual({
      type: 'tool_use',
      toolUse: {
        id: 'task-call-1',
        name: 'Task',
        input: {
          prompt: 'Investigate the renderer',
          receiverThreadIds: ['child-1']
        },
        status: 'success',
        startTime: Date.parse('2026-03-14T10:00:00.500Z'),
        endTime: Date.parse('2026-03-14T10:00:00.500Z'),
        output: undefined,
        error: undefined,
        subtasks: [
          {
            id: 'child-1',
            sessionID: 'child-1',
            prompt: '',
            description: 'Finished investigating the renderer',
            agent: 'task',
            parts: [],
            status: 'completed'
          }
        ]
      }
    })
    expect(timeline.find((message) => message.id === 'turn-1:task:child-1')).toBeUndefined()
  })

  it('keeps unmatched task activities as standalone subtask rows', () => {
    const messages: SessionMessage[] = [
      {
        id: 'db-user-1',
        session_id: 'session-1',
        role: 'user',
        content: 'Delegate the investigation',
        opencode_message_id: 'turn-1:user',
        opencode_message_json: null,
        opencode_parts_json: JSON.stringify([{ type: 'text', text: 'Delegate the investigation' }]),
        opencode_timeline_json: null,
        created_at: '2026-03-14T10:00:00.000Z'
      }
    ]

    const activities: SessionActivity[] = [
      {
        id: 'task-activity-1',
        session_id: 'session-1',
        agent_session_id: 'thread-1',
        thread_id: 'thread-1',
        turn_id: 'turn-1',
        item_id: null,
        request_id: null,
        kind: 'task.completed',
        tone: 'info',
        summary: 'Task completed',
        payload_json: JSON.stringify({
          task: {
            id: 'child-2',
            status: 'completed',
            message: 'Finished investigating the renderer'
          },
          threadId: 'child-2'
        }),
        sequence: 11,
        created_at: '2026-03-14T10:00:04.000Z'
      }
    ]

    const timeline = deriveCodexTimelineMessages(messages, activities)
    const taskRow = timeline.find((message) => message.id === 'turn-1:task:child-2')

    expect(taskRow?.parts).toEqual([
      {
        type: 'subtask',
        subtask: {
          id: 'child-2',
          sessionID: 'child-2',
          prompt: '',
          description: 'Finished investigating the renderer',
          agent: 'task',
          parts: [],
          status: 'completed'
        }
      }
    ])
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

  it('preserves same-turn steered user and assistant ordinals during timeline merge', () => {
    const messages: SessionMessage[] = [
      {
        id: 'db-user-1',
        session_id: 'session-1',
        role: 'user',
        content: 'First question',
        opencode_message_id: 'turn-1:user',
        opencode_message_json: null,
        opencode_parts_json: JSON.stringify([{ type: 'text', text: 'First question' }]),
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
        created_at: '2026-03-14T10:00:01.000Z'
      },
      {
        id: 'db-user-2',
        session_id: 'session-1',
        role: 'user',
        content: 'Follow-up steer',
        opencode_message_id: 'turn-1:user:2',
        opencode_message_json: null,
        opencode_parts_json: JSON.stringify([{ type: 'text', text: 'Follow-up steer' }]),
        opencode_timeline_json: null,
        created_at: '2026-03-14T10:00:02.000Z'
      },
      {
        id: 'db-assistant-2',
        session_id: 'session-1',
        role: 'assistant',
        content: 'Continued answer',
        opencode_message_id: 'turn-1:assistant:2',
        opencode_message_json: null,
        opencode_parts_json: JSON.stringify([{ type: 'text', text: 'Continued answer' }]),
        opencode_timeline_json: null,
        created_at: '2026-03-14T10:00:03.000Z'
      }
    ]

    const activities: SessionActivity[] = [
      {
        id: 'activity-1',
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
            input: { filePath: 'src/index.ts' },
            output: 'ok'
          }
        }),
        sequence: null,
        created_at: '2026-03-14T10:00:00.500Z'
      }
    ]

    const timeline = deriveCodexTimelineMessages(messages, activities)

    expect(timeline.map((message) => message.id)).toEqual([
      'turn-1:user',
      'turn-1:tool:tool-1',
      'turn-1:assistant',
      'turn-1:user:2',
      'turn-1:assistant:2'
    ])
  })
})
