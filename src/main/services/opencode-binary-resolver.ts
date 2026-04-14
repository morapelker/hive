import { execFileSync } from 'child_process'
import { existsSync } from 'fs'
import { createLogger } from './logger'

const log = createLogger({ component: 'OpenCodeBinaryResolver' })

export interface OpenCodeLaunchSpec {
  command: string
  shell: boolean
}

/**
 * Resolve the system-wide OpenCode CLI launch command.
 *
 * Windows installs commonly expose `opencode` through a `.cmd` shim.
 * Returning both the resolved command and whether Hive should launch it
 * through the shell keeps runtime launch behavior aligned with detection.
 */
export function resolveOpenCodeLaunchSpec(): OpenCodeLaunchSpec | null {
  const command = process.platform === 'win32' ? 'where' : 'which'

  try {
    const result = execFileSync(command, ['opencode'], {
      encoding: 'utf-8',
      timeout: 5000,
      env: process.env
    }).trim()

    const resolvedPath = result
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .find((entry) => entry.length > 0 && existsSync(entry))

    if (!resolvedPath) {
      log.warn('OpenCode binary not found on PATH')
      return null
    }

    const launchSpec: OpenCodeLaunchSpec = {
      command: resolvedPath,
      shell: process.platform === 'win32'
    }

    log.info('Resolved OpenCode binary', launchSpec)
    return launchSpec
  } catch {
    log.warn('Could not resolve OpenCode binary (not installed or not on PATH)')
    return null
  }
}
