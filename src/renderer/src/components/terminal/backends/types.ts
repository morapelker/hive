/**
 * Terminal backend abstraction layer.
 * Allows switching between xterm.js (cross-platform) and native Ghostty (macOS).
 */

export type TerminalBackendType = 'xterm' | 'ghostty'

export interface TerminalOpts {
  worktreeId: string
  cwd: string
  fontFamily?: string
  fontSize?: number
  cursorStyle?: 'block' | 'bar' | 'underline'
  scrollback?: number
  theme?: Record<string, string>
  shell?: string
}

/**
 * Callbacks the backend uses to communicate state changes to the host component.
 */
export interface TerminalBackendCallbacks {
  onStatusChange: (status: 'creating' | 'running' | 'exited', exitCode?: number) => void
  onTitleChange?: (title: string) => void
  onBell?: () => void
}

/**
 * Abstraction over different terminal rendering backends.
 * Both xterm.js and Ghostty implement this interface.
 */
export interface TerminalBackend {
  /** The type of this backend */
  readonly type: TerminalBackendType

  /** Mount the terminal into the given container element */
  mount(container: HTMLDivElement, opts: TerminalOpts, callbacks: TerminalBackendCallbacks): void

  /** Write data to the terminal (xterm only — Ghostty handles its own I/O) */
  write?(data: string): void

  /** Resize the terminal grid */
  resize(cols: number, rows: number): void

  /** Focus the terminal */
  focus(): void

  /** Clear the terminal scrollback */
  clear(): void

  /** Update the terminal theme at runtime (re-reads CSS variables) */
  updateTheme?(): void

  /** Toggle backend visibility while keeping session state alive */
  setVisible?(visible: boolean): void

  /** Search within terminal output */
  searchOpen?(): void
  searchClose?(): void
  searchNext?(query: string): void
  searchPrevious?(query: string): void

  /** Get whether the backend supports search */
  readonly supportsSearch: boolean

  /** Dispose of the terminal and clean up all resources */
  dispose(): void
}
