import { ipcMain } from 'electron'
import type { TelegramConfig, TelegramMode } from '@shared/types/telegram'
import { telegramForwardingService } from '../services/telegram-forwarding-service'
import { createLogger } from '../services/logger'
import { toError } from '../services/error-utils'

const log = createLogger({ component: 'TelegramHandlers' })

export function registerTelegramHandlers(): void {
  ipcMain.handle('telegram:getConfig', () => telegramForwardingService.getConfig())

  ipcMain.handle('telegram:setConfig', (_event, config: TelegramConfig | null) => {
    try {
      telegramForwardingService.setConfig(config)
      return { ok: true }
    } catch (error) {
      log.error('telegram:setConfig failed', toError(error))
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('telegram:verifyToken', async (_event, botToken: string) => {
    return telegramForwardingService.verifyToken(botToken)
  })

  ipcMain.handle('telegram:discoverChats', async (_event, config?: TelegramConfig | null) => {
    try {
      return await telegramForwardingService.discoverChats(config)
    } catch (error) {
      log.error('telegram:discoverChats failed', toError(error))
      return []
    }
  })

  ipcMain.handle('telegram:sendTestMessage', async () => {
    return telegramForwardingService.sendTestMessage()
  })

  ipcMain.handle(
    'telegram:startForwarding',
    async (
      _event,
      {
        sessionId,
        worktreeId,
        connectionId,
        mode
      }: { sessionId: string; worktreeId: string | null; connectionId: string | null; mode: TelegramMode }
    ) => {
      try {
        const status = await telegramForwardingService.startForwarding({
          sessionId,
          worktreeId,
          connectionId,
          mode
        })
        return { ok: true, status }
      } catch (error) {
        log.error('telegram:startForwarding failed', toError(error))
        return {
          ok: false,
          status: telegramForwardingService.getStatus(),
          error: error instanceof Error ? error.message : String(error)
        }
      }
    }
  )

  ipcMain.handle('telegram:stopForwarding', async () => {
    const status = await telegramForwardingService.stopForwarding()
    return { status }
  })

  ipcMain.handle('telegram:getStatus', () => telegramForwardingService.getStatus())
}
