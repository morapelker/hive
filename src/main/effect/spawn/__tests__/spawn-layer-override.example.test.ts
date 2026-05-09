// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { Effect, Either, Layer, Stream } from 'effect'

import { SpawnNonZeroExit } from '../errors'
import { Spawn } from '../service'
import type { RunOnceResult, SpawnOptions } from '../types'

const makeSpawnLayer = (
  runOnce: (options: SpawnOptions) => Effect.Effect<RunOnceResult, SpawnNonZeroExit>
) => {
  const fake = {
    runOnce,

    // Include every method in the service shape, even when the test only needs runOnce.
    // That keeps layer overrides honest when the Spawn service evolves.
    stream: (_options: SpawnOptions) => Stream.empty
  }

  return Layer.succeed(Spawn, fake)
}

describe('Spawn layer override example', () => {
  it('overrides Spawn.runOnce with a synthetic successful result', async () => {
    const layer = makeSpawnLayer((options) =>
      Effect.succeed({
        stdout: `stdout from ${options.command} ${options.args.join(' ')}`,
        stderr: 'synthetic stderr',
        exitCode: 0
      })
    )

    const result = await Effect.runPromise(
      Effect.flatMap(Spawn, (spawn) =>
        spawn.runOnce({
          command: 'fake-cli',
          args: ['--json'],
          cwd: '/tmp/example'
        })
      ).pipe(Effect.provide(layer))
    )

    expect(result).toEqual({
      stdout: 'stdout from fake-cli --json',
      stderr: 'synthetic stderr',
      exitCode: 0
    })
  })

  it('overrides Spawn.runOnce with a tagged SpawnNonZeroExit failure', async () => {
    const layer = makeSpawnLayer((options) =>
      Effect.fail(
        new SpawnNonZeroExit({
          command: options.command,
          exitCode: 42,
          stdoutPreview: 'partial output',
          stderrPreview: 'synthetic failure'
        })
      )
    )

    const result = await Effect.runPromise(
      Effect.either(
        Effect.flatMap(Spawn, (spawn) =>
          spawn.runOnce({
            command: 'fake-cli',
            args: ['fail']
          })
        ).pipe(Effect.provide(layer))
      )
    )

    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(SpawnNonZeroExit)
      expect(result.left._tag).toBe('SpawnNonZeroExit')
      expect(result.left.command).toBe('fake-cli')
      expect(result.left.exitCode).toBe(42)
      expect(result.left.stdoutPreview).toBe('partial output')
      expect(result.left.stderrPreview).toBe('synthetic failure')
    }
  })
})
