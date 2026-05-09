import type { ChildProcess } from 'node:child_process'
import { Context, Effect, Stream } from 'effect'

import type {
  SpawnFailed,
  SpawnNonZeroExit,
  SpawnOutputCapExceeded,
  SpawnSignalled,
  SpawnTimeout
} from './errors'
import type { RunOnceResult, SpawnOptions, StreamChunk } from './types'

export class LowLevelSpawn extends Context.Tag('SpawnIsland/LowLevelSpawn')<
  LowLevelSpawn,
  {
    readonly spawn: (options: SpawnOptions) => Effect.Effect<ChildProcess, SpawnFailed>
    readonly signalTree: (proc: ChildProcess, signal: NodeJS.Signals) => Effect.Effect<void>
  }
>() {}

export class Spawn extends Context.Tag('SpawnIsland/Spawn')<
  Spawn,
  {
    readonly runOnce: (
      options: SpawnOptions
    ) => Effect.Effect<
      RunOnceResult,
      SpawnFailed | SpawnTimeout | SpawnNonZeroExit | SpawnSignalled | SpawnOutputCapExceeded
    >
    readonly stream: (
      options: SpawnOptions
    ) => Stream.Stream<
      StreamChunk,
      SpawnFailed | SpawnTimeout | SpawnSignalled | SpawnOutputCapExceeded
    >
  }
>() {}
