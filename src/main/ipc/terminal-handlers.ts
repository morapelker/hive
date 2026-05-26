import { ipcMain, BrowserWindow } from 'electron'
import { Data, Effect } from 'effect'
import { z } from 'zod'
import { ptyService } from '../services/pty-service'
import { ghosttyService } from '../services/ghostty-service'
import { parseGhosttyConfig } from '../services/ghostty-config'
import { createLogger } from '../services/logger'
import { defineHandler } from './_shared/define-handler'
import { getDatabase } from '../db'
import { resolveClaudeBinaryPath } from '../services/claude-binary-resolver'
import { buildClaudeCliPtySpawn } from '../services/claude-cli-spawner'
import {
  watchForClaudeSessionId,
  type ClaudeSessionWatchHandle
} from '../services/claude-session-watcher'
import {
  buildClaudeCliHookSettings,
  getClaudeHookServer,
  publishClaudeCliStatus
} from '../services/claude-hook-server'

const log = createLogger({ component: 'TerminalHandlers' })

class TerminalIpcError extends Data.TaggedError('TerminalIpcError')<{
  message: string
  cause?: unknown
}> {}

const toMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const syncEffect = <A>(operation: () => A): Effect.Effect<A, TerminalIpcError> =>
  Effect.try({
    try: operation,
    catch: (error) => new TerminalIpcError({ message: toMessage(error), cause: error })
  })

const asyncEffect = <A>(operation: () => Promise<A>): Effect.Effect<A> => Effect.promise(operation)

const rectSchema = z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() })
const ghosttyOptsSchema = z
  .object({
    cwd: z.string().optional(),
    shell: z.string().optional(),
    scaleFactor: z.number().optional(),
    fontSize: z.number().optional()
  })
  .optional()
const ghosttyKeyEventSchema = z.object({
  action: z.number(),
  keycode: z.number(),
  mods: z.number(),
  consumedMods: z.number().optional(),
  text: z.string().optional(),
  unshiftedCodepoint: z.number().optional(),
  composing: z.boolean().optional()
})

// Track listener cleanup functions per terminalId to prevent duplicate registrations
const listenerCleanups = new Map<string, { removeData: () => void; removeExit: () => void }>()

// Per-worktree data buffers for batching PTY output before IPC send.
// node-pty can fire onData many times in rapid succession (e.g. during shell redraws).
// Sending each chunk as a separate IPC message means xterm.js parses them individually,
// which can split escape sequences across terminal.write() calls and cause visual glitches
// (e.g. cursor-reposition arriving in a different write than the text it precedes).
// Batching with setImmediate collects all data from the current I/O phase into one IPC message.
const dataBuffers = new Map<string, string>()
const flushScheduled = new Set<string>()
const claudeWatchers = new Map<string, ClaudeSessionWatchHandle>()
const claudeCliSessions = new Set<string>()

function attachNodePtyListeners(mainWindow: BrowserWindow, terminalId: string): void {
  // Clean up any stale listeners for this terminalId (shouldn't happen, but defensive)
  const existing = listenerCleanups.get(terminalId)
  if (existing) {
    existing.removeData()
    existing.removeExit()
    listenerCleanups.delete(terminalId)
  }

  const removeData = ptyService.onData(terminalId, (data) => {
    if (mainWindow.isDestroyed()) return

    const existing = dataBuffers.get(terminalId)
    dataBuffers.set(terminalId, existing ? existing + data : data)

    if (!flushScheduled.has(terminalId)) {
      flushScheduled.add(terminalId)
      setImmediate(() => {
        flushScheduled.delete(terminalId)
        const buffered = dataBuffers.get(terminalId)
        dataBuffers.delete(terminalId)
        if (buffered && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send(`terminal:data:${terminalId}`, buffered)
        }
      })
    }
  })

  const removeExit = ptyService.onExit(terminalId, (code) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send(`terminal:exit:${terminalId}`, code)
    }
    listenerCleanups.delete(terminalId)
    dataBuffers.delete(terminalId)
    flushScheduled.delete(terminalId)
    claudeWatchers.get(terminalId)?.close()
    claudeWatchers.delete(terminalId)
    if (claudeCliSessions.has(terminalId)) {
      publishClaudeCliStatus(mainWindow, {
        sessionId: terminalId,
        status: 'completed',
        metadata: { reason: 'pty_exit' }
      })
      claudeCliSessions.delete(terminalId)
    }
  })

  listenerCleanups.set(terminalId, { removeData, removeExit })
}

export function registerTerminalHandlers(mainWindow: BrowserWindow): void {
  // Set main window reference on the Ghostty service
  ghosttyService.setMainWindow(mainWindow)

  // -----------------------------------------------------------------------
  // node-pty (xterm.js backend) handlers
  // -----------------------------------------------------------------------

  // Create a PTY for a worktree
  defineHandler(
    'terminal:create',
    z.tuple([z.string().min(1), z.string().min(1), z.string().optional()]),
    ([terminalId, cwd, shell]) =>
      asyncEffect(async () => {
        log.info('IPC: terminal:create', { terminalId, cwd, shell })
        try {
          const alreadyExists = ptyService.has(terminalId)
          const { cols, rows } = ptyService.create(terminalId, { cwd, shell: shell || undefined })

          if (alreadyExists) {
            log.info('PTY already exists, skipping listener registration', { terminalId })
            return { success: true, cols, rows }
          }

          attachNodePtyListeners(mainWindow, terminalId)

          return { success: true, cols, rows }
        } catch (error) {
          log.error(
            'IPC: terminal:create failed',
            error instanceof Error ? error : new Error(String(error)),
            { terminalId }
          )
          return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error'
          }
        }
      })
  )

  defineHandler(
    'terminal:createClaudeCli',
    z.tuple([
      z.string().min(1),
      z.object({
        pendingPrompt: z.string().nullable().optional()
      }).optional()
    ]),
    ([sessionId, opts]) =>
      asyncEffect(async () => {
        const pendingPrompt = opts?.pendingPrompt ?? null
        log.info('IPC: terminal:createClaudeCli', { sessionId, hasPrompt: !!pendingPrompt })
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
          const { port } = await getClaudeHookServer(mainWindow)
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
                if (!mainWindow.isDestroyed()) {
                  mainWindow.webContents.send(
                    `terminal:claude-session-id:${sessionId}`,
                    claudeSessionId
                  )
                }
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
          if (!pendingPrompt) {
            publishClaudeCliStatus(mainWindow, {
              sessionId,
              status: 'completed',
              metadata: { reason: 'pty_start' }
            })
          }

          if (!alreadyExists) {
            attachNodePtyListeners(mainWindow, sessionId)
          }

          return { success: true, cols, rows }
        } catch (error) {
          log.error(
            'IPC: terminal:createClaudeCli failed',
            error instanceof Error ? error : new Error(String(error)),
            { sessionId }
          )
          return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error'
          }
        }
      })
  )

  // Write data to a PTY (fire-and-forget — no response needed for keystrokes)
  ipcMain.on('terminal:write', (_event, terminalId: string, data: string) => {
    ptyService.write(terminalId, data)
  })

  // Resize a PTY
  defineHandler(
    'terminal:resize',
    z.tuple([z.string().min(1), z.number(), z.number()]),
    ([terminalId, cols, rows]) => syncEffect(() => ptyService.resize(terminalId, cols, rows))
  )

  // Destroy a PTY
  defineHandler('terminal:destroy', z.string().min(1), (terminalId) =>
    syncEffect(() => {
      log.info('IPC: terminal:destroy', { terminalId })
      // Clean up listener tracking
      const cleanup = listenerCleanups.get(terminalId)
      if (cleanup) {
        cleanup.removeData()
        cleanup.removeExit()
        listenerCleanups.delete(terminalId)
      }
      // Discard any pending buffered data
      dataBuffers.delete(terminalId)
      flushScheduled.delete(terminalId)
      claudeWatchers.get(terminalId)?.close()
      claudeWatchers.delete(terminalId)
      claudeCliSessions.delete(terminalId)
      ptyService.destroy(terminalId)
    })
  )

  // Get Ghostty config for terminal theming
  defineHandler('terminal:getConfig', z.tuple([]), () =>
    syncEffect(() => {
      log.info('IPC: terminal:getConfig')
      try {
        return parseGhosttyConfig()
      } catch (error) {
        log.error(
          'IPC: terminal:getConfig failed',
          error instanceof Error ? error : new Error(String(error))
        )
        return {}
      }
    })
  )

  // -----------------------------------------------------------------------
  // Native Ghostty backend handlers
  // -----------------------------------------------------------------------

  // Initialize the Ghostty runtime (loads native addon + calls ghostty_init)
  defineHandler('terminal:ghostty:init', z.tuple([]), () =>
    syncEffect(() => {
      log.info('IPC: terminal:ghostty:init')
      return ghosttyService.init()
    })
  )

  // Check if the native Ghostty backend is available
  defineHandler('terminal:ghostty:isAvailable', z.tuple([]), () =>
    syncEffect(() => {
      // Attempt to load the addon if not already loaded
      ghosttyService.loadAddon()
      return {
        available: ghosttyService.isAvailable(),
        initialized: ghosttyService.isInitialized(),
        platform: process.platform
      }
    })
  )

  // Create a native Ghostty surface for a worktree
  defineHandler(
    'terminal:ghostty:createSurface',
    z.tuple([z.string().min(1), rectSchema, ghosttyOptsSchema]),
    ([terminalId, rect, opts]) =>
      syncEffect(() => {
        log.info('IPC: terminal:ghostty:createSurface', { terminalId, rect })
        return ghosttyService.createSurface(terminalId, rect, opts || {})
      })
  )

  // Update the native view frame (position + size)
  defineHandler(
    'terminal:ghostty:setFrame',
    z.tuple([z.string().min(1), rectSchema]),
    ([terminalId, rect]) => syncEffect(() => ghosttyService.setFrame(terminalId, rect))
  )

  // Update surface size in pixels
  defineHandler(
    'terminal:ghostty:setSize',
    z.tuple([z.string().min(1), z.number(), z.number()]),
    ([terminalId, width, height]) =>
      syncEffect(() => ghosttyService.setSize(terminalId, width, height))
  )

  // Forward a keyboard event to the Ghostty surface
  defineHandler(
    'terminal:ghostty:keyEvent',
    z.tuple([z.string().min(1), ghosttyKeyEventSchema]),
    ([terminalId, keyEvent]) => syncEffect(() => ghosttyService.keyEvent(terminalId, keyEvent))
  )

  // Forward a mouse button event
  defineHandler(
    'terminal:ghostty:mouseButton',
    z.tuple([z.string().min(1), z.number(), z.number(), z.number()]),
    ([terminalId, state, button, mods]) =>
      syncEffect(() => ghosttyService.mouseButton(terminalId, state, button, mods))
  )

  // Forward a mouse position event
  defineHandler(
    'terminal:ghostty:mousePos',
    z.tuple([z.string().min(1), z.number(), z.number(), z.number()]),
    ([terminalId, x, y, mods]) => syncEffect(() => ghosttyService.mousePos(terminalId, x, y, mods))
  )

  // Forward a mouse scroll event
  defineHandler(
    'terminal:ghostty:mouseScroll',
    z.tuple([z.string().min(1), z.number(), z.number(), z.number()]),
    ([terminalId, dx, dy, mods]) =>
      syncEffect(() => ghosttyService.mouseScroll(terminalId, dx, dy, mods))
  )

  // Set focus state for a surface
  defineHandler(
    'terminal:ghostty:setFocus',
    z.tuple([z.string().min(1), z.boolean()]),
    ([terminalId, focused]) => syncEffect(() => ghosttyService.setFocus(terminalId, focused))
  )

  // Paste text into a Ghostty surface (programmatic paste, bypasses macOS focus)
  defineHandler(
    'terminal:ghostty:pasteText',
    z.tuple([z.string().min(1), z.string()]),
    ([terminalId, text]) => syncEffect(() => ghosttyService.pasteText(terminalId, text))
  )

  // Diagnostic: inspect Ghostty view hierarchy and first responder state
  defineHandler('terminal:ghostty:focusDiagnostics', z.tuple([]), () =>
    syncEffect(() => ghosttyService.focusDiagnostics())
  )

  // Destroy a Ghostty surface for a worktree
  defineHandler('terminal:ghostty:destroySurface', z.string().min(1), (terminalId) =>
    syncEffect(() => {
      log.info('IPC: terminal:ghostty:destroySurface', { terminalId })
      ghosttyService.destroySurface(terminalId)
    })
  )

  // Shut down the Ghostty runtime entirely
  defineHandler('terminal:ghostty:shutdown', z.tuple([]), () =>
    syncEffect(() => {
      log.info('IPC: terminal:ghostty:shutdown')
      ghosttyService.shutdown()
    })
  )

  log.info('Terminal IPC handlers registered')
}

export function cleanupTerminals(): void {
  log.info('Cleaning up all terminals')
  // Clean up all listener tracking
  for (const [, cleanup] of listenerCleanups) {
    cleanup.removeData()
    cleanup.removeExit()
  }
  listenerCleanups.clear()
  // Discard all pending buffered data
  dataBuffers.clear()
  flushScheduled.clear()
  claudeCliSessions.clear()
  ptyService.destroyAll()
  ghosttyService.shutdown()
}
