import { ipcMain } from 'electron'
import { updaterService } from '../services/updater'

export function registerUpdaterHandlers(): void {
  ipcMain.handle('updater:check', async () => {
    await updaterService.checkForUpdates()
  })

  ipcMain.handle('updater:download', async () => {
    await updaterService.downloadUpdate()
  })

  ipcMain.handle('updater:install', () => {
    updaterService.quitAndInstall()
  })

  ipcMain.handle('updater:setChannel', (_event, channel: string) => {
    updaterService.setChannel(channel as 'stable' | 'canary')
  })

  ipcMain.handle('updater:getVersion', () => {
    return updaterService.getVersion()
  })
}
