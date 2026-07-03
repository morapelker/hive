// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'

import {
  clearAllClaudeCliInteractions,
  clearClaudeCliInteractions,
  hasBlockingClaudeCliInteraction,
  processClaudeCliHook
} from '../claude-cli-interaction-ledger'
import type { ClaudeCliStatusPayload, ParsedClaudeHook } from '../claude-hook-server'
import type { SessionStatusType } from '@shared/types/session-status'

const SESSION = 'hive-session-1'

interface HookStep {
  event: string
  tool?: string
  id?: string
  status: SessionStatusType | null
  plan?: string
}

function buildHook(step: HookStep): ParsedClaudeHook {
  const hook: ParsedClaudeHook = { hook_event_name: step.event }
  if (step.tool) hook.tool_name = step.tool
  if (step.id) hook.tool_use_id = step.id
  if (step.plan) hook.tool_input = { plan: step.plan }
  return hook
}

function buildMapped(sessionId: string, step: HookStep): ClaudeCliStatusPayload | null {
  if (!step.status) return null
  const metadata: NonNullable<ClaudeCliStatusPayload['metadata']> = {
    hookEventName: step.event,
    hookPath: 'tool'
  }
  if (step.tool) metadata.toolName = step.tool
  if (step.plan) metadata.plan = step.plan
  return { sessionId, status: step.status, metadata }
}

function process(step: HookStep, sessionId = SESSION): ClaudeCliStatusPayload[] {
  return processClaudeCliHook(sessionId, buildHook(step), buildMapped(sessionId, step))
}

function statuses(payloads: ClaudeCliStatusPayload[]): (SessionStatusType | undefined)[] {
  return payloads.map((p) => p.status)
}

afterEach(() => {
  clearAllClaudeCliInteractions()
})

describe('passthrough when no interactions pending', () => {
  it('publishes non-blocking statuses unchanged', () => {
    expect(statuses(process({ event: 'UserPromptSubmit', status: 'working' }))).toEqual(['working'])
    expect(statuses(process({ event: 'PostToolUse', tool: 'Read', status: 'working' }))).toEqual([
      'working'
    ])
    expect(statuses(process({ event: 'Stop', status: 'completed' }))).toEqual(['completed'])
  })

  it('publishes nothing for unmapped hooks', () => {
    expect(process({ event: 'BogusEvent', status: null })).toEqual([])
  })

  it('passes a stray AskUserQuestion resolution through when nothing is latched', () => {
    expect(
      statuses(process({ event: 'PostToolUse', tool: 'AskUserQuestion', status: 'working' }))
    ).toEqual(['working'])
  })
})

describe('answering latch (the ticket bug)', () => {
  it('suppresses unrelated tool completions while a question is pending', () => {
    expect(
      statuses(process({ event: 'PreToolUse', tool: 'AskUserQuestion', status: 'answering' }))
    ).toEqual(['answering'])
    expect(hasBlockingClaudeCliInteraction(SESSION)).toBe(true)

    // Parallel sub-agent activity must not clobber the question alert.
    expect(process({ event: 'PostToolUse', tool: 'Read', status: 'working' })).toEqual([])
    expect(process({ event: 'PostToolUseFailure', tool: 'Bash', status: 'working' })).toEqual([])
    expect(hasBlockingClaudeCliInteraction(SESSION)).toBe(true)
  })

  it('releases on PostToolUse(AskUserQuestion) and resumes publishing', () => {
    process({ event: 'PreToolUse', tool: 'AskUserQuestion', status: 'answering' })

    const released = process({ event: 'PostToolUse', tool: 'AskUserQuestion', status: 'working' })
    expect(statuses(released)).toEqual(['working'])
    expect(hasBlockingClaudeCliInteraction(SESSION)).toBe(false)

    expect(statuses(process({ event: 'PostToolUse', tool: 'Read', status: 'working' }))).toEqual([
      'working'
    ])
  })

  it('releases on PostToolUseFailure(AskUserQuestion) (question escaped)', () => {
    process({ event: 'PreToolUse', tool: 'AskUserQuestion', status: 'answering' })

    const released = process({
      event: 'PostToolUseFailure',
      tool: 'AskUserQuestion',
      status: 'working'
    })
    expect(statuses(released)).toEqual(['working'])
    expect(hasBlockingClaudeCliInteraction(SESSION)).toBe(false)
  })

  it('keeps the latch while another question with a distinct tool_use_id is outstanding', () => {
    process({ event: 'PreToolUse', tool: 'AskUserQuestion', id: 'q1', status: 'answering' })
    process({ event: 'PreToolUse', tool: 'AskUserQuestion', id: 'q2', status: 'answering' })

    const first = process({
      event: 'PostToolUse',
      tool: 'AskUserQuestion',
      id: 'q1',
      status: 'working'
    })
    // Resolution publishes, then the still-pending question re-surfaces.
    expect(statuses(first)).toEqual(['working', 'answering'])
    expect(first[1].metadata?.reason).toBe('interaction_resurfaced')
    expect(hasBlockingClaudeCliInteraction(SESSION)).toBe(true)

    const second = process({
      event: 'PostToolUse',
      tool: 'AskUserQuestion',
      id: 'q2',
      status: 'working'
    })
    expect(statuses(second)).toEqual(['working'])
    expect(hasBlockingClaudeCliInteraction(SESSION)).toBe(false)
  })

  it('deduplicates PreToolUse + PermissionRequest firing for the same question call', () => {
    process({ event: 'PreToolUse', tool: 'AskUserQuestion', id: 'q1', status: 'answering' })
    process({ event: 'PermissionRequest', tool: 'AskUserQuestion', id: 'q1', status: 'answering' })

    const released = process({
      event: 'PostToolUse',
      tool: 'AskUserQuestion',
      id: 'q1',
      status: 'working'
    })
    expect(statuses(released)).toEqual(['working'])
    expect(hasBlockingClaudeCliInteraction(SESSION)).toBe(false)
  })

  it('deduplicates the real-world sequence: PreToolUse with id + PermissionRequest without id', () => {
    // Empirically, PreToolUse carries tool_use_id but the paired
    // PermissionRequest for the same question does not.
    process({ event: 'PreToolUse', tool: 'AskUserQuestion', id: 'q1', status: 'answering' })
    process({ event: 'PermissionRequest', tool: 'AskUserQuestion', status: 'answering' })

    const released = process({
      event: 'PostToolUse',
      tool: 'AskUserQuestion',
      id: 'q1',
      status: 'working'
    })
    expect(statuses(released)).toEqual(['working'])
    expect(hasBlockingClaudeCliInteraction(SESSION)).toBe(false)
  })

  it('deduplicates PreToolUse + PermissionRequest double-fire without tool_use_ids', () => {
    process({ event: 'PreToolUse', tool: 'AskUserQuestion', status: 'answering' })
    process({ event: 'PermissionRequest', tool: 'AskUserQuestion', status: 'answering' })

    const released = process({
      event: 'PostToolUse',
      tool: 'AskUserQuestion',
      status: 'working'
    })
    expect(statuses(released)).toEqual(['working'])
    expect(hasBlockingClaudeCliInteraction(SESSION)).toBe(false)
  })
})

describe('permission latch and the pending-interaction queue', () => {
  it('holds a permission request behind a pending question, then re-surfaces it', () => {
    process({ event: 'PreToolUse', tool: 'AskUserQuestion', status: 'answering' })

    // Permission fires while the question is still shown: registered, not published.
    expect(process({ event: 'PermissionRequest', tool: 'Bash', status: 'permission' })).toEqual([])

    const released = process({ event: 'PostToolUse', tool: 'AskUserQuestion', status: 'working' })
    expect(statuses(released)).toEqual(['working', 'permission'])
    expect(released[1].metadata?.toolName).toBe('Bash')
    expect(released[1].metadata?.reason).toBe('interaction_resurfaced')

    expect(statuses(process({ event: 'PostToolUse', tool: 'Bash', status: 'working' }))).toEqual([
      'working'
    ])
    expect(hasBlockingClaudeCliInteraction(SESSION)).toBe(false)
  })

  it('publishes a permission immediately when it is the top pending interaction', () => {
    expect(
      statuses(process({ event: 'PermissionRequest', tool: 'Bash', status: 'permission' }))
    ).toEqual(['permission'])
  })

  it('does not release a permission on an unrelated same-tool completion (tool_use_id mismatch)', () => {
    process({ event: 'PermissionRequest', tool: 'Bash', id: 'p1', status: 'permission' })

    // A parallel sub-agent's Bash call (different id) completes — still latched.
    expect(process({ event: 'PostToolUse', tool: 'Bash', id: 'x9', status: 'working' })).toEqual([])
    expect(hasBlockingClaudeCliInteraction(SESSION)).toBe(true)

    const released = process({ event: 'PostToolUse', tool: 'Bash', id: 'p1', status: 'working' })
    expect(statuses(released)).toEqual(['working'])
    expect(hasBlockingClaudeCliInteraction(SESSION)).toBe(false)
  })

  it('falls back to counting when the release hook lacks a tool_use_id', () => {
    process({ event: 'PermissionRequest', tool: 'Bash', id: 'p1', status: 'permission' })

    const released = process({ event: 'PostToolUse', tool: 'Bash', status: 'working' })
    expect(statuses(released)).toEqual(['working'])
    expect(hasBlockingClaudeCliInteraction(SESSION)).toBe(false)
  })
})

describe('plan_ready latch', () => {
  it('keeps plan_ready surfaced through sub-agent completions until the plan resolves', () => {
    expect(
      statuses(
        process({ event: 'PreToolUse', tool: 'ExitPlanMode', status: 'plan_ready', plan: '# Plan' })
      )
    ).toEqual(['plan_ready'])

    expect(process({ event: 'PostToolUse', tool: 'Task', status: 'working' })).toEqual([])

    const approved = process({ event: 'PostToolUse', tool: 'ExitPlanMode', status: 'working' })
    expect(statuses(approved)).toEqual(['working'])
    expect(approved[0].metadata?.toolName).toBe('ExitPlanMode')
  })

  it('publishes the rejection payload on PostToolUseFailure(ExitPlanMode)', () => {
    process({ event: 'PreToolUse', tool: 'ExitPlanMode', status: 'plan_ready' })

    const rejected = process({
      event: 'PostToolUseFailure',
      tool: 'ExitPlanMode',
      status: 'planning'
    })
    expect(statuses(rejected)).toEqual(['planning'])
    expect(hasBlockingClaudeCliInteraction(SESSION)).toBe(false)
  })

  it('holds a plan registered behind a question and re-surfaces it with its plan text', () => {
    process({ event: 'PreToolUse', tool: 'AskUserQuestion', status: 'answering' })
    expect(
      process({ event: 'PreToolUse', tool: 'ExitPlanMode', status: 'plan_ready', plan: '# P' })
    ).toEqual([])

    const released = process({ event: 'PostToolUse', tool: 'AskUserQuestion', status: 'working' })
    expect(statuses(released)).toEqual(['working', 'plan_ready'])
    expect(released[1].metadata?.plan).toBe('# P')
  })

  it('lets a higher-priority permission surface over a latched plan_ready, then restores it', () => {
    process({ event: 'PreToolUse', tool: 'ExitPlanMode', status: 'plan_ready', plan: '# P' })

    expect(
      statuses(process({ event: 'PermissionRequest', tool: 'Bash', status: 'permission' }))
    ).toEqual(['permission'])

    const released = process({ event: 'PostToolUse', tool: 'Bash', status: 'working' })
    expect(statuses(released)).toEqual(['working', 'plan_ready'])
  })
})

describe('fail-safe clears', () => {
  it.each(['UserPromptSubmit', 'Stop', 'SessionStart', 'SessionEnd'])(
    '%s clears all pending interactions and publishes its own status',
    (event) => {
      process({ event: 'PreToolUse', tool: 'AskUserQuestion', status: 'answering' })
      process({ event: 'PermissionRequest', tool: 'Bash', status: 'permission' })

      const cleared = process({ event, status: event === 'UserPromptSubmit' ? 'working' : 'completed' })
      expect(statuses(cleared)).toEqual([event === 'UserPromptSubmit' ? 'working' : 'completed'])
      expect(hasBlockingClaudeCliInteraction(SESSION)).toBe(false)

      expect(statuses(process({ event: 'PostToolUse', tool: 'Read', status: 'working' }))).toEqual([
        'working'
      ])
    }
  )
})

describe('manual clears and session isolation', () => {
  it('clearClaudeCliInteractions drops only the given session', () => {
    process({ event: 'PreToolUse', tool: 'AskUserQuestion', status: 'answering' })
    process({ event: 'PreToolUse', tool: 'AskUserQuestion', status: 'answering' }, 'other-session')

    clearClaudeCliInteractions(SESSION)
    expect(hasBlockingClaudeCliInteraction(SESSION)).toBe(false)
    expect(hasBlockingClaudeCliInteraction('other-session')).toBe(true)
  })

  it('clearAllClaudeCliInteractions drops everything', () => {
    process({ event: 'PreToolUse', tool: 'AskUserQuestion', status: 'answering' })
    process({ event: 'PreToolUse', tool: 'AskUserQuestion', status: 'answering' }, 'other-session')

    clearAllClaudeCliInteractions()
    expect(hasBlockingClaudeCliInteraction(SESSION)).toBe(false)
    expect(hasBlockingClaudeCliInteraction('other-session')).toBe(false)
  })

  it('keeps sessions independent: a latch in one session never suppresses another', () => {
    process({ event: 'PreToolUse', tool: 'AskUserQuestion', status: 'answering' })

    expect(
      statuses(
        process({ event: 'PostToolUse', tool: 'Read', status: 'working' }, 'other-session')
      )
    ).toEqual(['working'])
  })
})
