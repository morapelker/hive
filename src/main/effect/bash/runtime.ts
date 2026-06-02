import type { BrowserWindow } from 'electron'
import { Layer, ManagedRuntime } from 'effect'

import { Bash } from './service'
import { AppLive } from './layers'
import { getOrCreateRuntime, disposeRuntime as disposeRuntimeShared } from '../_shared/runtime'
import { LoggerLive } from '../_shared/logger'
import { LowLevelSpawnLive } from '../spawn/layers'

const ISLAND_NAME = 'bash'

/**
 * Window reference is mutable - it's set after the BrowserWindow is created
 * (see registerBashHandlers in src/main/ipc/bash-handlers.ts) and is read
 * lazily by EventSinkLive when streaming events back to the renderer. The
 * ref object itself is captured at runtime construction time and survives
 * across calls.
 */
const windowRef: { current: BrowserWindow | null } = { current: null }

export const getRuntime = (): ManagedRuntime.ManagedRuntime<Bash, never> =>
  getOrCreateRuntime(ISLAND_NAME, () =>
    ManagedRuntime.make(Layer.merge(Layer.provide(AppLive(windowRef), LowLevelSpawnLive), LoggerLive))
  )

export const setMainWindow = (win: BrowserWindow): void => {
  windowRef.current = win
}

/**
 * Dispose this island's runtime. Equivalent to (and delegates to)
 * `disposeRuntime('bash')` from the shared registry. Most callers should
 * prefer `disposeAllRuntimes()` from `../_shared/runtime`.
 */
export const disposeRuntime = (): Promise<void> => disposeRuntimeShared(ISLAND_NAME)
