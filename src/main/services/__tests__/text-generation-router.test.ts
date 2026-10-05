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

vi.mock('../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}))

vi.mock('../system-info', () => ({
  detectAgentSdks: () => ({ claude: false, codex: true, opencode: false })
}))

vi.mock('../codex-binary-resolver', () => ({
  resolveCodexBinaryPath: () => '/usr/local/bin/codex'
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

import { generateText } from '../text-generation-router'

afterEach(() => {
  spawnMocks.runs.length = 0
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
