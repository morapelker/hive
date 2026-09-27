import { describe, expect, it } from 'vitest'
import {
  classifyClaudeCliStopCompletion,
  isClaudeCliCompletionDetected
} from './claude-cli-stop-completion'

describe('classifyClaudeCliStopCompletion', () => {
  it('is a completion when both arrays are present and empty', () => {
    expect(
      classifyClaudeCliStopCompletion({
        background_tasks: [],
        session_crons: []
      })
    ).toEqual({ kind: 'completed', pendingTasks: 0, pendingWakeups: 0 })
  })

  it('is waiting while any background task is reported, whatever its type', () => {
    expect(
      classifyClaudeCliStopCompletion({
        background_tasks: [
          { id: 'b8ut5wblu', type: 'shell', status: 'running', command: 'sleep 40' }
        ],
        session_crons: []
      })
    ).toEqual({ kind: 'waiting', pendingTasks: 1, pendingWakeups: 0 })

    // A Monitor watch is reported as type 'shell' on 2.1.269 — the label is
    // irrelevant, only the array emptiness counts.
    expect(
      classifyClaudeCliStopCompletion({
        background_tasks: [
          { id: 'a1', type: 'subagent', status: 'running', agent_type: 'Explore' },
          { id: 'w1', type: 'workflow', status: 'running', name: 'review-changes' }
        ],
        session_crons: []
      })
    ).toEqual({ kind: 'waiting', pendingTasks: 2, pendingWakeups: 0 })
  })

  it('is waiting while a scheduled wakeup is pending even with no background tasks', () => {
    expect(
      classifyClaudeCliStopCompletion({
        background_tasks: [],
        session_crons: [{ id: '0512d868', schedule: '4 15 * * *', recurring: false, prompt: 'say WOKE' }]
      })
    ).toEqual({ kind: 'waiting', pendingTasks: 0, pendingWakeups: 1 })
  })

  it('treats a single present-and-empty array as a completion', () => {
    expect(classifyClaudeCliStopCompletion({ background_tasks: [] }).kind).toBe('completed')
    expect(classifyClaudeCliStopCompletion({ session_crons: [] }).kind).toBe('completed')
  })

  it('is unknown when the body predates both arrays', () => {
    expect(classifyClaudeCliStopCompletion({})).toEqual({
      kind: 'unknown',
      pendingTasks: 0,
      pendingWakeups: 0
    })
    // Non-array junk is treated as absent, not as pending work.
    expect(
      classifyClaudeCliStopCompletion({ background_tasks: 'nope', session_crons: null }).kind
    ).toBe('unknown')
  })
})

describe('isClaudeCliCompletionDetected', () => {
  it('counts a clean Stop and a legacy Stop as done, a pause or no Stop as not done', () => {
    expect(isClaudeCliCompletionDetected('completed')).toBe(true)
    expect(isClaudeCliCompletionDetected('unknown')).toBe(true)
    expect(isClaudeCliCompletionDetected('waiting')).toBe(false)
    expect(isClaudeCliCompletionDetected('none')).toBe(false)
  })
})
