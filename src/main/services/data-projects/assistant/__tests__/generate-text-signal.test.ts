// @vitest-environment node
// The optional `signal` of generateText (added for the database assistant's Stop button): it
// reaches the spawned CLI, aborts the Claude query, skips retries and rejects with AbortError.
// Callers that pass no signal see no change.
import { Effect, Layer } from 'effect'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SpawnFailed } from '../../../../effect/spawn/errors'
import { Spawn } from '../../../../effect/spawn/service'
import type { RunOnceResult, SpawnOptions } from '../../../../effect/spawn/types'

const spawnMocks = vi.hoisted(() => ({
  runs: [] as SpawnOptions[],
  fail: null as Error | null,
  result: { stdout: '', stderr: '', exitCode: 0 } as RunOnceResult
}))

vi.mock('../../../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}))
vi.mock('../../../system-info', () => ({
  detectAgentSdks: () => ({ claude: true, codex: true, opencode: true })
}))
vi.mock('../../../codex-binary-resolver', () => ({
  resolveCodexBinaryPath: () => '/usr/local/bin/codex'
}))
vi.mock('../../../claude-binary-resolver', () => ({ resolveClaudeBinaryPath: () => null }))
vi.mock('../../../codex-cli-env', () => ({ getCodexCliEnv: () => ({ PATH: '/usr/local/bin' }) }))
vi.mock('../../../claude-sdk-loader', () => ({ loadClaudeSDK: vi.fn() }))
vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  return {
    ...actual,
    writeFile: vi.fn(async () => undefined),
    readFile: vi.fn(async () => '{"ok":true}'),
    unlink: vi.fn(async () => undefined)
  }
})
vi.mock('../../../../effect/spawn/runtime', () => ({
  getRuntime: () => ({
    runPromise: <A>(effect: Effect.Effect<A, unknown, Spawn>): Promise<A> =>
      Effect.runPromise(
        effect.pipe(
          Effect.provide(
            Layer.succeed(Spawn, {
              runOnce: (options: SpawnOptions) => {
                spawnMocks.runs.push(options)
                return spawnMocks.fail
                  ? Effect.fail(
                      new SpawnFailed({ command: options.command, cause: spawnMocks.fail })
                    )
                  : Effect.succeed(spawnMocks.result)
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

import { loadClaudeSDK } from '../../../claude-sdk-loader'
import { generateText } from '../../../text-generation-router'

afterEach(() => {
  spawnMocks.runs.length = 0
  spawnMocks.fail = null
  vi.mocked(loadClaudeSDK).mockReset()
})

describe('generateText signal', () => {
  it('passes the signal to the spawned CLI and leaves it out when none is given', async () => {
    const controller = new AbortController()
    await generateText('p', 's', 'codex', { maxRetries: 0, signal: controller.signal })
    expect(spawnMocks.runs[0].signal).toBe(controller.signal)
    await generateText('p', 's', 'codex', { maxRetries: 0 })
    expect(spawnMocks.runs[1]).not.toHaveProperty('signal')
  })

  it('rejects with AbortError without retrying when the CLI was killed by the caller', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      generateText('p', 's', 'codex', { maxRetries: 3, signal: controller.signal })
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(spawnMocks.runs).toHaveLength(0)

    const live = new AbortController()
    spawnMocks.fail = new Error('killed')
    const pending = generateText('p', 's', 'codex', { maxRetries: 3, signal: live.signal })
    live.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(spawnMocks.runs.length).toBeLessThanOrEqual(1)
  })

  it('aborts the Claude query when the caller aborts', async () => {
    const controller = new AbortController()
    let sdkSignal: AbortSignal | undefined
    const query = vi.fn((input: { options: { abortController: AbortController } }) => {
      sdkSignal = input.options.abortController.signal
      return (async function* () {
        yield { type: 'assistant', message: { content: [{ type: 'text', text: 'partial' }] } }
        await new Promise<void>((resolve) => sdkSignal!.addEventListener('abort', () => resolve()))
        throw Object.assign(new Error('aborted'), { name: 'AbortError' })
      })()
    })
    vi.mocked(loadClaudeSDK).mockResolvedValue({ query } as never)
    const pending = generateText('p', 's', 'claude-code', {
      maxRetries: 2,
      signal: controller.signal
    })
    await vi.waitFor(() => expect(sdkSignal).toBeDefined())
    controller.abort()
    // Half a reply is not an answer: the streamed 'partial' is not returned.
    await expect(pending).rejects.toMatchObject({
      name: 'AbortError',
      message: 'AI generation was cancelled'
    })
    expect(query).toHaveBeenCalledTimes(1)
  })
})
