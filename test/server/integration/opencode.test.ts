import { describe, it, expect, beforeEach, vi } from 'vitest'
import { homedir } from 'os'
import { join } from 'path'

// vi.hoisted ensures the mock object is declared before vi.mock factories run
const mockOpenCodeService = vi.hoisted(() => ({
  connect: vi.fn().mockResolvedValue({ sessionId: 'oc-session-1' }),
  reconnect: vi
    .fn()
    .mockResolvedValue({ success: true, sessionStatus: 'idle', revertMessageID: null }),
  disconnect: vi.fn().mockResolvedValue(undefined),
  prompt: vi.fn().mockResolvedValue(undefined),
  abort: vi.fn().mockResolvedValue(true),
  getMessages: vi.fn().mockResolvedValue([{ id: '1', role: 'user', content: 'hi' }]),
  getAvailableModels: vi
    .fn()
    .mockResolvedValue({ openai: [{ id: 'gpt-4', name: 'GPT-4' }] }),
  getModelInfo: vi.fn().mockResolvedValue({
    id: 'gpt-4',
    name: 'GPT-4',
    limit: { context: 128000, output: 4096 }
  }),
  setSelectedModel: vi.fn(),
  getSessionInfo: vi
    .fn()
    .mockResolvedValue({ revertMessageID: 'msg-5', revertDiff: '@@ -1 +1 @@' }),
  questionReply: vi.fn().mockResolvedValue(undefined),
  questionReject: vi.fn().mockResolvedValue(undefined),
  permissionReply: vi.fn().mockResolvedValue(undefined),
  permissionList: vi.fn().mockResolvedValue([]),
  undo: vi.fn().mockResolvedValue({
    revertMessageID: 'msg-3',
    restoredPrompt: 'my prompt',
    revertDiff: 'diff'
  }),
  redo: vi.fn().mockResolvedValue({ revertMessageID: 'msg-4' }),
  listCommands: vi
    .fn()
    .mockResolvedValue([{ name: 'compact', description: 'Compact', template: '/compact' }]),
  sendCommand: vi.fn().mockResolvedValue(undefined),
  renameSession: vi.fn().mockResolvedValue(undefined),
  forkSession: vi.fn().mockResolvedValue({ sessionId: 'fork-session-1' }),
  setMainWindow: vi.fn()
}))

// Mock Electron
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

// Mock opencode-service
vi.mock('../../../src/main/services/opencode-service', () => ({
  openCodeService: mockOpenCodeService
}))

// Mock event-bus
vi.mock('../../../src/server/event-bus', () => ({
  getEventBus: vi.fn(() => ({ emit: vi.fn() }))
}))

// Mock worktree/branch watchers
vi.mock('../../../src/main/services/worktree-watcher', () => ({
  watchWorktree: vi.fn(),
  unwatchWorktree: vi.fn()
}))

vi.mock('../../../src/main/services/branch-watcher', () => ({
  watchBranch: vi.fn(),
  unwatchBranch: vi.fn()
}))

// Mock connection-service
vi.mock('../../../src/main/services/connection-service', () => ({
  createConnectionDir: vi.fn(() => '/tmp/fake-conn-dir'),
  createSymlink: vi.fn(),
  removeSymlink: vi.fn(),
  deleteConnectionDir: vi.fn(),
  generateConnectionInstructions: vi.fn(),
  deriveSymlinkName: vi.fn((n: string) => n.toLowerCase().replace(/\s+/g, '-')),
  generateConnectionColor: vi.fn(() => '["#aaa","#bbb","#ccc","#ddd"]')
}))

import { MockDatabaseService } from '../helpers/mock-db'
import { createTestServer } from '../helpers/test-server'
import { createMockSdkManager } from '../helpers/mock-sdk'

/* eslint-disable @typescript-eslint/no-explicit-any */

describe('OpenCode Resolvers — Integration Tests', () => {
  let db: MockDatabaseService
  let execute: (
    query: string,
    variables?: Record<string, unknown>
  ) => Promise<{ data?: any; errors?: any[] }>
  let sdkMocks: ReturnType<typeof createMockSdkManager>

  beforeEach(() => {
    vi.clearAllMocks()
    db = new MockDatabaseService()
    sdkMocks = createMockSdkManager()

    const server = createTestServer(db, { sdkManager: sdkMocks.manager })
    execute = server.execute

    // Create test data: project + worktree + 2 sessions (opencode and claude-code)
    const project = db.createProject({
      name: 'Test',
      path: '/tmp/test',
      branch_name: 'main'
    })
    const worktree = db.createWorktree({
      project_id: project.id,
      path: '/tmp/test',
      branch_name: 'main',
      name: 'main',
      is_main: 1
    })
    db.createSession({
      worktree_id: worktree.id,
      project_id: project.id,
      opencode_session_id: 'oc-session-1',
      agent_sdk: 'opencode'
    })
    db.createSession({
      worktree_id: worktree.id,
      project_id: project.id,
      opencode_session_id: 'cc-session-1',
      agent_sdk: 'claude-code'
    })
  })

  // --- Connect ---
  describe('opencodeConnect', () => {
    it('routes to openCodeService for opencode sessions', async () => {
      const worktree = db.worktrees[0]
      const project = db.projects[0]
      const session = db.createSession({
        worktree_id: worktree.id,
        project_id: project.id,
        agent_sdk: 'opencode'
      })

      const result = await execute(`
        mutation { opencodeConnect(worktreePath: "/tmp/test", hiveSessionId: "${session.id}") {
          success sessionId
        }}
      `)

      expect(result.data.opencodeConnect.success).toBe(true)
      expect(result.data.opencodeConnect.sessionId).toBe('oc-session-1')
      expect(mockOpenCodeService.connect).toHaveBeenCalledWith('/tmp/test', session.id)
    })

    it('routes to claude-code implementer for claude-code sessions', async () => {
      const worktree = db.worktrees[0]
      const project = db.projects[0]
      const session = db.createSession({
        worktree_id: worktree.id,
        project_id: project.id,
        agent_sdk: 'claude-code'
      })

      const result = await execute(`
        mutation { opencodeConnect(worktreePath: "/tmp/test", hiveSessionId: "${session.id}") {
          success sessionId
        }}
      `)

      expect(result.data.opencodeConnect.success).toBe(true)
      expect(result.data.opencodeConnect.sessionId).toBe('claude-code-session-1')
      expect(sdkMocks.claudeImpl.connect).toHaveBeenCalledWith('/tmp/test', session.id)
    })
  })

  // --- Disconnect ---
  describe('opencodeDisconnect', () => {
    it('disconnects opencode session', async () => {
      const result = await execute(`
        mutation { opencodeDisconnect(worktreePath: "/tmp/test", sessionId: "oc-session-1") {
          success
        }}
      `)
      expect(result.data.opencodeDisconnect.success).toBe(true)
      expect(mockOpenCodeService.disconnect).toHaveBeenCalledWith('/tmp/test', 'oc-session-1')
    })

    it('disconnects claude-code session via implementer', async () => {
      const result = await execute(`
        mutation { opencodeDisconnect(worktreePath: "/tmp/test", sessionId: "cc-session-1") {
          success
        }}
      `)
      expect(result.data.opencodeDisconnect.success).toBe(true)
      expect(sdkMocks.claudeImpl.disconnect).toHaveBeenCalledWith('/tmp/test', 'cc-session-1')
    })
  })

  // --- Prompt ---
  describe('opencodePrompt', () => {
    it('sends prompt with text message', async () => {
      const result = await execute(`
        mutation { opencodePrompt(input: {
          worktreePath: "/tmp/test"
          opencodeSessionId: "oc-session-1"
          message: "Hello world"
        }) { success }}
      `)
      expect(result.data.opencodePrompt.success).toBe(true)
      expect(mockOpenCodeService.prompt).toHaveBeenCalled()
    })
  })

  // --- Abort ---
  describe('opencodeAbort', () => {
    it('aborts opencode session', async () => {
      const result = await execute(`
        mutation { opencodeAbort(worktreePath: "/tmp/test", sessionId: "oc-session-1") {
          success
        }}
      `)
      expect(result.data.opencodeAbort.success).toBe(true)
    })
  })

  // --- Messages ---
  describe('opencodeMessages', () => {
    it('gets messages from opencode session', async () => {
      const result = await execute(`
        query { opencodeMessages(worktreePath: "/tmp/test", sessionId: "oc-session-1") {
          success messages
        }}
      `)
      expect(result.data.opencodeMessages.success).toBe(true)
      expect(result.data.opencodeMessages.messages).toBeDefined()
    })

    it('gets messages from claude-code session', async () => {
      const result = await execute(`
        query { opencodeMessages(worktreePath: "/tmp/test", sessionId: "cc-session-1") {
          success messages
        }}
      `)
      expect(result.data.opencodeMessages.success).toBe(true)
      expect(sdkMocks.claudeImpl.getMessages).toHaveBeenCalledWith('/tmp/test', 'cc-session-1')
    })
  })

  // --- Session Info ---
  describe('opencodeSessionInfo', () => {
    it('gets session info', async () => {
      const result = await execute(`
        query { opencodeSessionInfo(worktreePath: "/tmp/test", sessionId: "oc-session-1") {
          success revertMessageID revertDiff
        }}
      `)
      expect(result.data.opencodeSessionInfo.success).toBe(true)
      expect(result.data.opencodeSessionInfo.revertMessageID).toBe('msg-5')
    })
  })

  // --- Models ---
  describe('opencodeModels', () => {
    it('lists opencode models by default', async () => {
      const result = await execute(`
        query { opencodeModels { success providers }}
      `)
      expect(result.data.opencodeModels.success).toBe(true)
      expect(mockOpenCodeService.getAvailableModels).toHaveBeenCalled()
    })

    it('lists claude-code models when agentSdk specified', async () => {
      const result = await execute(`
        query { opencodeModels(agentSdk: claude_code) { success providers }}
      `)
      expect(result.data.opencodeModels.success).toBe(true)
      expect(sdkMocks.claudeImpl.getAvailableModels).toHaveBeenCalled()
    })
  })

  // --- Set Model ---
  describe('opencodeSetModel', () => {
    it('sets model for opencode', async () => {
      const result = await execute(`
        mutation { opencodeSetModel(input: {
          providerID: "openai", modelID: "gpt-4"
        }) { success }}
      `)
      expect(result.data.opencodeSetModel.success).toBe(true)
      expect(mockOpenCodeService.setSelectedModel).toHaveBeenCalled()
    })
  })

  // --- Undo ---
  describe('opencodeUndo', () => {
    it('undoes opencode session', async () => {
      const result = await execute(`
        mutation { opencodeUndo(worktreePath: "/tmp/test", sessionId: "oc-session-1") {
          success revertMessageID restoredPrompt revertDiff
        }}
      `)
      expect(result.data.opencodeUndo.success).toBe(true)
      expect(result.data.opencodeUndo.revertMessageID).toBe('msg-3')
      expect(result.data.opencodeUndo.restoredPrompt).toBe('my prompt')
    })
  })

  // --- Redo ---
  describe('opencodeRedo', () => {
    it('redoes opencode session', async () => {
      const result = await execute(`
        mutation { opencodeRedo(worktreePath: "/tmp/test", sessionId: "oc-session-1") {
          success revertMessageID
        }}
      `)
      expect(result.data.opencodeRedo.success).toBe(true)
      expect(result.data.opencodeRedo.revertMessageID).toBe('msg-4')
    })
  })

  // --- Commands ---
  describe('opencodeCommands', () => {
    it('lists commands', async () => {
      const result = await execute(`
        query { opencodeCommands(worktreePath: "/tmp/test") {
          success commands { name description template }
        }}
      `)
      expect(result.data.opencodeCommands.success).toBe(true)
      expect(result.data.opencodeCommands.commands).toHaveLength(1)
      expect(result.data.opencodeCommands.commands[0].name).toBe('compact')
    })
  })

  // --- Capabilities ---
  describe('opencodeCapabilities', () => {
    it('returns opencode capabilities by default', async () => {
      const result = await execute(`
        query { opencodeCapabilities { success capabilities {
          supportsUndo supportsRedo supportsCommands
        }}}
      `)
      expect(result.data.opencodeCapabilities.success).toBe(true)
      expect(result.data.opencodeCapabilities.capabilities.supportsRedo).toBe(true)
    })

    it('returns claude-code capabilities for claude session', async () => {
      const result = await execute(`
        query { opencodeCapabilities(sessionId: "cc-session-1") { success capabilities {
          supportsUndo supportsRedo
        }}}
      `)
      expect(result.data.opencodeCapabilities.success).toBe(true)
      expect(result.data.opencodeCapabilities.capabilities.supportsRedo).toBe(false)
    })
  })

  // --- Permission List ---
  describe('opcodePermissionList', () => {
    it('lists permissions', async () => {
      const result = await execute(`
        query { opencodePermissionList { success permissions { id } }}
      `)
      expect(result.data.opencodePermissionList.success).toBe(true)
    })
  })

  // --- Permission Reply ---
  describe('opcodePermissionReply', () => {
    it('replies to permission request', async () => {
      const result = await execute(`
        mutation { opencodePermissionReply(input: {
          requestId: "perm-1", reply: "once"
        }) { success }}
      `)
      expect(result.data.opencodePermissionReply.success).toBe(true)
      expect(mockOpenCodeService.permissionReply).toHaveBeenCalledWith(
        'perm-1',
        'once',
        undefined,
        undefined
      )
    })
  })

  // --- Question Reply ---
  describe('opencodeQuestionReply', () => {
    it('replies to question via opencode', async () => {
      const result = await execute(`
        mutation { opencodeQuestionReply(input: {
          requestId: "q-1", answers: [["yes"]]
        }) { success }}
      `)
      expect(result.data.opencodeQuestionReply.success).toBe(true)
    })
  })

  // --- Question Reject ---
  describe('opencodeQuestionReject', () => {
    it('rejects question', async () => {
      const result = await execute(`
        mutation { opencodeQuestionReject(requestId: "q-1") { success }}
      `)
      expect(result.data.opencodeQuestionReject.success).toBe(true)
    })
  })

  // --- Fork ---
  describe('opencodeFork', () => {
    it('forks session', async () => {
      const result = await execute(`
        mutation { opencodeFork(input: {
          worktreePath: "/tmp/test", opencodeSessionId: "oc-session-1"
        }) { success sessionId }}
      `)
      expect(result.data.opencodeFork.success).toBe(true)
      expect(result.data.opencodeFork.sessionId).toBe('fork-session-1')
    })
  })

  // --- Rename ---
  describe('opencodeRenameSession', () => {
    it('renames session', async () => {
      const result = await execute(`
        mutation { opencodeRenameSession(input: {
          opencodeSessionId: "oc-session-1", title: "New Title"
        }) { success }}
      `)
      expect(result.data.opencodeRenameSession.success).toBe(true)
      expect(mockOpenCodeService.renameSession).toHaveBeenCalledWith(
        'oc-session-1',
        'New Title',
        undefined
      )
    })
  })

  // --- Reconnect ---
  describe('opencodeReconnect', () => {
    it('reconnects opencode session', async () => {
      const sessionId = db.sessions[0].id
      const result = await execute(`
        mutation { opencodeReconnect(input: {
          worktreePath: "/tmp/test"
          opencodeSessionId: "oc-session-1"
          hiveSessionId: "${sessionId}"
        }) { success sessionStatus revertMessageID }}
      `)
      expect(result.data.opencodeReconnect.success).toBe(true)
    })
  })
})
