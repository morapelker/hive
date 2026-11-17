// A project folder was renamed while terminals stayed open in it. The shells are in the new
// folder; the registry has to say so too, because "is a terminal open in this project" is
// answered from the folder each terminal is filed under.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ptyService } from '../pty-service'

const nodePtyMocks = vi.hoisted(() => ({
  spawn: vi.fn()
}))

vi.mock('node-pty', () => ({
  spawn: nodePtyMocks.spawn
}))

vi.mock('../logger', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  }))
}))

let nextPid = 7000
const fakePty = (): Record<string, unknown> => ({
  pid: nextPid++,
  cols: 80,
  rows: 24,
  onData: vi.fn(),
  onExit: vi.fn(),
  write: vi.fn(),
  resize: vi.fn(),
  kill: vi.fn()
})

const foldersById = (): Record<string, string> =>
  Object.fromEntries(ptyService.listInstances().map((terminal) => [terminal.id, terminal.cwd]))

describe('ptyService.refileMovedFolders', () => {
  beforeEach(() => {
    ptyService.destroyAll()
    nodePtyMocks.spawn.mockImplementation(() => fakePty())
  })

  afterEach(() => {
    ptyService.destroyAll()
    vi.clearAllMocks()
  })

  it('files a terminal opened in a folder that moved, or below it, under the new folder', () => {
    ptyService.create('root', { cwd: '/old/app' })
    ptyService.create('below', { cwd: '/old/app/packages/web' })
    ptyService.create('neighbour', { cwd: '/old/app-legacy' })
    ptyService.create('elsewhere', { cwd: '/work/other' })

    const refiled = ptyService.refileMovedFolders([{ from: '/old/app', to: '/dev/app' }])

    expect(refiled).toBe(2)
    expect(foldersById()).toEqual({
      root: '/dev/app',
      below: '/dev/app/packages/web',
      // A folder whose name only starts the same did not move.
      neighbour: '/old/app-legacy',
      elsewhere: '/work/other'
    })
  })

  it('follows a folder through every move, and each terminal once per move', () => {
    ptyService.create('root', { cwd: '/old/app' })
    ptyService.create('worktree', { cwd: '/old/app-feature' })

    // The checkout under both of its spellings, then the worktree that sat next to it.
    ptyService.refileMovedFolders([
      { from: '/old/app', to: '/dev/app' },
      { from: '/private/old/app', to: '/dev/app' },
      { from: '/old/app-feature', to: '/dev/app-feature' }
    ])
    expect(foldersById()).toEqual({ root: '/dev/app', worktree: '/dev/app-feature' })

    ptyService.refileMovedFolders([{ from: '/dev/app', to: '/Volumes/disk/dev/app' }])
    expect(foldersById()).toEqual({ root: '/Volumes/disk/dev/app', worktree: '/dev/app-feature' })
  })

  it('changes nothing when no terminal is in a folder that moved', () => {
    ptyService.create('elsewhere', { cwd: '/work/other' })

    expect(ptyService.refileMovedFolders([{ from: '/old/app', to: '/dev/app' }])).toBe(0)
    expect(ptyService.refileMovedFolders([])).toBe(0)
    expect(foldersById()).toEqual({ elsewhere: '/work/other' })
  })
})
