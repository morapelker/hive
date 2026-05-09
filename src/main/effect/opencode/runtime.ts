import { Layer, ManagedRuntime } from 'effect'

import { AppLive } from './layers'
import { OpenCodeAgent } from './service'
import { getOrCreateRuntime, disposeRuntime as disposeRuntimeShared } from '../_shared/runtime'
import { LoggerLive } from '../_shared/logger'

const ISLAND_NAME = 'opencode-agent'

export const getRuntime = (): ManagedRuntime.ManagedRuntime<OpenCodeAgent, never> =>
  getOrCreateRuntime(ISLAND_NAME, () => ManagedRuntime.make(Layer.provide(AppLive, LoggerLive)))

export const disposeRuntime = (): Promise<void> => disposeRuntimeShared(ISLAND_NAME)
