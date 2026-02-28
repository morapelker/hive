import { app, BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'
import { createLogger } from './logger'
import { getDatabase } from '../db'
import { APP_SETTINGS_DB_KEY } from '@shared/types/settings'

const log = createLogger({ component: 'AutoUpdater' })

function getUpdateChannel(): 'stable' | 'canary' {
  try {
    const db = getDatabase()
    const raw = db.getSetting(APP_SETTINGS_DB_KEY)
    if (raw) {
      const settings = JSON.parse(raw)
      return settings.updateChannel === 'canary' ? 'canary' : 'stable'
    }
  } catch {
    // DB not ready or setting not found — default to stable
  }
  return 'stable'
}

const CHECK_INTERVAL = 4 * 60 * 60 * 1000 // 4 hours
const INITIAL_DELAY = 10 * 1000 // 10 seconds

autoUpdater.autoDownload = true
autoUpdater.autoInstallOnAppQuit = true
autoUpdater.logger = null

export const updaterService = {
  init(mainWindow: BrowserWindow): void {
    if (!app.isPackaged) {
      log.debug('Skipping auto-updater in development mode')
      return
    }

    const channel = getUpdateChannel()
    autoUpdater.channel = channel === 'canary' ? 'canary' : 'latest'
    autoUpdater.allowPrerelease = channel === 'canary'
    autoUpdater.allowDowngrade = false // only allow downgrade on explicit channel switch
    log.info('Auto-updater initialized', { channel })

    autoUpdater.on('checking-for-update', () => {
      log.info('Checking for update')
      mainWindow.webContents.send('updater:checking')
    })

    autoUpdater.on('update-available', (info) => {
      log.info('Update available', { version: info.version })
      mainWindow.webContents.send('updater:available', {
        version: info.version,
        releaseNotes: info.releaseNotes,
        releaseDate: info.releaseDate
      })
    })

    autoUpdater.on('update-not-available', (info) => {
      log.info('No update available', { version: info.version })
      mainWindow.webContents.send('updater:not-available', {
        version: info.version
      })
    })

    autoUpdater.on('download-progress', (progress) => {
      log.info('Download progress', { percent: Math.round(progress.percent) })
      mainWindow.webContents.send('updater:progress', {
        percent: progress.percent,
        bytesPerSecond: progress.bytesPerSecond,
        transferred: progress.transferred,
        total: progress.total
      })
    })

    autoUpdater.on('update-downloaded', (info) => {
      log.info('Update downloaded', { version: info.version })
      mainWindow.webContents.send('updater:downloaded', {
        version: info.version,
        releaseNotes: info.releaseNotes
      })
    })

    autoUpdater.on('error', (error) => {
      log.error('Update error', error)
      mainWindow.webContents.send('updater:error', {
        message: error?.message ?? String(error)
      })
    })

    setTimeout(() => {
      this.checkForUpdates()
    }, INITIAL_DELAY)

    setInterval(() => {
      this.checkForUpdates()
    }, CHECK_INTERVAL)
  },

  async checkForUpdates(): Promise<void> {
    try {
      await autoUpdater.checkForUpdates()
    } catch (error) {
      log.error(
        'Failed to check for updates',
        error instanceof Error ? error : new Error(String(error))
      )
    }
  },

  async downloadUpdate(): Promise<void> {
    try {
      await autoUpdater.downloadUpdate()
    } catch (error) {
      log.error(
        'Failed to download update',
        error instanceof Error ? error : new Error(String(error))
      )
    }
  },

  quitAndInstall(): void {
    autoUpdater.quitAndInstall()
  },

  setChannel(channel: 'stable' | 'canary'): void {
    autoUpdater.channel = channel === 'canary' ? 'canary' : 'latest'
    autoUpdater.allowPrerelease = channel === 'canary'
    autoUpdater.allowDowngrade = true // allow downgrade on explicit channel switch
    log.info('Update channel changed', { channel })
    this.checkForUpdates()
  },

  getVersion(): string {
    return app.getVersion()
  }
}
