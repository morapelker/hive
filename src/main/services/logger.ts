import { app } from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync, appendFileSync, readdirSync, statSync, unlinkSync } from 'fs'

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3
}

interface LogEntry {
  timestamp: string
  level: string
  component: string
  message: string
  data?: Record<string, unknown>
  error?: {
    name: string
    message: string
    stack?: string
  }
}

interface LoggerOptions {
  component: string
  minLevel?: LogLevel
}

const LOG_LEVELS: Record<LogLevel, string> = {
  [LogLevel.DEBUG]: 'DEBUG',
  [LogLevel.INFO]: 'INFO',
  [LogLevel.WARN]: 'WARN',
  [LogLevel.ERROR]: 'ERROR'
}

// Configuration
const MAX_LOG_FILE_SIZE = 5 * 1024 * 1024 // 5MB
const MAX_LOG_FILES = 5
const LOG_DIR_NAME = 'logs'

class LoggerService {
  private static instance: LoggerService | null = null
  private logDir: string
  private currentLogFile: string
  private minLevel: LogLevel

  private constructor() {
    // Use ~/.hive/logs/ for logs
    const homeDir = app.getPath('home')
    this.logDir = join(homeDir, '.hive', LOG_DIR_NAME)
    this.ensureLogDir()
    this.currentLogFile = this.getLogFileName()
    this.minLevel = process.env.NODE_ENV === 'development' ? LogLevel.DEBUG : LogLevel.INFO
    this.cleanOldLogs()
  }

  static getInstance(): LoggerService {
    if (!LoggerService.instance) {
      LoggerService.instance = new LoggerService()
    }
    return LoggerService.instance
  }

  private ensureLogDir(): void {
    if (!existsSync(this.logDir)) {
      mkdirSync(this.logDir, { recursive: true })
    }
  }

  private getLogFileName(): string {
    const date = new Date().toISOString().split('T')[0]
    return join(this.logDir, `hive-${date}.log`)
  }

  private formatEntry(entry: LogEntry): string {
    const parts = [
      `[${entry.timestamp}]`,
      `[${entry.level}]`,
      `[${entry.component}]`,
      entry.message
    ]

    if (entry.data) {
      parts.push(JSON.stringify(entry.data))
    }

    if (entry.error) {
      parts.push(`\n  Error: ${entry.error.name}: ${entry.error.message}`)
      if (entry.error.stack) {
        parts.push(`\n  Stack: ${entry.error.stack}`)
      }
    }

    return parts.join(' ') + '\n'
  }

  private shouldRotate(): boolean {
    try {
      if (!existsSync(this.currentLogFile)) return false
      const stats = statSync(this.currentLogFile)
      return stats.size >= MAX_LOG_FILE_SIZE
    } catch {
      return false
    }
  }

  private rotateLog(): void {
    // Current file naming includes date, so rotation happens naturally
    // Just update to potentially new date
    this.currentLogFile = this.getLogFileName()
  }

  private cleanOldLogs(): void {
    try {
      const files = readdirSync(this.logDir)
        .filter((f) => f.startsWith('hive-') && f.endsWith('.log'))
        .map((f) => ({
          name: f,
          path: join(this.logDir, f),
          mtime: statSync(join(this.logDir, f)).mtime
        }))
        .sort((a, b) => b.mtime.getTime() - a.mtime.getTime())

      // Keep only MAX_LOG_FILES most recent files
      if (files.length > MAX_LOG_FILES) {
        files.slice(MAX_LOG_FILES).forEach((file) => {
          try {
            unlinkSync(file.path)
          } catch {
            // Ignore deletion errors
          }
        })
      }
    } catch {
      // Ignore errors during cleanup
    }
  }

  private write(
    level: LogLevel,
    component: string,
    message: string,
    data?: Record<string, unknown>,
    error?: Error
  ): void {
    if (level < this.minLevel) return

    if (this.shouldRotate()) {
      this.rotateLog()
    }

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level: LOG_LEVELS[level],
      component,
      message,
      data
    }

    if (error) {
      entry.error = {
        name: error.name,
        message: error.message,
        stack: error.stack
      }
    }

    const formatted = this.formatEntry(entry)

    // Write to file
    try {
      appendFileSync(this.currentLogFile, formatted)
    } catch {
      // Fallback to console if file write fails
      console.error('Failed to write to log file:', formatted)
    }

    // Also log to console in development
    if (process.env.NODE_ENV === 'development') {
      const consoleMethod =
        level === LogLevel.ERROR
          ? console.error
          : level === LogLevel.WARN
            ? console.warn
            : level === LogLevel.DEBUG
              ? console.debug
              : console.log
      consoleMethod(`[${entry.level}] [${component}]`, message, data || '', error || '')
    }
  }

  debug(component: string, message: string, data?: Record<string, unknown>): void {
    this.write(LogLevel.DEBUG, component, message, data)
  }

  info(component: string, message: string, data?: Record<string, unknown>): void {
    this.write(LogLevel.INFO, component, message, data)
  }

  warn(component: string, message: string, data?: Record<string, unknown>): void {
    this.write(LogLevel.WARN, component, message, data)
  }

  error(component: string, message: string, error?: Error, data?: Record<string, unknown>): void {
    this.write(LogLevel.ERROR, component, message, data, error)
  }

  getLogDir(): string {
    return this.logDir
  }
}

// Create a logger instance for a specific component
export function createLogger(options: LoggerOptions): {
  debug: (message: string, data?: Record<string, unknown>) => void
  info: (message: string, data?: Record<string, unknown>) => void
  warn: (message: string, data?: Record<string, unknown>) => void
  error: (message: string, error?: Error, data?: Record<string, unknown>) => void
} {
  const service = LoggerService.getInstance()
  const component = options.component

  return {
    debug: (message: string, data?: Record<string, unknown>) =>
      service.debug(component, message, data),
    info: (message: string, data?: Record<string, unknown>) =>
      service.info(component, message, data),
    warn: (message: string, data?: Record<string, unknown>) =>
      service.warn(component, message, data),
    error: (message: string, error?: Error, data?: Record<string, unknown>) =>
      service.error(component, message, error, data)
  }
}

// Export singleton instance
export const logger = LoggerService.getInstance()

// Export function to get log directory (for IPC)
export function getLogDir(): string {
  return logger.getLogDir()
}
