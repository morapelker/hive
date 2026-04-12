import { describe, expect, it } from 'vitest'

import {
  attachChildPartToTaskToolParts,
  correlateSubtasksIntoTaskTools
} from '../../../src/renderer/src/lib/codex-subtask-correlation'
import type {
  OpenCodeMessage,
  StreamingPart
} from '../../../src/renderer/src/lib/opencode-transcript'

function makeTaskTool(id: string, childSessionId: string): StreamingPart {
  return {
    type: 'tool_use',
    toolUse: {
      id,
      name: 'Task',
      input: {
        prompt: `Investigate ${childSessionId}`,
        receiverThreadIds: [childSessionId]
      },
      status: 'running',
      startTime: 1000
    }
  }
}

describe('codex subtask correlation', () => {
  it('attaches child text updates to the matching Task tool part', () => {
    const result = attachChildPartToTaskToolParts(
      [makeTaskTool('task-call-1', 'child-1')],
      'child-1',
      {
        type: 'text',
        text: 'Child analysis'
      }
    )

    expect(result.attached).toBe(true)
    expect(result.parts[0]).toEqual({
      type: 'tool_use',
      toolUse: {
        id: 'task-call-1',
        name: 'Task',
        input: {
          prompt: 'Investigate child-1',
          receiverThreadIds: ['child-1']
        },
        status: 'running',
        startTime: 1000,
        subtasks: [
          {
            id: 'child-1',
            sessionID: 'child-1',
            prompt: '',
            description: '',
            agent: 'task',
            parts: [{ type: 'text', text: 'Child analysis' }],
            status: 'running'
          }
        ]
      }
    })
  })

  it('moves standalone subtasks under their owning Task tool and removes the duplicate row', () => {
    const messages: OpenCodeMessage[] = [
      {
        id: 'turn-1:assistant',
        role: 'assistant',
        content: '',
        timestamp: '2026-03-14T10:00:00.000Z',
        parts: [makeTaskTool('task-call-1', 'child-1')]
      },
      {
        id: 'turn-1:task:child-1',
        role: 'assistant',
        content: '',
        timestamp: '2026-03-14T10:00:01.000Z',
        parts: [
          {
            type: 'subtask',
            subtask: {
              id: 'child-1',
              sessionID: 'child-1',
              prompt: '',
              description: 'Investigating the renderer',
              agent: 'task',
              parts: [{ type: 'text', text: 'Child analysis' }],
              status: 'completed'
            }
          }
        ]
      }
    ]

    const correlated = correlateSubtasksIntoTaskTools(messages)

    expect(correlated).toHaveLength(1)
    expect(correlated[0]?.parts?.[0]).toEqual({
      type: 'tool_use',
      toolUse: {
        id: 'task-call-1',
        name: 'Task',
        input: {
          prompt: 'Investigate child-1',
          receiverThreadIds: ['child-1']
        },
        status: 'running',
        startTime: 1000,
        subtasks: [
          {
            id: 'child-1',
            sessionID: 'child-1',
            prompt: '',
            description: 'Investigating the renderer',
            agent: 'task',
            parts: [{ type: 'text', text: 'Child analysis' }],
            status: 'completed'
          }
        ]
      }
    })
  })
})
