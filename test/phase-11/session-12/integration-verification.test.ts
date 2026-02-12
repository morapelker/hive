import { describe, test, expect, vi, beforeEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

// Mock electron's app module so importing git-service doesn't crash in jsdom
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn().mockReturnValue('/tmp/mock-home')
  }
}))

// Mock simple-git so the module can load without real git
vi.mock('simple-git', () => ({
  default: vi.fn().mockReturnValue({
    branch: vi.fn(),
    raw: vi.fn()
  })
}))

// Import pure functions after mocks are in place
import { canonicalizeBranchName } from '../../../src/main/services/git-service'
import { BREED_NAMES, LEGACY_CITY_NAMES } from '../../../src/main/services/breed-names'

// Helper to resolve paths from project root
function srcPath(...segments: string[]): string {
  return path.join(__dirname, '..', '..', '..', 'src', ...segments)
}

function readSrc(...segments: string[]): string {
  return fs.readFileSync(srcPath(...segments), 'utf-8')
}

describe('Session 12: Integration & Verification', () => {
  // ─── Cross-feature: Title event → branch auto-rename end-to-end ─────
  describe('title event triggers branch auto-rename', () => {
    test('session.updated handler persists title AND triggers auto-rename', () => {
      const content = readSrc('main', 'services', 'opencode-service.ts')

      // Title persistence
      expect(content).toContain('db.updateSession(hiveSessionId, { name: sessionTitle })')

      // Auto-rename logic follows title persistence
      const titlePersistIdx = content.indexOf(
        'db.updateSession(hiveSessionId, { name: sessionTitle })'
      )
      const autoRenameIdx = content.indexOf('Auto-rename branch if still an auto-generated name')
      expect(autoRenameIdx).toBeGreaterThan(titlePersistIdx)
    })

    test('auto-rename uses canonicalizeBranchName on the server title', () => {
      const content = readSrc('main', 'services', 'opencode-service.ts')
      expect(content).toContain('canonicalizeBranchName(sessionTitle)')
    })

    test('renderer receives both title update and branch rename events', () => {
      const content = readSrc('main', 'services', 'opencode-service.ts')
      // Title: forwarded as session.updated event to renderer
      expect(content).toContain("'session.updated'")
      // Branch rename: explicit notification
      expect(content).toContain("this.sendToRenderer('worktree:branchRenamed'")
    })

    test('renderer updates session name from session.updated event', () => {
      const content = readSrc('renderer', 'src', 'components', 'sessions', 'SessionView.tsx')
      expect(content).toContain('session.updated')
      expect(content).toContain('updateSessionName')
    })

    test('renderer updates branch name from worktree:branchRenamed event', () => {
      const content = readSrc('renderer', 'src', 'hooks', 'useOpenCodeGlobalListener.ts')
      expect(content).toContain('onBranchRenamed')
      expect(content).toContain('updateWorktreeBranch')
    })
  })

  // ─── Cross-feature: Manual rename prevents future auto-rename ────────
  describe('manual rename prevents future auto-rename', () => {
    test('worktree:renameBranch handler sets branch_renamed to 1', () => {
      const content = readSrc('main', 'ipc', 'worktree-handlers.ts')
      // Find the renameBranch handler
      expect(content).toContain("'worktree:renameBranch'")
      expect(content).toContain('branch_renamed: 1')
    })

    test('auto-rename checks branch_renamed flag before proceeding', () => {
      const content = readSrc('main', 'services', 'opencode-service.ts')
      expect(content).toContain('!worktree.branch_renamed')
    })

    test('auto-rename checks auto-generated name before proceeding', () => {
      const content = readSrc('main', 'services', 'opencode-service.ts')
      expect(content).toContain('ALL_BREED_NAMES.some')
    })

    test('once branch_renamed=1 after manual rename, auto-rename skips', () => {
      // Verify the control flow: branch_renamed check comes before rename attempt
      const content = readSrc('main', 'services', 'opencode-service.ts')
      const autoRenameBlock = content.slice(
        content.indexOf('Auto-rename branch if still an auto-generated name')
      )
      const flagCheckIdx = autoRenameBlock.indexOf('!worktree.branch_renamed')
      const renameCallIdx = autoRenameBlock.indexOf('gitService.renameBranch(')
      expect(flagCheckIdx).toBeGreaterThan(-1)
      expect(renameCallIdx).toBeGreaterThan(flagCheckIdx)
    })
  })

  // ─── Cross-feature: Auto-start + title flow ──────────────────────────
  describe('auto-start creates session in new worktree from branch', () => {
    test('auto-start effect exists in SessionTabs', () => {
      const content = readSrc('renderer', 'src', 'components', 'sessions', 'SessionTabs.tsx')
      expect(content).toContain('autoStartSession')
      expect(content).toContain('autoStartedRef')
      expect(content).toContain('createSession')
    })

    test('auto-start only fires when worktree has 0 sessions', () => {
      const content = readSrc('renderer', 'src', 'components', 'sessions', 'SessionTabs.tsx')
      expect(content).toContain('sessions.length')
    })

    test('new session gets ISO date title that server recognizes as placeholder', () => {
      const content = readSrc('renderer', 'src', 'stores', 'useSessionStore.ts')
      expect(content).toContain('New session - ${new Date().toISOString()}')
    })

    test('server recognizes placeholder title and will auto-generate', () => {
      // The opencode-service skips auto-rename for placeholder titles
      const content = readSrc('main', 'services', 'opencode-service.ts')
      expect(content).toContain('isPlaceholderTitle')
      expect(content).toContain(/New session/i.source || 'New session')
    })

    test('createWorktreeFromBranch IPC and auto-start are both available', () => {
      const wtHandlers = readSrc('main', 'ipc', 'worktree-handlers.ts')
      expect(wtHandlers).toContain("'worktree:createFromBranch'")

      const preload = readSrc('preload', 'index.ts')
      expect(preload).toContain('createFromBranch')
    })
  })

  // ─── Cross-feature: Streaming state preserved across tab switches ────
  describe('streaming state preserved across tab switches', () => {
    test('partial clear preserves isStreaming when switching sessions', () => {
      const content = readSrc('renderer', 'src', 'components', 'sessions', 'SessionView.tsx')

      const partialClearStart = content.indexOf('if (!isStreaming) {')
      const partialClearEnd = content.indexOf(
        'hasFinalizedCurrentResponseRef.current = false',
        partialClearStart
      )
      expect(partialClearStart).toBeGreaterThan(-1)
      expect(partialClearEnd).toBeGreaterThan(partialClearStart)

      const partialClearBlock = content.slice(partialClearStart, partialClearEnd)

      // Partial clear resets display data
      expect(content).toContain('streamingPartsRef.current = []')
      expect(content).toContain("streamingContentRef.current = ''")
      expect(content).toContain('Only clear streaming display state if NOT currently streaming')
      // But does NOT call resetStreamingState which would set isStreaming=false
      expect(partialClearBlock).not.toContain('resetStreamingState()')
      expect(partialClearBlock).not.toContain('setIsStreaming(false)')
    })

    test('generation counter prevents stale closures from processing wrong events', () => {
      const content = readSrc('renderer', 'src', 'components', 'sessions', 'SessionView.tsx')
      expect(content).toContain('streamGenerationRef.current += 1')
      expect(content).toContain('streamGenerationRef.current !== currentGeneration')
    })

    test('session.status events correctly control isStreaming after remount', () => {
      const content = readSrc('renderer', 'src', 'components', 'sessions', 'SessionView.tsx')
      expect(content).toContain("status.type === 'busy'")
      expect(content).toContain('setIsStreaming(true)')
      expect(content).toContain('setIsStreaming(false)')
    })
  })

  // ─── Cross-feature: Tool call result merges after tab switch ─────────
  describe('tool call result merges after tab switch', () => {
    test('streaming parts restored from last assistant message on remount', () => {
      const content = readSrc('renderer', 'src', 'components', 'sessions', 'SessionView.tsx')
      expect(content).toContain("lastMsg.role === 'assistant'")
      expect(content).toContain('lastMsg.parts')
      expect(content).toContain('const dbParts = lastMsg.parts.map((p) => ({ ...p }))')
      expect(content).toContain('let restoredParts = dbParts')
      expect(content).toContain('restoredParts = [...dbParts, ...extraParts]')
      expect(content).toContain('const hasActiveStreamingPart = restoredParts.some')
      expect(content).toContain('streamingPartsRef.current = restoredParts')
      expect(content).toContain('streamingPartsRef.current = []')
    })

    test('mapOpencodePartToStreamingPart preserves callID for tool result merging', () => {
      const content = readSrc('renderer', 'src', 'lib', 'opencode-transcript.ts')
      expect(content).toContain('export function mapOpencodePartToStreamingPart')
      expect(content).toContain(
        'id: asString(record.callID) ?? asString(record.id) ?? `tool-${index}`'
      )
    })

    test('text content is restored for continuity after switch', () => {
      const content = readSrc('renderer', 'src', 'components', 'sessions', 'SessionView.tsx')
      expect(content).toContain("p.type === 'text'")
      expect(content).toContain('streamingContentRef.current = content')
    })
  })

  // ─── Cross-feature: No streaming content in wrong tab ────────────────
  describe('no streaming content in wrong tab', () => {
    test('session ID guard exists in stream handler', () => {
      const content = readSrc('renderer', 'src', 'components', 'sessions', 'SessionView.tsx')
      expect(content).toContain('event.sessionId !== sessionId')
    })

    test('generation guard exists in stream handler', () => {
      const content = readSrc('renderer', 'src', 'components', 'sessions', 'SessionView.tsx')
      expect(content).toContain('streamGenerationRef.current !== currentGeneration')
    })

    test('stream subscription is cleaned up on unmount', () => {
      const content = readSrc('renderer', 'src', 'components', 'sessions', 'SessionView.tsx')
      // The useEffect should return an unsubscribe cleanup
      expect(content).toContain('unsubscribe()')
    })
  })

  // ─── Cross-feature: File sidebar tabs work during streaming ──────────
  describe('file sidebar tabs work during streaming', () => {
    test('FileSidebar component exists with two tabs', () => {
      const content = readSrc('renderer', 'src', 'components', 'file-tree', 'FileSidebar.tsx')
      expect(content).toContain("'changes'")
      expect(content).toContain("'files'")
      expect(content).toContain('<ChangesView')
      expect(content).toContain('<FileTree')
    })

    test('FileSidebar is independent from session streaming state', () => {
      const content = readSrc('renderer', 'src', 'components', 'file-tree', 'FileSidebar.tsx')
      // FileSidebar should NOT reference isStreaming or streaming state
      expect(content).not.toContain('isStreaming')
      expect(content).not.toContain('streamingParts')
    })

    test('ChangesView subscribes to git store, not streaming state', () => {
      const content = readSrc('renderer', 'src', 'components', 'file-tree', 'ChangesView.tsx')
      expect(content).toContain('useGitStore')
      expect(content).not.toContain('isStreaming')
    })

    test('Files tab hides git indicators in FileTree', () => {
      const content = readSrc('renderer', 'src', 'components', 'file-tree', 'FileSidebar.tsx')
      expect(content).toContain('hideGitIndicators')
      expect(content).toContain('hideGitContextActions')
      expect(content).toContain('hideHeader')
    })
  })

  // ─── Cross-feature: UI text changes visible during streaming ─────────
  describe('UI text changes visible during streaming', () => {
    test('no "Streaming..." text anywhere in AssistantCanvas', () => {
      const content = readSrc('renderer', 'src', 'components', 'sessions', 'AssistantCanvas.tsx')
      expect(content).not.toContain('Streaming...')
    })

    test('StreamingCursor still renders during streaming', () => {
      const content = readSrc('renderer', 'src', 'components', 'sessions', 'AssistantCanvas.tsx')
      expect(content).toContain('<StreamingCursor')
    })

    test('ToolCard shows "Agent" for task tool calls', () => {
      const content = readSrc('renderer', 'src', 'components', 'sessions', 'ToolCard.tsx')
      const taskSection = content.slice(content.indexOf('// Task'))
      expect(taskSection).toContain('>Agent<')
      expect(taskSection).not.toContain('>Task<')
    })

    test('TaskToolView shows "Sub-agent" fallback', () => {
      const content = readSrc(
        'renderer',
        'src',
        'components',
        'sessions',
        'tools',
        'TaskToolView.tsx'
      )
      expect(content).toContain("'Sub-agent'")
      expect(content).not.toContain("'Agent Task'")
    })
  })

  // ─── Integration: Full IPC chain verification ────────────────────────
  describe('full IPC chain verification', () => {
    const ipcChannels = [
      {
        channel: 'opencode:renameSession',
        handler: 'opencode-handlers.ts',
        preloadMethod: 'renameSession'
      },
      {
        channel: 'worktree:renameBranch',
        handler: 'worktree-handlers.ts',
        preloadMethod: 'renameBranch'
      },
      {
        channel: 'worktree:createFromBranch',
        handler: 'worktree-handlers.ts',
        preloadMethod: 'createFromBranch'
      },
      {
        channel: 'git:listBranchesWithStatus',
        handler: 'worktree-handlers.ts',
        preloadMethod: 'listBranchesWithStatus'
      }
    ]

    for (const { channel, handler, preloadMethod } of ipcChannels) {
      test(`${channel}: handler registered in ${handler}`, () => {
        const content = readSrc('main', 'ipc', handler)
        expect(content).toContain(`'${channel}'`)
      })

      test(`${channel}: preload exposes ${preloadMethod}`, () => {
        const preload = readSrc('preload', 'index.ts')
        expect(preload).toContain(preloadMethod)
      })

      test(`${channel}: type declaration exists for ${preloadMethod}`, () => {
        const dts = readSrc('preload', 'index.d.ts')
        expect(dts).toContain(preloadMethod)
      })
    }
  })

  // ─── Integration: DB schema consistency ──────────────────────────────
  describe('DB schema consistency', () => {
    test('branch_renamed column migration exists', () => {
      const content = readSrc('main', 'db', 'schema.ts')
      expect(content).toContain('branch_renamed')
      expect(content).toContain('ALTER TABLE worktrees ADD COLUMN branch_renamed')
    })

    test('Worktree type includes branch_renamed in DB types', () => {
      const content = readSrc('main', 'db', 'types.ts')
      expect(content).toContain('branch_renamed')
    })

    test('Worktree type includes branch_renamed in preload types', () => {
      const content = readSrc('preload', 'index.d.ts')
      expect(content).toContain('branch_renamed')
    })

    test('database CRUD handles branch_renamed field', () => {
      const content = readSrc('main', 'db', 'database.ts')
      expect(content).toContain('branch_renamed')
    })
  })

  // ─── Integration: No stale references to removed features ────────────
  describe('no stale references to removed features', () => {
    const filesToCheck = [
      ['main', 'services', 'opencode-service.ts'],
      ['main', 'ipc', 'opencode-handlers.ts'],
      ['preload', 'index.ts'],
      ['preload', 'index.d.ts'],
      ['renderer', 'src', 'components', 'sessions', 'SessionView.tsx'],
      ['renderer', 'src', 'stores', 'useSessionStore.ts']
    ]

    for (const segments of filesToCheck) {
      test(`${segments.join('/')} has no generateSessionName references`, () => {
        const content = readSrc(...segments)
        expect(content).not.toContain('generateSessionName')
      })

      test(`${segments.join('/')} has no NamingCallback references`, () => {
        const content = readSrc(...segments)
        expect(content).not.toContain('NamingCallback')
      })

      test(`${segments.join('/')} has no namingCallbacks references`, () => {
        const content = readSrc(...segments)
        expect(content).not.toContain('namingCallbacks')
      })
    }

    test('SessionView has no hasTriggeredNamingRef', () => {
      const content = readSrc('renderer', 'src', 'components', 'sessions', 'SessionView.tsx')
      expect(content).not.toContain('hasTriggeredNamingRef')
    })
  })

  // ─── Integration: canonicalizeBranchName with real titles ────────────
  describe('canonicalizeBranchName end-to-end with realistic titles', () => {
    test('server title "Auth Setup Guide" → "auth-setup-guide"', () => {
      expect(canonicalizeBranchName('Auth Setup Guide')).toBe('auth-setup-guide')
    })

    test('server title with special chars "Fix #123: Memory Leak!" → "fix-123-memory-leak"', () => {
      expect(canonicalizeBranchName('Fix #123: Memory Leak!')).toBe('fix-123-memory-leak')
    })

    test('long server title is truncated to 50 chars', () => {
      const longTitle = 'Implement comprehensive authentication system with OAuth2 and SAML support'
      const result = canonicalizeBranchName(longTitle)
      expect(result.length).toBeLessThanOrEqual(50)
      expect(result.endsWith('-')).toBe(false)
    })

    test('city names remain valid branch names', () => {
      for (const city of ['tokyo', 'oslo', 'lima', 'cairo', 'paris']) {
        const result = canonicalizeBranchName(city)
        expect(result).toBe(city)
      }
    })

    test('canonicalized title differs from auto-generated name for typical titles', () => {
      const title = 'Debug Authentication Module'
      const branch = canonicalizeBranchName(title)
      const isAutoName =
        BREED_NAMES.some((b) => b === branch) || LEGACY_CITY_NAMES.some((c) => c === branch)
      expect(isAutoName).toBe(false)
    })

    test('empty/whitespace titles produce empty string (prevents rename)', () => {
      expect(canonicalizeBranchName('')).toBe('')
      expect(canonicalizeBranchName('   ')).toBe('')
      expect(canonicalizeBranchName('!!!')).toBe('')
    })

    test('preserves slashes and dots for feature branch style', () => {
      expect(canonicalizeBranchName('feature/auth.v2')).toBe('feature/auth.v2')
    })
  })

  // ─── Integration: Store actions exist for cross-feature coordination ─
  describe('store actions for cross-feature coordination', () => {
    let mockSessionCreate: ReturnType<typeof vi.fn>

    beforeEach(() => {
      mockSessionCreate = vi.fn().mockImplementation((data) => ({
        id: 'session-1',
        worktree_id: data.worktree_id,
        project_id: data.project_id,
        name: data.name,
        status: 'active',
        opencode_session_id: null,
        mode: 'build',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        completed_at: null
      }))

      Object.defineProperty(window, 'db', {
        writable: true,
        configurable: true,
        value: {
          session: {
            create: mockSessionCreate,
            get: vi.fn(),
            getByWorktree: vi.fn().mockResolvedValue([]),
            getByProject: vi.fn().mockResolvedValue([]),
            getActiveByWorktree: vi.fn().mockResolvedValue([]),
            update: vi.fn(),
            delete: vi.fn(),
            search: vi.fn(),
            getDraft: vi.fn().mockResolvedValue(null),
            updateDraft: vi.fn()
          },
          project: {
            create: vi.fn(),
            get: vi.fn(),
            getByPath: vi.fn(),
            getAll: vi.fn(),
            update: vi.fn(),
            delete: vi.fn(),
            touch: vi.fn()
          },
          worktree: {
            create: vi.fn(),
            get: vi.fn(),
            getByProject: vi.fn(),
            getActiveByProject: vi.fn(),
            update: vi.fn(),
            delete: vi.fn(),
            archive: vi.fn(),
            touch: vi.fn()
          },
          message: {
            create: vi.fn(),
            getBySession: vi.fn().mockResolvedValue([]),
            delete: vi.fn()
          },
          setting: {
            get: vi.fn(),
            set: vi.fn(),
            delete: vi.fn(),
            getAll: vi.fn()
          },
          schemaVersion: vi.fn(),
          tableExists: vi.fn(),
          getIndexes: vi.fn()
        }
      })
    })

    test('createSession produces placeholder title that server will replace', async () => {
      const { useSessionStore } = await import('../../../src/renderer/src/stores/useSessionStore')

      await useSessionStore.getState().createSession('wt-1', 'proj-1')

      expect(mockSessionCreate).toHaveBeenCalledOnce()
      const callArgs = mockSessionCreate.mock.calls[0][0]
      expect(callArgs.name).toMatch(/^New session - \d{4}-\d{2}-\d{2}T/)
    })

    test('updateSessionName action exists for title events', async () => {
      const { useSessionStore } = await import('../../../src/renderer/src/stores/useSessionStore')
      expect(typeof useSessionStore.getState().updateSessionName).toBe('function')
    })

    test('updateWorktreeBranch action exists for branch rename events', async () => {
      const { useWorktreeStore } = await import('../../../src/renderer/src/stores/useWorktreeStore')
      expect(typeof useWorktreeStore.getState().updateWorktreeBranch).toBe('function')
    })
  })

  // ─── Integration: BranchPickerDialog wiring ──────────────────────────
  describe('worktree from branch wiring', () => {
    test('BranchPickerDialog.tsx exists', () => {
      const content = readSrc(
        'renderer',
        'src',
        'components',
        'worktrees',
        'BranchPickerDialog.tsx'
      )
      expect(content).toBeTruthy()
      expect(content).toContain('listBranchesWithStatus')
    })

    test('ProjectItem has "New Workspace From..." menu item', () => {
      const content = readSrc('renderer', 'src', 'components', 'projects', 'ProjectItem.tsx')
      expect(content).toContain('New Workspace From')
      expect(content).toContain('BranchPickerDialog')
    })

    test('git-service has listBranchesWithStatus and createWorktreeFromBranch', () => {
      const content = readSrc('main', 'services', 'git-service.ts')
      expect(content).toContain('listBranchesWithStatus')
      expect(content).toContain('createWorktreeFromBranch')
    })
  })

  // ─── Integration: Manual branch rename via WorktreeItem ──────────────
  describe('manual branch rename wiring', () => {
    test('WorktreeItem has Rename Branch menu item', () => {
      const content = readSrc('renderer', 'src', 'components', 'worktrees', 'WorktreeItem.tsx')
      expect(content).toContain('Rename Branch')
      expect(content).toContain('isRenamingBranch')
    })

    test('WorktreeItem calls worktreeOps.renameBranch', () => {
      const content = readSrc('renderer', 'src', 'components', 'worktrees', 'WorktreeItem.tsx')
      expect(content).toContain('window.worktreeOps.renameBranch')
    })

    test('WorktreeItem updates store after successful rename', () => {
      const content = readSrc('renderer', 'src', 'components', 'worktrees', 'WorktreeItem.tsx')
      expect(content).toContain('updateWorktreeBranch')
    })
  })
})
