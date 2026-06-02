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

const CHECK_INTERVAL = 5 * 60 * 60 * 1000 // 5 hours
const INITIAL_DELAY = 10 * 1000 // 10 seconds

autoUpdater.autoDownload = false
autoUpdater.autoInstallOnAppQuit = true
autoUpdater.logger = null

let isManualCheck = false
let checkInterval: ReturnType<typeof setInterval> | null = null
let initialTimeout: ReturnType<typeof setTimeout> | null = null

function safeSend(win: BrowserWindow, channel: string, data?: unknown): void {
  if (!win.isDestroyed()) {
    win.webContents.send(channel, data)
  }
}

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
      safeSend(mainWindow, 'updater:checking')
    })

    autoUpdater.on('update-available', (info) => {
      log.info('Update available', { version: info.version, isManualCheck })
      safeSend(mainWindow, 'updater:available', {
        version: info.version,
        releaseNotes: info.releaseNotes,
        releaseDate: info.releaseDate,
        isManualCheck
      })
      isManualCheck = false
    })

    autoUpdater.on('update-not-available', (info) => {
      log.info('No update available', { version: info.version, isManualCheck })
      safeSend(mainWindow, 'updater:not-available', {
        version: info.version,
        isManualCheck
      })
      isManualCheck = false
    })

    autoUpdater.on('download-progress', (progress) => {
      log.info('Download progress', { percent: Math.round(progress.percent) })
      safeSend(mainWindow, 'updater:progress', {
        percent: progress.percent,
        bytesPerSecond: progress.bytesPerSecond,
        transferred: progress.transferred,
        total: progress.total
      })
    })

    autoUpdater.on('update-downloaded', (info) => {
      log.info('Update downloaded', { version: info.version })
      safeSend(mainWindow, 'updater:downloaded', {
        version: info.version,
        releaseNotes: info.releaseNotes
      })
    })

    autoUpdater.on('error', (error) => {
      log.error('Update error', error)
      safeSend(mainWindow, 'updater:error', {
        message: error?.message ?? String(error),
        isManualCheck
      })
      isManualCheck = false
    })

    initialTimeout = setTimeout(() => {
      this.checkForUpdates()
    }, INITIAL_DELAY)

    checkInterval = setInterval(() => {
      this.checkForUpdates()
    }, CHECK_INTERVAL)
  },

  async checkForUpdates(options?: { manual?: boolean }): Promise<void> {
    try {
      isManualCheck = options?.manual ?? false
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

  cleanup(): void {
    if (initialTimeout) {
      clearTimeout(initialTimeout)
      initialTimeout = null
    }
    if (checkInterval) {
      clearInterval(checkInterval)
      checkInterval = null
    }
  },

  setChannel(channel: 'stable' | 'canary'): void {
    autoUpdater.channel = channel === 'canary' ? 'canary' : 'latest'
    autoUpdater.allowPrerelease = channel === 'canary'
    autoUpdater.allowDowngrade = true // allow downgrade on explicit channel switch
    log.info('Update channel changed', { channel })
    this.checkForUpdates({ manual: true })
  },

  getVersion(): string {
    return app.getVersion()
  }
}
