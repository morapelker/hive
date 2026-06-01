import { Effect, Exit } from 'effect'

import { fromCause } from '../../services/error-utils'
import type { BashError } from './errors'
import { BashAlreadyRunning, BashSpawnFailed } from './errors'
import { Bash } from './service'
import type { BashRunSnapshot } from './types'
import { getRuntime } from './runtime'
import { withLogComponent } from '../_shared/logger'

type RunSuccessEnvelope = { success: true; runId: string }
type RunErrorEnvelope = { success: false; errorCode: string; error: string; details?: unknown }
type RunEnvelope = RunSuccessEnvelope | RunErrorEnvelope

const tagged = <A, E>(eff: Effect.Effect<A, E, Bash>) =>
  eff.pipe(withLogComponent('BashEffectIsland'))

export const humanMessage = (error: BashError): string => {
  if (error instanceof BashAlreadyRunning) {
    return `A bash command is already running for session ${error.sessionId}`
  }
  if (error instanceof BashSpawnFailed) {
    const cause = error.cause instanceof Error ? error.cause.message : String(error.cause)
    return `Failed to start bash command "${error.command}": ${cause}`
  }
  return error.message
}

export const toEnvelope = (exit: Exit.Exit<{ runId: string }, BashError>): RunEnvelope =>
  Exit.match(exit, {
    onSuccess: (value) => ({ success: true as const, ...value }),
    onFailure: (cause) => {
      const env = fromCause(cause, { humanize: humanMessage })
      return { success: false as const, ...env }
    }
  })

class BashFacade {
  async run(sessionId: string, command: string, cwd: string): Promise<RunEnvelope> {
    const exit = await getRuntime().runPromiseExit(
      tagged(Effect.flatMap(Bash, (bash) => bash.run(sessionId, command, cwd)))
    )
    return toEnvelope(exit)
  }

  async abort(sessionId: string): Promise<boolean> {
    return getRuntime().runPromise(tagged(Effect.flatMap(Bash, (bash) => bash.abort(sessionId))))
  }

  async getRun(sessionId: string): Promise<BashRunSnapshot | null> {
    return getRuntime().runPromise(tagged(Effect.flatMap(Bash, (bash) => bash.getRun(sessionId))))
  }

  killAll(): void {
    void getRuntime().runPromise(tagged(Effect.flatMap(Bash, (bash) => bash.killAll)))
  }
}

export const bashService = new BashFacade()
