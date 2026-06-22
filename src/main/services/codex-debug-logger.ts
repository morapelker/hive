import { homedir } from 'node:os'
import { join } from 'node:path'
import { appendFileSync, mkdirSync, existsSync, writeFileSync } from 'node:fs'

const LOG_FILE_NAME = 'codex.jsonl'

let logFilePath: string | null = null
let initialized = false
let enabled = false
let resetPerSession = true

function getLogFilePath(): string {
  if (!logFilePath) {
    const logDir = join(homedir(), '.hive', 'logs')
    if (!existsSync(logDir)) {
      mkdirSync(logDir, { recursive: true })
    }
    logFilePath = join(logDir, LOG_FILE_NAME)
  }
  return logFilePath
}

function ensureInitialized(): void {
  if (initialized) return
  initialized = true
  getLogFilePath() // ensure directory exists
}

export function configure(opts: { enabled: boolean; resetPerSession: boolean }): void {
  enabled = opts.enabled
  resetPerSession = opts.resetPerSession
}

export function resetSession(): void {
  if (!enabled || !resetPerSession) return
  writeFileSync(getLogFilePath(), '')
  initialized = false
}

export function logCodexMessage(direction: 'outgoing' | 'incoming', rawData: unknown): void {
  if (!enabled) return
  ensureInitialized()
  const entry = {
    ts: new Date().toISOString(),
    request: direction === 'outgoing',
    data: rawData
  }
  appendFileSync(getLogFilePath(), JSON.stringify(entry) + '\n')
}

export function logCodexLifecycleEvent(event: string, detail?: Record<string, unknown>): void {
  if (!enabled) return
  ensureInitialized()
  const entry = {
    ts: new Date().toISOString(),
    lifecycle: true,
    event,
    ...(detail ?? {})
  }
  appendFileSync(getLogFilePath(), JSON.stringify(entry) + '\n')
}
