import { describe, expect, it } from 'vitest'

import {
  findClaudePlanFollowupAfterLine,
  scanPlanFollowupLines
} from '../claude-plan-followup-watcher'

function line(entry: Record<string, unknown>): string {
  return JSON.stringify(entry)
}

const planToolUse = line({
  type: 'assistant',
  message: {
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'toolu_plan', name: 'ExitPlanMode', input: { plan: 'Plan' } }]
  }
})

const planFollowup = line({
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

  it('scanPlanFollowupLines accumulates ExitPlanMode tool ids across incremental calls', () => {
    const exitPlanToolIds = new Set<string>()

    // First poll sees only the plan tool_use (id captured), no follow-up yet.
    expect(scanPlanFollowupLines([planToolUse], 0, 1, exitPlanToolIds)).toBe(false)
    expect(exitPlanToolIds.has('toolu_plan')).toBe(true)

    // Second poll scans ONLY the newly-appended line, yet still detects the
    // follow-up because the tool id was carried over from the previous call —
    // i.e. it does not need to re-parse the earlier plan tool_use line.
    expect(scanPlanFollowupLines([planToolUse, planFollowup], 1, 1, exitPlanToolIds)).toBe(true)
  })

  it('scanPlanFollowupLines respects the baseline (ignores follow-ups before it)', () => {
    const exitPlanToolIds = new Set<string>()
    // Both lines present, but baseline is past them → no detection.
    expect(scanPlanFollowupLines([planToolUse, planFollowup], 0, 2, exitPlanToolIds)).toBe(false)
    expect(exitPlanToolIds.has('toolu_plan')).toBe(true)
  })
})
