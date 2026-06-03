import { vi, describe, test, expect, beforeEach, afterEach } from 'vitest'

// Mock electron module
const mockSetBadge = vi.fn()
const mockSetBadgeCount = vi.fn()
const mockNotificationShow = vi.fn()
const mockNotificationOn = vi.fn()
let notificationsSupported = true
const originalPlatform = process.platform

vi.mock('electron', () => ({
  Notification: class MockNotification {
    static isSupported() {
      return notificationsSupported
    }
    constructor(_opts: Record<string, unknown>) {} // eslint-disable-line @typescript-eslint/no-empty-function
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

// Mock logger
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

// Import after mocks are established
import { notificationService } from '../../../src/main/services/notification-service'
import type { BrowserWindow } from 'electron'

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

function resetServiceState(): void {
  const { window, triggerFocus } = createMockWindow()
  notificationService.setMainWindow(window)
  triggerFocus() // Clear unread count
  vi.clearAllMocks()
}

describe('Session 6: Dock Badge', () => {
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    notificationsSupported = true
    resetServiceState()
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
  })

  test('increments badge count on notification', () => {
    notificationService.showSessionComplete(mockSessionData)
    expect(mockSetBadge).toHaveBeenCalledWith('1')

    notificationService.showSessionComplete(mockSessionData)
    expect(mockSetBadge).toHaveBeenCalledWith('2')
  })

  test('badge increments cumulatively across multiple notifications', () => {
    notificationService.showSessionComplete(mockSessionData)
    notificationService.showSessionComplete(mockSessionData)
    notificationService.showSessionComplete(mockSessionData)

    expect(mockSetBadge).toHaveBeenCalledTimes(3)
    expect(mockSetBadge).toHaveBeenNthCalledWith(1, '1')
    expect(mockSetBadge).toHaveBeenNthCalledWith(2, '2')
    expect(mockSetBadge).toHaveBeenNthCalledWith(3, '3')
  })

  test('clears badge on window focus', () => {
    const { window, triggerFocus } = createMockWindow()
    notificationService.setMainWindow(window)

    notificationService.showSessionComplete(mockSessionData)
    expect(mockSetBadge).toHaveBeenCalledWith('1')

    triggerFocus()
    expect(mockSetBadge).toHaveBeenCalledWith('')
  })

  test('resets count to 0 on focus so next notification shows 1', () => {
    const { window, triggerFocus } = createMockWindow()
    notificationService.setMainWindow(window)

    // Show two notifications
    notificationService.showSessionComplete(mockSessionData)
    notificationService.showSessionComplete(mockSessionData)
    expect(mockSetBadge).toHaveBeenCalledWith('2')

    // Focus to clear
    triggerFocus()
    expect(mockSetBadge).toHaveBeenCalledWith('')

    // Next notification should start from 1 again
    notificationService.showSessionComplete(mockSessionData)
    expect(mockSetBadge).toHaveBeenLastCalledWith('1')
  })

  test('does not set badge when notifications are not supported', () => {
    notificationsSupported = false

    notificationService.showSessionComplete(mockSessionData)

    expect(mockSetBadge).not.toHaveBeenCalled()
    expect(mockNotificationShow).not.toHaveBeenCalled()
  })

  test('notification.show() is called before badge increment', () => {
    const callOrder: string[] = []
    mockNotificationShow.mockImplementation(() => callOrder.push('show'))
    mockSetBadge.mockImplementation(() => callOrder.push('setBadge'))

    notificationService.showSessionComplete(mockSessionData)

    expect(callOrder).toEqual(['show', 'setBadge'])
  })

  test('uses optional chaining for app.dock (no crash on non-macOS)', () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })

    notificationService.showSessionComplete(mockSessionData)

    expect(mockSetBadgeCount).toHaveBeenCalledWith(1)
  })
})
