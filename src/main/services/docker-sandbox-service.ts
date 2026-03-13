import { execFileSync, spawn } from 'child_process'
import { existsSync, unlinkSync } from 'fs'
import { EventEmitter } from 'events'
import { homedir } from 'os'
import { join } from 'path'
import { Transform } from 'stream'
import type { SpawnOptions, SpawnedProcess } from '@anthropic-ai/claude-agent-sdk'
import { createLogger } from './logger'

const log = createLogger({ component: 'DockerSandboxService' })

function validateSandboxName(name: string): void {
  if (!/^[a-zA-Z0-9_.-]+$/.test(name)) {
    throw new Error(
      `Invalid sandbox name: "${name}" — only alphanumeric, hyphens, underscores, and dots allowed`
    )
  }
}

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

export interface SandboxSpawnerOptions {
  sandboxName: string
  worktreePath: string
  projectGitPath: string
  agent?: SandboxAgent
  token?: string
}

/**
 * Check if a named sandbox already exists.
 */
function sandboxExists(sandboxName: string): boolean {
  try {
    const output = execFileSync('docker', ['sandbox', 'ls'], {
      encoding: 'utf-8',
      timeout: 10000,
      env: process.env
    }).trim()
    return output.split('\n').some((line) => line.trim().startsWith(sandboxName + ' '))
  } catch {
    return false
  }
}

/**
 * Transform stream that filters Docker sandbox stdout to only pass JSON lines.
 *
 * Docker sandbox mixes status messages on stdout with the actual Claude Code
 * JSON-RPC output:
 *   - OSC terminal-title sequences (ESC]0;[📦 name]BEL)
 *   - Creation messages ("✓ Created sandbox...", "Workspace: ...")
 *   - ANSI cursor/color sequences
 *
 * The SDK expects ONLY newline-delimited JSON objects on stdout.
 * This transform buffers input into lines and only passes through lines
 * that start with '{' (JSON objects).
 */
function createJsonLineFilter(): Transform {
  let buffer = ''
  return new Transform({
    transform(chunk, _encoding, callback) {
      buffer += chunk.toString()
      const lines = buffer.split('\n')
      // Keep the last partial line in the buffer
      buffer = lines.pop() ?? ''
      let output = ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (trimmed.startsWith('{')) {
          output += trimmed + '\n'
        } else if (trimmed.length > 0) {
          log.info('Docker sandbox stdout (filtered)', { line: trimmed.substring(0, 120) })
        }
      }
      if (output.length > 0) {
        callback(null, output)
      } else {
        callback()
      }
    },
    flush(callback) {
      // Process any remaining buffer
      if (buffer.trim().startsWith('{')) {
        callback(null, buffer.trim() + '\n')
      } else {
        callback()
      }
    }
  })
}

/**
 * Create a spawnClaudeCodeProcess callback for Docker sandbox.
 *
 * This replaces the bash wrapper approach. The SDK calls this function
 * instead of spawning the CLI directly, giving us full control over:
 * - Which args are forwarded to `docker sandbox run`
 * - stdin/stdout piping (no shell intermediary)
 * - OSC escape sequence stripping on stdout
 *
 * The SDK passes { command, args, cwd, env, signal } where args are
 * its own CLI flags (--output-format, --input-format, --verbose, etc.).
 * We filter incompatible flags and forward the rest to docker sandbox.
 */
export function createSandboxSpawner(
  options: SandboxSpawnerOptions
): (spawnOptions: SpawnOptions) => SpawnedProcess {
  const { sandboxName, worktreePath, projectGitPath, agent = 'claude', token } = options
  validateSandboxName(sandboxName)

  return (spawnOptions: SpawnOptions): SpawnedProcess => {
    // Filter out flags incompatible with Docker sandbox's bundled CLI.
    // --include-partial-messages requires --print in the sandbox CLI,
    // but --print expects all input upfront — incompatible with the SDK's
    // streaming JSON-RPC protocol.
    const filteredArgs = spawnOptions.args.filter(
      (arg) => arg !== '--include-partial-messages'
    )

    // Always stop/remove existing sandbox before creating fresh.
    // Docker sandbox only forwards agent args on creation, not when
    // reusing an existing sandbox (existing ones ignore -- AGENT_ARGS).
    const exists = sandboxExists(sandboxName)
    if (exists) {
      log.info('Removing existing sandbox before fresh creation', { sandboxName })
      try {
        execFileSync('docker', ['sandbox', 'stop', sandboxName], {
          encoding: 'utf-8', timeout: 15000, env: process.env
        })
      } catch { /* may already be stopped */ }
      try {
        execFileSync('docker', ['sandbox', 'rm', sandboxName], {
          encoding: 'utf-8', timeout: 15000, env: process.env
        })
      } catch { /* may already be removed */ }
    }

    // Create fresh sandbox with name, agent, workspaces, and SDK args
    const dockerArgs: string[] = [
      'sandbox', 'run',
      '--name', sandboxName,
      agent,
      worktreePath,
      `${projectGitPath}:ro`,
      '--', ...filteredArgs
    ]

    log.info('Spawning Docker sandbox process', {
      sandboxName,
      dockerArgCount: dockerArgs.length,
      filteredOutArgs: spawnOptions.args.length - filteredArgs.length
    })

    const spawnEnv = { ...spawnOptions.env } as Record<string, string | undefined>
    if (token) {
      spawnEnv.CLAUDE_CODE_OAUTH_TOKEN = token
    }

    const proc = spawn('docker', dockerArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: spawnEnv as NodeJS.ProcessEnv,
      windowsHide: true
    })

    // Filter stdout to only pass JSON lines to the SDK.
    // Docker sandbox mixes status/creation messages with Claude Code JSON output.
    const jsonFilter = createJsonLineFilter()
    proc.stdout.pipe(jsonFilter)

    // Log stderr for debugging (docker sandbox status messages go here)
    proc.stderr.on('data', (data: Buffer) => {
      const msg = data.toString().trim()
      if (msg) log.info('Docker sandbox stderr', { sandboxName, message: msg })
    })

    // Wire up abort signal
    const abortHandler = () => {
      if (!proc.killed) proc.kill('SIGTERM')
    }
    spawnOptions.signal.addEventListener('abort', abortHandler)
    proc.on('exit', () => {
      spawnOptions.signal.removeEventListener('abort', abortHandler)
    })

    // Build the SpawnedProcess interface the SDK expects.
    // Use an EventEmitter to proxy exit/error events from the child process
    // so the SDK can register listeners on our wrapper object.
    const emitter = new EventEmitter()
    proc.on('exit', (code, signal) => emitter.emit('exit', code, signal))
    proc.on('error', (err) => emitter.emit('error', err))

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const proxy = emitter as any

    return {
      stdin: proc.stdin,
      stdout: jsonFilter,
      get killed() { return proc.killed },
      get exitCode() { return proc.exitCode },
      kill: (sig: NodeJS.Signals) => proc.kill(sig),
      on: proxy.on.bind(emitter),
      once: proxy.once.bind(emitter),
      off: proxy.off.bind(emitter)
    } as SpawnedProcess
  }
}

// Legacy: keep for cleanup of old wrapper scripts
export function removeSandboxWrapper(sandboxName: string): void {
  validateSandboxName(sandboxName)
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
  validateSandboxName(sandboxName)
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
