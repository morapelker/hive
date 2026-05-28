import { describe, expect, it } from 'vitest'

import { findClaudePlanFollowupAfterLine } from '../claude-plan-followup-watcher'

function line(entry: Record<string, unknown>): string {
  return JSON.stringify(entry)
}

describe('claude-plan-followup-watcher', () => {
  it('detects ExitPlanMode error tool results appended after the baseline', () => {
    const raw = [
      line({ type: 'user', message: { role: 'user', content: 'Initial prompt' } }),
      line({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'toolu_plan', name: 'ExitPlanMode', input: { plan: 'Plan' } }
          ]
        }
      }),
      line({
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_plan',
              is_error: true,
              content: 'Please adjust the plan before implementing.'
            }
          ]
        }
      })
    ].join('\n')

    expect(findClaudePlanFollowupAfterLine(raw, 2)).toEqual({
      found: true,
      nextLine: 3
    })
  })

  it('ignores unrelated tool results and sidechain user entries after the baseline', () => {
    const raw = [
      line({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'toolu_read', name: 'Read', input: {} }]
        }
      }),
      line({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_read', is_error: true, content: 'ok' }]
        }
      }),
      line({
        type: 'user',
        isSidechain: true,
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'subtask prompt' }]
        }
      })
    ].join('\n')

    expect(findClaudePlanFollowupAfterLine(raw, 0)).toEqual({
      found: false,
      nextLine: 3
    })
  })
})
