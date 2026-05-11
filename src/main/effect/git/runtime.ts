import { Layer, ManagedRuntime } from 'effect'

import { LoggerLive } from '../_shared/logger'
import { disposeRuntime as disposeRuntimeShared, getOrCreateRuntime } from '../_shared/runtime'
import { GitLive } from './layers'
import { Git } from './service'

const ISLAND_NAME = 'git'

export const getRuntime = (): ManagedRuntime.ManagedRuntime<Git, never> =>
  getOrCreateRuntime(ISLAND_NAME, () => ManagedRuntime.make(Layer.merge(GitLive, LoggerLive)))

export const disposeRuntime = (): Promise<void> => disposeRuntimeShared(ISLAND_NAME)
