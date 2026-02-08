import { app } from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync, appendFileSync } from 'fs'
import { createLogger } from './logger'

const log = createLogger({ component: 'ResponseLogger' })

const RESPONSE_LOG_DIR = 'responses'

function getResponseLogDir(): string {
  const homeDir = app.getPath('home')
  return join(homeDir, '.hive', 'logs', RESPONSE_LOG_DIR)
}

function ensureLogDir(): void {
  const dir = getResponseLogDir()
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

export function createResponseLog(sessionId: string): string {
  ensureLogDir()

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const fileName = `${sessionId}-${timestamp}.jsonl`
  const filePath = join(getResponseLogDir(), fileName)

  const header = JSON.stringify({
    type: 'session_start',
    sessionId,
    timestamp: new Date().toISOString()
  })

  appendFileSync(filePath, header + '\n')
  log.info('Created response log', { filePath, sessionId })

  return filePath
}

export function appendResponseLog(filePath: string, data: unknown): void {
  const entry = {
    ...(typeof data === 'object' && data !== null ? data : { data }),
    timestamp: new Date().toISOString()
  }

  appendFileSync(filePath, JSON.stringify(entry) + '\n')
}
