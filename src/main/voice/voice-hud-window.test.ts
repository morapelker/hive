import { beforeEach, describe, expect, it, vi } from 'vitest'

const send = vi.hoisted(() => vi.fn())

vi.mock('electron', () => {
  class FakeWindow {
    webContents = {
      send,
      on: vi.fn(),
      setWindowOpenHandler: vi.fn()
    }
    setVisibleOnAllWorkspaces = vi.fn()
    setAlwaysOnTop = vi.fn()
    setMenuBarVisibility = vi.fn()
    on = vi.fn()
    loadFile = vi.fn(async () => undefined)
    loadURL = vi.fn(async () => undefined)
    isDestroyed = (): boolean => false
  }
  return { BrowserWindow: FakeWindow, screen: {} }
})
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }))

const testClips = vi.hoisted(() => ({
  captureSource: vi.fn((): unknown => undefined),
  captureEnded: vi.fn()
}))
vi.mock('./voice-test-clips', () => ({ voiceTestClips: testClips }))

import { VoiceHudWindow } from './voice-hud-window'

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
