import { Notification, BrowserWindow, app } from 'electron'
import { createLogger } from './logger'

const log = createLogger({ component: 'NotificationService' })

interface SessionNotificationData {
  projectName: string
  sessionName: string
  projectId: string
  worktreeId: string
  sessionId: string
}

class NotificationService {
  private mainWindow: BrowserWindow | null = null
  private unreadCount = 0
  private sessionsWithQueuedMessages = new Set<string>()

  setMainWindow(window: BrowserWindow): void {
    this.mainWindow = window

    // Clear badge when window gains focus
    window.on('focus', () => {
      this.clearBadge()
    })
  }

  showSessionComplete(data: SessionNotificationData): void {
    if (this.sessionsWithQueuedMessages.has(data.sessionId)) {
      log.info('Skipping session complete notification: session has queued follow-up messages', {
        sessionId: data.sessionId,
        projectName: data.projectName,
        sessionName: data.sessionName
      })
      return
    }

    if (!Notification.isSupported()) {
      log.warn('Notifications not supported on this platform')
      return
    }

    log.info('Showing session complete notification', {
      projectName: data.projectName,
      sessionName: data.sessionName
    })

    const notification = new Notification({
      title: data.projectName,
      body: `"${data.sessionName}" completed`,
      silent: false
    })

    notification.on('click', () => {
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.show()
        this.mainWindow.focus()
        this.mainWindow.webContents.send('notification:navigate', {
          projectId: data.projectId,
          worktreeId: data.worktreeId,
          sessionId: data.sessionId
        })
      }
    })

    notification.show()

    // Increment dock/taskbar badge
    this.unreadCount++
    if (process.platform === 'darwin') {
      app.dock?.setBadge(String(this.unreadCount))
    } else {
      app.setBadgeCount(this.unreadCount)
    }
  }

  /**
   * Show a native notification when an AI session is blocked waiting for user
   * feedback (a question to answer or a permission to grant). Unlike
   * `showSessionComplete`, this is NOT suppressed by queued-message state —
   * a blocking feedback request always needs the user's attention.
   */
  showPendingUserFeedback(
    data: SessionNotificationData,
    kind: 'question' | 'permission'
  ): void {
    if (!Notification.isSupported()) {
      log.warn('Notifications not supported on this platform')
      return
    }

    const body =
      kind === 'question'
        ? `"${data.sessionName}" needs your answer`
        : `"${data.sessionName}" needs your permission`

    log.info('Showing pending user feedback notification', {
      projectName: data.projectName,
      sessionName: data.sessionName,
      kind
    })

    const notification = new Notification({
      title: data.projectName,
      body,
      silent: false
    })

    notification.on('click', () => {
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.show()
        this.mainWindow.focus()
        this.mainWindow.webContents.send('notification:navigate', {
          projectId: data.projectId,
          worktreeId: data.worktreeId,
          sessionId: data.sessionId
        })
      }
    })

    notification.show()

    // Increment dock/taskbar badge (same scheme as showSessionComplete)
    this.unreadCount++
    if (process.platform === 'darwin') {
      app.dock?.setBadge(String(this.unreadCount))
    } else {
      app.setBadgeCount(this.unreadCount)
    }
  }

  // Track which sessions currently have queued follow-up messages so that
  // `showSessionComplete` can suppress notifications while the session is
  // about to continue with the next queued message.
  setSessionQueuedState(sessionId: string, hasQueued: boolean): void {
    if (hasQueued) {
      this.sessionsWithQueuedMessages.add(sessionId)
    } else {
      this.sessionsWithQueuedMessages.delete(sessionId)
    }
  }

  private clearBadge(): void {
    this.unreadCount = 0
    if (process.platform === 'darwin') {
      app.dock?.setBadge('')
    } else {
      app.setBadgeCount(0)
    }
  }
}

export const notificationService = new NotificationService()
