import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcMain } from 'electron'

const controller = vi.hoisted(() => ({
  init: vi.fn(),
  dispose: vi.fn(),
  getStatus: vi.fn(() => ({ state: 'idle' })),
  isRecording: vi.fn(() => false),
  toggle: vi.fn(async () => undefined),
  onAudioChunk: vi.fn(),
  skipPolishing: vi.fn()
}))
vi.mock('./voice-controller', () => ({ voiceController: controller }))
const hudContents = { id: 2 }
const hud = vi.hoisted(() => ({ setInteractive: vi.fn() }))
vi.mock('./voice-hud-window', () => ({
  voiceHud: {
    isHudContents: vi.fn((sender: unknown) => sender === hudContents),
    setInteractive: hud.setInteractive
  }
}))
vi.mock('./voice-sounds', () => ({ loadVoiceSoundBuffers: vi.fn(async () => null) }))

const testClips = vi.hoisted(() => ({
  enabled: false,
  setStopHandler: vi.fn(),
  status: vi.fn(() => ({ enabled: true, selected: 'sentence' })),
  list: vi.fn(async () => [{ name: 'sentence' }]),
  select: vi.fn(async () => ({ enabled: true, selected: 'sentence' })),
  clipEnded: vi.fn()
}))
vi.mock('./voice-test-clips', () => ({ voiceTestClips: testClips }))

import { initVoiceDictation, registerVoiceTestClipIpc } from './voice-ipc'

type OnHandler = (event: { sender: unknown }, raw: unknown) => void

const mainContents = { id: 1 }
const mainWindow = {
  isDestroyed: () => false,
  webContents: mainContents
} as unknown as import('electron').BrowserWindow

describe('voice:hud:audio-chunk', () => {
  function chunkHandler(): OnHandler {
    const entry = vi
      .mocked(ipcMain.on)
      .mock.calls.find(([channel]) => channel === 'voice:hud:audio-chunk')
    expect(entry).toBeDefined()
    return entry![1] as OnHandler
  }

  beforeEach(() => {
    controller.onAudioChunk.mockClear()
    initVoiceDictation({ db: { getSetting: () => null } as never, getMainWindow: () => mainWindow })
  })

  const chunk = { streamId: 4, seq: 2, samples: new Float32Array(1536), sampleRate: 16000 }

  it('hands chunks from the HUD to the controller', () => {
    chunkHandler()({ sender: hudContents }, chunk)
    expect(controller.onAudioChunk).toHaveBeenCalledWith(chunk)
  })

  it('ignores chunks from any other sender, and malformed ones', () => {
    chunkHandler()({ sender: mainContents }, chunk)
    chunkHandler()({ sender: hudContents }, { ...chunk, samples: [0.1] })
    chunkHandler()({ sender: hudContents }, null)
    expect(controller.onAudioChunk).not.toHaveBeenCalled()
  })
})

describe('voice:hud:interactive', () => {
  function interactiveHandler(): OnHandler {
    const entry = vi
      .mocked(ipcMain.on)
      .mock.calls.find(([channel]) => channel === 'voice:hud:interactive')
    expect(entry).toBeDefined()
    return entry![1] as OnHandler
  }

  beforeEach(() => {
    hud.setInteractive.mockClear()
    initVoiceDictation({ db: {} as never, getMainWindow: () => mainWindow })
  })

  it('lets the HUD say whether the cursor is over its visible parts', () => {
    interactiveHandler()({ sender: hudContents }, true)
    interactiveHandler()({ sender: hudContents }, false)
    expect(hud.setInteractive.mock.calls).toEqual([[true], [false]])
  })

  it('treats anything but true as "let clicks through", and ignores other senders', () => {
    interactiveHandler()({ sender: hudContents }, 'yes')
    interactiveHandler()({ sender: mainContents }, true)
    expect(hud.setInteractive.mock.calls).toEqual([[false]])
  })
})

describe('voice:hud:click-skip', () => {
  function skipHandler(): OnHandler {
    const entry = vi
      .mocked(ipcMain.on)
      .mock.calls.find(([channel]) => channel === 'voice:hud:click-skip')
    expect(entry).toBeDefined()
    return entry![1] as OnHandler
  }

  beforeEach(() => {
    controller.skipPolishing.mockClear()
    initVoiceDictation({ db: {} as never, getMainWindow: () => mainWindow })
  })

  it('skips polishing when the HUD Skip button is clicked', () => {
    skipHandler()({ sender: hudContents }, undefined)
    expect(controller.skipPolishing).toHaveBeenCalledWith('click')
  })

  it('ignores other senders', () => {
    skipHandler()({ sender: mainContents }, undefined)
    expect(controller.skipPolishing).not.toHaveBeenCalled()
  })
})

describe('voice test clips IPC (dev/test only)', () => {
  type InvokeHandler = (event: { sender: unknown }, ...args: unknown[]) => unknown
  const hudContents = { id: 2 }

  function handler(channel: string): InvokeHandler {
    const entry = vi.mocked(ipcMain.handle).mock.calls.findLast(([c]) => c === channel)
    expect(entry).toBeDefined()
    return entry![1] as InvokeHandler
  }

  function register(): void {
    registerVoiceTestClipIpc({
      isMainWindow: (event) => event.sender === mainContents,
      isHud: (event) => event.sender === hudContents
    })
  }

  beforeEach(() => {
    vi.clearAllMocks()
    controller.getStatus.mockReturnValue({ state: 'idle' })
    controller.isRecording.mockReturnValue(false)
  })

  it('is not registered when the switch is off', async () => {
    // A fresh module instance: handlers are registered once per process.
    vi.resetModules()
    const fresh = await import('./voice-ipc')
    fresh.initVoiceDictation({
      db: { getSetting: () => null } as never,
      getMainWindow: () => mainWindow
    })
    expect(vi.mocked(ipcMain.handle).mock.calls.map(([channel]) => channel)).toContain(
      'voice:toggle'
    )
    const channels = vi.mocked(ipcMain.handle).mock.calls.map(([channel]) => channel)
    expect(channels.some((channel) => channel.startsWith('voice:test:'))).toBe(false)
    const events = vi.mocked(ipcMain.on).mock.calls.map(([channel]) => channel)
    expect(events).not.toContain('voice:hud:test-clip-ended')
  })

  it('only answers the main window', async () => {
    register()
    const channels = [
      'voice:test:status',
      'voice:test:list',
      'voice:test:select',
      'voice:test:start',
      'voice:test:stop'
    ]
    for (const channel of channels) {
      await expect(
        (async () => handler(channel)({ sender: { id: 99 } }, { clip: 'sentence' }))()
      ).rejects.toThrow('only the main window')
    }
    expect(testClips.select).not.toHaveBeenCalled()
    expect(controller.toggle).not.toHaveBeenCalled()
  })

  it('selects the clip, then starts through the hotkey toggle', async () => {
    register()
    await expect(
      handler('voice:test:start')(
        { sender: mainContents },
        { clip: 'sentence', autoStopAfterMs: 800 }
      )
    ).resolves.toEqual({ enabled: true, selected: 'sentence' })
    expect(testClips.select).toHaveBeenCalledWith('sentence', { autoStopAfterMs: 800 })
    expect(controller.toggle).toHaveBeenCalledTimes(1)
    expect(testClips.select.mock.invocationCallOrder[0]).toBeLessThan(
      controller.toggle.mock.invocationCallOrder[0]
    )
  })

  it('refuses to start while a dictation is in flight', async () => {
    register()
    controller.getStatus.mockReturnValue({ state: 'recording' })
    await expect(
      handler('voice:test:start')({ sender: mainContents }, { clip: 'sentence' })
    ).rejects.toThrow('not idle')
    expect(controller.toggle).not.toHaveBeenCalled()
  })

  it('stops through the hotkey toggle only while recording', async () => {
    register()
    await handler('voice:test:stop')({ sender: mainContents })
    expect(controller.toggle).not.toHaveBeenCalled()
    controller.isRecording.mockReturnValue(true)
    await handler('voice:test:stop')({ sender: mainContents })
    expect(controller.toggle).toHaveBeenCalledTimes(1)
  })

  it('wires the auto-stop to the toggle and the HUD clip-ended report to the clips', () => {
    register()
    const stop = testClips.setStopHandler.mock.calls[0][0] as () => void
    stop()
    expect(controller.toggle).not.toHaveBeenCalled()
    controller.isRecording.mockReturnValue(true)
    stop()
    expect(controller.toggle).toHaveBeenCalledTimes(1)

    const ended = vi
      .mocked(ipcMain.on)
      .mock.calls.findLast(([channel]) => channel === 'voice:hud:test-clip-ended')![1] as (event: {
      sender: unknown
    }) => void
    ended({ sender: mainContents })
    expect(testClips.clipEnded).not.toHaveBeenCalled()
    ended({ sender: hudContents })
    expect(testClips.clipEnded).toHaveBeenCalledTimes(1)
  })
})
