import { ipcMain } from 'electron'
import { createLogger } from '../services'
import { getClaudeAccountEmail, getOpenAIAccountEmail } from '../services/account-service'

const log = createLogger({ component: 'AccountHandlers' })

export function registerAccountHandlers(): void {
  log.info('Registering account handlers')
  ipcMain.handle('account:getClaudeEmail', () => getClaudeAccountEmail())
  ipcMain.handle('account:getOpenAIEmail', () => getOpenAIAccountEmail())
}
