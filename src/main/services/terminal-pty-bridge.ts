import path from 'node:path'
import { getDatabase } from '../db'
import {
  buildClaudeCliHookSettings,
  getClaudeHookServer,
  publishClaudeCliStatus
} from './claude-hook-server'
import { resolveClaudeBinaryPath } from './claude-binary-resolver'
import { buildClaudeCliPtySpawn } from './claude-cli-spawner'
import { watchForClaudeSessionId, type ClaudeSessionWatchHandle } from './claude-session-watcher'
import {
  applyClaudeCliTitle,
  processClaudeCliPtyData,
  resetAllClaudeCliTitleState,
  resetClaudeCliTitleState
} from './claude-cli-title-handler'
import { ghosttyService } from './ghostty-service'
import { createLogger } from './logger'
import { ptyService } from './pty-service'

const log = createLogger({ component: 'TerminalPtyBridge' })

const listenerCleanups = new Map<string, { removeData: () => void; removeExit: () => void }>()
const dataBuffers = new Map<string, string>()
const flushScheduled = new Set<string>()
const claudeWatchers = new Map<string, ClaudeSessionWatchHandle>()
const claudeCliSessions = new Set<string>()
const claudeCliWorktreeBasenames = new Map<string, string>()

export function destroyNodePtyTerminal(terminalId: string): void {
  const cleanup = listenerCleanups.get(terminalId)
  if (cleanup) {
    cleanup.removeData()
    cleanup.removeExit()
    listenerCleanups.delete(terminalId)
  }
  dataBuffers.delete(terminalId)
  flushScheduled.delete(terminalId)
  claudeWatchers.get(terminalId)?.close()
  claudeWatchers.delete(terminalId)
  claudeCliSessions.delete(terminalId)
  claudeCliWorktreeBasenames.delete(terminalId)
  resetClaudeCliTitleState(terminalId)
  ptyService.destroy(terminalId)
}

function attachNodePtyListeners(terminalId: string): void {
  const existing = listenerCleanups.get(terminalId)
  if (existing) {
    existing.removeData()
    existing.removeExit()
    listenerCleanups.delete(terminalId)
  }

  const removeData = ptyService.onData(terminalId, (data) => {
    const existing = dataBuffers.get(terminalId)
    dataBuffers.set(terminalId, existing ? existing + data : data)

    if (claudeCliSessions.has(terminalId)) {
      const title = processClaudeCliPtyData(terminalId, data, {
        worktreeBasename: claudeCliWorktreeBasenames.get(terminalId)
      })
      if (title) {
        applyClaudeCliTitle({
          sessionId: terminalId,
          title,
          db: getDatabase()
        }).catch(() => {
          // applyClaudeCliTitle logs and swallows internally.
        })
      }
    }

    if (!flushScheduled.has(terminalId)) {
      flushScheduled.add(terminalId)
      setImmediate(() => {
        flushScheduled.delete(terminalId)
        const buffered = dataBuffers.get(terminalId)
        dataBuffers.delete(terminalId)
        if (buffered) {
          void import('../desktop/backend-manager')
            .then(({ publishDesktopBackendEvent }) =>
              publishDesktopBackendEvent(`terminal:data:${terminalId}`, buffered)
            )
            .catch(() => undefined)
        }
      })
    }
  })

  const removeExit = ptyService.onExit(terminalId, (code) => {
    void import('../desktop/backend-manager')
      .then(({ publishDesktopBackendEvent }) =>
        publishDesktopBackendEvent(`terminal:exit:${terminalId}`, code)
      )
      .catch(() => undefined)
    listenerCleanups.delete(terminalId)
    dataBuffers.delete(terminalId)
    flushScheduled.delete(terminalId)
    claudeWatchers.get(terminalId)?.close()
    claudeWatchers.delete(terminalId)
    if (claudeCliSessions.has(terminalId)) {
      publishClaudeCliStatus({
        sessionId: terminalId,
        status: 'completed',
        metadata: { reason: 'pty_exit' }
      })
      claudeCliSessions.delete(terminalId)
    }
    claudeCliWorktreeBasenames.delete(terminalId)
    resetClaudeCliTitleState(terminalId)
  })

  listenerCleanups.set(terminalId, { removeData, removeExit })
}

export async function createClaudeCliTerminal(
  sessionId: string,
  opts?: { pendingPrompt?: string | null }
): Promise<{ success: boolean; cols?: number; rows?: number; error?: string }> {
  const pendingPrompt = opts?.pendingPrompt ?? null
  log.info('RPC: terminalOps.createClaudeCli', { sessionId, hasPrompt: !!pendingPrompt })
  try {
    const db = getDatabase()
    const session = db.getSession(sessionId)
    if (!session) {
      return { success: false, error: 'Session not found' }
    }
    if (session.agent_sdk !== 'claude-code-cli') {
      return { success: false, error: 'Session is not a Claude Code CLI session' }
    }

    let worktreePath: string | null = null
    if (session.worktree_id) {
      worktreePath = db.getWorktree(session.worktree_id)?.path ?? null
    } else if (session.connection_id) {
      worktreePath = db.getConnection(session.connection_id)?.path ?? null
    }
    if (!worktreePath) {
      return { success: false, error: 'Could not resolve session working directory' }
    }

    const claudeBinary = resolveClaudeBinaryPath()
    if (!claudeBinary) {
      return { success: false, error: 'Claude binary not found on PATH' }
    }

    const alreadyExists = ptyService.has(sessionId)
    const { port } = await getClaudeHookServer()
    const hookSettingsJson = buildClaudeCliHookSettings(port, sessionId)
    const spawn = buildClaudeCliPtySpawn({
      session,
      worktreePath,
      pendingPrompt,
      claudeBinary,
      hookSettingsJson,
      db
    })

    log.info('Creating Claude CLI PTY', {
      sessionId,
      command: spawn.command,
      args: spawn.args.map((arg, index) =>
        index === spawn.args.length - 1 && pendingPrompt ? '<prompt>' : arg
      )
    })

    if (!session.claude_session_id) {
      claudeWatchers.get(sessionId)?.close()
      claudeWatchers.set(
        sessionId,
        watchForClaudeSessionId(worktreePath, (claudeSessionId) => {
          try {
            db.updateSession(sessionId, { claude_session_id: claudeSessionId })
          } catch (error) {
            log.warn('Failed to persist Claude CLI session id', {
              sessionId,
              error: error instanceof Error ? error.message : String(error)
            })
          }
          void import('../desktop/backend-manager')
            .then(({ publishDesktopBackendEvent }) =>
              publishDesktopBackendEvent(`terminal:claude-session-id:${sessionId}`, claudeSessionId)
            )
            .catch(() => undefined)
          claudeWatchers.delete(sessionId)
        })
      )
    }

    const { cols, rows } = ptyService.create(sessionId, {
      cwd: spawn.cwd,
      command: spawn.command,
      args: spawn.args,
      env: spawn.env
    })
    claudeCliSessions.add(sessionId)
    claudeCliWorktreeBasenames.set(sessionId, path.basename(worktreePath))
    if (!pendingPrompt) {
      publishClaudeCliStatus({
        sessionId,
        status: 'completed',
        metadata: { reason: 'pty_start' }
      })
    }

    if (!alreadyExists) {
      attachNodePtyListeners(sessionId)
    }

    return { success: true, cols, rows }
  } catch (error) {
    log.error(
      'RPC: terminalOps.createClaudeCli failed',
      error instanceof Error ? error : new Error(String(error)),
      { sessionId }
    )
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }
  }
}

export function cleanupTerminals(): void {
  log.info('Cleaning up all terminals')
  for (const [, cleanup] of listenerCleanups) {
    cleanup.removeData()
    cleanup.removeExit()
  }
  listenerCleanups.clear()
  dataBuffers.clear()
  flushScheduled.clear()
  claudeCliSessions.clear()
  claudeCliWorktreeBasenames.clear()
  resetAllClaudeCliTitleState()
  ptyService.destroyAll()
  ghosttyService.shutdown()
}
