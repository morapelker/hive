import { ManagedRuntime, type Layer } from 'effect'

import { LoggerLive } from '../../effect/_shared/logger'
import { getOrCreateRuntime, disposeRuntime as disposeRuntimeShared } from '../../effect/_shared/runtime'

const ISLAND_NAME = 'ipc'

/**
 * Shared runtime used by every channel registered via `defineHandler`. Today
 * it provides only `LoggerLive` (so `Effect.logInfo` etc. flow into the
 * rotating file log). Later sessions may layer in cross-cutting services
 * (telemetry, metrics) here, NOT per-island services - those stay scoped to
 * their island runtimes.
 */
const buildLayer = (): Layer.Layer<never, never, never> => LoggerLive

export const getIpcRuntime = (): ManagedRuntime.ManagedRuntime<never, never> =>
  getOrCreateRuntime(ISLAND_NAME, () => ManagedRuntime.make(buildLayer()))

export const disposeIpcRuntime = (): Promise<void> => disposeRuntimeShared(ISLAND_NAME)
