import type { TerminalBackend, TerminalOpts, TerminalBackendCallbacks } from './types'
import { useSettingsStore } from '@/stores/useSettingsStore'

/**
 * Native Ghostty terminal backend (macOS only).
 * Renders via Metal through a native NSView overlay on the Electron window.
 * Delegates all I/O to the Ghostty runtime — no node-pty involvement.
 */
export class GhosttyBackend implements TerminalBackend {
  readonly type = 'ghostty' as const
  readonly supportsSearch = false // Ghostty handles its own search natively

  private static readonly HIDDEN_RECT = { x: -10000, y: -10000, w: 1, h: 1 }

  /** Fallback font size when the setting is unavailable (points). */
  private static readonly FALLBACK_FONT_SIZE = 14

  private worktreeId: string = ''
  private container: HTMLDivElement | null = null
  private resizeObserver: ResizeObserver | null = null
  private mounted = false
  private syncFrameTimer: ReturnType<typeof requestAnimationFrame> | null = null

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

    // Track container position/size and update the native NSView frame.
    // Debounced via requestAnimationFrame to avoid rapid-fire IPC during resizing.
    this.resizeObserver = new ResizeObserver(() => {
      this.debouncedSyncFrame()
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
        scaleFactor: window.devicePixelRatio || 2.0,
        fontSize: useSettingsStore.getState().ghosttyFontSize || GhosttyBackend.FALLBACK_FONT_SIZE
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
   *
   * getBoundingClientRect() returns CSS pixels which are inflated by the Electron
   * zoom factor (Cmd+/-). The native NSView frame needs AppKit points, so we
   * divide out the zoom factor to avoid double-scaling that makes fonts giant.
   */
  private getContainerRect(): { x: number; y: number; w: number; h: number } | null {
    if (!this.container) return null

    const bounds = this.container.getBoundingClientRect()
    if (bounds.width === 0 || bounds.height === 0) return null

    // Compensate for Electron zoom: CSS pixels → AppKit points.
    // devicePixelRatio includes both display scale and Electron zoom;
    // the native layer already accounts for display backingScaleFactor,
    // so we only need to undo the Electron zoom portion.
    // Electron zoom factor = devicePixelRatio / backingScaleFactor.
    // Since we can't query backingScaleFactor from the renderer, we use
    // the fact that screen.deviceXDPI / screen.logicalXDPI is the zoom,
    // but the simplest reliable approach is:
    //   zoomFactor = devicePixelRatio / (base DPR without zoom)
    // On Retina Mac, base DPR is 2.0. On non-Retina, it's 1.0.
    // However, there's no reliable way to know the "base" DPR from the
    // renderer alone. Instead, we note that Electron gives us
    // visualViewport.scale which IS the zoom factor on Electron >= 28.
    const zoomFactor = window.visualViewport?.scale ?? 1.0

    return {
      x: Math.round(bounds.left / zoomFactor),
      y: Math.round(bounds.top / zoomFactor),
      w: Math.round(bounds.width / zoomFactor),
      h: Math.round(bounds.height / zoomFactor)
    }
  }

  /**
   * Schedule a syncFrame on the next animation frame.
   * Coalesces rapid ResizeObserver firings into a single update.
   */
  private debouncedSyncFrame(): void {
    if (this.syncFrameTimer !== null) return
    this.syncFrameTimer = requestAnimationFrame(() => {
      this.syncFrameTimer = null
      this.syncFrame()
    })
  }

  /**
   * Sync the native NSView frame with the current container position.
   * Called on resize and scroll events.
   *
   * setFrame in the native bridge already calls ghostty_surface_set_size
   * internally, so we only need the single setFrame call here.
   */
  private syncFrame(): void {
    if (!this.mounted) return

    const rect = this.getContainerRect()
    if (!rect) return

    window.terminalOps.ghosttySetFrame(this.worktreeId, rect).catch(() => {
      // Ignore frame sync errors during teardown
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

  setVisible(visible: boolean): void {
    if (!this.mounted) return

    if (!visible) {
      window.terminalOps.ghosttySetFocus(this.worktreeId, false).catch(() => {
        // Ignore focus errors
      })
      window.terminalOps.ghosttySetFrame(this.worktreeId, GhosttyBackend.HIDDEN_RECT).catch(() => {
        // Ignore frame sync errors during teardown
      })
      return
    }

    this.syncFrame()
  }

  clear(): void {
    // Ghostty doesn't expose a clear API through our bridge yet
    // This is a known limitation of the native backend
  }

  dispose(): void {
    this.mounted = false

    if (this.syncFrameTimer !== null) {
      cancelAnimationFrame(this.syncFrameTimer)
      this.syncFrameTimer = null
    }

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
