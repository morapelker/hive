import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const getSessionMock = vi.fn()
vi.mock('../../db', () => ({
  getDatabase: () => ({ getSession: getSessionMock })
}))

import { CODEX_PLAN_MODE_PREFIX } from '@shared/agent-mode-prefixes'
import {
  buildCodexCliHookArgs,
  clearAllCodexSessionTracking,
  extractProposedPlanText,
  seedCodexSessionTracking,
  setCodexSessionIdSink,
  translateCodexHook
} from '../codex-cli-hooks'

const HIVE_ID = 'hive-1'
const THREAD = '019f0000-0000-7000-8000-000000000001'

let sessionDir: string
let transcriptPath: string

function setHiveMode(mode: string): void {
  getSessionMock.mockReturnValue({ mode })
}

beforeEach(() => {
  clearAllCodexSessionTracking()
  setCodexSessionIdSink(null)
  getSessionMock.mockReset()
  setHiveMode('build')
  sessionDir = mkdtempSync(path.join(tmpdir(), 'codex-hooks-test-'))
  transcriptPath = path.join(sessionDir, 'rollout.jsonl')
})

afterEach(() => {
  clearAllCodexSessionTracking()
  setCodexSessionIdSink(null)
  rmSync(sessionDir, { recursive: true, force: true })
})

describe('buildCodexCliHookArgs', () => {
  it('enables hooks, bypasses hook trust, and wires every pipeline event as -c overrides', () => {
    const args = buildCodexCliHookArgs(4242, HIVE_ID)
    expect(args.slice(0, 3)).toEqual(['--enable', 'hooks', '--dangerously-bypass-hook-trust'])
    const overrides = args.filter((arg) => arg.startsWith('hooks.'))
    expect(overrides.map((o) => o.split('=')[0]).sort()).toEqual([
      'hooks.PermissionRequest',
      'hooks.PostToolUse',
      'hooks.PreToolUse',
      'hooks.SessionStart',
      'hooks.Stop',
      'hooks.UserPromptSubmit'
    ])
    // Each override curls the payload to the per-session codex-hook route, with
    // both a POSIX command and a cmd.exe-compatible commandWindows override.
    for (const override of overrides) {
      expect(override).toContain(`http://127.0.0.1:4242/codex-hook/${HIVE_ID}/`)
      expect(override).toContain("type=\"command\"")
      expect(override).toContain('commandWindows=')
      expect(override).toContain('2>nul') // Windows null redirect + bare echo
      expect(override).toContain("|| echo {}")
    }
    // Questions are the only PreToolUse we need.
    const preToolUse = overrides.find((o) => o.startsWith('hooks.PreToolUse'))
    expect(preToolUse).toContain('matcher="request_user_input"')
  })
})

describe('translateCodexHook', () => {
  it('passes SessionStart through and reports the thread id via the sink', () => {
    const sink = vi.fn()
    setCodexSessionIdSink(sink)
    seedCodexSessionTracking(HIVE_ID, null)

    const hook = translateCodexHook(HIVE_ID, {
      hook_event_name: 'SessionStart',
      session_id: THREAD,
      transcript_path: transcriptPath
    })
    expect(hook).toMatchObject({ hook_event_name: 'SessionStart' })
    expect(sink).toHaveBeenCalledWith(HIVE_ID, THREAD)

    // Unchanged id on later hooks is not re-reported…
    translateCodexHook(HIVE_ID, { hook_event_name: 'Stop', session_id: THREAD })
    expect(sink).toHaveBeenCalledTimes(1)

    // …but a new thread id (e.g. /clear) is.
    translateCodexHook(HIVE_ID, { hook_event_name: 'SessionStart', session_id: 'new-thread' })
    expect(sink).toHaveBeenCalledWith(HIVE_ID, 'new-thread')
  })

  it('drops subagent-scoped hooks entirely', () => {
    expect(
      translateCodexHook(HIVE_ID, {
        hook_event_name: 'Stop',
        session_id: THREAD,
        agent_id: 'collab-1'
      })
    ).toBeNull()
  })

  it('maps request_user_input to AskUserQuestion so the question pipeline latches', () => {
    const pre = translateCodexHook(HIVE_ID, {
      hook_event_name: 'PreToolUse',
      tool_name: 'request_user_input',
      tool_use_id: 'call-1',
      tool_input: { questions: [{ question: 'Which flavor?' }] }
    })
    expect(pre).toMatchObject({
      hook_event_name: 'PreToolUse',
      tool_name: 'AskUserQuestion',
      tool_use_id: 'call-1'
    })

    const post = translateCodexHook(HIVE_ID, {
      hook_event_name: 'PostToolUse',
      tool_name: 'request_user_input',
      tool_use_id: 'call-1'
    })
    expect(post).toMatchObject({ hook_event_name: 'PostToolUse', tool_name: 'AskUserQuestion' })
  })

  it('injects permission_mode plan on UserPromptSubmit for a Hive plan-prefixed prompt', () => {
    setHiveMode('plan')
    const prompt = CODEX_PLAN_MODE_PREFIX + 'Design the feature'
    const hook = translateCodexHook(HIVE_ID, {
      hook_event_name: 'UserPromptSubmit',
      prompt
    })
    expect(hook).toMatchObject({
      hook_event_name: 'UserPromptSubmit',
      prompt,
      permission_mode: 'plan'
    })

    setHiveMode('build')
    const buildHook = translateCodexHook(HIVE_ID, {
      hook_event_name: 'UserPromptSubmit',
      prompt: 'Implement it'
    })
    expect(buildHook?.permission_mode).toBeUndefined()
  })

  it('does NOT mark a raw TUI prompt as plan mode even when the session is persisted as plan', () => {
    // The user typed straight into the yolo codex TUI, so the prompt lacks the
    // codex plan convention; codex can mutate, so it must not report as planning.
    setHiveMode('plan')
    const hook = translateCodexHook(HIVE_ID, {
      hook_event_name: 'UserPromptSubmit',
      prompt: 'just fix the bug directly'
    })
    expect(hook).toMatchObject({
      hook_event_name: 'UserPromptSubmit',
      prompt: 'just fix the bug directly'
    })
    expect(hook?.permission_mode).toBeUndefined()
  })

  it("translates the 'Implement the plan.' approval into PostToolUse(ExitPlanMode) — only in plan mode", () => {
    setHiveMode('plan')
    expect(
      translateCodexHook(HIVE_ID, { hook_event_name: 'UserPromptSubmit', prompt: 'Implement the plan.' })
    ).toMatchObject({ hook_event_name: 'PostToolUse', tool_name: 'ExitPlanMode' })
  })

  it("does NOT convert a literal 'Implement the plan.' typed in build mode (no spurious plan-approved event)", () => {
    setHiveMode('build')
    const hook = translateCodexHook(HIVE_ID, {
      hook_event_name: 'UserPromptSubmit',
      prompt: 'Implement the plan.'
    })
    expect(hook).toMatchObject({ hook_event_name: 'UserPromptSubmit', prompt: 'Implement the plan.' })
    expect(hook?.permission_mode).toBeUndefined()
  })

  it('latches plan_ready from a plan-mode Stop only when a <proposed_plan> block is present', () => {
    setHiveMode('plan')
    const hook = translateCodexHook(HIVE_ID, {
      hook_event_name: 'Stop',
      session_id: THREAD,
      transcript_path: transcriptPath,
      last_assistant_message:
        'Here is my plan.\n<proposed_plan>\n1. Add --version to main.py\n2. Add a test\n</proposed_plan>'
    })
    expect(hook).toMatchObject({
      hook_event_name: 'PermissionRequest',
      tool_name: 'ExitPlanMode',
      tool_input: { plan: '1. Add --version to main.py\n2. Add a test' }
    })
  })

  it('keeps a plan-mode Stop as Stop when the message has no <proposed_plan> (e.g. only a question was asked)', () => {
    setHiveMode('plan')
    expect(
      translateCodexHook(HIVE_ID, {
        hook_event_name: 'Stop',
        session_id: THREAD,
        last_assistant_message: 'Which database should we target?'
      })
    ).toMatchObject({ hook_event_name: 'Stop', last_assistant_message: 'Which database should we target?' })

    expect(
      translateCodexHook(HIVE_ID, { hook_event_name: 'Stop', session_id: THREAD })
    ).toMatchObject({ hook_event_name: 'Stop' })
  })

  it('never latches plan_ready in build mode, even with a <proposed_plan> block', () => {
    setHiveMode('build')
    expect(
      translateCodexHook(HIVE_ID, {
        hook_event_name: 'Stop',
        session_id: THREAD,
        last_assistant_message: 'done <proposed_plan>x</proposed_plan>'
      })
    ).toMatchObject({ hook_event_name: 'Stop' })
  })

  it('returns null for events the pipeline must not see', () => {
    expect(
      translateCodexHook(HIVE_ID, { hook_event_name: 'SubagentStop', session_id: THREAD })
    ).toBeNull()
    expect(translateCodexHook(HIVE_ID, { hook_event_name: 'PreCompact' })).toBeNull()
  })
})

describe('extractProposedPlanText', () => {
  it('extracts the trimmed markdown inside a <proposed_plan> block', () => {
    expect(
      extractProposedPlanText('intro\n<proposed_plan>\n  # Plan\n  - step 1\n</proposed_plan>\noutro')
    ).toBe('# Plan\n  - step 1')
  })

  it('is case-insensitive on the tag', () => {
    expect(extractProposedPlanText('<PROPOSED_PLAN>hi</PROPOSED_PLAN>')).toBe('hi')
  })

  it('returns null when there is no complete block or the block is empty', () => {
    expect(extractProposedPlanText('just a plan, no tags')).toBeNull()
    expect(extractProposedPlanText('<proposed_plan>only an open tag')).toBeNull()
    expect(extractProposedPlanText('<proposed_plan>   </proposed_plan>')).toBeNull()
    expect(extractProposedPlanText(null)).toBeNull()
    expect(extractProposedPlanText(undefined)).toBeNull()
  })

  it('skips an earlier empty or narrated block and returns the first block with content', () => {
    expect(
      extractProposedPlanText(
        "I'll wrap it in <proposed_plan></proposed_plan> tags.\n<proposed_plan>1. real step</proposed_plan>"
      )
    ).toBe('1. real step')
    expect(
      extractProposedPlanText('<proposed_plan>  </proposed_plan> then <proposed_plan>the plan</proposed_plan>')
    ).toBe('the plan')
  })
})
