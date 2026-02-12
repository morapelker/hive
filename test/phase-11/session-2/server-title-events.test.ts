import { describe, test, expect, vi, beforeEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

describe('Session 2: Server Title Events', () => {
  describe('session.updated event handling in renderer', () => {
    beforeEach(() => {
      Object.defineProperty(window, 'db', {
        writable: true,
        configurable: true,
        value: {
          session: {
            create: vi.fn(),
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

    test('updateSessionName is available on session store', async () => {
      const { useSessionStore } = await import('../../../src/renderer/src/stores/useSessionStore')
      const store = useSessionStore.getState()
      expect(typeof store.updateSessionName).toBe('function')
    })
  })

  describe('session.updated handler exists in SessionView', () => {
    test('SessionView handles session.updated events', () => {
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
      // Verify the session.updated handler exists
      expect(content).toContain("event.type === 'session.updated'")
      // Verify it calls updateSessionName with the title from info
      expect(content).toContain('updateSessionName(sessionId, sessionTitle)')
    })

    test('session.updated handler checks for title field', () => {
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
      // Verify title field guard - checks info.title (SDK structure) with fallback
      expect(content).toContain('event.data?.info?.title')
    })
  })

  describe('session.updated handler exists in main process', () => {
    test('opencode-service handles session.updated events', () => {
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
      // Verify the session.updated handler block exists
      expect(content).toContain("eventType === 'session.updated'")
      // Verify it persists the title via DB (uses hiveSessionId and extracts title from info)
      expect(content).toContain('db.updateSession(hiveSessionId, { name: sessionTitle })')
    })
  })

  describe('renameSession IPC chain', () => {
    test('renameSession method exists in opencode-service', () => {
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
      expect(content).toContain('async renameSession(')
      expect(content).toContain('client.session.patch')
    })

    test('opencode:renameSession IPC handler registered', () => {
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
      expect(content).toContain("'opencode:renameSession'")
      expect(content).toContain('openCodeService.renameSession')
    })

    test('preload exposes renameSession on opencodeOps', () => {
      const preloadPath = path.join(__dirname, '..', '..', '..', 'src', 'preload', 'index.ts')
      const content = fs.readFileSync(preloadPath, 'utf-8')
      expect(content).toContain('renameSession:')
      expect(content).toContain("ipcRenderer.invoke('opencode:renameSession'")
    })

    test('preload type declarations include renameSession', () => {
      const dtsPath = path.join(__dirname, '..', '..', '..', 'src', 'preload', 'index.d.ts')
      const content = fs.readFileSync(dtsPath, 'utf-8')
      expect(content).toContain('renameSession')
      // Verify the full signature shape
      expect(content).toContain('opencodeSessionId: string')
      expect(content).toContain('title: string')
      expect(content).toContain('worktreePath?: string')
    })
  })
})
