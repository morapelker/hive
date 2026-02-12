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

  setMainWindow(window: BrowserWindow): void {
    this.mainWindow = window

    // Clear badge when window gains focus
    window.on('focus', () => {
      this.clearBadge()
    })
  }

  showSessionComplete(data: SessionNotificationData): void {
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

    // Increment dock badge
    this.unreadCount++
    app.dock?.setBadge(String(this.unreadCount))
  }

  private clearBadge(): void {
    this.unreadCount = 0
    app.dock?.setBadge('')
  }
}

export const notificationService = new NotificationService()
