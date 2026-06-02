import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockSessionCreate = vi.fn()

vi.mock('@/stores/store-coordination', () => ({
  notifyKanbanSessionSync: vi.fn(),
  notifyKanbanNewSession: vi.fn(),
  registerConnectionClear: vi.fn(),
  registerWorktreeClear: vi.fn(),
  clearConnectionSelection: vi.fn(),
  clearWorktreeSelection: vi.fn(),
  registerKanbanSessionSync: vi.fn(),
  registerKanbanNewSession: vi.fn()
}))

describe('useSessionStore unavailable provider guard', () => {
  beforeEach(() => {
    vi.resetModules()
    mockSessionCreate.mockReset()

    Object.defineProperty(window, 'db', {
      writable: true,
      configurable: true,
      value: {
        setting: {
          get: vi.fn().mockResolvedValue(null),
          set: vi.fn().mockResolvedValue(undefined)
        },
        session: {
          create: mockSessionCreate
        }
      }
    })

    Object.defineProperty(window, 'systemOps', {
      writable: true,
      configurable: true,
      value: {
        ...(window.systemOps ?? {}),
        detectAgentSdks: vi.fn().mockResolvedValue({
          opencode: false,
          claude: true,
          codex: true
        })
      }
    })
  })

  it('blocks new sessions when the configured provider is unavailable', async () => {
    const { useSettingsStore } = await import('@/stores/useSettingsStore')
    const { useSessionStore } = await import('@/stores/useSessionStore')

    useSettingsStore.setState({
      defaultAgentSdk: 'opencode',
      availableAgentSdks: {
        opencode: false,
        claude: true,
        codex: true
      }
    })

    const result = await useSessionStore.getState().createSession('wt-1', 'proj-1')

    expect(result.success).toBe(false)
    expect(result.error).toContain('OpenCode is not available on this system')
    expect(mockSessionCreate).not.toHaveBeenCalled()
  })
})
