import { vi, describe, test, expect, beforeEach, afterEach } from 'vitest'

const apiMocks = vi.hoisted(() => ({
  systemApi: {
    setSessionQueuedState: vi.fn(),
    detectAgentSdks: vi.fn()
  },
  dbApi: {
    setting: {
      get: vi.fn(),
      set: vi.fn()
    },
    session: {
      update: vi.fn()
    }
  },
  settingsApi: {
    onSettingsUpdated: vi.fn(() => vi.fn())
  }
}))

vi.mock('@/api/system-api', () => ({
  systemApi: apiMocks.systemApi
}))

vi.mock('@/api/db-api', () => ({
  dbApi: apiMocks.dbApi
}))

vi.mock('@/api/settings-api', () => ({
  settingsApi: apiMocks.settingsApi
}))

// -----------------------------------------------------------------------------
// Suite 1 setup: mock electron + logger BEFORE importing notificationService.
// Pattern copied from test/phase-14/session-6/dock-badge.test.ts.
// -----------------------------------------------------------------------------

const mockSetBadge = vi.fn()
const mockSetBadgeCount = vi.fn()
const mockNotificationShow = vi.fn()
const mockNotificationOn = vi.fn()
let notificationsSupported = true
const originalPlatform = process.platform

vi.mock('electron', () => ({
  Notification: class MockNotification {
    static isSupported(): boolean {
      return notificationsSupported
    }
    constructor(_opts: Record<string, unknown>) {}
    on = mockNotificationOn
    show = mockNotificationShow
  },
  BrowserWindow: vi.fn(),
  app: {
    getPath: () => '/tmp/test-home',
    dock: {
      setBadge: (...args: string[]) => mockSetBadge(...args)
    },
    setBadgeCount: (...args: number[]) => mockSetBadgeCount(...args)
  }
}))

vi.mock('../../../src/main/services/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  })
}))

vi.mock('../../../src/main/desktop/backend-event-publisher', () => ({
  publishDesktopBackendEvent: vi.fn()
}))

// Import AFTER mocks so notificationService resolves the mocked electron module.
import { notificationService } from '../../../src/main/services/notification-service'
import type { BrowserWindow } from 'electron'
import { useSessionStore } from '../../../src/renderer/src/stores/useSessionStore'
import { systemApi } from '@/api/system-api'
import { dbApi } from '@/api/db-api'

const mockSessionData = {
  projectName: 'Test Project',
  sessionName: 'Test Session',
  projectId: 'proj-1',
  worktreeId: 'wt-1',
  sessionId: 'sess-1'
}

function createMockWindow(): { window: BrowserWindow; triggerFocus: () => void } {
  let focusHandler: (() => void) | undefined
  const mockWindow = {
    on: vi.fn((event: string, handler: () => void) => {
      if (event === 'focus') focusHandler = handler
    })
  } as unknown as BrowserWindow
  return {
    window: mockWindow,
    triggerFocus: () => focusHandler?.()
  }
}

// Clear accumulated unread count + any previous queued-state for the IDs this
// suite uses. The notificationService is a module singleton, so state from a
// prior test in the same file leaks unless we explicitly clear it. Cross-file
// isolation relies on vitest's default `isolate: true`, which gives each test
// file a fresh module graph.
function resetNotificationServiceState(): void {
  const { window, triggerFocus } = createMockWindow()
  notificationService.setMainWindow(window)
  triggerFocus() // Clear unread count via the focus handler we just registered
  notificationService.setSessionQueuedState('s1', false)
  notificationService.setSessionQueuedState('s2', false)
  vi.clearAllMocks()
}

describe('Phase 23 · Session 1: NotificationService queued-state suppression', () => {
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    notificationsSupported = true
    resetNotificationServiceState()
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
  })

  test('showSessionComplete suppresses notification + badge when session has queued messages', () => {
    notificationService.setSessionQueuedState('s1', true)

    notificationService.showSessionComplete({ ...mockSessionData, sessionId: 's1' })

    expect(mockNotificationShow).not.toHaveBeenCalled()
    expect(mockSetBadge).not.toHaveBeenCalled()
  })

  test('showSessionComplete fires notification after setSessionQueuedState("s1", false)', () => {
    notificationService.setSessionQueuedState('s1', true)
    notificationService.setSessionQueuedState('s1', false)

    notificationService.showSessionComplete({ ...mockSessionData, sessionId: 's1' })

    expect(mockNotificationShow).toHaveBeenCalledTimes(1)
    expect(mockSetBadgeCount).toHaveBeenCalledWith(1)
  })

  test('suppression is per-session — setting "s1" does not affect "s2"', () => {
    notificationService.setSessionQueuedState('s1', true)

    notificationService.showSessionComplete({ ...mockSessionData, sessionId: 's2' })

    expect(mockNotificationShow).toHaveBeenCalledTimes(1)
    expect(mockSetBadgeCount).toHaveBeenCalledWith(1)
  })

  test('redundant setSessionQueuedState("s1", true) calls are idempotent', () => {
    notificationService.setSessionQueuedState('s1', true)
    notificationService.setSessionQueuedState('s1', true)

    // Still suppressed after two "true" pushes.
    notificationService.showSessionComplete({ ...mockSessionData, sessionId: 's1' })
    expect(mockNotificationShow).not.toHaveBeenCalled()
    expect(mockSetBadge).not.toHaveBeenCalled()

    // A single "false" is enough to restore firing — the internal Set
    // removes the ID once, regardless of how many times `true` was pushed.
    notificationService.setSessionQueuedState('s1', false)
    notificationService.showSessionComplete({ ...mockSessionData, sessionId: 's1' })

    expect(mockNotificationShow).toHaveBeenCalledTimes(1)
    expect(mockSetBadgeCount).toHaveBeenCalledWith(1)
  })
})

// -----------------------------------------------------------------------------
// Suite 2: Zustand store mutators push queued-state through the renderer API.
// -----------------------------------------------------------------------------

describe('Phase 23 · Session 1: Zustand queue → systemApi push', () => {
  const mockSetSessionQueuedState = vi.mocked(systemApi.setSessionQueuedState)
  const mockDetectAgentSdks = vi.mocked(systemApi.detectAgentSdks)
  const mockSessionUpdate = vi.mocked(dbApi.session.update)

  beforeEach(() => {
    vi.clearAllMocks()
    mockSetSessionQueuedState.mockResolvedValue(undefined)
    mockDetectAgentSdks.mockResolvedValue({ opencode: false, claude: false, codex: false })
    apiMocks.dbApi.setting.get.mockResolvedValue(null)
    apiMocks.dbApi.setting.set.mockResolvedValue(true)
    apiMocks.settingsApi.onSettingsUpdated.mockReturnValue(vi.fn())
    mockSessionUpdate.mockResolvedValue({ id: 's1', status: 'completed' })

    // Reset only the slices this suite touches. Other slices (connection,
    // orphaned, board-assistant, etc.) keep their initial Map/Set values from
    // the module's create() call, so we don't need to clobber them.
    useSessionStore.setState({
      pendingFollowUpMessages: new Map(),
      sessionsByWorktree: new Map(),
      tabOrderByWorktree: new Map(),
      activeSessionId: null,
      activeSessionByWorktree: {}
    })
  })

  test('enqueueFollowUpMessage("s1", "msg1") pushes ("s1", true)', () => {
    useSessionStore.getState().enqueueFollowUpMessage('s1', 'msg1')

    expect(mockSetSessionQueuedState).toHaveBeenCalledWith('s1', true)
    expect(mockSetSessionQueuedState).toHaveBeenCalledTimes(1)
  })

  test('after two enqueues, dequeueFollowUpMessage("s1") pushes ("s1", true) (queue still non-empty)', () => {
    useSessionStore.getState().enqueueFollowUpMessage('s1', 'msg1')
    useSessionStore.getState().enqueueFollowUpMessage('s1', 'msg2')

    mockSetSessionQueuedState.mockClear()

    const popped = useSessionStore.getState().dequeueFollowUpMessage('s1')

    expect(popped).toBe('msg1')
    expect(mockSetSessionQueuedState).toHaveBeenCalledWith('s1', true)
    expect(mockSetSessionQueuedState).toHaveBeenCalledTimes(1)
  })

  test('last dequeueFollowUpMessage that empties the queue pushes ("s1", false)', () => {
    useSessionStore.getState().enqueueFollowUpMessage('s1', 'only-msg')

    mockSetSessionQueuedState.mockClear()

    const popped = useSessionStore.getState().dequeueFollowUpMessage('s1')

    expect(popped).toBe('only-msg')
    expect(mockSetSessionQueuedState).toHaveBeenCalledWith('s1', false)
    expect(mockSetSessionQueuedState).toHaveBeenCalledTimes(1)
  })

  test('requeueFollowUpMessageFront("s1", "msg") pushes ("s1", true)', () => {
    useSessionStore.getState().requeueFollowUpMessageFront('s1', 'msg')

    expect(mockSetSessionQueuedState).toHaveBeenCalledWith('s1', true)
    expect(mockSetSessionQueuedState).toHaveBeenCalledTimes(1)
  })

  test('setPendingFollowUpMessages pushes true for non-empty and false for empty', () => {
    useSessionStore.getState().setPendingFollowUpMessages('s1', ['a', 'b'])
    expect(mockSetSessionQueuedState).toHaveBeenLastCalledWith('s1', true)

    useSessionStore.getState().setPendingFollowUpMessages('s1', [])
    expect(mockSetSessionQueuedState).toHaveBeenLastCalledWith('s1', false)

    expect(mockSetSessionQueuedState).toHaveBeenCalledTimes(2)
  })

  test('closeSession("s1") pushes ("s1", false) and clears the map entry', async () => {
    // Seed a queued message so we can assert the entry is removed afterwards.
    useSessionStore.getState().enqueueFollowUpMessage('s1', 'pending-msg')
    mockSetSessionQueuedState.mockClear()

    await useSessionStore.getState().closeSession('s1')

    expect(mockSetSessionQueuedState).toHaveBeenCalledWith('s1', false)
    expect(useSessionStore.getState().pendingFollowUpMessages.has('s1')).toBe(false)
  })
})
