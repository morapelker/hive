import type { BrowserWindow } from 'electron'
import { ManagedRuntime } from 'effect'

import { Bash } from './service'
import { AppLive } from './layers'

let runtime: ManagedRuntime.ManagedRuntime<Bash, never> | null = null
const windowRef: { current: BrowserWindow | null } = { current: null }

export const getRuntime = (): ManagedRuntime.ManagedRuntime<Bash, never> =>
  runtime ??= ManagedRuntime.make(AppLive(windowRef))

export const setMainWindow = (win: BrowserWindow): void => {
  windowRef.current = win
}

export const disposeRuntime = async (): Promise<void> => {
  const current = runtime
  runtime = null
  if (current) {
    await current.dispose()
  }
}
