import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, writeFileSync, chmodSync, unlinkSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { createLogger } from './logger'

const log = createLogger({ component: 'DockerSandboxService' })

export type SandboxAgent = 'claude' | 'codex' | 'copilot' | 'gemini' | 'opencode' | 'shell'

/**
 * Detect whether Docker and Docker Sandbox are available on the system.
 */
export function detectDockerSandbox(): {
  dockerAvailable: boolean
  sandboxAvailable: boolean
} {
  let dockerAvailable = false
  let sandboxAvailable = false

  try {
    execFileSync('docker', ['--version'], {
      encoding: 'utf-8',
      timeout: 5000,
      env: process.env
    })
    dockerAvailable = true
    log.info('Docker is available')
  } catch {
    log.warn('Docker is not available (not installed or not on PATH)')
    return { dockerAvailable: false, sandboxAvailable: false }
  }

  try {
    execFileSync('docker', ['sandbox', 'version'], {
      encoding: 'utf-8',
      timeout: 10000,
      env: process.env
    })
    sandboxAvailable = true
    log.info('Docker Sandbox is available')
  } catch {
    log.warn('Docker Sandbox is not available')
  }

  return { dockerAvailable, sandboxAvailable }
}

export interface SandboxWrapperOptions {
  sandboxName: string
  worktreePath: string
  projectGitPath: string
  agent?: SandboxAgent
}

/**
 * Create a bash wrapper script that launches a Docker Sandbox session.
 * Returns the absolute path to the generated script.
 */
export function ensureSandboxWrapper(options: SandboxWrapperOptions): string {
  const { sandboxName, worktreePath, projectGitPath, agent = 'claude' } = options
  const sandboxDir = join(homedir(), '.hive', 'sandbox')

  mkdirSync(sandboxDir, { recursive: true })

  const scriptPath = join(sandboxDir, `${sandboxName}.sh`)
  const scriptContent = [
    '#!/bin/bash',
    `exec docker sandbox run --name ${sandboxName} ${agent} ${worktreePath} ${projectGitPath}:ro -- "$@"`
  ].join('\n') + '\n'

  writeFileSync(scriptPath, scriptContent)
  chmodSync(scriptPath, 0o755)

  log.info('Created sandbox wrapper script', { scriptPath, sandboxName, agent })
  return scriptPath
}

/**
 * Remove the wrapper script for a given sandbox name.
 * Best-effort: errors are logged but not thrown.
 */
export function removeSandboxWrapper(sandboxName: string): void {
  const scriptPath = join(homedir(), '.hive', 'sandbox', `${sandboxName}.sh`)

  try {
    if (existsSync(scriptPath)) {
      unlinkSync(scriptPath)
      log.info('Removed sandbox wrapper script', { scriptPath })
    }
  } catch (err) {
    log.warn('Failed to remove sandbox wrapper script', {
      scriptPath,
      error: String(err)
    })
  }
}

/**
 * Stop and remove a Docker Sandbox by name.
 * Best-effort: errors on each step are logged but not thrown.
 */
export function stopAndRemoveSandbox(sandboxName: string): void {
  try {
    execFileSync('docker', ['sandbox', 'stop', sandboxName], {
      encoding: 'utf-8',
      timeout: 15000,
      env: process.env
    })
    log.info('Stopped sandbox', { sandboxName })
  } catch (err) {
    log.warn('Failed to stop sandbox (may already be stopped)', {
      sandboxName,
      error: String(err)
    })
  }

  try {
    execFileSync('docker', ['sandbox', 'rm', sandboxName], {
      encoding: 'utf-8',
      timeout: 15000,
      env: process.env
    })
    log.info('Removed sandbox', { sandboxName })
  } catch (err) {
    log.warn('Failed to remove sandbox (may already be removed)', {
      sandboxName,
      error: String(err)
    })
  }
}

/**
 * List all Docker Sandbox names.
 * Returns an empty array on error.
 */
export function listSandboxes(): string[] {
  try {
    const output = execFileSync('docker', ['sandbox', 'ls'], {
      encoding: 'utf-8',
      timeout: 10000,
      env: process.env
    }).trim()

    if (!output) return []

    // Skip the header line and extract sandbox names (first column)
    const lines = output.split('\n')
    if (lines.length <= 1) return []

    return lines
      .slice(1)
      .map((line) => line.trim().split(/\s+/)[0])
      .filter(Boolean)
  } catch (err) {
    log.warn('Failed to list sandboxes', { error: String(err) })
    return []
  }
}
