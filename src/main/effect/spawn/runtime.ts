import { Layer, ManagedRuntime } from 'effect'

import { LoggerLive } from '../_shared/logger'
import { disposeRuntime as disposeRuntimeShared, getOrCreateRuntime } from '../_shared/runtime'
import { AppLive } from './layers'
import { LowLevelSpawn, Spawn } from './service'

const ISLAND_NAME = 'spawn'

export const getRuntime = (): ManagedRuntime.ManagedRuntime<Spawn | LowLevelSpawn, never> =>
  getOrCreateRuntime(ISLAND_NAME, () => ManagedRuntime.make(Layer.merge(AppLive, LoggerLive)))

export const disposeRuntime = (): Promise<void> => disposeRuntimeShared(ISLAND_NAME)
