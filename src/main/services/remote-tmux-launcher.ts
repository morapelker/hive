import { execFile } from 'node:child_process'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { getDatabase } from '../db'
import { logClaudeBinaryVersion, resolveClaudeBinaryPath } from './claude-binary-resolver'
import { buildClaudeCliHookSettings, getClaudeHookServer } from './claude-hook-server'
import { buildClaudeCliPtySpawn } from './claude-cli-spawner'
import { watchForClaudeSessionId, type ClaudeSessionWatchHandle } from './claude-session-watcher'
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
 * Env vars owned by the tmux pane / login shell, never exported into the
 * launch script: a tmux session created against an already-running server
 * inherits THAT server's values for these, and overriding them from Hive's
 * process (a GUI app) would break TUI size/term detection inside the pane.
 */
const TMUX_PANE_OWNED_ENV = new Set([
  'TERM',
  'TMUX',
  'TMUX_PANE',
  'COLUMNS',
  'LINES',
  'PWD',
  'OLDPWD',
  'SHLVL',
  '_'
])

/**
 * The full environment the launched claude process needs, written as explicit
 * `export` lines. A tmux session inherits the tmux SERVER's environment —
 * which matches Hive's `process.env` only when Hive started that server. A
 * pre-existing server (user ran `tmux` earlier, different shell state) can
 * be missing or hold stale auth vars, so everything except pane-owned vars
 * is exported explicitly, mirroring the local PTY spawn's
 * `{ ...process.env, ...spawn.env }` merge.
 */
function buildLaunchEnv(spawnEnv: Record<string, string>): Record<string, string> {
  const merged: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) merged[key] = value
  }
  Object.assign(merged, spawnEnv)
  for (const key of TMUX_PANE_OWNED_ENV) {
    delete merged[key]
  }
  return merged
}

/**
 * Render a `sh` script that cd's into the worktree, exports the env deltas,
 * and execs the claude binary with its args plus the prompt file's contents
 * as the final argument. Every interpolated value is shq'd; the prompt
 * content never appears in the persisted script or tmux history — only the
 * path to the 0600 file holding it, expanded at exec time via `$(cat ...)`.
 * The expanded prompt does end up in the claude process's argv (visible in
 * `ps` on the remote host, like every local launch — see the pendingPrompt
 * argv push in claude-cli-spawner.ts); interactive claude has no stdin/file
 * prompt handoff, so argv is the only delivery for the initial prompt.
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

// One session-id watcher per Hive session: a relaunch for the same session
// (retry after a dead tmux) must replace the previous watcher, not stack a
// second set of fs watchers/timers next to it.
const sessionIdWatchers = new Map<string, ClaudeSessionWatchHandle>()

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
 * attachable. The prompt is delivered via a 0600 file expanded at exec time,
 * keeping it out of the persisted script and tmux history (though, as with
 * local launches, it is claude's final argv token — see buildTmuxLaunchScript).
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
      env: buildLaunchEnv(spawn.env),
      promptFilePath
    })
    await writeSecretFile(scriptPath, script)

    const tmuxResult = await runTmuxNewSession(tmuxSessionName, scriptPath)
    if (!tmuxResult.success) {
      return { success: false, error: tmuxResult.error }
    }

    if (!session.claude_session_id) {
      sessionIdWatchers.get(sessionId)?.close()
      const handle = watchForClaudeSessionId(worktreePath, (claudeSessionId) => {
        sessionIdWatchers.delete(sessionId)
        try {
          db.updateSession(sessionId, { claude_session_id: claudeSessionId })
        } catch (error) {
          log.warn('Failed to persist Claude CLI session id for remote launch', {
            sessionId,
            error: error instanceof Error ? error.message : String(error)
          })
        }
      })
      sessionIdWatchers.set(sessionId, handle)
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
