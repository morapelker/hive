import { afterEach, describe, expect, it } from 'vitest'

import { perfDiagnostics } from './perf-diagnostics'

describe('perf diagnostics service', () => {
  afterEach(() => {
    perfDiagnostics.cleanup()
  })

  it('collects desktop Electron process counts from the registered metrics collector', () => {
    perfDiagnostics.setCollectors({
      getPtyCount: () => 1,
      getScriptStats: () => ({ active: 2, totalOpened: 3, totalClosed: 4 }),
      getFileWatcherCount: () => 5,
      getWorktreeWatcherCount: () => 6,
      getBranchWatcherCount: () => 7,
      getActiveSessionCount: () => 8,
      getElectronProcessCounts: () => ({ windows: 9, webContents: 10 })
    })

    const snapshot = perfDiagnostics.getSnapshot()

    expect(snapshot.processes).toMatchObject({
      ptyActive: 1,
      scriptsActive: 2,
      scriptsTotalOpened: 3,
      scriptsTotalClosed: 4
    })
    expect(snapshot.watchers).toEqual({ fileTree: 5, worktree: 6, branch: 7 })
    expect(snapshot.sessions).toEqual({ active: 8 })
    expect(snapshot.electron).toEqual({ windows: 9, webContents: 10 })
  })
})
