import { ipcMain, BrowserWindow } from 'electron'
import { ptyService } from '../services/pty-service'
import { ghosttyService } from '../services/ghostty-service'
import { parseGhosttyConfig } from '../services/ghostty-config'
import { createLogger } from '../services/logger'

const log = createLogger({ component: 'TerminalHandlers' })

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

export function registerTerminalHandlers(mainWindow: BrowserWindow): void {
  // Set main window reference on the Ghostty service
  ghosttyService.setMainWindow(mainWindow)

  // -----------------------------------------------------------------------
  // node-pty (xterm.js backend) handlers
  // -----------------------------------------------------------------------

  // Create a PTY for a worktree
  ipcMain.handle(
    'terminal:create',
    async (_event, terminalId: string, cwd: string, shell?: string) => {
      log.info('IPC: terminal:create', { terminalId, cwd, shell })
      try {
        // Check if PTY already exists before creating — if it does, skip listener registration
        const alreadyExists = ptyService.has(terminalId)
        const { cols, rows } = ptyService.create(terminalId, { cwd, shell: shell || undefined })

        if (alreadyExists) {
          log.info('PTY already exists, skipping listener registration', { terminalId })
          return { success: true, cols, rows }
        }

        // Clean up any stale listeners for this terminalId (shouldn't happen, but defensive)
        const existing = listenerCleanups.get(terminalId)
        if (existing) {
          existing.removeData()
          existing.removeExit()
          listenerCleanups.delete(terminalId)
        }

        // Wire PTY output to renderer (batched via setImmediate)
        const removeData = ptyService.onData(terminalId, (data) => {
          if (mainWindow.isDestroyed()) return

          // Accumulate into buffer
          const existing = dataBuffers.get(terminalId)
          dataBuffers.set(terminalId, existing ? existing + data : data)

          // Schedule a flush if one isn't already pending
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

        // Wire PTY exit to renderer
        const removeExit = ptyService.onExit(terminalId, (code) => {
          if (!mainWindow.isDestroyed()) {
            mainWindow.webContents.send(`terminal:exit:${terminalId}`, code)
          }
          // Clean up listener tracking on exit
          listenerCleanups.delete(terminalId)
        })

        listenerCleanups.set(terminalId, { removeData, removeExit })

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
    }
  )

  // Write data to a PTY (fire-and-forget — no response needed for keystrokes)
  ipcMain.on('terminal:write', (_event, terminalId: string, data: string) => {
    ptyService.write(terminalId, data)
  })

  // Resize a PTY
  ipcMain.handle('terminal:resize', (_event, terminalId: string, cols: number, rows: number) => {
    ptyService.resize(terminalId, cols, rows)
  })

  // Destroy a PTY
  ipcMain.handle('terminal:destroy', (_event, terminalId: string) => {
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
    ptyService.destroy(terminalId)
  })

  // Get Ghostty config for terminal theming
  ipcMain.handle('terminal:getConfig', () => {
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

  // -----------------------------------------------------------------------
  // Native Ghostty backend handlers
  // -----------------------------------------------------------------------

  // Initialize the Ghostty runtime (loads native addon + calls ghostty_init)
  ipcMain.handle('terminal:ghostty:init', () => {
    log.info('IPC: terminal:ghostty:init')
    return ghosttyService.init()
  })

  // Check if the native Ghostty backend is available
  ipcMain.handle('terminal:ghostty:isAvailable', () => {
    // Attempt to load the addon if not already loaded
    ghosttyService.loadAddon()
    return {
      available: ghosttyService.isAvailable(),
      initialized: ghosttyService.isInitialized(),
      platform: process.platform
    }
  })

  // Create a native Ghostty surface for a worktree
  ipcMain.handle(
    'terminal:ghostty:createSurface',
    (
      _event,
      terminalId: string,
      rect: { x: number; y: number; w: number; h: number },
      opts?: { cwd?: string; shell?: string; scaleFactor?: number; fontSize?: number }
    ) => {
      log.info('IPC: terminal:ghostty:createSurface', { terminalId, rect })
      return ghosttyService.createSurface(terminalId, rect, opts || {})
    }
  )

  // Update the native view frame (position + size)
  ipcMain.handle(
    'terminal:ghostty:setFrame',
    (_event, terminalId: string, rect: { x: number; y: number; w: number; h: number }) => {
      ghosttyService.setFrame(terminalId, rect)
    }
  )

  // Update surface size in pixels
  ipcMain.handle(
    'terminal:ghostty:setSize',
    (_event, terminalId: string, width: number, height: number) => {
      ghosttyService.setSize(terminalId, width, height)
    }
  )

  // Forward a keyboard event to the Ghostty surface
  ipcMain.handle(
    'terminal:ghostty:keyEvent',
    (
      _event,
      terminalId: string,
      keyEvent: {
        action: number
        keycode: number
        mods: number
        consumedMods?: number
        text?: string
        unshiftedCodepoint?: number
        composing?: boolean
      }
    ) => {
      return ghosttyService.keyEvent(terminalId, keyEvent)
    }
  )

  // Forward a mouse button event
  ipcMain.handle(
    'terminal:ghostty:mouseButton',
    (_event, terminalId: string, state: number, button: number, mods: number) => {
      ghosttyService.mouseButton(terminalId, state, button, mods)
    }
  )

  // Forward a mouse position event
  ipcMain.handle(
    'terminal:ghostty:mousePos',
    (_event, terminalId: string, x: number, y: number, mods: number) => {
      ghosttyService.mousePos(terminalId, x, y, mods)
    }
  )

  // Forward a mouse scroll event
  ipcMain.handle(
    'terminal:ghostty:mouseScroll',
    (_event, terminalId: string, dx: number, dy: number, mods: number) => {
      ghosttyService.mouseScroll(terminalId, dx, dy, mods)
    }
  )

  // Set focus state for a surface
  ipcMain.handle('terminal:ghostty:setFocus', (_event, terminalId: string, focused: boolean) => {
    ghosttyService.setFocus(terminalId, focused)
  })

  // Paste text into a Ghostty surface (programmatic paste, bypasses macOS focus)
  ipcMain.handle('terminal:ghostty:pasteText', (_event, terminalId: string, text: string) => {
    ghosttyService.pasteText(terminalId, text)
  })

  // Diagnostic: inspect Ghostty view hierarchy and first responder state
  ipcMain.handle('terminal:ghostty:focusDiagnostics', () => {
    return ghosttyService.focusDiagnostics()
  })

  // Destroy a Ghostty surface for a worktree
  ipcMain.handle('terminal:ghostty:destroySurface', (_event, terminalId: string) => {
    log.info('IPC: terminal:ghostty:destroySurface', { terminalId })
    ghosttyService.destroySurface(terminalId)
  })

  // Shut down the Ghostty runtime entirely
  ipcMain.handle('terminal:ghostty:shutdown', () => {
    log.info('IPC: terminal:ghostty:shutdown')
    ghosttyService.shutdown()
  })

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
  ptyService.destroyAll()
  ghosttyService.shutdown()
}
