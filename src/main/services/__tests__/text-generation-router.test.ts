// @vitest-environment node
import { tmpdir } from 'node:os'
import { Effect, Layer } from 'effect'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Spawn } from '../../effect/spawn/service'
import type { RunOnceResult, SpawnOptions } from '../../effect/spawn/types'

const spawnMocks = vi.hoisted(() => ({
  runs: [] as SpawnOptions[],
  result: { stdout: '', stderr: '', exitCode: 0 } as RunOnceResult
}))

const claudeBinaryMocks = vi.hoisted(() => ({
  resolve: vi.fn<() => string | null>(() => null)
}))

vi.mock('../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}))

vi.mock('../system-info', () => ({
  // Every provider is installed: each test asks for the one it exercises, nothing falls back.
  detectAgentSdks: () => ({ claude: true, codex: true, opencode: true })
}))

vi.mock('../codex-binary-resolver', () => ({
  resolveCodexBinaryPath: () => '/usr/local/bin/codex'
}))

vi.mock('../claude-binary-resolver', () => ({
  resolveClaudeBinaryPath: claudeBinaryMocks.resolve
}))

vi.mock('../codex-cli-env', () => ({
  getCodexCliEnv: () => ({ PATH: '/usr/local/bin' })
}))

vi.mock('../claude-sdk-loader', () => ({
  loadClaudeSDK: vi.fn()
}))

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  return {
    ...actual,
    writeFile: vi.fn(async () => undefined),
    readFile: vi.fn(async () => '{"ok":true}'),
    unlink: vi.fn(async () => undefined)
  }
})

vi.mock('../../effect/spawn/runtime', () => ({
  getRuntime: () => ({
    runPromise: <A>(effect: Effect.Effect<A, unknown, Spawn>): Promise<A> =>
      Effect.runPromise(
        effect.pipe(
          Effect.provide(
            Layer.succeed(Spawn, {
              runOnce: (options: SpawnOptions) => {
                spawnMocks.runs.push(options)
                return Effect.succeed(spawnMocks.result)
              },
              stream: () => {
                throw new Error('not used')
              }
            })
          )
        )
      )
  })
}))

import { loadClaudeSDK } from '../claude-sdk-loader'
import { generateText, setClaudeBinaryPath } from '../text-generation-router'

const PROMPT = 'Cut this into tickets.'
const SYSTEM_PROMPT = 'You are an extractor.'

async function* asyncIterableOf<T>(items: T[]): AsyncGenerator<T> {
  for (const item of items) yield item
}

type ClaudeQueryInput = { prompt: string; options: Record<string, unknown> }

/** A Claude SDK whose one query answers with `result` and records what it was asked. */
function mockClaudeSdk(
  result: string
): ReturnType<typeof vi.fn<(input: ClaudeQueryInput) => unknown>> {
  const query = vi.fn((_input: ClaudeQueryInput) =>
    asyncIterableOf([{ type: 'result', subtype: 'success', result }])
  )
  vi.mocked(loadClaudeSDK).mockResolvedValue({ query } as never)
  return query
}

/** One opencode JSON event line carrying `text`. */
const openCodeTextEvent = (text: string): string => `${JSON.stringify({ type: 'text', text })}\n`

afterEach(() => {
  spawnMocks.runs.length = 0
  spawnMocks.result = { stdout: '', stderr: '', exitCode: 0 }
  vi.mocked(loadClaudeSDK).mockReset()
  claudeBinaryMocks.resolve.mockReset().mockReturnValue(null)
  setClaudeBinaryPath(null)
})

describe('generateText with codex', () => {
  it('runs codex exec outside a repository, read-only and ephemeral, with the prompt on stdin', async () => {
    const reply = await generateText('Cut this into tickets.', 'You are an extractor.', 'codex', {
      modelOverride: 'gpt-5.4-mini',
      effort: 'low',
      outputSchema: '{"type":"object"}',
      cwd: tmpdir(),
      timeoutMs: 1234,
      maxRetries: 0
    })

    expect(reply).toBe('{"ok":true}')
    expect(spawnMocks.runs).toHaveLength(1)
    const [run] = spawnMocks.runs
    expect(run.command).toBe('/usr/local/bin/codex')
    // The one-shot calls run in a temp directory (or no directory at all): without this flag
    // codex refuses an untrusted, non-git cwd before contacting any model.
    expect(run.args.slice(0, 7)).toEqual([
      'exec',
      '--ephemeral',
      '--skip-git-repo-check',
      '-s',
      'read-only',
      '--model',
      'gpt-5.4-mini'
    ])
    expect(run.args).toContain('--output-schema')
    expect(run.args.at(-1)).toBe('-')
    expect(run.stdin).toBe('You are an extractor.\n\nCut this into tickets.')
    expect(run.cwd).toBe(tmpdir())
    expect(run.timeout).toBe(1234)
  })
})

describe('generateText with claude', () => {
  it('hands the model its read-only file tools and the turns to use them when it may read the repository', async () => {
    const query = mockClaudeSdk('{"ok":true}')

    const reply = await generateText(PROMPT, SYSTEM_PROMPT, 'claude-code', {
      cwd: '/repo',
      readRepository: true,
      maxRetries: 0
    })

    expect(reply).toBe('{"ok":true}')
    expect(query).toHaveBeenCalledTimes(1)
    const [{ prompt, options }] = query.mock.calls[0]
    expect(prompt).toBe(PROMPT)
    expect(options).toMatchObject({
      cwd: '/repo',
      systemPrompt: SYSTEM_PROMPT,
      tools: ['Read', 'Glob', 'Grep'],
      maxTurns: 60,
      permissionMode: 'dontAsk'
    })
  })

  it('answers in one shot without tools by default', async () => {
    const query = mockClaudeSdk('{"ok":true}')

    await generateText(PROMPT, SYSTEM_PROMPT, 'claude-code', { cwd: '/repo', maxRetries: 0 })

    expect(query).toHaveBeenCalledTimes(1)
    const [{ options }] = query.mock.calls[0]
    expect(options).toMatchObject({ cwd: '/repo', tools: [], maxTurns: 2 })
    expect(options).not.toHaveProperty('permissionMode')
  })

  it('spawns the binary the app resolved at startup', async () => {
    const query = mockClaudeSdk('{"ok":true}')
    setClaudeBinaryPath('/opt/claude/bin/claude')

    await generateText(PROMPT, SYSTEM_PROMPT, 'claude-code', { maxRetries: 0 })

    const [{ options }] = query.mock.calls[0]
    expect(options.pathToClaudeCodeExecutable).toBe('/opt/claude/bin/claude')
    expect(claudeBinaryMocks.resolve).not.toHaveBeenCalled()
  })

  // The desktop backend never has the path set. Left to itself the SDK spawns its bundled
  // binary, which in a packaged app is inside app.asar: `spawn ENOTDIR`.
  it('looks the system binary up itself when no path was set, once', async () => {
    const query = mockClaudeSdk('{"ok":true}')
    claudeBinaryMocks.resolve.mockReturnValue('/usr/local/bin/claude')

    await generateText(PROMPT, SYSTEM_PROMPT, 'claude-code', { maxRetries: 0 })
    await generateText(PROMPT, SYSTEM_PROMPT, 'claude-code', { maxRetries: 0 })

    expect(query).toHaveBeenCalledTimes(2)
    for (const [{ options }] of query.mock.calls) {
      expect(options.pathToClaudeCodeExecutable).toBe('/usr/local/bin/claude')
    }
    expect(claudeBinaryMocks.resolve).toHaveBeenCalledTimes(1)
  })

  it('leaves the SDK its own binary when none is installed', async () => {
    const query = mockClaudeSdk('{"ok":true}')

    await generateText(PROMPT, SYSTEM_PROMPT, 'claude-code', { maxRetries: 0 })

    const [{ options }] = query.mock.calls[0]
    expect(options).not.toHaveProperty('pathToClaudeCodeExecutable')
  })
})

describe('generateText with opencode', () => {
  it('runs the read-only plan agent when it may read the repository', async () => {
    spawnMocks.result = { stdout: openCodeTextEvent('{"ok":true}'), stderr: '', exitCode: 0 }

    const reply = await generateText(PROMPT, SYSTEM_PROMPT, 'opencode', {
      modelOverride: 'claude-haiku',
      cwd: '/repo',
      readRepository: true,
      maxRetries: 0
    })

    expect(reply).toBe('{"ok":true}')
    expect(spawnMocks.runs).toHaveLength(1)
    const [run] = spawnMocks.runs
    expect(run.command).toBe('opencode')
    expect(run.args).toEqual([
      'run',
      '--format',
      'json',
      '--model',
      'claude-haiku',
      '--agent',
      'plan'
    ])
    expect(run.stdin).toBe(`${SYSTEM_PROMPT}\n\n${PROMPT}`)
    expect(run.cwd).toBe('/repo')
  })

  it('runs the default agent otherwise', async () => {
    spawnMocks.result = { stdout: openCodeTextEvent('{"ok":true}'), stderr: '', exitCode: 0 }

    await generateText(PROMPT, SYSTEM_PROMPT, 'opencode', {
      modelOverride: 'claude-haiku',
      cwd: '/repo',
      maxRetries: 0
    })

    const [run] = spawnMocks.runs
    expect(run.args).toEqual(['run', '--format', 'json', '--model', 'claude-haiku'])
    expect(run.args).not.toContain('--agent')
  })
})
