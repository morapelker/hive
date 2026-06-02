import type { ChildProcess } from 'child_process'
import { Context, Effect } from 'effect'

import type { BashAlreadyRunning, BashSpawnFailed } from './errors'
import type { BashRunSnapshot, BashStreamEvent } from './types'

export class EventSink extends Context.Tag('BashIsland/EventSink')<
  EventSink,
  {
    readonly send: (event: BashStreamEvent) => Effect.Effect<void>
  }
>() {}

export class Spawner extends Context.Tag('BashIsland/Spawner')<
  Spawner,
  {
    readonly spawn: (
      sessionId: string,
      command: string,
      cwd: string
    ) => Effect.Effect<ChildProcess, BashSpawnFailed>
    readonly signalTree: (proc: ChildProcess, signal: NodeJS.Signals) => Effect.Effect<void>
  }
>() {}

export class Bash extends Context.Tag('BashIsland/Bash')<
  Bash,
  {
    readonly run: (
      sessionId: string,
      command: string,
      cwd: string
    ) => Effect.Effect<{ runId: string }, BashAlreadyRunning | BashSpawnFailed>
    readonly abort: (sessionId: string) => Effect.Effect<boolean>
    readonly getRun: (sessionId: string) => Effect.Effect<BashRunSnapshot | null>
    readonly killAll: Effect.Effect<void>
  }
>() {}
