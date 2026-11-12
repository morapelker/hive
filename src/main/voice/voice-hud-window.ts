import { BrowserWindow, screen } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import type { VoiceCaptureStartOptions, VoiceHudState } from '@shared/types/voice'
import { createLogger } from '../services/logger'
import type { VoiceSoundName } from './voice-sounds'
import { voiceTestClips } from './voice-test-clips'

const log = createLogger({ component: 'VoiceHud' })

/** Transparent window large enough for the widest notice; the pill centres inside. */
export const HUD_WIDTH = 520
/** The strip at the bottom of the window the pill centres in. */
export const HUD_PILL_HEIGHT = 72
/**
 * Room above the pill for the live transcript preview (VOICE-07): up to four
 * lines of text plus padding, the gap to the pill and the panel's shadow.
 */
export const HUD_PREVIEW_HEIGHT = 112
export const HUD_HEIGHT = HUD_PILL_HEIGHT + HUD_PREVIEW_HEIGHT
/** The pill's bottom edge sits this far above the main window's bottom edge (Wispelker: 80pt above the Dock). */
export const HUD_BOTTOM_MARGIN = 80

/**
 * Where the window can let clicks through its transparent parts while still
 * seeing the mouse move (`setIgnoreMouseEvents(true, { forward: true })` is
 * macOS/Windows only). Elsewhere the whole window takes clicks, as before.
 */
function supportsClickThrough(platform: NodeJS.Platform): boolean {
  return platform === 'darwin' || platform === 'win32'
}

/**
 * The floating recording pill — Wispelker's non-activating NSPanel, as an
 * Electron panel window: transparent, borderless, always on top of the main
 * window, never focusable (the text field the user was typing in keeps focus
 * throughout), following the main window when it moves. It also owns the
 * microphone: audio is captured in this window's renderer and handed to the
 * main process when recording stops.
 *
 * The window is taller than the pill to fit the live transcript preview above
 * it, so most of it is transparent. Those parts let clicks through to the app
 * underneath: the window ignores the mouse except while the cursor is over the
 * pill or the preview panel (the renderer reports that, see setInteractive).
 */
export class VoiceHudWindow {
  private window: BrowserWindow | null = null
  private ready = false
  private state: VoiceHudState = { phase: { kind: 'hidden' }, sounds: true }
  private getMainWindow: () => BrowserWindow | null = () => null
  private followTargets = new WeakSet<BrowserWindow>()
  private readyWaiters: Array<() => void> = []
  /** The window takes mouse clicks (the cursor is over the pill or the preview). */
  private interactive = false
  private readonly clickThrough: boolean

  constructor({ platform = process.platform }: { platform?: NodeJS.Platform } = {}) {
    this.clickThrough = supportsClickThrough(platform)
  }

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
    if (this.clickThrough) window.setIgnoreMouseEvents(true, { forward: true })

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
    this.interactive = false
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
      // A freshly shown pill lets clicks through until the cursor moves onto it.
      this.setInteractive(false, { force: true })
      window.showInactive()
    }
  }

  hide(): void {
    if (this.window && !this.window.isDestroyed() && this.window.isVisible()) {
      this.window.hide()
    }
    this.setInteractive(false)
  }

  /**
   * The HUD renderer reports whether the cursor is over a visible part of the
   * HUD (the pill or the preview panel). Only then does the window take mouse
   * clicks; everywhere else they go to the app underneath. Mouse moves are
   * still forwarded while ignoring, so the renderer sees the cursor arrive.
   * Never affects focus: the window stays unfocusable either way.
   */
  setInteractive(interactive: boolean, { force = false }: { force?: boolean } = {}): void {
    const window = this.window
    if (!this.clickThrough || !window || window.isDestroyed()) return
    // A late report from a pill that has just been hidden must not leave the
    // whole window blocking clicks the next time it shows.
    if (interactive && !window.isVisible()) return
    if (!force && interactive === this.interactive) return
    this.interactive = interactive
    if (interactive) {
      window.setIgnoreMouseEvents(false)
    } else {
      window.setIgnoreMouseEvents(true, { forward: true })
    }
  }

  isInteractive(): boolean {
    return this.interactive
  }

  isVisible(): boolean {
    return this.window !== null && !this.window.isDestroyed() && this.window.isVisible()
  }

  /**
   * `streamId` (streaming speech models only) makes the HUD send each chunk as
   * it is recorded, tagged with that id, as well as the whole clip at stop.
   */
  startCapture({ streamId }: { streamId?: number } = {}): void {
    // Dev/test only: with HIVE_VOICE_TEST_CLIPS set, the armed clip
    // replaces the microphone. Normally there is no test clip and the mic is used.
    const testClip = voiceTestClips.captureSource()
    const options: VoiceCaptureStartOptions = {
      ...(testClip === undefined ? {} : { testClip }),
      ...(streamId === undefined ? {} : { streamId })
    }
    // No options at all with an offline model and the mic: exactly as before streaming.
    this.send('voice:hud:capture-start', Object.keys(options).length > 0 ? options : undefined)
  }

  stopCapture(): void {
    voiceTestClips.captureEnded()
    this.send('voice:hud:capture-stop')
  }

  cancelCapture(): void {
    voiceTestClips.captureEnded()
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

  /**
   * Bottom-centre of the main window, clamped to that display's work area: the
   * pill sits HUD_BOTTOM_MARGIN above the main window's bottom edge and the
   * preview room extends upwards from it. Near a screen edge the whole window
   * (pill and preview) is pushed back onto the screen.
   */
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
