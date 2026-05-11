import { Effect, Exit } from 'effect'

import { fromCause } from '../../services/error-utils'
import { withLogComponent } from '../_shared/logger'
import type { SpawnError } from './errors'
import {
  SpawnFailed,
  SpawnNonZeroExit,
  SpawnOutputCapExceeded,
  SpawnSignalled,
  SpawnTimeout
} from './errors'
import { getRuntime } from './runtime'
import { Spawn } from './service'
import type { RunOnceResult, SpawnOptions } from './types'

type RunOnceSuccessEnvelope = { success: true; result: RunOnceResult }
type RunOnceErrorEnvelope = { success: false; errorCode: string; error: string; details?: unknown }
type RunOnceEnvelope = RunOnceSuccessEnvelope | RunOnceErrorEnvelope

const tagged = <A, E>(effect: Effect.Effect<A, E, Spawn>) =>
  effect.pipe(withLogComponent('SpawnEffectIsland'))

export const humanMessage = (error: SpawnError): string => {
  if (error instanceof SpawnFailed) {
    const cause = error.cause instanceof Error ? error.cause.message : String(error.cause)
    return `Failed to start "${error.command}": ${cause}`
  }
  if (error instanceof SpawnTimeout) {
    return `${error.command} timed out after ${error.durationMs}ms`
  }
  if (error instanceof SpawnNonZeroExit) {
    return `${error.command} exited with code ${error.exitCode}`
  }
  if (error instanceof SpawnSignalled) {
    return `${error.command} exited from signal ${error.signal ?? 'unknown'}`
  }
  if (error instanceof SpawnOutputCapExceeded) {
    return `${error.command} ${error.stream} exceeded ${error.limit} bytes`
  }
  return String(error)
}

export const toEnvelope = (exit: Exit.Exit<RunOnceResult, SpawnError>): RunOnceEnvelope =>
  Exit.match(exit, {
    onSuccess: (result) => ({ success: true as const, result }),
    onFailure: (cause) => {
      const env = fromCause(cause, { humanize: humanMessage })
      return { success: false as const, ...env }
    }
  })

class SpawnFacade {
  async runOnce(options: SpawnOptions): Promise<RunOnceEnvelope> {
    const exit = await getRuntime().runPromiseExit(
      tagged(Effect.flatMap(Spawn, (spawn) => spawn.runOnce(options)))
    )
    return toEnvelope(exit)
  }
}

export const spawnService = new SpawnFacade()
