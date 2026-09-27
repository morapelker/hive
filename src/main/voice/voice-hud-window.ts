import { BrowserWindow, screen } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import type { VoiceHudState } from '@shared/types/voice'
import { createLogger } from '../services/logger'
import type { VoiceSoundName } from './voice-sounds'

const log = createLogger({ component: 'VoiceHud' })

/** Transparent window large enough for the widest notice; the pill centres inside. */
const HUD_WIDTH = 520
const HUD_HEIGHT = 72
/** The pill's bottom edge sits this far above the main window's bottom edge (Wispelker: 80pt above the Dock). */
const HUD_BOTTOM_MARGIN = 80

/**
 * The floating recording pill — Wispelker's non-activating NSPanel, as an
 * Electron panel window: transparent, borderless, always on top of the main
 * window, never focusable (the text field the user was typing in keeps focus
 * throughout), following the main window when it moves. It also owns the
 * microphone: audio is captured in this window's renderer and handed to the
 * main process when recording stops.
 */
export class VoiceHudWindow {
  private window: BrowserWindow | null = null
  private ready = false
  private state: VoiceHudState = { phase: { kind: 'hidden' }, sounds: true }
  private getMainWindow: () => BrowserWindow | null = () => null
  private followTargets = new WeakSet<BrowserWindow>()
  private readyWaiters: Array<() => void> = []

  configure(options: { getMainWindow: () => BrowserWindow | null }): void {
    this.getMainWindow = options.getMainWindow
  }

  isHudContents(contents: Electron.WebContents): boolean {
    return (
      this.window !== null && !this.window.isDestroyed() && this.window.webContents === contents
    )
  }

  /** Create the (hidden) window ahead of time so the first hotkey press shows the pill instantly. */
  ensureCreated(): BrowserWindow {
    if (this.window && !this.window.isDestroyed()) return this.window

    const window = new BrowserWindow({
      width: HUD_WIDTH,
      height: HUD_HEIGHT,
      transparent: true,
      ...(process.platform === 'darwin' ? { type: 'panel' as const } : {}),
      frame: false,
      hasShadow: false,
      skipTaskbar: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      alwaysOnTop: true,
      focusable: false,
      acceptFirstMouse: true,
      hiddenInMissionControl: true,
      roundedCorners: false,
      show: false,
      title: 'Voice dictation',
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        backgroundThrottling: false
      }
    })

    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    window.setAlwaysOnTop(true, 'floating')
    window.setMenuBarVisibility(false)

    window.on('closed', () => {
      if (this.window === window) {
        this.window = null
        this.ready = false
      }
    })
    window.webContents.on('render-process-gone', (_event, details) => {
      log.warn('HUD renderer gone', { reason: details.reason })
      this.ready = false
    })
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

    if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
      void window.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/voice-hud.html`)
    } else {
      void window.loadFile(join(__dirname, '../renderer/voice-hud.html'))
    }

    this.window = window
    this.ready = false
    this.followMainWindow()
    return window
  }

  /** Called by the HUD renderer once its React tree and IPC listeners are up. */
  markReady(): void {
    this.ready = true
    this.send('voice:hud:state', this.state)
    for (const waiter of this.readyWaiters.splice(0)) waiter()
  }

  async waitUntilReady(timeoutMs = 4_000): Promise<boolean> {
    this.ensureCreated()
    if (this.ready) return true
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.readyWaiters = this.readyWaiters.filter((w) => w !== waiter)
        resolve(false)
      }, timeoutMs)
      const waiter = (): void => {
        clearTimeout(timer)
        resolve(true)
      }
      this.readyWaiters.push(waiter)
    })
  }

  setState(state: VoiceHudState): void {
    this.state = state
    // Always tell the renderer, including 'hidden': it clears the pill so the
    // next show() never flashes the previous phase for a frame.
    this.send('voice:hud:state', state)
    if (state.phase.kind === 'hidden') {
      this.hide()
    }
  }

  getState(): VoiceHudState {
    return this.state
  }

  show(): void {
    const window = this.ensureCreated()
    this.reposition()
    if (!window.isVisible()) {
      window.showInactive()
    }
  }

  hide(): void {
    if (this.window && !this.window.isDestroyed() && this.window.isVisible()) {
      this.window.hide()
    }
  }

  isVisible(): boolean {
    return this.window !== null && !this.window.isDestroyed() && this.window.isVisible()
  }

  startCapture(): void {
    this.send('voice:hud:capture-start')
  }

  stopCapture(): void {
    this.send('voice:hud:capture-stop')
  }

  cancelCapture(): void {
    this.send('voice:hud:capture-cancel')
  }

  playSound(name: VoiceSoundName): void {
    this.send('voice:hud:sound', name)
  }

  destroy(): void {
    if (this.window && !this.window.isDestroyed()) {
      this.window.destroy()
    }
    this.window = null
    this.ready = false
  }

  private send(channel: string, payload?: unknown): void {
    if (!this.window || this.window.isDestroyed()) return
    try {
      this.window.webContents.send(channel, payload)
    } catch (error) {
      log.warn('HUD send failed', { channel, error: String(error) })
    }
  }

  /** Bottom-centre of the main window, clamped to that display's work area. */
  reposition(): void {
    const hud = this.window
    if (!hud || hud.isDestroyed()) return
    const main = this.getMainWindow()
    const anchor =
      main && !main.isDestroyed() ? main.getBounds() : screen.getPrimaryDisplay().workArea
    const display = screen.getDisplayMatching(anchor)
    const area = display.workArea
    let x = Math.round(anchor.x + anchor.width / 2 - HUD_WIDTH / 2)
    let y = Math.round(anchor.y + anchor.height - HUD_BOTTOM_MARGIN - HUD_HEIGHT)
    x = Math.min(Math.max(x, area.x), area.x + area.width - HUD_WIDTH)
    y = Math.min(Math.max(y, area.y), area.y + area.height - HUD_HEIGHT)
    hud.setBounds({ x, y, width: HUD_WIDTH, height: HUD_HEIGHT }, false)
  }

  private followMainWindow(): void {
    const main = this.getMainWindow()
    if (!main || main.isDestroyed() || this.followTargets.has(main)) return
    this.followTargets.add(main)
    const onMove = (): void => {
      if (this.isVisible()) this.reposition()
    }
    main.on('move', onMove)
    main.on('resize', onMove)
    main.on('enter-full-screen', onMove)
    main.on('leave-full-screen', onMove)
  }
}

export const voiceHud = new VoiceHudWindow()
