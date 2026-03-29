import { app } from 'electron'
import { execFileSync } from 'child_process'
import { existsSync } from 'fs'
import { getLogDir } from './logger'

export interface AgentSdkDetection {
  opencode: boolean
  claude: boolean
  codex: boolean
}

export interface AppPaths {
  userData: string
  home: string
  logs: string
}

export function detectAgentSdks(): AgentSdkDetection {
  const whichCmd = process.platform === 'win32' ? 'where' : 'which'
  const check = (binary: string): boolean => {
    try {
      const result = execFileSync(whichCmd, [binary], {
        encoding: 'utf-8',
        timeout: 5000,
        env: process.env
      }).trim()
      const resolved = result.split('\n')[0].trim()
      return !!resolved && existsSync(resolved)
    } catch {
      return false
    }
  }
  return { opencode: check('opencode'), claude: check('claude'), codex: check('codex') }
}

export function getAppPaths(): AppPaths {
  return {
    userData: app.getPath('userData'),
    home: app.getPath('home'),
    logs: getLogDir()
  }
}

export function getAppVersion(): string {
  return app.getVersion()
}
