import { describe, test, expect, vi, beforeEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

describe('Session 1: Remove Haiku Naming', () => {
  describe('createSession uses ISO date format title', () => {
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

    test('createSession uses ISO date format title', async () => {
      // Dynamically import the store after mocks are set up
      const { useSessionStore } = await import('../../../src/renderer/src/stores/useSessionStore')

      const beforeTime = new Date().toISOString()
      await useSessionStore.getState().createSession('worktree-1', 'project-1')
      const afterTime = new Date().toISOString()

      expect(mockSessionCreate).toHaveBeenCalledOnce()
      const callArgs = mockSessionCreate.mock.calls[0][0]

      // Verify name matches the expected format
      expect(callArgs.name).toMatch(/^New session - \d{4}-\d{2}-\d{2}T/)

      // Verify the ISO date is within the expected time range
      const nameParts = callArgs.name.split(' - ')
      expect(nameParts[0]).toBe('New session')
      const isoDate = nameParts[1]
      expect(isoDate >= beforeTime).toBe(true)
      expect(isoDate <= afterTime).toBe(true)
    })
  })

  describe('generateSessionName removed from codebase', () => {
    test('generateSessionName does not exist on window.opencodeOps type', () => {
      // Source-level verification: read the preload type declarations
      const dtsPath = path.join(__dirname, '..', '..', '..', 'src', 'preload', 'index.d.ts')
      const content = fs.readFileSync(dtsPath, 'utf-8')
      expect(content).not.toContain('generateSessionName')
    })

    test('generateSessionName does not exist in preload implementation', () => {
      const preloadPath = path.join(__dirname, '..', '..', '..', 'src', 'preload', 'index.ts')
      const content = fs.readFileSync(preloadPath, 'utf-8')
      expect(content).not.toContain('generateSessionName')
    })

    test('NamingCallback interface removed from opencode-service', () => {
      const servicePath = path.join(
        __dirname,
        '..',
        '..',
        '..',
        'src',
        'main',
        'services',
        'opencode-service.ts'
      )
      const content = fs.readFileSync(servicePath, 'utf-8')
      expect(content).not.toContain('NamingCallback')
      expect(content).not.toContain('namingCallbacks')
      expect(content).not.toContain('generateSessionName')
    })

    test('opencode:generateSessionName IPC handler removed', () => {
      const handlersPath = path.join(
        __dirname,
        '..',
        '..',
        '..',
        'src',
        'main',
        'ipc',
        'opencode-handlers.ts'
      )
      const content = fs.readFileSync(handlersPath, 'utf-8')
      expect(content).not.toContain('generateSessionName')
    })

    test('hasTriggeredNamingRef removed from SessionView', () => {
      const sessionViewPath = path.join(
        __dirname,
        '..',
        '..',
        '..',
        'src',
        'renderer',
        'src',
        'components',
        'sessions',
        'SessionView.tsx'
      )
      const content = fs.readFileSync(sessionViewPath, 'utf-8')
      expect(content).not.toContain('hasTriggeredNamingRef')
      expect(content).not.toContain('generateSessionName')
    })

    test('generateSessionName utility removed from session store', () => {
      const storePath = path.join(
        __dirname,
        '..',
        '..',
        '..',
        'src',
        'renderer',
        'src',
        'stores',
        'useSessionStore.ts'
      )
      const content = fs.readFileSync(storePath, 'utf-8')
      // The old utility function
      expect(content).not.toMatch(/function generateSessionName\(\)/)
      // The new format should be present
      expect(content).toContain('New session - ${new Date().toISOString()}')
    })
  })
})
