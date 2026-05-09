import type { BrowserWindow } from 'electron'
import { Cause, Effect, Exit, Option } from 'effect'

import type { BashError } from './errors'
import {
  BashAlreadyRunning,
  BashSpawnFailed,
  BashWindowMissing
} from './errors'
import { Bash } from './service'
import type { BashRunSnapshot } from './types'
import { getRuntime, setMainWindow } from './runtime'

type RunSuccessEnvelope = { success: true; runId: string }
type RunErrorEnvelope = { success: false; errorCode: string; error: string }
type RunEnvelope = RunSuccessEnvelope | RunErrorEnvelope

export const humanMessage = (error: BashError): string => {
  if (error instanceof BashAlreadyRunning) {
    return `A bash command is already running for session ${error.sessionId}`
  }
  if (error instanceof BashSpawnFailed) {
    const cause =
      error.cause instanceof Error ? error.cause.message : String(error.cause)
    return `Failed to start bash command "${error.command}": ${cause}`
  }
  if (error instanceof BashWindowMissing) {
    return error.reason === 'not-set'
      ? 'Bash output window is not set'
      : 'Bash output window has been destroyed'
  }
  return error.message
}

export const toEnvelope = (exit: Exit.Exit<{ runId: string }, BashError>): RunEnvelope =>
  Exit.match(exit, {
    onSuccess: (value) => ({ success: true as const, ...value }),
    onFailure: (cause) => {
      const failure = Cause.failureOption(cause)
      if (Option.isSome(failure)) {
        const error = failure.value
        return {
          success: false as const,
          errorCode: error._tag,
          error: humanMessage(error)
        }
      }

      return {
        success: false as const,
        errorCode: 'Defect',
        error: Cause.pretty(cause)
      }
    }
  })

class BashFacade {
  setMainWindow(win: BrowserWindow): void {
    setMainWindow(win)
  }

  async run(sessionId: string, command: string, cwd: string): Promise<RunEnvelope> {
    const exit = await getRuntime().runPromiseExit(
      Effect.flatMap(Bash, (bash) => bash.run(sessionId, command, cwd))
    )
    return toEnvelope(exit)
  }

  async abort(sessionId: string): Promise<boolean> {
    return getRuntime().runPromise(Effect.flatMap(Bash, (bash) => bash.abort(sessionId)))
  }

  async getRun(sessionId: string): Promise<BashRunSnapshot | null> {
    return getRuntime().runPromise(Effect.flatMap(Bash, (bash) => bash.getRun(sessionId)))
  }

  killAll(): void {
    void getRuntime().runPromise(Effect.flatMap(Bash, (bash) => bash.killAll))
  }
}

export const bashService = new BashFacade()
