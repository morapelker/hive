/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import simpleGit from 'simple-git'
import { BrowserWindow } from 'electron'

const handlers = new Map<string, (...args: any[]) => any>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: any[]) => any) => {
      handlers.set(channel, handler)
    })
  },
  BrowserWindow: class {
    isDestroyed() {
      return false
    }
    webContents = { send: vi.fn() }
  },
  shell: { showItemInFolder: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

vi.mock('../../../services/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  LoggerService: class {},
  LogLevel: { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 }
}))

vi.mock('../../../services/worktree-watcher', () => ({
  initWorktreeWatcher: vi.fn(),
  watchWorktree: vi.fn(),
  unwatchWorktree: vi.fn(),
  cleanupWorktreeWatchers: vi.fn(),
  getWorktreeWatcherCount: vi.fn(() => 0)
}))

vi.mock('../../../services/branch-watcher', () => ({
  initBranchWatcher: vi.fn(),
  watchBranch: vi.fn(),
  unwatchBranch: vi.fn(),
  cleanupBranchWatchers: vi.fn(),
  getBranchWatcherCount: vi.fn(() => 0)
}))

import { registerGitFileHandlers } from '../../git-file-handlers'
import { __resetRuntimeRegistryForTests } from '../../../effect/_shared/runtime'

const mockEvent = {} as any
const mockWindow = new BrowserWindow()

describe('migrated git:discardChanges handler', () => {
  let repoPath: string

  beforeEach(async () => {
    handlers.clear()
    __resetRuntimeRegistryForTests()
    repoPath = mkdtempSync(join(tmpdir(), 'hive-git-test-'))
    const git = simpleGit(repoPath)
    await git.init()
    await git.addConfig('user.email', 'test@test.com')
    await git.addConfig('user.name', 'Test')
    writeFileSync(join(repoPath, 'a.txt'), 'original')
    await git.add('.')
    await git.commit('init')
    registerGitFileHandlers(mockWindow)
  })

  afterEach(() => {
    rmSync(repoPath, { recursive: true, force: true })
  })

  it('discards working-tree changes and returns success envelope', async () => {
    writeFileSync(join(repoPath, 'a.txt'), 'modified')
    const result = await handlers.get('git:discardChanges')!(mockEvent, repoPath, 'a.txt')
    expect(result).toEqual({ success: true, value: null })
    expect(readFileSync(join(repoPath, 'a.txt'), 'utf-8')).toBe('original')
  })

  it('returns ZodDecodeError envelope when worktreePath is empty', async () => {
    const result = await handlers.get('git:discardChanges')!(mockEvent, '', 'a.txt')
    expect(result).toMatchObject({ success: false, errorCode: 'ZodDecodeError' })
  })
})
