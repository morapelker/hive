import { execFile } from 'node:child_process'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { getDatabase } from '../db'
import { logClaudeBinaryVersion, resolveClaudeBinaryPath } from './claude-binary-resolver'
import { buildClaudeCliHookSettings, getClaudeHookServer } from './claude-hook-server'
import { buildClaudeCliPtySpawn } from './claude-cli-spawner'
import { watchForClaudeSessionId } from './claude-session-watcher'
import { createLogger } from './logger'

const log = createLogger({ component: 'RemoteTmuxLauncher' })

export interface RemoteTmuxLaunchParams {
  sessionId: string
  worktreePath: string
  prompt: string
  tmuxSessionName: string
}

export interface RemoteTmuxLaunchResult {
  success: boolean
  error?: string
  tmuxSession?: string
}

const BUILD_MODE_PERMISSION_FLAG = '--dangerously-skip-permissions'
// Guards `export KEY=...` lines: only a legal POSIX shell identifier is ever
// interpolated as a bare (unquoted) token in the generated script. Values are
// always shq'd; this protects the one thing that is never quoted — the name.
const SAFE_ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * POSIX single-quote escaping: wraps `value` in single quotes, closing and
 * re-opening the quote around any embedded `'` (`'\''`). Single-quoted
 * strings are the only POSIX shell quoting form with no exceptions — nothing
 * inside them is expanded, not `$`, not backticks, not double quotes, not
 * newlines — so this is safe for arbitrary untrusted content.
 */
export function shq(value: string): string {
  return `'${value.split("'").join("'\\''")}'`
}

/**
 * Entries of `spawnEnv` that are new or different vs. the current
 * `process.env`. A tmux session created against an already-running tmux
 * server inherits that server's environment, not this process's — so only
 * the vars the spawn actually adds/overrides need an explicit `export` line
 * in the launch script; everything else is already correct via inheritance.
 */
function diffEnvFromProcess(spawnEnv: Record<string, string>): Record<string, string> {
  const diff: Record<string, string> = {}
  for (const [key, value] of Object.entries(spawnEnv)) {
    if (process.env[key] !== value) {
      diff[key] = value
    }
  }
  return diff
}

/**
 * Render a `sh` script that cd's into the worktree, exports the env deltas,
 * and execs the claude binary with its args plus the prompt file's contents
 * as the final argument. Every interpolated value is shq'd; the prompt
 * content itself never appears — only the path to the file holding it, read
 * at exec time via `$(cat ...)` so it is never captured in this script, tmux
 * history, or `ps`.
 */
export function buildTmuxLaunchScript(opts: {
  cwd: string
  command: string
  args: string[]
  env: Record<string, string>
  promptFilePath: string
}): string {
  const lines = ['#!/bin/sh', `cd ${shq(opts.cwd)} || exit 1`]

  for (const [key, value] of Object.entries(opts.env)) {
    if (!SAFE_ENV_KEY.test(key)) {
      log.warn('Skipping env var with unsafe name in remote tmux launch script', { key })
      continue
    }
    lines.push(`export ${key}=${shq(value)}`)
  }

  const execTokens = [
    'exec',
    shq(opts.command),
    ...opts.args.map(shq),
    `"$(cat ${shq(opts.promptFilePath)})"`
  ]
  lines.push(execTokens.join(' '))

  return `${lines.join('\n')}\n`
}

function remoteLaunchDir(): string {
  return join(homedir(), '.hive', 'remote-launch')
}

/** Write a file others on the machine cannot read (mode 0600), matching the
 * secrets-file precedent in atomic-json.ts: pass the mode to `writeFile` up
 * front, then `chmod` again explicitly since `writeFile`'s mode is subject to
 * the process umask. */
async function writeSecretFile(path: string, content: string): Promise<void> {
  await writeFile(path, content, { encoding: 'utf-8', mode: 0o600 })
  await chmod(path, 0o600)
}

function runTmuxNewSession(
  tmuxSessionName: string,
  scriptPath: string
): Promise<{ success: boolean; error?: string }> {
  return new Promise((resolve) => {
    execFile(
      'tmux',
      ['new-session', '-d', '-s', tmuxSessionName, `sh ${shq(scriptPath)}`],
      (error, _stdout, stderr) => {
        if (!error) {
          resolve({ success: true })
          return
        }

        const errno = error as NodeJS.ErrnoException
        if (errno.code === 'ENOENT') {
          resolve({ success: false, error: 'tmux is not installed or not on PATH' })
          return
        }

        if (stderr && /duplicate session/i.test(stderr)) {
          resolve({
            success: false,
            error: `A tmux session named "${tmuxSessionName}" already exists`
          })
          return
        }

        resolve({ success: false, error: stderr?.trim() || error.message })
      }
    )
  })
}

/**
 * Assemble the claude-cli invocation for a remote-launched session (same
 * spawn/hook machinery as the local `createClaudeCliTerminal` path) and start
 * it inside a detached tmux session, so it survives Hive restarts and is
 * attachable. The prompt is delivered via a file read at exec time, never as
 * argv or an env var, so it never appears in `ps` or shell history.
 */
export async function launchClaudeCliInTmux(
  params: RemoteTmuxLaunchParams
): Promise<RemoteTmuxLaunchResult> {
  const { sessionId, worktreePath, prompt, tmuxSessionName } = params
  log.info('Launching remote Claude CLI tmux session', { sessionId, tmuxSessionName })

  try {
    const db = getDatabase()
    const session = db.getSession(sessionId)
    if (!session) {
      return { success: false, error: 'Session not found' }
    }

    const claudeBinary = resolveClaudeBinaryPath()
    if (!claudeBinary) {
      return { success: false, error: 'Claude binary not found on PATH' }
    }
    logClaudeBinaryVersion(claudeBinary)

    const { port } = await getClaudeHookServer()
    const hookSettingsJson = buildClaudeCliHookSettings(port, sessionId)

    const spawn = buildClaudeCliPtySpawn({
      session,
      worktreePath,
      claudeBinary,
      hookSettingsJson,
      db
    })

    // buildClaudeCliPtySpawn already puts --dangerously-skip-permissions first
    // for build mode; this is a defensive backstop in case that ever changes,
    // since a remote headless session must never block on an interactive
    // permission prompt no one is there to answer.
    const args = [...spawn.args]
    if (session.mode === 'build' && !args.includes(BUILD_MODE_PERMISSION_FLAG)) {
      args.push(BUILD_MODE_PERMISSION_FLAG)
    }

    const dir = remoteLaunchDir()
    await mkdir(dir, { recursive: true })
    const promptFilePath = join(dir, `${sessionId}.prompt.txt`)
    const scriptPath = join(dir, `${sessionId}.sh`)

    await writeSecretFile(promptFilePath, prompt)
    const script = buildTmuxLaunchScript({
      cwd: spawn.cwd,
      command: spawn.command,
      args,
      env: diffEnvFromProcess(spawn.env),
      promptFilePath
    })
    await writeSecretFile(scriptPath, script)

    const tmuxResult = await runTmuxNewSession(tmuxSessionName, scriptPath)
    if (!tmuxResult.success) {
      return { success: false, error: tmuxResult.error }
    }

    if (!session.claude_session_id) {
      watchForClaudeSessionId(worktreePath, (claudeSessionId) => {
        try {
          db.updateSession(sessionId, { claude_session_id: claudeSessionId })
        } catch (error) {
          log.warn('Failed to persist Claude CLI session id for remote launch', {
            sessionId,
            error: error instanceof Error ? error.message : String(error)
          })
        }
      })
    }

    return { success: true, tmuxSession: tmuxSessionName }
  } catch (error) {
    log.error(
      'Failed to launch remote Claude CLI tmux session',
      error instanceof Error ? error : new Error(String(error)),
      { sessionId }
    )
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }
  }
}
