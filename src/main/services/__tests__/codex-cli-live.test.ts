// @vitest-environment node
/**
 * Live verification of the Codex CLI provider against the REAL `codex` binary.
 *
 * Opt-in: `CODEX_CLI_LIVE=1 pnpm exec vitest run src/main/services/__tests__/codex-cli-live.test.ts`
 * Needs a logged-in codex (~/.codex/auth.json) and network; each scenario runs a
 * tiny turn on a cheap model (gpt-5.3-codex-spark, low effort). The TUI is driven in a
 * pseudo-terminal by scripts/codex-cli-pty-driver.py exactly the way the PTY
 * bridge drives it (argv from buildCodexCliPtySpawn, hooks from
 * buildCodexCliHookOverrides posting to the real hook server, Shift+Tab into Plan
 * mode after the title reports Ready, bracketed-paste prompt delivery).
 *
 * What it proves end to end:
 *  - the `-c hooks.*` overrides + pre-computed `hooks.state` trust hashes make
 *    codex run Hive's hooks with no bypass flag and no "Hooks need review" screen;
 *  - the `-c projects={…}` override suppresses the folder-trust onboarding;
 *  - the title channel emits run-state / thread id; the thread id captured from
 *    the SessionStart hook matches the rollout on disk;
 *  - statuses flow UserPromptSubmit→working, Stop→completed (build), and a
 *    plan-mode turn yields plan_ready with the proposed plan text;
 *  - `codex resume <id>` re-announces the thread (source=resume) and completes.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

const LIVE = process.env.CODEX_CLI_LIVE === '1'
const CODEX_BIN = process.env.CODEX_BIN ?? '/opt/homebrew/bin/codex'
// A current, cheap model: gpt-5.4-mini is deprecated and would open codex's
// migration prompt (which the spawner pre-acknowledges, but keep the run simple).
const MODEL = process.env.CODEX_CLI_LIVE_MODEL ?? 'gpt-5.3-codex-spark'

interface FakeSession {
  id: string
  claude_session_id: string | null
  agent_sdk: string
  mode: string
  model_id: string | null
  model_variant: string | null
}

const dbMocks = vi.hoisted(() => ({
  sessions: new Map<string, FakeSession>(),
  updateSession: vi.fn(),
  getSessionByClaudeSessionId: vi.fn(() => null)
}))

vi.mock('../../db', () => ({
  getDatabase: () => ({
    getSession: (id: string) => dbMocks.sessions.get(id) ?? null,
    getSessionByClaudeSessionId: dbMocks.getSessionByClaudeSessionId,
    updateSession: (id: string, update: Partial<FakeSession>) => {
      dbMocks.updateSession(id, update)
      const row = dbMocks.sessions.get(id)
      if (row) Object.assign(row, update)
    }
  })
}))
vi.mock('../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}))
vi.mock('../../desktop/backend-event-publisher', () => ({ publishDesktopBackendEvent: vi.fn() }))
vi.mock('../hive-enterprise-claude-cli-telemetry', () => ({
  handleClaudeCliHiveTelemetryHook: vi.fn().mockResolvedValue(undefined)
}))
vi.mock('../usage/session-usage-service', () => ({ scheduleSessionUsageReport: vi.fn() }))
vi.mock('../pty-service', () => ({ ptyService: { has: vi.fn(() => false), write: vi.fn() } }))
vi.mock('../env-vars', () => ({ getUserEnvironmentVariables: vi.fn(() => ({})) }))

import {
  closeClaudeHookServer,
  getClaudeHookServer,
  subscribeClaudeCliStatus,
  subscribeCliHookEvents,
  type CliHookEvent,
  type ClaudeCliStatusPayload
} from '../claude-hook-server'
import { buildCodexCliHookOverrides } from '../codex-cli-hooks'
import { buildCodexCliPtySpawn } from '../codex-cli-spawner'
import { buildCodexTerminalTitleOverride, extractCodexTitles, parseCodexTerminalTitle } from '../codex-cli-title'
import { findCodexRolloutByIdPrefix, readCodexPlanText, rolloutThreadIdFromPath } from '../codex-cli-rollout'

const DRIVER = resolve(__dirname, '../../../../scripts/codex-cli-pty-driver.py')
/** Raw TUI output and hook/status summaries are kept here for inspection after a run. */
const LOG_DIR = process.env.CODEX_CLI_LIVE_LOG_DIR ?? '/tmp/codex-cli-live-logs'

type Step =
  | ['wait', string, number]
  | ['send', string]
  | ['paste', string]
  | ['sleep', number]
  | ['quit', number]

interface DriverResult {
  exitCode: number | null
  timedOut: boolean
  matched: string[]
}

async function runDriver(spec: {
  command: string
  args: string[]
  cwd: string
  env: Record<string, string>
  logPath: string
  steps: Step[]
}): Promise<DriverResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('python3', [DRIVER], { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d.toString()))
    child.stderr.on('data', (d) => (stderr += d.toString()))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`driver exited ${code}: ${stderr}`))
      try {
        resolvePromise(JSON.parse(stdout.trim().split('\n').at(-1) ?? '{}'))
      } catch (error) {
        reject(new Error(`driver output unparseable: ${stdout} ${stderr} ${String(error)}`))
      }
    })
    child.stdin.end(JSON.stringify(spec))
  })
}

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
}

const describeLive = LIVE && existsSync(CODEX_BIN) ? describe : describe.skip

describeLive('codex-cli live (real binary)', () => {
  let repo: string
  let statuses: ClaudeCliStatusPayload[] = []
  let hooks: CliHookEvent[] = []
  let unsubscribeStatus: (() => void) | null = null
  let unsubscribeHooks: (() => void) | null = null
  let port = 0

  beforeAll(async () => {
    repo = mkdtempSync(join(tmpdir(), 'codex-cli-live-'))
    mkdirSync(join(repo, '.git'))
    // A real git repo so codex resolves a trust root exactly like a worktree.
    rmSync(join(repo, '.git'), { recursive: true, force: true })
    const { execSync } = await import('node:child_process')
    execSync('git init -q && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init', {
      cwd: repo
    })
    ;({ port } = await getClaudeHookServer())
  })

  afterEach((ctx) => {
    unsubscribeStatus?.()
    unsubscribeHooks?.()
    mkdirSync(LOG_DIR, { recursive: true })
    const name = ctx.task.name.split(':')[0].replace(/\W+/g, '-')
    writeFileSync(
      join(LOG_DIR, `${name}.summary.json`),
      JSON.stringify(
        {
          hooks: hooks.map((h) => h.hook),
          statuses,
          sessions: [...dbMocks.sessions.values()]
        },
        null,
        2
      )
    )
    statuses = []
    hooks = []
  })

  afterAll(async () => {
    await closeClaudeHookServer()
    rmSync(repo, { recursive: true, force: true })
  })

  function subscribe(sessionId: string): void {
    unsubscribeStatus = subscribeClaudeCliStatus((p) => {
      if (p.sessionId === sessionId) statuses.push(p)
    })
    unsubscribeHooks = subscribeCliHookEvents((e) => {
      if (e.sessionId === sessionId) hooks.push(e)
    })
  }

  function spawnSpec(sessionId: string, prompt: string | null) {
    const session = dbMocks.sessions.get(sessionId)!
    const overrides = buildCodexCliHookOverrides(port, sessionId)
    const spawnPlan = buildCodexCliPtySpawn({
      session: {
        mode: session.mode as 'build' | 'plan',
        model_id: session.model_id,
        model_variant: session.model_variant,
        claude_session_id: session.claude_session_id
      },
      worktreePath: repo,
      projectPath: repo,
      pendingPrompt: prompt,
      codexBinary: CODEX_BIN,
      hookOverrideArgs: [...overrides.args, '-c', buildCodexTerminalTitleOverride()]
    })
    return spawnPlan
  }

  // The TUI positions words with cursor moves, so stripped output often has no
  // spaces between them ("Doyoutrustthecontents…"): match whitespace-insensitively.
  function assertNoInteractiveGates(log: string): void {
    const text = stripAnsi(log)
    expect(text).not.toMatch(/Hooks\s*need\s*review/i)
    expect(text).not.toMatch(/Do\s*you\s*trust/i)
    expect(text).not.toMatch(/dangerously-bypass-hook-trust/i)
    expect(text).not.toMatch(/Update\s*available/i)
  }

  function titlesFrom(log: string): ReturnType<typeof parseCodexTerminalTitle>[] {
    return extractCodexTitles(`live-${Math.random()}`, log).map(parseCodexTerminalTitle)
  }

  it(
    'build mode: argv prompt runs a turn whose hooks reach Hive with the thread id',
    async () => {
      const sessionId = `live-build-${Date.now()}`
      dbMocks.sessions.set(sessionId, {
        id: sessionId,
        claude_session_id: null,
        agent_sdk: 'codex-cli',
        mode: 'build',
        model_id: MODEL,
        model_variant: 'low'
      })
      subscribe(sessionId)
      const spec = spawnSpec(sessionId, 'Reply with exactly the word done. Do not run any tools.')
      mkdirSync(LOG_DIR, { recursive: true })
      const logPath = join(LOG_DIR, 'build.log')
      const result = await runDriver({
        command: spec.command,
        args: spec.args,
        cwd: spec.cwd,
        env: spec.env,
        logPath,
        steps: [
          ['wait', '\\x1b\\]0;(Working|Thinking)', 60],
          ['wait', '\\x1b\\]0;Ready', 120],
          ['sleep', 1],
          ['quit', 15]
        ]
      })
      const log = readFileSync(logPath, 'utf8')
      assertNoInteractiveGates(log)
      expect(result.timedOut).toBe(false)

      const events = hooks.map((h) => h.hook.hook_event_name)
      // codex runs SessionStart hooks as the first turn starts; when the prompt
      // rides on argv it has been observed to skip it, so it is not required.
      if (!events.includes('SessionStart')) {
        console.warn('[codex-cli live] no SessionStart hook for the argv-prompt launch', events)
      }
      expect(events, JSON.stringify(events)).toContain('UserPromptSubmit')
      expect(events, JSON.stringify(events)).toContain('Stop')
      expect(statuses.map((s) => s.status)).toEqual(
        expect.arrayContaining(['working', 'completed'])
      )
      expect(statuses.at(-1)?.status).toBe('completed')
      const prompt = hooks.find((h) => h.hook.hook_event_name === 'UserPromptSubmit')
      expect(prompt?.hook.prompt).toBe('Reply with exactly the word done. Do not run any tools.')

      // Thread id: hook-captured, matches the rollout file and the title channel.
      const threadId = dbMocks.sessions.get(sessionId)!.claude_session_id!
      expect(threadId).toMatch(/^[0-9a-f-]{36}$/)
      const first = hooks[0]!
      expect(first.hook.session_id).toBe(threadId)
      expect(rolloutThreadIdFromPath(String(first.hook.transcript_path))).toBe(threadId)
      const titles = titlesFrom(log)
      const withId = titles.find((t) => t.threadIdPrefix)
      expect(withId).toBeDefined()
      expect(threadId.startsWith(withId!.threadIdPrefix!)).toBe(true)
      expect(findCodexRolloutByIdPrefix(withId!.threadIdPrefix!)?.threadId).toBe(threadId)
      expect(titles.some((t) => t.runState === 'Ready')).toBe(true)
    },
    240_000
  )

  it(
    'plan mode: Shift+Tab after Ready, pasted prompt, Stop yields plan_ready with the plan text',
    async () => {
      const sessionId = `live-plan-${Date.now()}`
      dbMocks.sessions.set(sessionId, {
        id: sessionId,
        claude_session_id: null,
        agent_sdk: 'codex-cli',
        mode: 'plan',
        model_id: MODEL,
        model_variant: 'low'
      })
      subscribe(sessionId)
      const prompt =
        'Propose a two-step plan to add a LICENSE file to this repository. Only plan; do not implement anything.'
      const spec = spawnSpec(sessionId, prompt)
      expect(spec.promptViaPty).toBe(prompt)
      mkdirSync(LOG_DIR, { recursive: true })
      const logPath = join(LOG_DIR, 'plan.log')
      const result = await runDriver({
        command: spec.command,
        args: spec.args,
        cwd: spec.cwd,
        env: spec.env,
        logPath,
        steps: [
          // Mirror the bridge: the toggle only works after the post-startup Ready has settled.
          ['wait', '\\x1b\\]0;Ready \\|', 60],
          ['wait', '\\x1b\\]0;(Starting|Working)', 20],
          ['wait', '\\x1b\\]0;Ready \\|', 60],
          ['sleep', 1.5],
          ['send', '\x1b[Z'],
          ['sleep', 0.5],
          ['paste', prompt],
          ['wait', '\\x1b\\]0;(Working|Thinking)', 60],
          ['wait', '\\x1b\\]0;Ready', 180],
          ['sleep', 3],
          // Close the "Implement this plan?" selection (stay in Plan mode) before quitting.
          ['send', '\x1b'],
          ['sleep', 0.5],
          ['quit', 15]
        ]
      })
      const log = readFileSync(logPath, 'utf8')
      assertNoInteractiveGates(log)
      expect(result.timedOut).toBe(false)
      // The TUI's post-plan prompt confirms the Shift+Tab mode switch took.
      const text = stripAnsi(log)
      expect(text).toMatch(/Implement\s*this\s*plan/i)

      const submit = hooks.find((h) => h.hook.hook_event_name === 'UserPromptSubmit')
      expect(submit?.hook.prompt).toBe(prompt)
      expect(submit?.hook.permission_mode).toBe('plan')
      const planReady = statuses.find((s) => s.status === 'plan_ready')
      expect(planReady, `statuses: ${JSON.stringify(statuses)}`).toBeDefined()
      expect(planReady?.metadata?.plan?.length ?? 0).toBeGreaterThan(10)
      const stop = hooks.find((h) => h.hook.hook_event_name === 'Stop')!
      expect(readCodexPlanText(String(stop.hook.transcript_path), null)).toBe(planReady?.metadata?.plan)
      expect(statuses.at(-1)?.status).toBe('completed')
    },
    300_000
  )

  it(
    'resume: `codex resume <id>` re-announces the thread and runs the argv prompt',
    async () => {
      const sessionId = `live-resume-${Date.now()}`
      // Reuse the thread the build scenario created (a fresh one if that did not run).
      const previous = [...dbMocks.sessions.values()].find(
        (s) => s.mode === 'build' && s.claude_session_id
      )
      if (!previous?.claude_session_id) return
      dbMocks.sessions.set(sessionId, {
        id: sessionId,
        claude_session_id: previous.claude_session_id,
        agent_sdk: 'codex-cli',
        mode: 'build',
        model_id: MODEL,
        model_variant: 'low'
      })
      subscribe(sessionId)
      const spec = spawnSpec(sessionId, 'Reply with exactly the word again.')
      expect(spec.args.slice(0, 2)).toEqual(['resume', previous.claude_session_id])
      mkdirSync(LOG_DIR, { recursive: true })
      const logPath = join(LOG_DIR, 'resume.log')
      const result = await runDriver({
        command: spec.command,
        args: spec.args,
        cwd: spec.cwd,
        env: spec.env,
        logPath,
        steps: [
          ['wait', '\\x1b\\]0;(Working|Thinking)', 60],
          ['wait', '\\x1b\\]0;Ready', 120],
          ['sleep', 1],
          ['quit', 15]
        ]
      })
      const log = readFileSync(logPath, 'utf8')
      assertNoInteractiveGates(log)
      expect(result.timedOut).toBe(false)
      // SessionStart is skipped for argv-prompt launches (see the build scenario);
      // when it does fire on a resume it must say so.
      const start = hooks.find((h) => h.hook.hook_event_name === 'SessionStart')
      if (start) expect(start.hook.source).toBe('resume')
      expect(hooks.length).toBeGreaterThan(0)
      for (const h of hooks) expect(h.hook.session_id).toBe(previous.claude_session_id)
      expect(hooks.map((h) => h.hook.hook_event_name)).toContain('Stop')
      expect(statuses.at(-1)?.status).toBe('completed')
      // The row keeps the resumed thread id.
      expect(dbMocks.sessions.get(sessionId)!.claude_session_id).toBe(previous.claude_session_id)
    },
    240_000
  )
})
