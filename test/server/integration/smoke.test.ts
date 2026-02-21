import { describe, it, expect, beforeEach, vi } from 'vitest'
import { homedir } from 'os'
import { join } from 'path'

// Mock Electron's app module before any resolver imports
vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'home') return homedir()
      if (name === 'userData') return join(homedir(), '.hive')
      if (name === 'logs') return join(homedir(), '.hive', 'logs')
      return '/tmp'
    },
    getVersion: () => '0.0.0-test',
    getAppPath: () => '/tmp/hive-test-app'
  },
  ipcMain: { handle: vi.fn() },
  BrowserWindow: vi.fn()
}))

// Mock worktree and branch watchers (filesystem-dependent)
vi.mock('../../../src/main/services/worktree-watcher', () => ({
  watchWorktree: vi.fn(),
  unwatchWorktree: vi.fn()
}))

vi.mock('../../../src/main/services/branch-watcher', () => ({
  watchBranch: vi.fn(),
  unwatchBranch: vi.fn()
}))

// Mock event-bus (used by git mutation resolvers)
vi.mock('../../../src/server/event-bus', () => ({
  getEventBus: vi.fn(() => ({ emit: vi.fn() }))
}))

import { MockDatabaseService } from '../helpers/mock-db'
import { createTestServer } from '../helpers/test-server'

/* eslint-disable @typescript-eslint/no-explicit-any */

describe('Server Smoke Tests', () => {
  let db: MockDatabaseService
  let execute: (
    query: string,
    variables?: Record<string, unknown>
  ) => Promise<{ data?: any; errors?: any[] }>

  beforeEach(() => {
    db = new MockDatabaseService()
    const server = createTestServer(db)
    execute = server.execute
  })

  it('responds to a simple query', async () => {
    const { data, errors } = await execute('{ systemAppVersion }')
    expect(errors).toBeUndefined()
    expect(data?.systemAppVersion).toBeTruthy()
    expect(typeof data?.systemAppVersion).toBe('string')
  })

  it('responds to a mutation', async () => {
    const { data, errors } = await execute(`
      mutation {
        createProject(input: { name: "smoke-test", path: "/tmp/smoke-test" }) {
          name
          path
        }
      }
    `)
    expect(errors).toBeUndefined()
    expect(data?.createProject.name).toBe('smoke-test')
    expect(data?.createProject.path).toBe('/tmp/smoke-test')
  })

  it('returns errors for unknown fields', async () => {
    const { errors } = await execute('{ nonExistentField }')
    expect(errors).toBeDefined()
    expect(errors!.length).toBeGreaterThan(0)
  })
})
