import { beforeEach, describe, expect, it, vi } from 'vitest'

const send = vi.hoisted(() => vi.fn())
const created = vi.hoisted(() => ({ windows: [] as unknown[] }))
const display = vi.hoisted(() => ({
  workArea: { x: 0, y: 25, width: 1512, height: 920 }
}))

vi.mock('electron', () => {
  class FakeWindow {
    visible = false
    webContents = {
      send,
      on: vi.fn(),
      setWindowOpenHandler: vi.fn()
    }
    setVisibleOnAllWorkspaces = vi.fn()
    setAlwaysOnTop = vi.fn()
    setMenuBarVisibility = vi.fn()
    setIgnoreMouseEvents = vi.fn()
    setBounds = vi.fn()
    showInactive = vi.fn(() => {
      this.visible = true
    })
    hide = vi.fn(() => {
      this.visible = false
    })
    isVisible = (): boolean => this.visible
    on = vi.fn()
    loadFile = vi.fn(async () => undefined)
    loadURL = vi.fn(async () => undefined)
    isDestroyed = (): boolean => false
    constructor(readonly options: Record<string, unknown>) {
      created.windows.push(this)
    }
  }
  return {
    BrowserWindow: FakeWindow,
    screen: {
      getDisplayMatching: () => display,
      getPrimaryDisplay: () => display
    }
  }
})
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }))

const testClips = vi.hoisted(() => ({
  captureSource: vi.fn((): unknown => undefined),
  captureEnded: vi.fn()
}))
vi.mock('./voice-test-clips', () => ({ voiceTestClips: testClips }))

import {
  HUD_BOTTOM_MARGIN,
  HUD_HEIGHT,
  HUD_PILL_HEIGHT,
  HUD_WIDTH,
  VoiceHudWindow
} from './voice-hud-window'

interface FakeWindow {
  options: Record<string, unknown>
  setIgnoreMouseEvents: ReturnType<typeof vi.fn>
  setBounds: ReturnType<typeof vi.fn>
  showInactive: ReturnType<typeof vi.fn>
}

function lastWindow(): FakeWindow {
  return created.windows.at(-1) as FakeWindow
}

function mainWindowAt(bounds: { x: number; y: number; width: number; height: number }) {
  return (): import('electron').BrowserWindow =>
    ({
      isDestroyed: () => false,
      getBounds: () => bounds,
      on: vi.fn()
    }) as unknown as import('electron').BrowserWindow
}

describe('VoiceHudWindow capture', () => {
  let hud: VoiceHudWindow

  beforeEach(() => {
    vi.clearAllMocks()
    hud = new VoiceHudWindow()
    hud.ensureCreated()
  })

  it('starts the microphone with no options when test clips are off', () => {
    hud.startCapture()
    expect(send).toHaveBeenCalledWith('voice:hud:capture-start', undefined)
  })

  it('hands the armed test clip to the HUD instead of the microphone', () => {
    const clip = { name: 'sentence', samples: new Float32Array(4), sampleRate: 16000 }
    testClips.captureSource.mockReturnValueOnce(clip)
    hud.startCapture()
    expect(send).toHaveBeenCalledWith('voice:hud:capture-start', { testClip: clip })
  })

  it('tells the HUD there is no clip when test clips are on but none is selected', () => {
    testClips.captureSource.mockReturnValueOnce(null)
    hud.startCapture()
    expect(send).toHaveBeenCalledWith('voice:hud:capture-start', { testClip: null })
  })

  it('asks the HUD to stream chunks with the given id (streaming models), mic or test clip', () => {
    hud.startCapture({ streamId: 12 })
    expect(send).toHaveBeenLastCalledWith('voice:hud:capture-start', { streamId: 12 })

    const clip = { name: 'sentence', samples: new Float32Array(4), sampleRate: 16000 }
    testClips.captureSource.mockReturnValueOnce(clip)
    hud.startCapture({ streamId: 13 })
    expect(send).toHaveBeenLastCalledWith('voice:hud:capture-start', {
      testClip: clip,
      streamId: 13
    })
  })

  it('sends no options for an offline model with the microphone, as before streaming', () => {
    hud.startCapture({})
    expect(send).toHaveBeenCalledWith('voice:hud:capture-start', undefined)
  })

  it('ends test-clip playback bookkeeping on stop and cancel', () => {
    hud.stopCapture()
    hud.cancelCapture()
    expect(testClips.captureEnded).toHaveBeenCalledTimes(2)
    expect(send).toHaveBeenCalledWith('voice:hud:capture-stop', undefined)
    expect(send).toHaveBeenCalledWith('voice:hud:capture-cancel', undefined)
  })
})

describe('VoiceHudWindow preview room and click-through', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('is tall enough for the preview above the pill, and never focusable', () => {
    new VoiceHudWindow({ platform: 'darwin' }).ensureCreated()
    expect(lastWindow().options).toMatchObject({
      width: HUD_WIDTH,
      height: HUD_HEIGHT,
      transparent: true,
      focusable: false
    })
    // Four 18px lines plus padding, gap and shadow fit above the 72px pill strip.
    expect(HUD_HEIGHT - HUD_PILL_HEIGHT).toBeGreaterThanOrEqual(4 * 18 + 16 + 8)
  })

  it('lets clicks through its transparent parts from the start (mouse moves still forwarded)', () => {
    new VoiceHudWindow({ platform: 'darwin' }).ensureCreated()
    expect(lastWindow().setIgnoreMouseEvents).toHaveBeenCalledWith(true, { forward: true })
  })

  it('takes clicks only while the cursor is over the pill or the preview', () => {
    const hud = new VoiceHudWindow({ platform: 'darwin' })
    hud.ensureCreated()
    hud.show()
    const window = lastWindow()
    window.setIgnoreMouseEvents.mockClear()

    hud.setInteractive(true)
    expect(window.setIgnoreMouseEvents).toHaveBeenLastCalledWith(false)
    expect(hud.isInteractive()).toBe(true)
    // Repeated reports change nothing.
    hud.setInteractive(true)
    expect(window.setIgnoreMouseEvents).toHaveBeenCalledTimes(1)

    hud.setInteractive(false)
    expect(window.setIgnoreMouseEvents).toHaveBeenLastCalledWith(true, { forward: true })
    expect(hud.isInteractive()).toBe(false)
  })

  it('goes back to letting clicks through when hidden, and ignores a late report after that', () => {
    const hud = new VoiceHudWindow({ platform: 'darwin' })
    hud.ensureCreated()
    hud.show()
    hud.setInteractive(true)
    const window = lastWindow()

    hud.setState({ phase: { kind: 'hidden' }, sounds: true })
    expect(window.setIgnoreMouseEvents).toHaveBeenLastCalledWith(true, { forward: true })
    expect(hud.isInteractive()).toBe(false)

    window.setIgnoreMouseEvents.mockClear()
    hud.setInteractive(true)
    expect(window.setIgnoreMouseEvents).not.toHaveBeenCalled()
    expect(hud.isInteractive()).toBe(false)
  })

  it('shows without taking focus, letting clicks through until the cursor reaches it', () => {
    const hud = new VoiceHudWindow({ platform: 'win32' })
    hud.ensureCreated()
    const window = lastWindow()
    window.setIgnoreMouseEvents.mockClear()
    hud.show()
    expect(window.showInactive).toHaveBeenCalledTimes(1)
    expect(window.setIgnoreMouseEvents).toHaveBeenCalledWith(true, { forward: true })
  })

  it('keeps the whole window clickable where mouse moves cannot be forwarded (Linux)', () => {
    const hud = new VoiceHudWindow({ platform: 'linux' })
    hud.ensureCreated()
    hud.show()
    hud.setInteractive(true)
    hud.setInteractive(false)
    expect(lastWindow().setIgnoreMouseEvents).not.toHaveBeenCalled()
  })

  it('keeps the pill 80px above the main window bottom, with the preview room above it', () => {
    const hud = new VoiceHudWindow({ platform: 'darwin' })
    hud.configure({ getMainWindow: mainWindowAt({ x: 100, y: 100, width: 1000, height: 700 }) })
    hud.ensureCreated()
    hud.show()
    const bounds = lastWindow().setBounds.mock.lastCall![0]
    expect(bounds).toEqual({
      x: 100 + 500 - HUD_WIDTH / 2,
      y: 800 - HUD_BOTTOM_MARGIN - HUD_HEIGHT,
      width: HUD_WIDTH,
      height: HUD_HEIGHT
    })
  })

  it('stays on screen, preview included, when the main window is near a screen edge', () => {
    const hud = new VoiceHudWindow({ platform: 'darwin' })
    // Main window mostly off the left and top edges, and short.
    hud.configure({ getMainWindow: mainWindowAt({ x: -800, y: 0, width: 900, height: 150 }) })
    hud.ensureCreated()
    hud.show()
    const bounds = lastWindow().setBounds.mock.lastCall![0]
    const area = display.workArea
    expect(bounds.x).toBe(area.x)
    expect(bounds.y).toBe(area.y)

    // And off the bottom-right corner.
    hud.configure({
      getMainWindow: mainWindowAt({ x: 1400, y: 900, width: 900, height: 600 })
    })
    hud.reposition()
    const corner = lastWindow().setBounds.mock.lastCall![0]
    expect(corner.x + corner.width).toBe(area.x + area.width)
    expect(corner.y + corner.height).toBe(area.y + area.height)
  })
})
