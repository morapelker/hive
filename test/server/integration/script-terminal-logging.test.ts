import { describe, it, expect, beforeEach, vi } from 'vitest'
import { join } from 'path'
import { homedir } from 'os'

// ── Hoisted mocks (created before module resolution) ──────────────────────────

const mockScriptRunner = vi.hoisted(() => ({
  runSequential: vi.fn(),
  runPersistent: vi.fn(),
  killProcess: vi.fn(),
  runAndWait: vi.fn(),
  setMainWindow: vi.fn(),
  killAll: vi.fn()
}))

const mockPtyService = vi.hoisted(() => ({
  create: vi.fn(),
  write: vi.fn(),
  resize: vi.fn(),
  destroy: vi.fn(),
  destroyAll: vi.fn(),
  onData: vi.fn(() => vi.fn()),
  onExit: vi.fn(() => vi.fn()),
  has: vi.fn(),
  getOrCreate: vi.fn(),
  getBackend: vi.fn(),
  getIds: vi.fn(),
  destroyExcept: vi.fn()
}))

const mockGetAssignedPort = vi.hoisted(() => vi.fn())

const mockCreateResponseLog = vi.hoisted(() => vi.fn())
const mockAppendResponseLog = vi.hoisted(() => vi.fn())

// ── Module mocks ──────────────────────────────────────────────────────────────

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

vi.mock('../../../src/main/services/script-runner', () => ({
  ScriptRunner: vi.fn(),
  scriptRunner: mockScriptRunner
}))

vi.mock('../../../src/main/services/pty-service', () => ({
  ptyService: mockPtyService
}))

vi.mock('../../../src/main/services/port-registry', () => ({
  getAssignedPort: mockGetAssignedPort,
  assignPort: vi.fn(),
  releasePort: vi.fn()
}))

vi.mock('../../../src/main/services/response-logger', () => ({
  createResponseLog: mockCreateResponseLog,
  appendResponseLog: mockAppendResponseLog
}))

// Mock worktree and branch watchers (imported transitively by other resolvers)
vi.mock('../../../src/main/services/worktree-watcher', () => ({
  watchWorktree: vi.fn(),
  unwatchWorktree: vi.fn()
}))

vi.mock('../../../src/main/services/branch-watcher', () => ({
  watchBranch: vi.fn(),
  unwatchBranch: vi.fn()
}))

vi.mock('../../../src/main/services/connection-service', () => ({
  createConnectionDir: vi.fn(() => '/tmp/fake-conn-dir'),
  createSymlink: vi.fn(),
  removeSymlink: vi.fn(),
  deleteConnectionDir: vi.fn(),
  generateConnectionInstructions: vi.fn(),
  deriveSymlinkName: vi.fn((name: string) => name.toLowerCase().replace(/\s+/g, '-')),
  generateConnectionColor: vi.fn(() => '["#aaa","#bbb","#ccc","#ddd"]')
}))

vi.mock('../../../src/main/services/worktree-ops', () => ({
  createWorktreeOp: vi.fn(),
  deleteWorktreeOp: vi.fn(),
  syncWorktreesOp: vi.fn(),
  duplicateWorktreeOp: vi.fn(),
  renameWorktreeBranchOp: vi.fn(),
  createWorktreeFromBranchOp: vi.fn()
}))

vi.mock('../../../src/server/event-bus', () => ({
  getEventBus: vi.fn(() => ({ emit: vi.fn() }))
}))

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import { MockDatabaseService } from '../helpers/mock-db'
import { createTestServer } from '../helpers/test-server'

/* eslint-disable @typescript-eslint/no-explicit-any */

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Phase 7 — Script, Terminal, Logging Resolvers', () => {
  let db: MockDatabaseService
  let execute: (
    query: string,
    variables?: Record<string, unknown>
  ) => Promise<{ data?: any; errors?: any[] }>

  beforeEach(() => {
    vi.clearAllMocks()
    db = new MockDatabaseService()
    const server = createTestServer(db)
    execute = server.execute
  })

  // ── Script Resolvers ──────────────────────────────────────────────────────

  describe('Script Resolvers', () => {
    it('scriptPort query returns assigned port number', async () => {
      mockGetAssignedPort.mockReturnValue(3011)

      const { data } = await execute(`
        query { scriptPort(cwd: "/tmp/test-project") }
      `)

      expect(data.scriptPort).toBe(3011)
      expect(mockGetAssignedPort).toHaveBeenCalledWith('/tmp/test-project')
    })

    it('scriptPort query returns null when no port assigned', async () => {
      mockGetAssignedPort.mockReturnValue(null)

      const { data } = await execute(`
        query { scriptPort(cwd: "/tmp/no-port") }
      `)

      expect(data.scriptPort).toBeNull()
    })

    it('scriptRunSetup mutation returns success', async () => {
      mockScriptRunner.runSequential.mockResolvedValue({ success: true })

      const { data } = await execute(`
        mutation {
          scriptRunSetup(input: {
            commands: ["echo hello"]
            cwd: "/tmp/test"
            worktreeId: "wt-1"
          }) { success error }
        }
      `)

      expect(data.scriptRunSetup.success).toBe(true)
      expect(data.scriptRunSetup.error).toBeNull()
      expect(mockScriptRunner.runSequential).toHaveBeenCalledWith(
        ['echo hello'],
        '/tmp/test',
        'wt-1'
      )
    })

    it('scriptRunSetup mutation returns error on failure', async () => {
      mockScriptRunner.runSequential.mockResolvedValue({
        success: false,
        error: 'Command "echo hello" exited with code 1'
      })

      const { data } = await execute(`
        mutation {
          scriptRunSetup(input: {
            commands: ["echo hello"]
            cwd: "/tmp/test"
            worktreeId: "wt-1"
          }) { success error }
        }
      `)

      expect(data.scriptRunSetup.success).toBe(false)
      expect(data.scriptRunSetup.error).toContain('exited with code 1')
    })

    it('scriptRunSetup mutation catches thrown errors', async () => {
      mockScriptRunner.runSequential.mockRejectedValue(new Error('spawn ENOENT'))

      const { data } = await execute(`
        mutation {
          scriptRunSetup(input: {
            commands: ["nonexistent-cmd"]
            cwd: "/tmp/test"
            worktreeId: "wt-1"
          }) { success error }
        }
      `)

      expect(data.scriptRunSetup.success).toBe(false)
      expect(data.scriptRunSetup.error).toBe('spawn ENOENT')
    })

    it('scriptRunProject mutation returns success with pid', async () => {
      mockScriptRunner.runPersistent.mockResolvedValue({
        pid: 12345,
        kill: vi.fn()
      })

      const { data } = await execute(`
        mutation {
          scriptRunProject(input: {
            commands: ["node server.js"]
            cwd: "/tmp/test"
            worktreeId: "wt-1"
          }) { success pid error }
        }
      `)

      expect(data.scriptRunProject.success).toBe(true)
      expect(data.scriptRunProject.pid).toBe(12345)
      expect(data.scriptRunProject.error).toBeNull()
      expect(mockScriptRunner.runPersistent).toHaveBeenCalledWith(
        ['node server.js'],
        '/tmp/test',
        'wt-1'
      )
    })

    it('scriptRunProject mutation catches thrown errors', async () => {
      mockScriptRunner.runPersistent.mockRejectedValue(new Error('cannot start'))

      const { data } = await execute(`
        mutation {
          scriptRunProject(input: {
            commands: ["node server.js"]
            cwd: "/tmp/test"
            worktreeId: "wt-1"
          }) { success pid error }
        }
      `)

      expect(data.scriptRunProject.success).toBe(false)
      expect(data.scriptRunProject.pid).toBeNull()
      expect(data.scriptRunProject.error).toBe('cannot start')
    })

    it('scriptKill mutation returns success', async () => {
      mockScriptRunner.killProcess.mockResolvedValue(true)

      const { data } = await execute(`
        mutation { scriptKill(worktreeId: "wt-1") { success error } }
      `)

      expect(data.scriptKill.success).toBe(true)
      expect(data.scriptKill.error).toBeNull()
      expect(mockScriptRunner.killProcess).toHaveBeenCalledWith('wt-1')
    })

    it('scriptKill mutation catches thrown errors', async () => {
      mockScriptRunner.killProcess.mockRejectedValue(new Error('no such process'))

      const { data } = await execute(`
        mutation { scriptKill(worktreeId: "wt-999") { success error } }
      `)

      expect(data.scriptKill.success).toBe(false)
      expect(data.scriptKill.error).toBe('no such process')
    })

    it('scriptRunArchive mutation returns success with output', async () => {
      mockScriptRunner.runAndWait.mockResolvedValue({
        success: true,
        output: 'archive created\n'
      })

      const { data } = await execute(`
        mutation {
          scriptRunArchive(commands: ["echo done"], cwd: "/tmp/test") {
            success output error
          }
        }
      `)

      expect(data.scriptRunArchive.success).toBe(true)
      expect(data.scriptRunArchive.output).toBe('archive created\n')
      expect(data.scriptRunArchive.error).toBeNull()
      expect(mockScriptRunner.runAndWait).toHaveBeenCalledWith(
        ['echo done'],
        '/tmp/test'
      )
    })

    it('scriptRunArchive mutation returns error on failure', async () => {
      mockScriptRunner.runAndWait.mockResolvedValue({
        success: false,
        output: 'partial output',
        error: 'Command failed'
      })

      const { data } = await execute(`
        mutation {
          scriptRunArchive(commands: ["bad-cmd"], cwd: "/tmp/test") {
            success output error
          }
        }
      `)

      expect(data.scriptRunArchive.success).toBe(false)
      expect(data.scriptRunArchive.output).toBe('partial output')
      expect(data.scriptRunArchive.error).toBe('Command failed')
    })

    it('scriptRunArchive mutation catches thrown errors', async () => {
      mockScriptRunner.runAndWait.mockRejectedValue(new Error('timeout'))

      const { data } = await execute(`
        mutation {
          scriptRunArchive(commands: ["slow-cmd"], cwd: "/tmp/test") {
            success output error
          }
        }
      `)

      expect(data.scriptRunArchive.success).toBe(false)
      expect(data.scriptRunArchive.output).toBe('')
      expect(data.scriptRunArchive.error).toBe('timeout')
    })
  })

  // ── Terminal Resolvers ────────────────────────────────────────────────────

  describe('Terminal Resolvers', () => {
    it('terminalCreate mutation returns success with cols/rows', async () => {
      mockPtyService.create.mockReturnValue({ cols: 80, rows: 24 })

      const { data } = await execute(`
        mutation {
          terminalCreate(worktreeId: "wt-1", cwd: "/tmp/test") {
            success cols rows error
          }
        }
      `)

      expect(data.terminalCreate.success).toBe(true)
      expect(data.terminalCreate.cols).toBe(80)
      expect(data.terminalCreate.rows).toBe(24)
      expect(data.terminalCreate.error).toBeNull()
      expect(mockPtyService.create).toHaveBeenCalledWith('wt-1', {
        cwd: '/tmp/test',
        shell: undefined
      })
    })

    it('terminalCreate mutation passes shell parameter', async () => {
      mockPtyService.create.mockReturnValue({ cols: 120, rows: 40 })

      const { data } = await execute(`
        mutation {
          terminalCreate(worktreeId: "wt-2", cwd: "/tmp/test", shell: "/bin/zsh") {
            success cols rows error
          }
        }
      `)

      expect(data.terminalCreate.success).toBe(true)
      expect(mockPtyService.create).toHaveBeenCalledWith('wt-2', {
        cwd: '/tmp/test',
        shell: '/bin/zsh'
      })
    })

    it('terminalCreate wires onData and onExit to EventBus', async () => {
      mockPtyService.create.mockReturnValue({ cols: 80, rows: 24 })

      await execute(`
        mutation {
          terminalCreate(worktreeId: "wt-1", cwd: "/tmp/test") {
            success
          }
        }
      `)

      expect(mockPtyService.onData).toHaveBeenCalledWith('wt-1', expect.any(Function))
      expect(mockPtyService.onExit).toHaveBeenCalledWith('wt-1', expect.any(Function))
    })

    it('terminalCreate mutation returns error on failure', async () => {
      mockPtyService.create.mockImplementation(() => {
        throw new Error('PTY creation failed')
      })

      const { data } = await execute(`
        mutation {
          terminalCreate(worktreeId: "wt-bad", cwd: "/nonexistent") {
            success cols rows error
          }
        }
      `)

      expect(data.terminalCreate.success).toBe(false)
      expect(data.terminalCreate.error).toBe('PTY creation failed')
      expect(data.terminalCreate.cols).toBeNull()
      expect(data.terminalCreate.rows).toBeNull()
    })

    it('terminalWrite mutation returns true', async () => {
      const { data } = await execute(`
        mutation { terminalWrite(worktreeId: "wt-1", data: "ls\\n") }
      `)

      expect(data.terminalWrite).toBe(true)
      expect(mockPtyService.write).toHaveBeenCalledWith('wt-1', 'ls\n')
    })

    it('terminalWrite mutation returns false on error', async () => {
      mockPtyService.write.mockImplementation(() => {
        throw new Error('no terminal')
      })

      const { data } = await execute(`
        mutation { terminalWrite(worktreeId: "wt-bad", data: "ls\\n") }
      `)

      expect(data.terminalWrite).toBe(false)
    })

    it('terminalResize mutation returns true', async () => {
      const { data } = await execute(`
        mutation { terminalResize(worktreeId: "wt-1", cols: 120, rows: 40) }
      `)

      expect(data.terminalResize).toBe(true)
      expect(mockPtyService.resize).toHaveBeenCalledWith('wt-1', 120, 40)
    })

    it('terminalResize mutation returns false on error', async () => {
      mockPtyService.resize.mockImplementation(() => {
        throw new Error('no terminal')
      })

      const { data } = await execute(`
        mutation { terminalResize(worktreeId: "wt-bad", cols: 120, rows: 40) }
      `)

      expect(data.terminalResize).toBe(false)
    })

    it('terminalDestroy mutation returns true', async () => {
      const { data } = await execute(`
        mutation { terminalDestroy(worktreeId: "wt-1") }
      `)

      expect(data.terminalDestroy).toBe(true)
      expect(mockPtyService.destroy).toHaveBeenCalledWith('wt-1')
    })

    it('terminalDestroy mutation returns false on error', async () => {
      mockPtyService.destroy.mockImplementation(() => {
        throw new Error('no terminal')
      })

      const { data } = await execute(`
        mutation { terminalDestroy(worktreeId: "wt-bad") }
      `)

      expect(data.terminalDestroy).toBe(false)
    })
  })

  // ── Logging Resolvers ─────────────────────────────────────────────────────

  describe('Logging Resolvers', () => {
    it('createResponseLog mutation returns file path string', async () => {
      const expectedPath = join(homedir(), '.hive/logs/responses/sess-1-2026-02-20T00-00-00-000Z.jsonl')
      mockCreateResponseLog.mockReturnValue(expectedPath)

      const { data } = await execute(`
        mutation { createResponseLog(sessionId: "sess-1") }
      `)

      expect(typeof data.createResponseLog).toBe('string')
      expect(data.createResponseLog).toBe(expectedPath)
      expect(mockCreateResponseLog).toHaveBeenCalledWith('sess-1')
    })

    it('appendResponseLog mutation returns true', async () => {
      const { data } = await execute(
        `mutation($filePath: String!, $data: JSON!) {
          appendResponseLog(filePath: $filePath, data: $data)
        }`,
        {
          filePath: '/tmp/logs/sess-1.jsonl',
          data: { type: 'response', content: 'hello' }
        }
      )

      expect(data.appendResponseLog).toBe(true)
      expect(mockAppendResponseLog).toHaveBeenCalledWith(
        '/tmp/logs/sess-1.jsonl',
        { type: 'response', content: 'hello' }
      )
    })
  })
})
