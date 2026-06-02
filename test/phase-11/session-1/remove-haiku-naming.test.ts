import { describe, test, expect, vi, beforeEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

const apiMocks = vi.hoisted(() => ({
  dbApi: {
    setting: {
      get: vi.fn(),
      set: vi.fn()
    },
    session: {
      create: vi.fn()
    }
  },
  petApi: {
    hide: vi.fn(),
    show: vi.fn(),
    updateSettings: vi.fn()
  },
  settingsApi: {
    onSettingsUpdated: vi.fn()
  },
  systemApi: {
    detectAgentSdks: vi.fn()
  },
  telegramApi: {
    getConfig: vi.fn()
  }
}))

vi.mock('@/api/db-api', () => ({
  dbApi: apiMocks.dbApi
}))

vi.mock('@/api/pet-api', () => ({
  petApi: apiMocks.petApi
}))

vi.mock('@/api/settings-api', () => ({
  settingsApi: apiMocks.settingsApi
}))

vi.mock('@/api/system-api', () => ({
  systemApi: apiMocks.systemApi
}))

vi.mock('@/api/telegram-api', () => ({
  telegramApi: apiMocks.telegramApi
}))

describe('Session 1: Remove Haiku Naming', () => {
  describe('createSession uses ISO date format title', () => {
    beforeEach(() => {
      vi.clearAllMocks()

      apiMocks.dbApi.setting.get.mockResolvedValue(null)
      apiMocks.dbApi.setting.set.mockResolvedValue(true)
      apiMocks.dbApi.session.create.mockImplementation((data) => ({
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
      apiMocks.petApi.hide.mockResolvedValue(undefined)
      apiMocks.petApi.show.mockResolvedValue(undefined)
      apiMocks.petApi.updateSettings.mockResolvedValue({ success: true })
      apiMocks.settingsApi.onSettingsUpdated.mockReturnValue(vi.fn())
      apiMocks.systemApi.detectAgentSdks.mockResolvedValue({
        opencode: true,
        claude: true,
        codex: true
      })
      apiMocks.telegramApi.getConfig.mockResolvedValue(null)
    })

    test('createSession uses sequential counter title', async () => {
      // Dynamically import the store after mocks are set up
      const { useSessionStore } = await import('../../../src/renderer/src/stores/useSessionStore')

      await useSessionStore
        .getState()
        .createSession('worktree-1', 'project-1', undefined, undefined, { autoFocus: false })

      expect(apiMocks.dbApi.session.create).toHaveBeenCalledOnce()
      const callArgs = apiMocks.dbApi.session.create.mock.calls[0][0]

      // Verify name matches the expected format: "Session N"
      expect(callArgs.name).toMatch(/^Session \d+$/)
    })
  })

  describe('generateSessionName removed from codebase', () => {
    test('generateSessionName does not exist in preload type declarations', () => {
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

    test('generateSessionName command helper removed', () => {
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
      expect(content).toContain('`Session ${sessionNumber}`')
    })
  })
})
