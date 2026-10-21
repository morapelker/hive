/**
 * What the main process does when the thread-pool probe reports a stall:
 * log it, wake the pool workers (threadpool-waker.ts), and — if the pool is
 * still wedged a couple of minutes later — offer a restart once, since every
 * terminal keystroke goes through that pool and nothing else would tell the
 * user why their terminals stopped taking input.
 */
import type { ThreadpoolProbeResult } from './threadpool-probe'
import { shouldWakeAtMiss, type ThreadpoolWakeResult } from './threadpool-waker'

export interface ThreadpoolStallRecoveryOptions {
  /** The probe's `stallAfter`: the miss count of the first `onStall`. */
  stallAfter: number
  /** Consecutive misses after which a restart is offered (once per stall). */
  promptRestartAfter: number
  log: {
    warn: (message: string, data?: Record<string, unknown>) => void
    info: (message: string, data?: Record<string, unknown>) => void
  }
  wake: () => ThreadpoolWakeResult
  promptRestart: () => void
  /** Handle/timer dump; called on the first stalled tick and every 40th after. */
  dumpHandles?: () => void
}

export interface ThreadpoolStallRecovery {
  onStall: (result: ThreadpoolProbeResult, consecutiveMisses: number) => void
  onRecover: (result: ThreadpoolProbeResult, missedTicks: number) => void
}

const DUMP_EVERY_MISSES = 40

export function createThreadpoolStallRecovery(
  options: ThreadpoolStallRecoveryOptions
): ThreadpoolStallRecovery {
  let wakes = 0
  let restartOffered = false

  return {
    onStall: (result, misses) => {
      options.log.warn(
        'Main-process thread pool is stalled: async file I/O and getaddrinfo are not completing',
        {
          consecutiveMisses: misses,
          pendingRequests: result.requests.requests,
          requestsByType: result.requests.requestsByType,
          pendingLookups: result.requests.pendingLookups
        }
      )
      if ((misses - options.stallAfter) % DUMP_EVERY_MISSES === 0) options.dumpHandles?.()
      if (shouldWakeAtMiss(misses, options.stallAfter)) {
        wakes += 1
        options.log.warn('Waking the thread-pool workers', {
          consecutiveMisses: misses,
          attempt: wakes,
          ...options.wake()
        })
      }
      if (misses >= options.promptRestartAfter && !restartOffered) {
        restartOffered = true
        options.promptRestart()
      }
    },
    onRecover: (_result, missedTicks) => {
      options.log.info('Thread pool recovered', { missedTicks, wakeAttempts: wakes })
      wakes = 0
      restartOffered = false
    }
  }
}
