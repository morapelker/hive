import { describe, test, expect, vi, beforeEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

const apiMocks = vi.hoisted(() => ({
  dbApi: {
    session: {
      update: vi.fn()
    }
  },
  settingsApi: {
    onSettingsUpdated: vi.fn(() => vi.fn())
  }
}))

vi.mock('@/api/db-api', () => ({
  dbApi: apiMocks.dbApi
}))

vi.mock('@/api/settings-api', () => ({
  settingsApi: apiMocks.settingsApi
}))

import { dbApi } from '@/api/db-api'

const mockSessionDb = vi.mocked(dbApi.session)

describe('Session 2: Server Title Events', () => {
  describe('session.updated event handling in renderer', () => {
    beforeEach(() => {
      vi.clearAllMocks()
      mockSessionDb.update.mockResolvedValue({ id: 'session-1', name: 'New title' })
    })

    test('updateSessionName is available on session store', async () => {
      const { useSessionStore } = await import('../../../src/renderer/src/stores/useSessionStore')
      const store = useSessionStore.getState()
      expect(typeof store.updateSessionName).toBe('function')
    })

    test('updateSessionName persists through dbApi.session.update', async () => {
      const { useSessionStore } = await import('../../../src/renderer/src/stores/useSessionStore')

      await expect(useSessionStore.getState().updateSessionName('session-1', 'New title')).resolves.toBe(
        true
      )

      expect(mockSessionDb.update).toHaveBeenCalledWith('session-1', { name: 'New title' })
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

  describe('renameSession RPC chain', () => {
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

    test('renameSession command helper is available for RPC routing', () => {
      const commandsPath = path.join(
        __dirname,
        '..',
        '..',
        '..',
        'src',
        'main',
        'services',
        'opencode-session-commands.ts'
      )
      const content = fs.readFileSync(commandsPath, 'utf-8')
      expect(content).toContain('export async function renameOpenCodeSession')
      expect(content).toContain('openCodeService.renameSession')
    })

    test('opencodeApi.renameSession routes through the RPC client', () => {
      const opencodeApiPath = path.join(
        __dirname,
        '..',
        '..',
        '..',
        'src',
        'renderer',
        'src',
        'api',
        'opencode-api.ts'
      )
      const content = fs.readFileSync(opencodeApiPath, 'utf-8')
      expect(content).toContain('renameSession:')
      expect(content).toContain(
        "getRendererRpcClient().request<OpenCodeRenameSessionResult>(\n      'opencodeOps.renameSession'"
      )
    })

    test('preload type declarations do not expose the old renameSession bridge', () => {
      const dtsPath = path.join(__dirname, '..', '..', '..', 'src', 'preload', 'index.d.ts')
      const content = fs.readFileSync(dtsPath, 'utf-8')
      expect(content).not.toContain('renameSession')
      expect(content).not.toContain('opencodeSessionId: string')
      expect(content).not.toContain('worktreePath?: string')
    })
  })
})
