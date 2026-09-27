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
    ).toEqual({ kind: 'completed', pendingTasks: 0, pendingWakeups: 0, ignoredShells: 0 })
  })

  it('ignores background shells: a dev server left running is not a pause', () => {
    // The body cannot tell a wait loop from a Metro/cargo server the agent
    // started for its own verification; both are `type: 'shell'`. Counting
    // them stranded finished tickets on the hourglass forever.
    expect(
      classifyClaudeCliStopCompletion({
        background_tasks: [
          { id: 'b8ut5wblu', type: 'shell', status: 'running', command: 'sleep 40' },
          { id: 'bmetro', type: 'shell', status: 'running', command: 'npx expo start' }
        ],
        session_crons: []
      })
    ).toEqual({ kind: 'completed', pendingTasks: 0, pendingWakeups: 0, ignoredShells: 2 })
  })

  it('is waiting while a Monitor watch is reported (a shell whose id the caller knows as a monitor)', () => {
    // A Monitor watch is reported as type 'shell' on 2.1.269 — only the
    // caller-supplied monitor ids tell it apart from an ignored shell.
    expect(
      classifyClaudeCliStopCompletion(
        {
          background_tasks: [
            { id: 'bmon1', type: 'shell', status: 'running' },
            { id: 'bmetro', type: 'shell', status: 'running' }
          ],
          session_crons: []
        },
        { monitorTaskIds: new Set(['bmon1']) }
      )
    ).toEqual({ kind: 'waiting', pendingTasks: 1, pendingWakeups: 0, ignoredShells: 1 })
  })

  it('is waiting while a subagent or workflow is reported', () => {
    expect(
      classifyClaudeCliStopCompletion({
        background_tasks: [
          { id: 'a1', type: 'subagent', status: 'running', agent_type: 'Explore' },
          { id: 'w1', type: 'workflow', status: 'running', name: 'review-changes' }
        ],
        session_crons: []
      })
    ).toEqual({ kind: 'waiting', pendingTasks: 2, pendingWakeups: 0, ignoredShells: 0 })

    // Any other (or missing) task type holds the session open too — only
    // shells are singled out.
    expect(
      classifyClaudeCliStopCompletion({
        background_tasks: [{ id: 'x1', status: 'running' }, 'junk'],
        session_crons: []
      })
    ).toMatchObject({ kind: 'waiting', pendingTasks: 2 })
  })

  it('is waiting while a scheduled wakeup is pending even with no background tasks', () => {
    expect(
      classifyClaudeCliStopCompletion({
        background_tasks: [],
        session_crons: [{ id: '0512d868', schedule: '4 15 * * *', recurring: false, prompt: 'say WOKE' }]
      })
    ).toEqual({ kind: 'waiting', pendingTasks: 0, pendingWakeups: 1, ignoredShells: 0 })
  })

  it('treats a single present-and-empty array as a completion', () => {
    expect(classifyClaudeCliStopCompletion({ background_tasks: [] }).kind).toBe('completed')
    expect(classifyClaudeCliStopCompletion({ session_crons: [] }).kind).toBe('completed')
  })

  it('is unknown when the body predates both arrays', () => {
    expect(classifyClaudeCliStopCompletion({})).toEqual({
      kind: 'unknown',
      pendingTasks: 0,
      pendingWakeups: 0,
      ignoredShells: 0
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
