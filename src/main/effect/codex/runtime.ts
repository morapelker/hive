import { Layer, ManagedRuntime } from 'effect'

import { AppLive } from './layers'
import { CodexAgent } from './service'
import { getOrCreateRuntime, disposeRuntime as disposeRuntimeShared } from '../_shared/runtime'
import { LoggerLive } from '../_shared/logger'

const ISLAND_NAME = 'codex-agent'

export const getRuntime = (): ManagedRuntime.ManagedRuntime<CodexAgent, never> =>
  getOrCreateRuntime(ISLAND_NAME, () => ManagedRuntime.make(Layer.provide(AppLive, LoggerLive)))

export const disposeRuntime = (): Promise<void> => disposeRuntimeShared(ISLAND_NAME)
