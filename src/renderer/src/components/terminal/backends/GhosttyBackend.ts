import type { TerminalBackend, TerminalOpts, TerminalBackendCallbacks } from './types'

/**
 * Native Ghostty terminal backend (macOS only).
 * Renders via Metal through a native NSView overlay on the Electron window.
 * Delegates all I/O to the Ghostty runtime — no node-pty involvement.
 */
export class GhosttyBackend implements TerminalBackend {
  readonly type = 'ghostty' as const
  readonly supportsSearch = false // Ghostty handles its own search natively

  private worktreeId: string = ''
  private container: HTMLDivElement | null = null
  private resizeObserver: ResizeObserver | null = null
  private mounted = false

  mount(container: HTMLDivElement, opts: TerminalOpts, callbacks: TerminalBackendCallbacks): void {
    this.worktreeId = opts.worktreeId
    this.container = container
    this.mounted = true

    // The container acts as a transparent "hole" — the native NSView renders behind it.
    // We need pointer-events: none so mouse events pass through to the native view.
    container.innerHTML = ''
    container.style.pointerEvents = 'none'
    container.style.position = 'relative'

    callbacks.onStatusChange('creating')

    this.initAndCreateSurface(opts).then((success) => {
      if (success) {
        callbacks.onStatusChange('running')
      } else {
        callbacks.onStatusChange('exited')
      }
    })

    // Track container position/size and update the native NSView frame
    this.resizeObserver = new ResizeObserver(() => {
      this.syncFrame()
    })
    this.resizeObserver.observe(container)
  }

  /**
   * Initialize the Ghostty runtime (if needed) and create a surface.
   */
  private async initAndCreateSurface(opts: TerminalOpts): Promise<boolean> {
    try {
      // Ensure Ghostty runtime is initialized
      const initResult = await window.terminalOps.ghosttyInit()
      if (!initResult.success) {
        console.error('Failed to initialize Ghostty:', initResult.error)
        return false
      }

      // Get container rect for initial surface placement
      const rect = this.getContainerRect()
      if (!rect) return false

      // Create the native surface
      const result = await window.terminalOps.ghosttyCreateSurface(this.worktreeId, rect, {
        cwd: opts.cwd,
        shell: opts.shell,
        scaleFactor: window.devicePixelRatio || 2.0
      })

      if (!result.success) {
        console.error('Failed to create Ghostty surface:', result.error)
        return false
      }

      // Set initial focus
      await window.terminalOps.ghosttySetFocus(this.worktreeId, true)

      return true
    } catch (err) {
      console.error('Error creating Ghostty surface:', err)
      return false
    }
  }

  /**
   * Get the container's bounding rect in screen coordinates for the native NSView.
   */
  private getContainerRect(): { x: number; y: number; w: number; h: number } | null {
    if (!this.container) return null

    const bounds = this.container.getBoundingClientRect()
    if (bounds.width === 0 || bounds.height === 0) return null

    return {
      x: Math.round(bounds.left),
      y: Math.round(bounds.top),
      w: Math.round(bounds.width),
      h: Math.round(bounds.height)
    }
  }

  /**
   * Sync the native NSView frame with the current container position.
   * Called on resize and scroll events.
   */
  private syncFrame(): void {
    if (!this.mounted) return

    const rect = this.getContainerRect()
    if (!rect) return

    window.terminalOps.ghosttySetFrame(this.worktreeId, rect).catch(() => {
      // Ignore frame sync errors during teardown
    })

    window.terminalOps.ghosttySetSize(this.worktreeId, rect.w, rect.h).catch(() => {
      // Ignore size sync errors during teardown
    })
  }

  /** Not used — Ghostty handles its own I/O */
  write(): void {
    // No-op: Ghostty manages its own PTY internally
  }

  resize(_cols: number, _rows: number): void {
    // Ghostty calculates its own grid from pixel dimensions
    this.syncFrame()
  }

  focus(): void {
    if (!this.mounted) return
    window.terminalOps.ghosttySetFocus(this.worktreeId, true).catch(() => {
      // Ignore focus errors
    })
  }

  clear(): void {
    // Ghostty doesn't expose a clear API through our bridge yet
    // This is a known limitation of the native backend
  }

  dispose(): void {
    this.mounted = false
    this.resizeObserver?.disconnect()
    this.resizeObserver = null

    if (this.container) {
      this.container.style.pointerEvents = ''
      this.container = null
    }

    window.terminalOps.ghosttyDestroySurface(this.worktreeId).catch(() => {
      // Best-effort cleanup
    })
  }
}

/**
 * Check if the Ghostty native backend is available on this system.
 * Returns false on non-macOS platforms or if the addon isn't built.
 */
export async function isGhosttyAvailable(): Promise<boolean> {
  try {
    const result = await window.terminalOps.ghosttyIsAvailable()
    return result.available
  } catch {
    return false
  }
}
