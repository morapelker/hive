import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import type { VoiceCaptureStartOptions, VoiceHudPhase, VoiceHudState } from '@shared/types/voice'

type StateListener = (state: VoiceHudState) => void

let stateListener: StateListener | null = null
let captureStartListener: ((options?: VoiceCaptureStartOptions) => void) | null = null
let captureStopListener: (() => void) | null = null
let captureCancelListener: (() => void) | null = null

const recorder = vi.hoisted(() => ({
  instance: null as null | {
    start: ReturnType<typeof vi.fn>
    cancel: ReturnType<typeof vi.fn>
    onTestClipEnded: (() => void) | null
    onChunk: ((samples: Float32Array, sampleRate: number) => void) | null
  }
}))
vi.mock('../audio-capture', () => ({
  VoiceRecorder: class {
    start = vi.fn(async () => undefined)
    // Like the real recorder: the flushed last chunk is handed over before stop resolves.
    stop = vi.fn(async () => {
      this.onChunk?.(new Float32Array([0.9]), 16000)
      return { samples: new Float32Array([0.9]), sampleRate: 16000 }
    })
    cancel = vi.fn()
    onLevel = null
    onInterrupted = null
    onTestClipEnded: (() => void) | null = null
    onChunk: ((samples: Float32Array, sampleRate: number) => void) | null = null
    constructor() {
      recorder.instance = this
    }
  }
}))

const voiceHud = {
  ready: vi.fn(),
  clickStop: vi.fn(),
  clickCancel: vi.fn(),
  clickSkip: vi.fn(),
  setInteractive: vi.fn(),
  captureStarted: vi.fn(),
  captureError: vi.fn(),
  submitAudio: vi.fn(async () => undefined),
  streamAudio: vi.fn(),
  getSounds: vi.fn(async () => ({ start: null, stop: null })),
  onState: vi.fn((cb: StateListener) => {
    stateListener = cb
    return () => {
      stateListener = null
    }
  }),
  onSound: vi.fn(() => () => {}),
  onCaptureStart: vi.fn((cb: (options?: VoiceCaptureStartOptions) => void) => {
    captureStartListener = cb
    return () => {
      captureStartListener = null
    }
  }),
  testClipEnded: vi.fn(),
  onCaptureStop: vi.fn((cb: () => void) => {
    captureStopListener = cb
    return () => {
      captureStopListener = null
    }
  }),
  onCaptureCancel: vi.fn((cb: () => void) => {
    captureCancelListener = cb
    return () => {
      captureCancelListener = null
    }
  })
}

function pushPhase(phase: VoiceHudPhase, transcript?: string): void {
  act(() => {
    stateListener?.({ phase, sounds: false, ...(transcript === undefined ? {} : { transcript }) })
  })
}

const RECORDING: VoiceHudPhase = { kind: 'recording' }
const TRANSCRIBING: VoiceHudPhase = {
  kind: 'transcribing',
  progress: null,
  showsProgress: false
}
const ENHANCING: VoiceHudPhase = { ...TRANSCRIBING, kind: 'enhancing' }

describe('VoiceHudApp', () => {
  const originalRaf = window.requestAnimationFrame
  const originalCancelRaf = window.cancelAnimationFrame

  beforeEach(() => {
    stateListener = null
    // The test setup's requestAnimationFrame runs callbacks synchronously, which
    // would turn the processing wave's self-scheduling loop into infinite recursion.
    window.requestAnimationFrame = vi.fn(() => 0)
    window.cancelAnimationFrame = vi.fn()
    // The bridge must exist before the component module is imported and mounted.
    Object.defineProperty(window, 'desktopBridge', {
      configurable: true,
      value: { voiceHud }
    })
  })

  afterEach(() => {
    Reflect.deleteProperty(window, 'desktopBridge')
    window.requestAnimationFrame = originalRaf
    window.cancelAnimationFrame = originalCancelRaf
    vi.clearAllMocks()
  })

  async function mount(): Promise<void> {
    const { VoiceHudApp } = await import('../VoiceHudApp')
    render(<VoiceHudApp />)
    expect(voiceHud.ready).toHaveBeenCalled()
    expect(stateListener).not.toBeNull()
  }

  it('renders nothing while hidden', async () => {
    await mount()
    expect(screen.queryByTestId('voice-hud-recording')).toBeNull()
    expect(screen.queryByTestId('voice-hud-processing')).toBeNull()
  })

  it('shows the level bars first on the recording pill', async () => {
    await mount()
    pushPhase({ kind: 'recording' })
    const pill = screen.getByTestId('voice-hud-recording')
    expect(pill.firstElementChild).toBe(screen.getByTestId('voice-hud-bars'))
    expect(pill).toHaveAttribute('title', 'Click to stop · Esc to cancel')
  })

  it('shows the usual titles while processing a dictation', async () => {
    await mount()
    pushPhase({ kind: 'transcribing', progress: null, showsProgress: false })
    expect(screen.getByTestId('voice-hud-processing')).toHaveAttribute('title', 'Transcribing…')

    pushPhase({ kind: 'enhancing', progress: null, showsProgress: false })
    expect(screen.getByTestId('voice-hud-processing')).toHaveAttribute(
      'title',
      'Polishing… Esc to skip'
    )
  })

  describe('skippable polishing (VOICE-08)', () => {
    const ENHANCING_PASTE: VoiceHudPhase = {
      kind: 'enhancing',
      progress: null,
      showsProgress: false
    }

    it('shows "Polishing…", an "Esc to skip" hint and a Skip button under the final text', async () => {
      await mount()
      pushPhase(ENHANCING_PASTE, 'Create a ticket for the login bug')
      const pill = screen.getByTestId('voice-hud-processing')
      expect(pill).toHaveTextContent('Polishing…')
      expect(pill).toHaveTextContent('Esc to skip')
      expect(screen.getByTestId('voice-hud-skip')).toHaveTextContent('Skip')
      expect(screen.getByTestId('voice-hud-preview-text')).toHaveTextContent(
        'Create a ticket for the login bug'
      )
    })

    it('names the hotkey on the Skip button when main says it skips', async () => {
      await mount()
      act(() => {
        stateListener?.({ phase: ENHANCING_PASTE, sounds: false, skipHotkey: '⌃Space' })
      })
      expect(screen.getByTestId('voice-hud-skip')).toHaveTextContent('Skip⌃Space')
      expect(screen.getByTestId('voice-hud-processing')).toHaveAttribute(
        'title',
        'Polishing… Esc or ⌃Space to skip'
      )

      // Not registered (or an invalid hotkey): the pill doesn't promise it.
      pushPhase(ENHANCING_PASTE)
      expect(screen.getByTestId('voice-hud-skip')).toHaveTextContent(/^Skip$/)
      expect(screen.queryByTestId('voice-hud-skip-hotkey')).toBeNull()
    })

    it('asks main to skip when Skip is clicked, without taking focus', async () => {
      await mount()
      pushPhase(ENHANCING_PASTE, 'Create a ticket')
      const skip = screen.getByTestId('voice-hud-skip')
      // A default-prevented mousedown keeps focus in the field being dictated into.
      expect(fireEvent.mouseDown(skip)).toBe(false)
      fireEvent.click(skip)
      expect(voiceHud.clickSkip).toHaveBeenCalledTimes(1)
      expect(voiceHud.clickStop).not.toHaveBeenCalled()
      expect(voiceHud.clickCancel).not.toHaveBeenCalled()
      expect(skip).toHaveAttribute('tabindex', '-1')
    })

    it('takes clicks over the Skip button (it is part of the visible pill)', async () => {
      await mount()
      pushPhase(ENHANCING_PASTE, 'Create a ticket')
      fireEvent.mouseMove(screen.getByTestId('voice-hud-skip'))
      expect(voiceHud.setInteractive).toHaveBeenLastCalledWith(true)
    })

    it('has no Skip while transcribing or recording', async () => {
      await mount()
      pushPhase({ kind: 'recording' }, 'create a')
      expect(screen.queryByTestId('voice-hud-skip')).toBeNull()
      pushPhase({ kind: 'transcribing', progress: null, showsProgress: false })
      expect(screen.queryByTestId('voice-hud-skip')).toBeNull()
    })
  })

  it('starts the microphone when capture starts without options', async () => {
    await mount()
    await act(async () => captureStartListener?.())
    expect(recorder.instance!.start).toHaveBeenCalledWith(undefined)
    expect(voiceHud.captureStarted).toHaveBeenCalled()
  })

  it('passes a test clip to the recorder and reports its end to main', async () => {
    await mount()
    const options = {
      testClip: { name: 'sentence', samples: new Float32Array(2), sampleRate: 16000 }
    }
    await act(async () => captureStartListener?.(options))
    expect(recorder.instance!.start).toHaveBeenCalledWith(options)
    recorder.instance!.onTestClipEnded?.()
    expect(voiceHud.testClipEnded).toHaveBeenCalledTimes(1)
  })

  it('streams each recorded chunk to main, numbered, when capture starts with a stream id', async () => {
    await mount()
    await act(async () => captureStartListener?.({ streamId: 41 }))
    expect(recorder.instance!.start).toHaveBeenCalledWith({ streamId: 41 })
    const a = new Float32Array([0.1, 0.2])
    const b = new Float32Array([0.3])
    recorder.instance!.onChunk?.(a, 16000)
    recorder.instance!.onChunk?.(b, 16000)
    expect(voiceHud.streamAudio.mock.calls).toEqual([
      [{ streamId: 41, seq: 0, samples: a, sampleRate: 16000 }],
      [{ streamId: 41, seq: 1, samples: b, sampleRate: 16000 }]
    ])

    // Stop: the flushed last chunk goes out before the whole clip.
    await act(async () => captureStopListener?.())
    await vi.waitFor(() => expect(voiceHud.submitAudio).toHaveBeenCalledTimes(1))
    expect(voiceHud.streamAudio).toHaveBeenCalledTimes(3)
    expect(voiceHud.streamAudio.mock.lastCall![0]).toMatchObject({ streamId: 41, seq: 2 })
    expect(voiceHud.streamAudio.mock.invocationCallOrder[2]).toBeLessThan(
      voiceHud.submitAudio.mock.invocationCallOrder[0]
    )
    expect(recorder.instance!.onChunk).toBeNull()

    // The next capture numbers from zero again under its own id.
    await act(async () => captureStartListener?.({ streamId: 42 }))
    recorder.instance!.onChunk?.(a, 16000)
    expect(voiceHud.streamAudio.mock.lastCall![0]).toMatchObject({ streamId: 42, seq: 0 })
  })

  it('stops streaming on cancel', async () => {
    await mount()
    await act(async () => captureStartListener?.({ streamId: 7 }))
    act(() => captureCancelListener?.())
    expect(recorder.instance!.cancel).toHaveBeenCalled()
    expect(recorder.instance!.onChunk).toBeNull()
  })

  it('sends no chunks without a stream id (offline speech model)', async () => {
    await mount()
    await act(async () => captureStartListener?.())
    expect(recorder.instance!.onChunk).toBeNull()
    await act(async () => captureStopListener?.())
    await vi.waitFor(() => expect(voiceHud.submitAudio).toHaveBeenCalledTimes(1))
    expect(voiceHud.streamAudio).not.toHaveBeenCalled()
  })

  it('keeps the level bars when the recording state is re-sent with a live transcript', async () => {
    await mount()
    pushPhase({ kind: 'recording' })
    await act(async () => captureStartListener?.({ streamId: 3 }))
    const levels = recorder.instance as unknown as { onLevel: ((level: number) => void) | null }
    act(() => levels.onLevel?.(1))
    const lastBar = (): HTMLElement =>
      screen.getByTestId('voice-hud-bars').lastElementChild as HTMLElement
    expect(lastBar().style.height).toBe('23px')

    act(() => {
      stateListener?.({
        phase: { kind: 'recording' },
        sounds: false,
        transcript: 'create a ticket'
      })
    })
    expect(lastBar().style.height).toBe('23px')

    // A new recording starts with empty bars.
    pushPhase({ kind: 'hidden' })
    pushPhase({ kind: 'recording' })
    expect(lastBar().style.height).toBe('3px')
  })
  describe('live transcript preview', () => {
    const previewText = (): HTMLElement | null => screen.queryByTestId('voice-hud-preview-text')

    it('shows nothing above the pill until the first words arrive', async () => {
      await mount()
      pushPhase(RECORDING)
      expect(screen.getByTestId('voice-hud-recording')).toBeInTheDocument()
      expect(screen.queryByTestId('voice-hud-preview')).toBeNull()
    })

    it('shows the text so far directly above the pill and grows with each update', async () => {
      await mount()
      pushPhase(RECORDING, 'create a')
      expect(previewText()).toHaveTextContent('create a')
      const preview = screen.getByTestId('voice-hud-preview')
      const pill = screen.getByTestId('voice-hud-recording')
      // Stacked: the preview comes first, the pill's strip right under it.
      expect(preview.nextElementSibling).toBe(pill.parentElement)
      expect(pill.parentElement).toHaveClass('voice-pill-slot')

      pushPhase(RECORDING, 'create a ticket for the login bug')
      expect(previewText()).toHaveTextContent('create a ticket for the login bug')
      expect(screen.getAllByTestId('voice-hud-preview')).toHaveLength(1)
    })

    it('keeps the text through transcribing and the AI step, then goes with the pill', async () => {
      await mount()
      pushPhase(RECORDING, 'create a tick')
      pushPhase(TRANSCRIBING, 'create a tick')
      expect(previewText()).toHaveTextContent('create a tick')
      pushPhase(ENHANCING, 'Create a ticket.')
      expect(previewText()).toHaveTextContent('Create a ticket.')
      expect(screen.getByTestId('voice-hud-processing')).toBeInTheDocument()

      pushPhase({ kind: 'hidden' })
      expect(screen.queryByTestId('voice-hud-preview')).toBeNull()
      // The next dictation starts without the old text.
      pushPhase(RECORDING)
      expect(screen.queryByTestId('voice-hud-preview')).toBeNull()
    })

    it('offline models: no panel while transcribing, the final text during the AI step', async () => {
      await mount()
      pushPhase(RECORDING)
      pushPhase(TRANSCRIBING)
      expect(screen.queryByTestId('voice-hud-preview')).toBeNull()
      pushPhase(ENHANCING, 'create a ticket')
      expect(previewText()).toHaveTextContent('create a ticket')
    })

    it('never shows with a notice', async () => {
      await mount()
      pushPhase(RECORDING, 'create a')
      pushPhase({ kind: 'notice', text: 'Nothing heard' }, 'create a')
      expect(screen.queryByTestId('voice-hud-preview')).toBeNull()
      expect(screen.getByTestId('voice-hud-notice')).toBeInTheDocument()
    })

    it('fades older lines only once the text is taller than the four lines that fit', async () => {
      await mount()
      const heights = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get')
      const clientHeights = vi.spyOn(Element.prototype, 'clientHeight', 'get')
      clientHeights.mockReturnValue(72)
      try {
        heights.mockReturnValue(36)
        pushPhase(RECORDING, 'two lines of text')
        expect(screen.getByTestId('voice-hud-preview')).not.toHaveClass('voice-preview--overflow')

        heights.mockReturnValue(126)
        pushPhase(RECORDING, 'seven lines of text '.repeat(20))
        expect(screen.getByTestId('voice-hud-preview')).toHaveClass('voice-preview--overflow')
        // The whole transcript stays in the panel; only the view is clipped.
        expect(previewText()!.textContent).toBe('seven lines of text '.repeat(20))
      } finally {
        heights.mockRestore()
        clientHeights.mockRestore()
      }
    })

    it('never takes focus when clicked', async () => {
      await mount()
      pushPhase(RECORDING, 'create a')
      const notPrevented = fireEvent.mouseDown(screen.getByTestId('voice-hud-preview-text'))
      expect(notPrevented).toBe(false)
    })
  })

  describe('click-through', () => {
    it('takes clicks only while the cursor is over the pill or the preview', async () => {
      await mount()
      pushPhase(RECORDING, 'create a')
      const root = document.querySelector('.voice-hud-root')!

      fireEvent.mouseMove(root)
      expect(voiceHud.setInteractive).not.toHaveBeenCalled()

      fireEvent.mouseMove(screen.getByTestId('voice-hud-bars'))
      expect(voiceHud.setInteractive.mock.calls).toEqual([[true]])
      // Moving within the visible parts reports nothing new.
      fireEvent.mouseMove(screen.getByTestId('voice-hud-preview-text'))
      expect(voiceHud.setInteractive).toHaveBeenCalledTimes(1)

      // The transparent space beside or above the pill lets clicks through again.
      fireEvent.mouseMove(document.querySelector('.voice-pill-slot')!)
      expect(voiceHud.setInteractive.mock.calls).toEqual([[true], [false]])

      fireEvent.mouseMove(screen.getByTestId('voice-hud-recording'))
      fireEvent.mouseLeave(document.documentElement)
      expect(voiceHud.setInteractive.mock.calls).toEqual([[true], [false], [true], [false]])
    })

    it('covers the processing pill and notices too', async () => {
      await mount()
      pushPhase(ENHANCING, 'done')
      fireEvent.mouseMove(screen.getByTestId('voice-hud-processing'))
      expect(voiceHud.setInteractive).toHaveBeenLastCalledWith(true)
      pushPhase({ kind: 'notice', text: 'Copied to clipboard' })
      fireEvent.mouseMove(document.querySelector('.voice-hud-root')!)
      fireEvent.mouseMove(screen.getByTestId('voice-hud-notice'))
      expect(voiceHud.setInteractive.mock.calls).toEqual([[true], [false], [true]])
    })

    it('starts over when the pill hides (main lets clicks through on hide)', async () => {
      await mount()
      pushPhase(RECORDING)
      fireEvent.mouseMove(screen.getByTestId('voice-hud-recording'))
      pushPhase({ kind: 'hidden' })
      // Nothing to report while hidden.
      fireEvent.mouseMove(document.body)
      expect(voiceHud.setInteractive.mock.calls).toEqual([[true]])

      pushPhase(RECORDING)
      fireEvent.mouseMove(screen.getByTestId('voice-hud-recording'))
      expect(voiceHud.setInteractive.mock.calls).toEqual([[true], [true]])
    })
  })
})
