import { ipcMain } from 'electron'
import { createLogger } from '../services'
import { fetchClaudeUsage } from '../services/usage-service'

const log = createLogger({ component: 'UsageHandlers' })

export function registerUsageHandlers(): void {
  log.info('Registering usage handlers')

  ipcMain.handle('usage:fetch', () => fetchClaudeUsage())
}
