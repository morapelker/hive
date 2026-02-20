import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { homedir } from 'os'

// Mock Electron's app module before any resolver imports (logger, system-info, file-ops all use it)
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

// Mock connection-service filesystem operations (used by connection-ops)
vi.mock('../../../src/main/services/connection-service', () => ({
  createConnectionDir: vi.fn(() => '/tmp/fake-conn-dir'),
  createSymlink: vi.fn(),
  removeSymlink: vi.fn(),
  deleteConnectionDir: vi.fn(),
  generateConnectionInstructions: vi.fn(),
  deriveSymlinkName: vi.fn((projectName: string) => projectName.toLowerCase().replace(/\s+/g, '-')),
  generateConnectionColor: vi.fn(() => '["#aaa","#bbb","#ccc","#ddd"]')
}))

// Mock worktree-ops (filesystem-dependent)
vi.mock('../../../src/main/services/worktree-ops', () => ({
  createWorktreeOp: vi.fn(),
  deleteWorktreeOp: vi.fn(),
  syncWorktreesOp: vi.fn(),
  duplicateWorktreeOp: vi.fn(),
  renameWorktreeBranchOp: vi.fn(),
  createWorktreeFromBranchOp: vi.fn()
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

describe('Operation Resolvers — Integration Tests', () => {
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

  // =========================================================================
  // System Mutations
  // =========================================================================
  describe('System Mutations', () => {
    it('systemRegisterPushToken stores token and platform', async () => {
      const { data } = await execute(`
        mutation { systemRegisterPushToken(token: "test-token", platform: "ios") }
      `)
      expect(data?.systemRegisterPushToken).toBe(true)
      expect(db.getSetting('headless_push_token')).toBe('test-token')
      expect(db.getSetting('headless_push_platform')).toBe('ios')
    })

    it('systemRegisterPushToken overwrites existing token', async () => {
      db.setSetting('headless_push_token', 'old-token')
      db.setSetting('headless_push_platform', 'android')

      const { data } = await execute(`
        mutation { systemRegisterPushToken(token: "new-token", platform: "ios") }
      `)
      expect(data?.systemRegisterPushToken).toBe(true)
      expect(db.getSetting('headless_push_token')).toBe('new-token')
      expect(db.getSetting('headless_push_platform')).toBe('ios')
    })

    it('systemKillSwitch deletes API key hash', async () => {
      db.setSetting('headless_api_key_hash', 'some-hash')
      const { data } = await execute('mutation { systemKillSwitch }')
      expect(data?.systemKillSwitch).toBe(true)
      expect(db.getSetting('headless_api_key_hash')).toBeNull()
    })

    it('systemKillSwitch succeeds even when no key exists', async () => {
      const { data } = await execute('mutation { systemKillSwitch }')
      expect(data?.systemKillSwitch).toBe(true)
    })
  })

  // =========================================================================
  // Settings Detection
  // =========================================================================
  describe('Settings Detection', () => {
    it('detectedEditors returns an array of apps', async () => {
      const { data, errors } = await execute(`
        { detectedEditors { id name command available } }
      `)
      expect(errors).toBeUndefined()
      expect(data?.detectedEditors).toBeInstanceOf(Array)
      expect(data?.detectedEditors.length).toBeGreaterThan(0)

      // Verify shape of each entry
      for (const editor of data.detectedEditors) {
        expect(editor).toHaveProperty('id')
        expect(editor).toHaveProperty('name')
        expect(editor).toHaveProperty('command')
        expect(typeof editor.available).toBe('boolean')
      }

      // Should include well-known editors
      const ids = data.detectedEditors.map((e: any) => e.id)
      expect(ids).toContain('vscode')
    })

    it('detectedTerminals returns an array of apps', async () => {
      const { data, errors } = await execute(`
        { detectedTerminals { id name command available } }
      `)
      expect(errors).toBeUndefined()
      expect(data?.detectedTerminals).toBeInstanceOf(Array)
      expect(data?.detectedTerminals.length).toBeGreaterThan(0)

      for (const terminal of data.detectedTerminals) {
        expect(terminal).toHaveProperty('id')
        expect(terminal).toHaveProperty('name')
        expect(terminal).toHaveProperty('command')
        expect(typeof terminal.available).toBe('boolean')
      }
    })
  })

  // =========================================================================
  // System Queries (via mocked Electron app module)
  // =========================================================================
  describe('System Queries', () => {
    it('systemAppVersion returns version string', async () => {
      const { data, errors } = await execute('{ systemAppVersion }')
      expect(errors).toBeUndefined()
      expect(typeof data?.systemAppVersion).toBe('string')
      expect(data.systemAppVersion).toBe('0.0.0-test')
    })

    it('systemAppPaths returns path fields', async () => {
      const { data, errors } = await execute(
        '{ systemAppPaths { userData home logs } }'
      )
      expect(errors).toBeUndefined()
      expect(data?.systemAppPaths).toBeDefined()
      expect(typeof data.systemAppPaths.userData).toBe('string')
      expect(typeof data.systemAppPaths.home).toBe('string')
      expect(typeof data.systemAppPaths.logs).toBe('string')
    })

    it('systemServerStatus returns status fields', async () => {
      const { data, errors } = await execute(`
        { systemServerStatus { uptime connections requestCount locked version } }
      `)
      expect(errors).toBeUndefined()
      expect(data?.systemServerStatus).toBeDefined()
      expect(typeof data.systemServerStatus.uptime).toBe('number')
      expect(typeof data.systemServerStatus.connections).toBe('number')
      expect(typeof data.systemServerStatus.locked).toBe('boolean')
      expect(data.systemServerStatus.version).toBe('0.0.0-test')
    })

    it('systemLogDir returns a string', async () => {
      const { data, errors } = await execute('{ systemLogDir }')
      expect(errors).toBeUndefined()
      expect(typeof data?.systemLogDir).toBe('string')
    })
  })

  // =========================================================================
  // Agent SDK Detection
  // =========================================================================
  describe('Agent SDK Detection', () => {
    it('systemDetectAgentSdks returns detection result', async () => {
      const { data, errors } = await execute(`
        { systemDetectAgentSdks { opencode claude } }
      `)
      expect(errors).toBeUndefined()
      expect(data?.systemDetectAgentSdks).toBeDefined()
      expect(typeof data.systemDetectAgentSdks.opencode).toBe('boolean')
      expect(typeof data.systemDetectAgentSdks.claude).toBe('boolean')
    })
  })

  // =========================================================================
  // Connection Queries (via mock DB)
  // =========================================================================
  describe('Connection Queries', () => {
    let projectId: string
    let worktreeId: string

    beforeEach(async () => {
      // Seed a project and worktree in mock DB
      const project = db.createProject({ name: 'ConnProject', path: '/conn/proj' })
      projectId = project.id
      const wt = db.createWorktree({
        project_id: projectId,
        name: 'main',
        branch_name: 'main',
        path: '/conn/proj/main'
      })
      worktreeId = wt.id
    })

    it('connections returns empty list when none exist', async () => {
      const { data, errors } = await execute('{ connections { id name status } }')
      expect(errors).toBeUndefined()
      expect(data?.connections).toEqual([])
    })

    it('connections returns list with members', async () => {
      // Create a connection directly in the mock
      const conn = db.createConnection({
        name: 'Test Connection',
        path: '/tmp/conn-test',
        color: '["#aaa","#bbb","#ccc","#ddd"]'
      })
      db.createConnectionMember({
        connection_id: conn.id,
        worktree_id: worktreeId,
        project_id: projectId,
        symlink_name: 'ConnProject'
      })

      const { data, errors } = await execute(`
        { connections { id name status path members { worktreeId projectId symlinkName worktreeName projectName } } }
      `)
      expect(errors).toBeUndefined()
      expect(data?.connections).toHaveLength(1)
      expect(data.connections[0].name).toBe('Test Connection')
      expect(data.connections[0].members).toHaveLength(1)
      expect(data.connections[0].members[0]).toMatchObject({
        worktreeId: worktreeId,
        projectId: projectId,
        symlinkName: 'ConnProject',
        worktreeName: 'main',
        projectName: 'ConnProject'
      })
    })

    it('connection by id returns connection with members', async () => {
      const conn = db.createConnection({
        name: 'Specific Connection',
        path: '/tmp/conn-specific'
      })
      db.createConnectionMember({
        connection_id: conn.id,
        worktree_id: worktreeId,
        project_id: projectId,
        symlink_name: 'proj-link'
      })

      const { data, errors } = await execute(
        `query($cid: ID!) { connection(connectionId: $cid) { id name members { symlinkName } } }`,
        { cid: conn.id }
      )
      expect(errors).toBeUndefined()
      expect(data?.connection).toBeDefined()
      expect(data.connection.name).toBe('Specific Connection')
      expect(data.connection.members).toHaveLength(1)
      expect(data.connection.members[0].symlinkName).toBe('proj-link')
    })

    it('connection by id returns null for non-existent', async () => {
      const { data, errors } = await execute(
        `query { connection(connectionId: "non-existent") { id } }`
      )
      expect(errors).toBeUndefined()
      expect(data?.connection).toBeNull()
    })

    it('connections excludes archived connections', async () => {
      const conn = db.createConnection({
        name: 'Archived Connection',
        path: '/tmp/conn-arch'
      })
      db.updateConnection(conn.id, { status: 'archived' })

      const { data } = await execute('{ connections { id } }')
      expect(data?.connections).toHaveLength(0)
    })
  })

  // =========================================================================
  // File Operations (real filesystem)
  // =========================================================================
  describe('File Operations', () => {
    let tempDir: string

    beforeEach(() => {
      tempDir = mkdtempSync(join(tmpdir(), 'hive-test-'))
    })

    afterAll(() => {
      // Clean up temp dirs (best-effort)
      try {
        // Temp dirs created per test are unique; afterAll handles overall cleanup
      } catch {
        /* ignore */
      }
    })

    it('fileRead reads an existing file', async () => {
      const filePath = join(tempDir, 'test.txt')
      writeFileSync(filePath, 'hello world', 'utf-8')

      const { data, errors } = await execute(
        `query($path: String!) { fileRead(filePath: $path) { success content error } }`,
        { path: filePath }
      )
      expect(errors).toBeUndefined()
      expect(data?.fileRead.success).toBe(true)
      expect(data?.fileRead.content).toBe('hello world')
    })

    it('fileRead returns error for non-existent file', async () => {
      const { data, errors } = await execute(
        `query { fileRead(filePath: "/no/such/file.txt") { success error } }`
      )
      expect(errors).toBeUndefined()
      expect(data?.fileRead.success).toBe(false)
      expect(data?.fileRead.error).toBeDefined()
    })

    it('fileWrite writes a file successfully', async () => {
      const filePath = join(tempDir, 'output.txt')

      const { data, errors } = await execute(
        `mutation($path: String!, $content: String!) {
          fileWrite(filePath: $path, content: $content) { success error }
        }`,
        { path: filePath, content: 'written via graphql' }
      )
      expect(errors).toBeUndefined()
      expect(data?.fileWrite.success).toBe(true)

      // Verify by reading it back
      const { data: readData } = await execute(
        `query($path: String!) { fileRead(filePath: $path) { success content } }`,
        { path: filePath }
      )
      expect(readData?.fileRead.content).toBe('written via graphql')
    })

    it('fileWrite returns error for invalid path', async () => {
      const { data, errors } = await execute(
        `mutation {
          fileWrite(filePath: "/no/such/dir/file.txt", content: "test") { success error }
        }`
      )
      expect(errors).toBeUndefined()
      expect(data?.fileWrite.success).toBe(false)
      expect(data?.fileWrite.error).toBeDefined()
    })
  })

  // =========================================================================
  // File Tree Operations (real filesystem)
  // =========================================================================
  describe('File Tree Operations', () => {
    let tempDir: string

    beforeEach(() => {
      tempDir = mkdtempSync(join(tmpdir(), 'hive-tree-'))
      // Create a small directory structure
      writeFileSync(join(tempDir, 'file1.ts'), 'const a = 1')
      writeFileSync(join(tempDir, 'file2.txt'), 'hello')
      mkdirSync(join(tempDir, 'subdir'))
      writeFileSync(join(tempDir, 'subdir', 'nested.js'), 'export {}')
    })

    it('fileTreeScan returns tree structure', async () => {
      const { data, errors } = await execute(
        `query($dir: String!) { fileTreeScan(dirPath: $dir) { success tree { name isDirectory } error } }`,
        { dir: tempDir }
      )
      expect(errors).toBeUndefined()
      expect(data?.fileTreeScan.success).toBe(true)
      expect(data?.fileTreeScan.tree).toBeInstanceOf(Array)
      expect(data?.fileTreeScan.tree.length).toBeGreaterThan(0)

      const names = data.fileTreeScan.tree.map((n: any) => n.name)
      expect(names).toContain('file1.ts')
      expect(names).toContain('subdir')
    })

    it('fileTreeScan returns error for non-existent dir', async () => {
      const { data, errors } = await execute(
        `query { fileTreeScan(dirPath: "/no/such/dir") { success error } }`
      )
      expect(errors).toBeUndefined()
      expect(data?.fileTreeScan.success).toBe(false)
      expect(data?.fileTreeScan.error).toContain('does not exist')
    })

    it('fileTreeScanFlat returns flat file list (requires git repo)', async () => {
      // scanFlat uses git ls-files internally, so it needs a git repo.
      // We test the error case for a non-git directory.
      const { data, errors } = await execute(
        `query($dir: String!) { fileTreeScanFlat(dirPath: $dir) { success error } }`,
        { dir: tempDir }
      )
      expect(errors).toBeUndefined()
      // Non-git directories will fail since scanFlat uses simpleGit
      expect(data?.fileTreeScanFlat.success).toBe(false)
      expect(data?.fileTreeScanFlat.error).toBeDefined()
    })

    it('fileTreeLoadChildren returns children of a subdirectory', async () => {
      const { data, errors } = await execute(
        `query($dir: String!, $root: String!) {
          fileTreeLoadChildren(dirPath: $dir, rootPath: $root) { success children { name isDirectory } error }
        }`,
        { dir: join(tempDir, 'subdir'), root: tempDir }
      )
      expect(errors).toBeUndefined()
      expect(data?.fileTreeLoadChildren.success).toBe(true)
      expect(data?.fileTreeLoadChildren.children).toHaveLength(1)
      expect(data?.fileTreeLoadChildren.children[0].name).toBe('nested.js')
    })
  })

  // =========================================================================
  // File Tree Watch/Unwatch (stub resolvers)
  // =========================================================================
  describe('File Tree Watch Stubs', () => {
    it('fileTreeWatch returns success', async () => {
      const { data, errors } = await execute(
        `mutation { fileTreeWatch(worktreePath: "/tmp/some-path") { success } }`
      )
      expect(errors).toBeUndefined()
      expect(data?.fileTreeWatch.success).toBe(true)
    })

    it('fileTreeUnwatch returns success', async () => {
      const { data, errors } = await execute(
        `mutation { fileTreeUnwatch(worktreePath: "/tmp/some-path") { success } }`
      )
      expect(errors).toBeUndefined()
      expect(data?.fileTreeUnwatch.success).toBe(true)
    })
  })

  // =========================================================================
  // DB Schema Version (cross-check with db.test.ts)
  // =========================================================================
  describe('DB Schema Version', () => {
    it('dbSchemaVersion returns a positive integer', async () => {
      const { data, errors } = await execute('{ dbSchemaVersion }')
      expect(errors).toBeUndefined()
      expect(typeof data?.dbSchemaVersion).toBe('number')
      expect(data.dbSchemaVersion).toBeGreaterThanOrEqual(1)
    })
  })

  // =========================================================================
  // Worktree Existence Check (filesystem-based)
  // =========================================================================
  describe('Worktree Existence', () => {
    it('worktreeExists returns true for existing path', async () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'hive-wt-'))
      const { data, errors } = await execute(
        `query($path: String!) { worktreeExists(worktreePath: $path) }`,
        { path: tempDir }
      )
      expect(errors).toBeUndefined()
      expect(data?.worktreeExists).toBe(true)
      rmSync(tempDir, { recursive: true, force: true })
    })

    it('worktreeExists returns false for non-existent path', async () => {
      const { data, errors } = await execute(
        `query { worktreeExists(worktreePath: "/no/such/path/ever") }`
      )
      expect(errors).toBeUndefined()
      expect(data?.worktreeExists).toBe(false)
    })
  })
})
