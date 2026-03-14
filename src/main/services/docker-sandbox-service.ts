import { execFileSync, spawn } from 'child_process'
import { existsSync, unlinkSync } from 'fs'
import { EventEmitter } from 'events'
import { homedir } from 'os'
import { join } from 'path'
import { Transform } from 'stream'
import type { SpawnOptions, SpawnedProcess } from '@anthropic-ai/claude-agent-sdk'
import { createLogger } from './logger.ts'

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

export function getSandboxNameForWorktree(worktreeId: string): string {
  const sandboxName = worktreeId.replace(/[^a-zA-Z0-9_.-]/g, '-')
  validateSandboxName(sandboxName)
  return sandboxName
}

/**
 * Check if a named sandbox already exists.
 */
export function sandboxExists(sandboxName: string): boolean {
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

export function ensureSandboxExists(options: {
  sandboxName: string
  worktreePath: string
  projectGitPath: string
  agent?: SandboxAgent
}): { created: boolean } {
  const { sandboxName, worktreePath, projectGitPath, agent = 'claude' } = options
  validateSandboxName(sandboxName)

  if (sandboxExists(sandboxName)) {
    log.info('Reusing existing sandbox', { sandboxName })
    return { created: false }
  }

  execFileSync(
    'docker',
    ['sandbox', 'create', '--name', sandboxName, agent, worktreePath, `${projectGitPath}:ro`],
    {
      encoding: 'utf-8',
      timeout: 30000,
      env: process.env
    }
  )

  log.info('Created sandbox', { sandboxName, worktreePath, agent })
  return { created: true }
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
 * - Which args are forwarded to `docker sandbox exec`
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
  const { sandboxName, token } = options
  validateSandboxName(sandboxName)

  return (spawnOptions: SpawnOptions): SpawnedProcess => {
    // Two problems need fixing when forwarding SDK args to Docker sandbox:
    //
    // 1. CLI entry-point path: The SDK resolves pathToClaudeCodeExecutable
    //    to its bundled cli.js and includes it as the first arg. Docker
    //    sandbox already bundles its own Claude CLI — the local path doesn't
    //    exist inside the container and breaks arg parsing.
    //
    // 2. TTY override: Docker sandbox always allocates a PTY for the agent,
    //    so Claude Code sees isTTY=true and enters interactive TUI mode,
    //    ignoring --output-format/--input-format. We must prepend --print
    //    (-p) to explicitly force non-interactive mode. The SDK's
    //    --input-format stream-json still works with --print — it overrides
    //    the default "read all input upfront" behavior with streaming JSON.
    //
    // 3. --include-partial-messages requires --print in the sandbox CLI,
    //    but the sandbox's bundled version may not support it.
    const filteredArgs = spawnOptions.args.filter((arg) => {
      if (arg === '--include-partial-messages') return false
      // Strip the SDK's local CLI entry-point path (e.g. .../cli.js)
      if (arg.endsWith('/cli.js') || arg.endsWith('/cli.mjs')) return false
      return true
    })

    // Prepend --print to force non-interactive mode inside the sandbox PTY.
    // Without this, Claude Code detects the PTY and launches the TUI,
    // producing ANSI art instead of JSON-RPC output.
    const sandboxArgs = ['--print', ...filteredArgs]

    log.info('Docker sandbox arg filtering', {
      originalArgs: spawnOptions.args.join(' '),
      sandboxArgs: sandboxArgs.join(' '),
      command: spawnOptions.command
    })

    const dockerArgs: string[] = ['sandbox', 'exec', '-i']
    if (token) {
      dockerArgs.push('-e', `CLAUDE_CODE_OAUTH_TOKEN=${token}`)
    }
    dockerArgs.push(sandboxName, 'claude', ...sandboxArgs)

    log.info('Spawning Docker sandbox process', {
      sandboxName,
      dockerArgCount: dockerArgs.length,
      filteredOutArgs: spawnOptions.args.length - filteredArgs.length,
      dockerArgs: dockerArgs.map((arg) =>
        arg.startsWith('CLAUDE_CODE_OAUTH_TOKEN=') ? 'CLAUDE_CODE_OAUTH_TOKEN=<redacted>' : arg
      )
    })

    const proc = spawn('docker', dockerArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: spawnOptions.env as NodeJS.ProcessEnv,
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

    proc.on('exit', (code, signal) => {
      log.info('Docker sandbox process exited', {
        sandboxName,
        code,
        signal
      })
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
  if (!sandboxExists(sandboxName)) {
    return
  }
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
