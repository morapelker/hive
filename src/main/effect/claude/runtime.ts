import { Layer, ManagedRuntime } from 'effect'

import { AppLive } from './layers'
import { ClaudeAgent } from './service'
import { getOrCreateRuntime, disposeRuntime as disposeRuntimeShared } from '../_shared/runtime'
import { LoggerLive } from '../_shared/logger'

const ISLAND_NAME = 'claude-agent'

export const getRuntime = (): ManagedRuntime.ManagedRuntime<ClaudeAgent, never> =>
  getOrCreateRuntime(ISLAND_NAME, () => ManagedRuntime.make(Layer.provide(AppLive, LoggerLive)))

export const disposeRuntime = (): Promise<void> => disposeRuntimeShared(ISLAND_NAME)
