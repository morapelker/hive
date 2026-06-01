import { Layer, ManagedRuntime } from 'effect'

import { Bash } from './service'
import { AppLive } from './layers'
import { getOrCreateRuntime, disposeRuntime as disposeRuntimeShared } from '../_shared/runtime'
import { LoggerLive } from '../_shared/logger'
import { LowLevelSpawnLive } from '../spawn/layers'

const ISLAND_NAME = 'bash'

export const getRuntime = (): ManagedRuntime.ManagedRuntime<Bash, never> =>
  getOrCreateRuntime(ISLAND_NAME, () =>
    ManagedRuntime.make(Layer.merge(Layer.provide(AppLive, LowLevelSpawnLive), LoggerLive))
  )

/**
 * Dispose this island's runtime. Equivalent to (and delegates to)
 * `disposeRuntime('bash')` from the shared registry. Most callers should
 * prefer `disposeAllRuntimes()` from `../_shared/runtime`.
 */
export const disposeRuntime = (): Promise<void> => disposeRuntimeShared(ISLAND_NAME)
