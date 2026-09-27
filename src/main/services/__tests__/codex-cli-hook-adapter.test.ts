import { beforeEach, describe, expect, it } from 'vitest'
import {
  CODEX_PLAN_IMPLEMENT_CLEAR_CONTEXT_PREFIX,
  CODEX_PLAN_IMPLEMENT_PROMPT,
  adaptCodexCliHook,
  adaptCodexQuestionsInput,
  isCodexPlanImplementPrompt,
  resetAllCodexCliModelTracking,
  trackCodexCliModel,
  type CodexCliHookBody
} from '../codex-cli-hook-adapter'

const base: CodexCliHookBody = {
  session_id: '01a07dbd-6a11-7982-a2b6-ceaa43736708',
  turn_id: 'turn-1',
  transcript_path: '/Users/me/.codex/sessions/2026/09/08/rollout-x.jsonl',
  cwd: '/repo/wt',
  model: 'gpt-5.5',
  permission_mode: 'bypassPermissions'
}

describe('adaptCodexCliHook', () => {
  it('passes lifecycle events through and rewrites permission_mode while Hive holds Plan mode', () => {
    const [start] = adaptCodexCliHook(
      { ...base, hook_event_name: 'SessionStart', source: 'startup' },
      { planMode: false }
    )
    expect(start.hook).toMatchObject({
      hook_event_name: 'SessionStart',
      session_id: base.session_id,
      transcript_path: base.transcript_path,
      permission_mode: 'bypassPermissions',
      source: 'startup',
      turn_id: 'turn-1'
    })

    const [submit] = adaptCodexCliHook(
      { ...base, hook_event_name: 'UserPromptSubmit', prompt: 'plan this' },
      { planMode: true }
    )
    expect(submit.hook.hook_event_name).toBe('UserPromptSubmit')
    expect(submit.hook.prompt).toBe('plan this')
    expect(submit.hook.permission_mode).toBe('plan')
  })

  it('drops compaction events', () => {
    expect(adaptCodexCliHook({ ...base, hook_event_name: 'PreCompact' }, { planMode: false })).toEqual([])
    expect(adaptCodexCliHook({ ...base, hook_event_name: 'PostCompact' }, { planMode: false })).toEqual([])
    expect(adaptCodexCliHook({ ...base }, { planMode: false })).toEqual([])
  })

  it('turns Interrupt into a Stop tagged user_interrupt', () => {
    const [interrupt] = adaptCodexCliHook({ ...base, hook_event_name: 'Interrupt' }, { planMode: false })
    expect(interrupt.hook.hook_event_name).toBe('Stop')
    expect(interrupt.reason).toBe('user_interrupt')
  })

  it('maps request_user_input to AskUserQuestion with claude-shaped questions', () => {
    const [pre] = adaptCodexCliHook(
      {
        ...base,
        hook_event_name: 'PreToolUse',
        tool_name: 'request_user_input',
        tool_use_id: 'call_1',
        tool_input: {
          questions: [
            {
              id: 'q1',
              header: 'Database',
              question: 'Which database?',
              options: [
                { label: 'Postgres', description: 'Relational' },
                { label: 'Redis', description: 'KV' }
              ]
            }
          ]
        }
      },
      { planMode: false }
    )
    expect(pre.hook.hook_event_name).toBe('PreToolUse')
    expect(pre.hook.tool_name).toBe('AskUserQuestion')
    expect(pre.hook.tool_use_id).toBe('call_1')
    expect(pre.hook.tool_input).toEqual({
      questions: [
        {
          id: 'q1',
          question: 'Which database?',
          header: 'Database',
          options: [
            { label: 'Postgres', description: 'Relational' },
            { label: 'Redis', description: 'KV' }
          ],
          multiSelect: false
        }
      ]
    })

  })

  it('drops the question PostToolUse in either mode (the title resolves a question)', () => {
    // Default mode: the question is non-blocking, so this fires with the
    // question still unanswered. Plan mode: it blocks, but the PostToolUse after
    // the answer is not dependable. The Action Required title covers both.
    for (const planMode of [false, true]) {
      expect(
        adaptCodexCliHook(
          {
            ...base,
            hook_event_name: 'PostToolUse',
            tool_name: 'request_user_input',
            tool_use_id: 'call_1',
            tool_input: { questions: [] },
            tool_response: { answers: { q1: 'Postgres' } }
          },
          { planMode }
        )
      ).toEqual([])
    }
  })

  it('passes other tools through with their input, id and response', () => {
    const [hook] = adaptCodexCliHook(
      {
        ...base,
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: { command: 'rm -rf build', description: null }
      },
      { planMode: false }
    )
    expect(hook.hook.hook_event_name).toBe('PermissionRequest')
    expect(hook.hook.tool_name).toBe('Bash')
    expect(hook.hook.tool_input).toEqual({ command: 'rm -rf build', description: null })
    expect(hook.hook.tool_use_id).toBeUndefined()
  })

  it('carries subagent identity so the background-work tracker counts codex subagents', () => {
    const [hook] = adaptCodexCliHook(
      { ...base, hook_event_name: 'SubagentStart', agent_id: 'thread-child', agent_type: 'worker' },
      { planMode: false }
    )
    expect(hook.hook.agent_id).toBe('thread-child')
    expect(hook.hook.agent_type).toBe('worker')
  })

  it('emits a plan-ready ExitPlanMode before a Stop that produced a plan in Plan mode', () => {
    const result = adaptCodexCliHook(
      { ...base, hook_event_name: 'Stop', last_assistant_message: 'Here is the plan', stop_hook_active: false },
      {
        planMode: true,
        readPlanText: (path, turnId) => {
          expect(path).toBe(base.transcript_path)
          expect(turnId).toBe('turn-1')
          return '## Plan\n1. do things'
        }
      }
    )
    expect(result.map((r) => r.hook.hook_event_name)).toEqual(['PreToolUse', 'Stop'])
    expect(result[0].hook.tool_name).toBe('ExitPlanMode')
    expect(result[0].hook.tool_use_id).toBe('codex-plan:turn-1')
    expect(result[0].hook.tool_input).toEqual({ plan: '## Plan\n1. do things' })
    expect(result[0].hook.permission_mode).toBe('plan')
    expect(result[1].hook.last_assistant_message).toBe('Here is the plan')
  })

  it('emits only the Stop when there is no plan item, outside Plan mode, or for a subagent', () => {
    const noPlan = adaptCodexCliHook(
      { ...base, hook_event_name: 'Stop' },
      { planMode: true, readPlanText: () => null }
    )
    expect(noPlan.map((r) => r.hook.hook_event_name)).toEqual(['Stop'])

    const buildMode = adaptCodexCliHook(
      { ...base, hook_event_name: 'Stop' },
      { planMode: false, readPlanText: () => 'plan' }
    )
    expect(buildMode.map((r) => r.hook.hook_event_name)).toEqual(['Stop'])

    const subagent = adaptCodexCliHook(
      { ...base, hook_event_name: 'SubagentStop', agent_id: 'child', agent_type: 'worker' },
      { planMode: true, readPlanText: () => 'plan' }
    )
    expect(subagent.map((r) => r.hook.hook_event_name)).toEqual(['SubagentStop'])
  })

  it('treats the TUI\'s "Implement the plan." prompt as plan approval', () => {
    for (const prompt of [
      CODEX_PLAN_IMPLEMENT_PROMPT,
      `${CODEX_PLAN_IMPLEMENT_CLEAR_CONTEXT_PREFIX} Implement the plan in a fresh context.\n\n## Plan`
    ]) {
      expect(isCodexPlanImplementPrompt(prompt)).toBe(true)
      const result = adaptCodexCliHook(
        { ...base, hook_event_name: 'UserPromptSubmit', prompt },
        { planMode: true }
      )
      expect(result.map((r) => r.hook.hook_event_name)).toEqual(['PostToolUse', 'UserPromptSubmit'])
      expect(result[0].hook.tool_name).toBe('ExitPlanMode')
      expect(result[0].hook.tool_use_id).toBe('codex-plan:turn-1')
      // The implement turn runs in Default mode even though the row still says plan.
      expect(result[1].hook.permission_mode).toBe('bypassPermissions')
    }
    expect(isCodexPlanImplementPrompt('Implement the plan, please')).toBe(false)
  })
})

describe('adaptCodexQuestionsInput', () => {
  it('tolerates malformed input', () => {
    expect(adaptCodexQuestionsInput(null)).toEqual({ questions: [] })
    expect(adaptCodexQuestionsInput({ questions: 'nope' })).toEqual({ questions: [] })
    expect(adaptCodexQuestionsInput({ questions: [{ question: 'Q?' }] })).toEqual({
      questions: [{ question: 'Q?', header: '', options: [], multiSelect: false }]
    })
  })
})

describe('trackCodexCliModel', () => {
  beforeEach(() => resetAllCodexCliModelTracking())

  it('seeds silently and reports only transitions', () => {
    expect(trackCodexCliModel('s1', 'gpt-5.5')).toBeNull()
    expect(trackCodexCliModel('s1', 'gpt-5.5')).toBeNull()
    expect(trackCodexCliModel('s1', 'gpt-5.4-mini')).toBe('gpt-5.4-mini')
    expect(trackCodexCliModel('s1', 'gpt-5.4-mini')).toBeNull()
    expect(trackCodexCliModel('s1', undefined)).toBeNull()
    expect(trackCodexCliModel('s2', 'gpt-5.4-mini')).toBeNull()
  })
})
