import { app, BrowserWindow, screen } from 'electron'
import { join } from 'path'
import { createLogger } from './logger'

const log = createLogger({ component: 'GhosttyService' })

// Types matching the N-API addon exports
interface GhosttyAddon {
  ghosttyInit(): boolean
  ghosttyGetVersion(): string
  ghosttyCreateSurface(
    windowHandle: Buffer,
    rect: { x: number; y: number; w: number; h: number },
    opts: { cwd?: string; shell?: string; scaleFactor: number; fontSize?: number }
  ): number
  ghosttySetFrame(surfaceId: number, rect: { x: number; y: number; w: number; h: number }): void
  ghosttySetSize(surfaceId: number, width: number, height: number): void
  ghosttyKeyEvent(
    surfaceId: number,
    event: {
      action: number
      keycode: number
      mods: number
      consumedMods?: number
      text?: string
      unshiftedCodepoint?: number
      composing?: boolean
    }
  ): boolean
  ghosttyMouseButton(surfaceId: number, state: number, button: number, mods: number): void
  ghosttyMousePos(surfaceId: number, x: number, y: number, mods: number): void
  ghosttyMouseScroll(surfaceId: number, dx: number, dy: number, mods: number): void
  ghosttySetFocus(surfaceId: number, focused: boolean): void
  ghosttyDestroySurface(surfaceId: number): void
  ghosttyShutdown(): void
}

export interface GhosttyRect {
  x: number
  y: number
  w: number
  h: number
}

export interface GhosttyKeyEvent {
  action: number // 0 = release, 1 = press, 2 = repeat
  keycode: number // native platform keycode (macOS virtual keycode)
  mods: number // ghostty_input_mods_e bitmask
  consumedMods?: number
  text?: string
  unshiftedCodepoint?: number
  composing?: boolean
}

export interface GhosttyCreateSurfaceOpts {
  cwd?: string
  shell?: string
  scaleFactor?: number
  fontSize?: number
}

// Surface tracking for worktree association
interface SurfaceInfo {
  surfaceId: number
  worktreeId: string
}

class GhosttyService {
  private addon: GhosttyAddon | null = null
  private initialized = false
  private available = false
  private surfaces: Map<string, SurfaceInfo> = new Map()
  private mainWindow: BrowserWindow | null = null

  /**
   * Attempt to load the native Ghostty addon.
   * Returns true if the addon was loaded successfully (macOS only).
   */
  loadAddon(): boolean {
    if (this.addon) return true

    if (process.platform !== 'darwin') {
      log.info('Ghostty native addon is only available on macOS')
      return false
    }

    // In packaged app: <app>/Contents/Resources/native/ghostty.node (via extraResources)
    // In dev:          <project>/src/native/build/Release/ghostty.node
    const isPackaged = app.isPackaged
    const addonPath = isPackaged
      ? join(process.resourcesPath, 'native', 'ghostty.node')
      : join(app.getAppPath(), 'src', 'native', 'build', 'Release', 'ghostty.node')

    log.info('Ghostty addon load attempt', {
      isPackaged,
      addonPath,
      __dirname,
      resourcesPath: process.resourcesPath,
      appPath: app.getAppPath()
    })

    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      this.addon = require(addonPath) as GhosttyAddon
      this.available = true
      log.info('Ghostty native addon loaded successfully', { path: addonPath })
      return true
    } catch (err) {
      log.warn('Failed to load Ghostty native addon', {
        error: err instanceof Error ? err.message : String(err),
        addonPath,
        isPackaged
      })
      this.available = false
      return false
    }
  }

  /**
   * Check if the native addon is available (loaded successfully).
   */
  isAvailable(): boolean {
    return this.available
  }

  /**
   * Check if the Ghostty runtime has been initialized.
   */
  isInitialized(): boolean {
    return this.initialized
  }

  /**
   * Set the main window reference for sending IPC events to the renderer.
   */
  setMainWindow(window: BrowserWindow): void {
    this.mainWindow = window
  }

  /**
   * Initialize the Ghostty runtime. Must be called once before creating surfaces.
   * Automatically loads the addon if not already loaded.
   */
  init(): { success: boolean; version?: string; error?: string } {
    if (this.initialized) {
      return { success: true, version: this.getVersion() }
    }

    if (!this.addon && !this.loadAddon()) {
      return { success: false, error: 'Native addon not available' }
    }

    try {
      const result = this.addon!.ghosttyInit()
      if (!result) {
        return { success: false, error: 'ghostty_init() returned false' }
      }

      this.initialized = true
      const version = this.getVersion()
      log.info('Ghostty runtime initialized', { version })
      return { success: true, version }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      log.error(
        'Failed to initialize Ghostty runtime',
        err instanceof Error ? err : new Error(error)
      )
      return { success: false, error }
    }
  }

  /**
   * Get the Ghostty version string.
   */
  getVersion(): string {
    if (!this.addon) return 'unknown'
    try {
      return this.addon.ghosttyGetVersion()
    } catch {
      return 'unknown'
    }
  }

  /**
   * Create a native Ghostty terminal surface for a worktree.
   * The surface is attached to the Electron BrowserWindow as a native NSView overlay.
   */
  createSurface(
    worktreeId: string,
    rect: GhosttyRect,
    opts: GhosttyCreateSurfaceOpts = {}
  ): { success: boolean; surfaceId?: number; error?: string } {
    if (!this.initialized || !this.addon) {
      return { success: false, error: 'Ghostty runtime not initialized' }
    }

    // Check if surface already exists for this worktree
    const existing = this.surfaces.get(worktreeId)
    if (existing) {
      log.info('Surface already exists for worktree, reusing', {
        worktreeId,
        surfaceId: existing.surfaceId
      })
      return { success: true, surfaceId: existing.surfaceId }
    }

    if (!this.mainWindow || this.mainWindow.isDestroyed()) {
      return { success: false, error: 'Main window not available' }
    }

    try {
      const windowHandle = this.mainWindow.getNativeWindowHandle()
      // Use the display's native scale factor, NOT the Electron zoom factor.
      // Electron's getZoomFactor() reflects Cmd+/- zoom which inflates CSS pixel
      // values but does NOT change the actual display DPI — mixing them in
      // caused Ghostty to render with an incorrect scale, producing giant fonts.
      const display = screen.getDisplayMatching(this.mainWindow.getBounds())
      const scaleFactor = opts.scaleFactor ?? display.scaleFactor

      const surfaceId = this.addon.ghosttyCreateSurface(windowHandle, rect, {
        cwd: opts.cwd,
        shell: opts.shell,
        scaleFactor,
        fontSize: opts.fontSize
      })

      if (surfaceId === 0) {
        return { success: false, error: 'ghostty_surface_new returned null' }
      }

      this.surfaces.set(worktreeId, { surfaceId, worktreeId })

      log.info('Created Ghostty surface', { worktreeId, surfaceId, rect })
      return { success: true, surfaceId }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      log.error('Failed to create Ghostty surface', err instanceof Error ? err : new Error(error), {
        worktreeId
      })
      return { success: false, error }
    }
  }

  /**
   * Reposition/resize a surface's native view.
   */
  setFrame(worktreeId: string, rect: GhosttyRect): void {
    if (!this.addon) return

    const info = this.surfaces.get(worktreeId)
    if (!info) {
      log.warn('No surface found for setFrame', { worktreeId })
      return
    }

    try {
      this.addon.ghosttySetFrame(info.surfaceId, rect)
    } catch (err) {
      log.error(
        'Failed to set surface frame',
        err instanceof Error ? err : new Error(String(err)),
        { worktreeId, surfaceId: info.surfaceId }
      )
    }
  }

  /**
   * Update surface size in pixels (for Ghostty's internal grid calculation).
   */
  setSize(worktreeId: string, width: number, height: number): void {
    if (!this.addon) return

    const info = this.surfaces.get(worktreeId)
    if (!info) {
      log.warn('No surface found for setSize', { worktreeId })
      return
    }

    try {
      this.addon.ghosttySetSize(info.surfaceId, width, height)
    } catch (err) {
      log.error('Failed to set surface size', err instanceof Error ? err : new Error(String(err)), {
        worktreeId,
        surfaceId: info.surfaceId
      })
    }
  }

  /**
   * Forward a keyboard event to the Ghostty surface.
   * Returns true if Ghostty consumed the event.
   */
  keyEvent(worktreeId: string, event: GhosttyKeyEvent): boolean {
    if (!this.addon) return false

    const info = this.surfaces.get(worktreeId)
    if (!info) return false

    try {
      return this.addon.ghosttyKeyEvent(info.surfaceId, event)
    } catch (err) {
      log.error(
        'Failed to forward key event',
        err instanceof Error ? err : new Error(String(err)),
        { worktreeId }
      )
      return false
    }
  }

  /**
   * Forward a mouse button event to the Ghostty surface.
   */
  mouseButton(worktreeId: string, state: number, button: number, mods: number): void {
    if (!this.addon) return

    const info = this.surfaces.get(worktreeId)
    if (!info) return

    try {
      this.addon.ghosttyMouseButton(info.surfaceId, state, button, mods)
    } catch (err) {
      log.error(
        'Failed to forward mouse button',
        err instanceof Error ? err : new Error(String(err)),
        { worktreeId }
      )
    }
  }

  /**
   * Forward a mouse position event to the Ghostty surface.
   */
  mousePos(worktreeId: string, x: number, y: number, mods: number): void {
    if (!this.addon) return

    const info = this.surfaces.get(worktreeId)
    if (!info) return

    try {
      this.addon.ghosttyMousePos(info.surfaceId, x, y, mods)
    } catch (err) {
      log.error(
        'Failed to forward mouse position',
        err instanceof Error ? err : new Error(String(err)),
        { worktreeId }
      )
    }
  }

  /**
   * Forward a mouse scroll event to the Ghostty surface.
   */
  mouseScroll(worktreeId: string, dx: number, dy: number, mods: number): void {
    if (!this.addon) return

    const info = this.surfaces.get(worktreeId)
    if (!info) return

    try {
      this.addon.ghosttyMouseScroll(info.surfaceId, dx, dy, mods)
    } catch (err) {
      log.error(
        'Failed to forward mouse scroll',
        err instanceof Error ? err : new Error(String(err)),
        { worktreeId }
      )
    }
  }

  /**
   * Set focus state for a surface.
   */
  setFocus(worktreeId: string, focused: boolean): void {
    if (!this.addon) return

    const info = this.surfaces.get(worktreeId)
    if (!info) return

    try {
      this.addon.ghosttySetFocus(info.surfaceId, focused)
    } catch (err) {
      log.error(
        'Failed to set surface focus',
        err instanceof Error ? err : new Error(String(err)),
        { worktreeId }
      )
    }
  }

  /**
   * Destroy the Ghostty surface for a worktree.
   */
  destroySurface(worktreeId: string): void {
    if (!this.addon) return

    const info = this.surfaces.get(worktreeId)
    if (!info) {
      log.warn('No surface found for destroy', { worktreeId })
      return
    }

    try {
      this.addon.ghosttyDestroySurface(info.surfaceId)
      this.surfaces.delete(worktreeId)
      log.info('Destroyed Ghostty surface', { worktreeId, surfaceId: info.surfaceId })
    } catch (err) {
      log.error('Failed to destroy surface', err instanceof Error ? err : new Error(String(err)), {
        worktreeId
      })
      // Remove from tracking even if destroy failed
      this.surfaces.delete(worktreeId)
    }
  }

  /**
   * Destroy all surfaces and shut down the Ghostty runtime.
   */
  shutdown(): void {
    if (!this.addon || !this.initialized) return

    log.info('Shutting down Ghostty runtime', { surfaceCount: this.surfaces.size })

    // Destroy all surfaces first
    for (const [worktreeId] of this.surfaces) {
      this.destroySurface(worktreeId)
    }

    try {
      this.addon.ghosttyShutdown()
    } catch (err) {
      log.error(
        'Error during Ghostty shutdown',
        err instanceof Error ? err : new Error(String(err))
      )
    }

    this.initialized = false
    log.info('Ghostty runtime shut down')
  }

  /**
   * Check if a surface exists for the given worktree.
   */
  hasSurface(worktreeId: string): boolean {
    return this.surfaces.has(worktreeId)
  }

  /**
   * Get the surface ID for a worktree (0 if not found).
   */
  getSurfaceId(worktreeId: string): number {
    return this.surfaces.get(worktreeId)?.surfaceId ?? 0
  }

  /**
   * Destroy all surfaces whose worktree IDs are NOT in the given set.
   */
  destroyExcept(validIds: Set<string>): void {
    for (const [worktreeId] of this.surfaces) {
      if (!validIds.has(worktreeId)) {
        log.info('Destroying orphaned Ghostty surface', { worktreeId })
        this.destroySurface(worktreeId)
      }
    }
  }
}

export const ghosttyService = new GhosttyService()
