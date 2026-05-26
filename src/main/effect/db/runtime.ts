import { Layer, ManagedRuntime } from 'effect'

import { LoggerLive } from '../_shared/logger'
import { disposeRuntime as disposeRuntimeShared, getOrCreateRuntime } from '../_shared/runtime'
import { DbLive } from './layers'
import { Db } from './service'

const ISLAND_NAME = 'db'

export const getRuntime = (): ManagedRuntime.ManagedRuntime<Db, never> =>
  getOrCreateRuntime(ISLAND_NAME, () => ManagedRuntime.make(Layer.merge(DbLive, LoggerLive)))

export const disposeRuntime = (): Promise<void> => disposeRuntimeShared(ISLAND_NAME)
