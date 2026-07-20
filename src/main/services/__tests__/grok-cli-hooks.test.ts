import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildGrokCliHookUrlBase,
  buildGrokHookFileContent,
  clearAllGrokSessionTracking,
  getGrokPlanState,
  seedGrokSessionTracking,
  setGrokSessionIdSink,
  setGrokSessionModeProvider,
  translateGrokHook
} from '../grok-cli-hooks'

const HIVE_ID = 'hive-1'
const ROOT = '019f0000-0000-7000-8000-000000000001'
const CHILD = '019f0000-0000-7000-8000-000000000002'

let sessionDir: string
let transcriptPath: string

beforeEach(() => {
  clearAllGrokSessionTracking()
  setGrokSessionIdSink(null)
  sessionDir = mkdtempSync(path.join(tmpdir(), 'grok-hooks-test-'))
  transcriptPath = path.join(sessionDir, 'updates.jsonl')
})

afterEach(() => {
  clearAllGrokSessionTracking()
  setGrokSessionIdSink(null)
  setGrokSessionModeProvider(null)
  rmSync(sessionDir, { recursive: true, force: true })
})

describe('buildGrokHookFileContent', () => {
  // hookCommand branches on process.platform at call time; stub it so both
  // relay variants are exercised deterministically on any CI host.
  const realPlatform = process.platform
  const setPlatform = (value: NodeJS.Platform): void => {
    Object.defineProperty(process, 'platform', { value, configurable: true })
  }
  afterEach(() => {
    setPlatform(realPlatform)
  })

  it('registers every event the pipeline consumes, with POSIX curl relays gated on HIVE_GROK_HOOK_URL', () => {
    setPlatform('darwin')
    const parsed = JSON.parse(buildGrokHookFileContent()) as {
      hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>>
    }
    expect(Object.keys(parsed.hooks).sort()).toEqual([
      'Notification',
      'PostToolUse',
      'PostToolUseFailure',
      'PreToolUse',
      'SessionEnd',
      'SessionStart',
      'Stop',
      'SubagentStop',
      'UserPromptSubmit'
    ])
    // Notifications are permission dialogs only.
    expect(parsed.hooks.Notification[0].matcher).toBe('permission_prompt')
    for (const [, entries] of Object.entries(parsed.hooks)) {
      const command = entries[0].hooks[0].command
      expect(command).toContain('printenv HIVE_GROK_HOOK_URL')
      expect(command).toContain('curl')
      // No bare $VAR tokens that grok's load-time expansion could blank out.
      expect(command).not.toMatch(/\$HIVE_GROK_HOOK_URL/)
    }
  })

  it('emits cmd.exe relays with runtime %VAR% expansion on win32', () => {
    setPlatform('win32')
    const parsed = JSON.parse(buildGrokHookFileContent()) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>
    }
    for (const [, entries] of Object.entries(parsed.hooks)) {
      const command = entries[0].hooks[0].command
      expect(command).toContain('if not defined HIVE_GROK_HOOK_URL')
      expect(command).toContain('"%HIVE_GROK_HOOK_URL%/')
      expect(command).toContain('curl')
      // POSIX-isms must not leak into the cmd variant.
      expect(command).not.toContain('printenv')
      expect(command).not.toMatch(/\$\{?HIVE_GROK_HOOK_URL/)
    }
  })
})

describe('getGrokPlanState', () => {
  it('reads Active/Inactive from plan_mode.json and reports unknown for unseen session dirs', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'grok-home-test-'))
    const spawnEnv = { GROK_HOME: home }
    const worktree = '/repo/my feature' // space exercises percent-encoding
    const dir = path.join(home, 'sessions', encodeURIComponent(worktree), ROOT)
    mkdirSync(dir, { recursive: true })

    // Session dir exists but plan never armed → inactive (safe to toggle).
    expect(getGrokPlanState(worktree, ROOT, spawnEnv)).toBe('inactive')

    writeFileSync(path.join(dir, 'plan_mode.json'), JSON.stringify({ state: 'Active' }))
    expect(getGrokPlanState(worktree, ROOT, spawnEnv)).toBe('active')

    writeFileSync(path.join(dir, 'plan_mode.json'), JSON.stringify({ state: 'Inactive' }))
    expect(getGrokPlanState(worktree, ROOT, spawnEnv)).toBe('inactive')

    // Session dir we can't see (encoding drift, relocated home) → unknown.
    expect(getGrokPlanState(worktree, CHILD, spawnEnv)).toBe('unknown')

    rmSync(home, { recursive: true, force: true })
  })

  it("resolves session dirs whose cwd contains !'()* (grok encodes beyond encodeURIComponent)", () => {
    const home = mkdtempSync(path.join(tmpdir(), 'grok-home-test-'))
    const spawnEnv = { GROK_HOME: home }
    const worktree = "/repo/it's (v2)!*"
    // Grok writes the dir name percent-encoded to RFC3986 unreserved chars
    // only; encodeURIComponent alone would leave !'()* bare and miss the dir.
    const encoded = '%2Frepo%2Fit%27s%20%28v2%29%21%2A'
    const dir = path.join(home, 'sessions', encoded, ROOT)
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'plan_mode.json'), JSON.stringify({ state: 'Active' }))

    expect(getGrokPlanState(worktree, ROOT, spawnEnv)).toBe('active')

    rmSync(home, { recursive: true, force: true })
  })
})

describe('buildGrokCliHookUrlBase', () => {
  it('embeds port and encoded hive session id under the grok-hook prefix', () => {
    expect(buildGrokCliHookUrlBase(4242, 'a/b')).toBe('http://127.0.0.1:4242/grok-hook/a%2Fb')
  })
})

describe('translateGrokHook', () => {
  it('maps lifecycle events to claude hook names and reports the root session id once', () => {
    const sink = vi.fn()
    setGrokSessionIdSink(sink)
    seedGrokSessionTracking(HIVE_ID, null)

    const start = translateGrokHook(HIVE_ID, {
      hookEventName: 'session_start',
      sessionId: ROOT,
      source: 'new'
    })
    expect(start?.hook_event_name).toBe('SessionStart')
    expect(sink).toHaveBeenCalledOnce()
    expect(sink).toHaveBeenCalledWith(HIVE_ID, ROOT)

    const stop = translateGrokHook(HIVE_ID, { hookEventName: 'stop', sessionId: ROOT })
    expect(stop?.hook_event_name).toBe('Stop')
    expect(stop?.agent_id).toBeUndefined()
    expect(sink).toHaveBeenCalledTimes(1)
  })

  it('unwraps <user_query> tags and injects the seeded plan permission mode', () => {
    seedGrokSessionTracking(HIVE_ID, ROOT, { planMode: true })
    const hook = translateGrokHook(HIVE_ID, {
      hookEventName: 'user_prompt_submit',
      sessionId: ROOT,
      prompt: '<user_query>\nfix the bug\n</user_query>'
    })
    expect(hook?.prompt).toBe('fix the bug')
    expect(hook?.permission_mode).toBe('plan')
  })

  it('keeps mapping prompts to plan across tool turns — grok reports the mode ARMED UNDERNEATH', () => {
    seedGrokSessionTracking(HIVE_ID, ROOT, { planMode: true })
    // During an active plan session, pre_tool_use reports bypassPermissions
    // (always-approve armed underneath); that must not end the plan signal —
    // otherwise the second planning round maps to 'working' and the renderer
    // treats plan feedback as an implement turn.
    translateGrokHook(HIVE_ID, {
      hookEventName: 'pre_tool_use',
      sessionId: ROOT,
      toolName: 'run_terminal_command',
      toolUseId: 'call-1',
      permissionMode: 'bypassPermissions'
    })
    const followup = translateGrokHook(HIVE_ID, {
      hookEventName: 'user_prompt_submit',
      sessionId: ROOT,
      prompt: 'plan revision notes'
    })
    expect(followup?.permission_mode).toBe('plan')
  })

  it('ends the plan signal on approved exit_plan_mode and restarts it on enter_plan_mode', () => {
    seedGrokSessionTracking(HIVE_ID, ROOT, { planMode: true })
    translateGrokHook(HIVE_ID, {
      hookEventName: 'pre_tool_use',
      sessionId: ROOT,
      toolName: 'run_terminal_command',
      toolUseId: 'call-0',
      permissionMode: 'bypassPermissions'
    })

    // Rejected plan (revisions requested) → still planning.
    translateGrokHook(HIVE_ID, {
      hookEventName: 'post_tool_use_failure',
      sessionId: ROOT,
      toolName: 'exit_plan_mode',
      toolUseId: 'call-r'
    })
    expect(
      translateGrokHook(HIVE_ID, {
        hookEventName: 'user_prompt_submit',
        sessionId: ROOT,
        prompt: 'more revisions'
      })?.permission_mode
    ).toBe('plan')

    // Approved plan → implementation prompts map off the live mode.
    translateGrokHook(HIVE_ID, {
      hookEventName: 'post_tool_use',
      sessionId: ROOT,
      toolName: 'exit_plan_mode',
      toolUseId: 'call-a'
    })
    expect(
      translateGrokHook(HIVE_ID, {
        hookEventName: 'user_prompt_submit',
        sessionId: ROOT,
        prompt: 'implement it'
      })?.permission_mode
    ).toBe('bypassPermissions')

    // Agent re-enters plan mode mid-session (approved enter_plan_mode).
    translateGrokHook(HIVE_ID, {
      hookEventName: 'post_tool_use',
      sessionId: ROOT,
      toolName: 'enter_plan_mode',
      toolUseId: 'call-e'
    })
    expect(
      translateGrokHook(HIVE_ID, {
        hookEventName: 'user_prompt_submit',
        sessionId: ROOT,
        prompt: 'plan again'
      })?.permission_mode
    ).toBe('plan')
  })

  it('reconciles Hive-side mode switches: a CHANGED db mode overrides the hook-derived plan state', () => {
    let dbMode = 'plan'
    setGrokSessionModeProvider(() => dbMode)
    seedGrokSessionTracking(HIVE_ID, ROOT, { planMode: true, dbMode: 'plan' })

    // Unchanged db mode → grok-driven state stays in charge.
    expect(
      translateGrokHook(HIVE_ID, {
        hookEventName: 'user_prompt_submit',
        sessionId: ROOT,
        prompt: 'first round'
      })?.permission_mode
    ).toBe('plan')

    // User flips the session to build in Hive (setSessionMode persists mode
    // and only sends Shift+Tab to the TUI — no hook fires).
    dbMode = 'build'
    expect(
      translateGrokHook(HIVE_ID, {
        hookEventName: 'user_prompt_submit',
        sessionId: ROOT,
        prompt: 'implement instead'
      })?.permission_mode
    ).toBeUndefined()

    // ...and back to plan.
    dbMode = 'plan'
    expect(
      translateGrokHook(HIVE_ID, {
        hookEventName: 'user_prompt_submit',
        sessionId: ROOT,
        prompt: 'actually plan more'
      })?.permission_mode
    ).toBe('plan')

    // Grok-driven approval still ends the plan while the db mode is unchanged
    // (the renderer's own build-persist lands moments later).
    translateGrokHook(HIVE_ID, {
      hookEventName: 'post_tool_use',
      sessionId: ROOT,
      toolName: 'exit_plan_mode',
      toolUseId: 'call-ok'
    })
    expect(
      translateGrokHook(HIVE_ID, {
        hookEventName: 'user_prompt_submit',
        sessionId: ROOT,
        prompt: 'post-approval'
      })?.permission_mode
    ).toBeUndefined()
  })

  it('maps grok tool names to their claude equivalents', () => {
    seedGrokSessionTracking(HIVE_ID, ROOT)
    const hook = translateGrokHook(HIVE_ID, {
      hookEventName: 'pre_tool_use',
      sessionId: ROOT,
      toolName: 'ask_user_question',
      toolUseId: 'call-q',
      toolInput: { questions: [] }
    })
    expect(hook?.hook_event_name).toBe('PreToolUse')
    expect(hook?.tool_name).toBe('AskUserQuestion')
    expect(hook?.tool_use_id).toBe('call-q')
  })

  it('pairs permission_prompt notifications with the preceding pre_tool_use', () => {
    seedGrokSessionTracking(HIVE_ID, ROOT)
    translateGrokHook(HIVE_ID, {
      hookEventName: 'pre_tool_use',
      sessionId: ROOT,
      toolName: 'run_terminal_command',
      toolUseId: 'call-2'
    })
    const permission = translateGrokHook(HIVE_ID, {
      hookEventName: 'notification',
      sessionId: ROOT,
      notificationType: 'permission_prompt',
      message: 'Tool permission requested'
    })
    expect(permission?.hook_event_name).toBe('PermissionRequest')
    expect(permission?.tool_name).toBe('run_terminal_command')
    expect(permission?.tool_use_id).toBe('call-2')
  })

  it('drops non-permission notifications', () => {
    seedGrokSessionTracking(HIVE_ID, ROOT)
    expect(
      translateGrokHook(HIVE_ID, {
        hookEventName: 'notification',
        sessionId: ROOT,
        notificationType: 'elicitation_dialog',
        message: 'User question requested'
      })
    ).toBeNull()
  })

  it('reads plan.md for exit_plan_mode (empty toolInput on grok)', () => {
    seedGrokSessionTracking(HIVE_ID, ROOT)
    writeFileSync(path.join(sessionDir, 'plan.md'), '# The plan\ndo it\n')
    const hook = translateGrokHook(HIVE_ID, {
      hookEventName: 'pre_tool_use',
      sessionId: ROOT,
      toolName: 'exit_plan_mode',
      toolUseId: 'call-3',
      toolInput: {},
      transcriptPath
    })
    expect(hook?.tool_name).toBe('ExitPlanMode')
    expect(hook?.tool_input).toEqual({ plan: '# The plan\ndo it' })
  })

  it('marks events from other grok session ids as subagent-scoped and drops their lifecycle', () => {
    seedGrokSessionTracking(HIVE_ID, ROOT)
    translateGrokHook(HIVE_ID, { hookEventName: 'session_start', sessionId: ROOT, source: 'new' })

    expect(
      translateGrokHook(HIVE_ID, { hookEventName: 'session_start', sessionId: CHILD })
    ).toBeNull()
    expect(
      translateGrokHook(HIVE_ID, {
        hookEventName: 'user_prompt_submit',
        sessionId: CHILD,
        prompt: 'child turn'
      })
    ).toBeNull()

    const childStop = translateGrokHook(HIVE_ID, { hookEventName: 'stop', sessionId: CHILD })
    expect(childStop?.hook_event_name).toBe('Stop')
    expect(childStop?.agent_id).toBe(CHILD)
  })

  it('adopts the first seen session id as root when spawned without a resume id', () => {
    const sink = vi.fn()
    setGrokSessionIdSink(sink)
    seedGrokSessionTracking(HIVE_ID, null)
    const hook = translateGrokHook(HIVE_ID, {
      hookEventName: 'user_prompt_submit',
      sessionId: ROOT,
      prompt: 'hello'
    })
    expect(hook?.hook_event_name).toBe('UserPromptSubmit')
    expect(sink).toHaveBeenCalledWith(HIVE_ID, ROOT)
  })

  it('never adopts root from tool/subagent hooks — only session_start / user_prompt_submit', () => {
    const sink = vi.fn()
    setGrokSessionIdSink(sink)
    seedGrokSessionTracking(HIVE_ID, null)

    // A stray tool hook (e.g. a subagent's) arriving before the root is known
    // must not become the root — later root hooks would all be mis-scoped.
    translateGrokHook(HIVE_ID, {
      hookEventName: 'pre_tool_use',
      sessionId: CHILD,
      toolName: 'run_terminal_command',
      toolUseId: 'call-x'
    })
    translateGrokHook(HIVE_ID, { hookEventName: 'subagent_stop', sessionId: CHILD })
    expect(sink).not.toHaveBeenCalled()

    const start = translateGrokHook(HIVE_ID, {
      hookEventName: 'session_start',
      sessionId: ROOT,
      source: 'new'
    })
    expect(start?.hook_event_name).toBe('SessionStart')
    expect(sink).toHaveBeenCalledOnce()
    expect(sink).toHaveBeenCalledWith(HIVE_ID, ROOT)

    const stop = translateGrokHook(HIVE_ID, { hookEventName: 'stop', sessionId: ROOT })
    expect(stop?.agent_id).toBeUndefined()
  })

  it('passes tool inputs through (ask_user_question questions reach the pipeline)', () => {
    seedGrokSessionTracking(HIVE_ID, ROOT)
    const questions = [{ question: 'Which color?', options: [{ label: 'Red' }] }]
    const pre = translateGrokHook(HIVE_ID, {
      hookEventName: 'pre_tool_use',
      sessionId: ROOT,
      toolName: 'ask_user_question',
      toolUseId: 'call-q2',
      toolInput: { questions }
    })
    expect(pre?.tool_input).toEqual({ questions })

    // The synthesized PermissionRequest carries the paired tool's input too.
    const permission = translateGrokHook(HIVE_ID, {
      hookEventName: 'notification',
      sessionId: ROOT,
      notificationType: 'permission_prompt',
      message: 'Tool permission requested'
    })
    expect(permission?.tool_name).toBe('AskUserQuestion')
    expect(permission?.tool_input).toEqual({ questions })
  })
})
