import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { VoiceHudPhase, VoiceHudState } from '@shared/types/voice'
import { VoiceRecorder } from './audio-capture'
import { VoiceSoundPlayer } from './sounds'

/** Wispelker's widget: 16 bars, 3pt wide, 2.5pt gap, 3…23pt tall while recording. */
const BAR_COUNT = 16
const BAR_MAX_HEIGHT = 20
const EMPTY_LEVELS = Array.from({ length: BAR_COUNT }, () => 0)

function RecordingBars({ levels }: { levels: number[] }): React.JSX.Element {
  return (
    <div className="voice-bars" data-testid="voice-hud-bars">
      {levels.map((level, index) => (
        <div
          key={index}
          className="voice-bar"
          style={{ height: `${3 + level * BAR_MAX_HEIGHT}px` }}
        />
      ))}
    </div>
  )
}

/** Sine wave at ≤30 fps: height = 4 + ((sin(4t + 0.55i) + 1) / 2) · 12, travelling right to left. */
function ProcessingWave(): React.JSX.Element {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    let frame = 0
    let last = 0
    const loop = (now: number): void => {
      if (now - last >= 1000 / 30) {
        last = now
        setTick(now / 1000)
      }
      frame = requestAnimationFrame(loop)
    }
    frame = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(frame)
  }, [])
  return (
    <div className="voice-bars" data-testid="voice-hud-wave">
      {Array.from({ length: BAR_COUNT }, (_, index) => {
        const wave = (Math.sin(tick * 4 + index * 0.55) + 1) / 2
        return (
          <div
            key={index}
            className="voice-bar voice-bar--processing"
            style={{ height: `${4 + wave * BAR_MAX_HEIGHT * 0.6}px` }}
          />
        )
      })}
    </div>
  )
}

/** Elapsed time appears on the pill once a recording runs longer than this. */
const TIMER_AFTER_SECONDS = 30

function formatElapsed(seconds: number): string {
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return `${minutes}:${rest.toString().padStart(2, '0')}`
}

function RecordingTimer({ since }: { since: number }): React.JSX.Element | null {
  const [seconds, setSeconds] = useState(0)
  useEffect(() => {
    const update = (): void => setSeconds(Math.floor((Date.now() - since) / 1000))
    update()
    const timer = setInterval(update, 1000)
    return () => clearInterval(timer)
  }, [since])
  if (seconds < TIMER_AFTER_SECONDS) return null
  return <span className="voice-text voice-timer">{formatElapsed(seconds)}</span>
}

/** Marks the visible parts of the HUD: only over these does the window take clicks. */
const HIT_ATTRIBUTE = 'data-hud-hit'
const hit = { [HIT_ATTRIBUTE]: '' }

/**
 * The live transcript above the pill (VOICE-07): the text so far while a
 * streaming model records, then the final transcript until the pill goes away.
 * At most ~4 lines show; the newest text stays at the bottom and older lines
 * give way at the top, fading once there is more than fits.
 */
function TranscriptPreview({ text }: { text: string }): React.JSX.Element {
  const boxRef = useRef<HTMLDivElement | null>(null)
  const textRef = useRef<HTMLParagraphElement | null>(null)
  const [overflowing, setOverflowing] = useState(false)
  useLayoutEffect(() => {
    const box = boxRef.current
    const content = textRef.current
    if (!box || !content) return
    // The box is bottom-aligned, so text it can't fit is cut off at the top
    // (and isn't counted in its scrollHeight): compare the text's own height.
    setOverflowing(content.offsetHeight > box.clientHeight + 1)
  }, [text])
  return (
    <div
      className={`voice-preview${overflowing ? ' voice-preview--overflow' : ''}`}
      data-testid="voice-hud-preview"
      onMouseDown={(event) => event.preventDefault()}
      {...hit}
    >
      <div className="voice-preview-box" ref={boxRef}>
        <p className="voice-preview-text" ref={textRef} data-testid="voice-hud-preview-text">
          {text}
        </p>
      </div>
    </div>
  )
}

/**
 * Tell main whether the cursor is over a visible part of the HUD. The window
 * ignores the mouse elsewhere (its transparent parts let clicks through to the
 * app underneath) but still gets mouse moves, so this sees the cursor arrive.
 */
function useClickThrough(visible: boolean): void {
  const interactiveRef = useRef(false)
  useEffect(() => {
    const bridge = window.desktopBridge?.voiceHud
    if (!bridge?.setInteractive || !visible) return
    const report = (target: EventTarget | null): void => {
      const over = target instanceof Element && target.closest(`[${HIT_ATTRIBUTE}]`) !== null
      if (over === interactiveRef.current) return
      interactiveRef.current = over
      bridge.setInteractive(over)
    }
    const onMove = (event: MouseEvent): void => report(event.target)
    const onLeave = (): void => report(null)
    const root = document.documentElement
    document.addEventListener('mousemove', onMove)
    root.addEventListener('mouseleave', onLeave)
    return () => {
      document.removeEventListener('mousemove', onMove)
      root.removeEventListener('mouseleave', onLeave)
      // Main lets clicks through again whenever it hides the pill.
      interactiveRef.current = false
    }
  }, [visible])
}

export function VoiceHudApp(): React.JSX.Element | null {
  const [phase, setPhase] = useState<VoiceHudPhase>({ kind: 'hidden' })
  const [transcript, setTranscript] = useState('')
  const [levels, setLevels] = useState<number[]>(EMPTY_LEVELS)
  const [recordingSince, setRecordingSince] = useState(0)
  const recorderRef = useRef<VoiceRecorder | null>(null)
  const soundsRef = useRef<VoiceSoundPlayer | null>(null)
  const soundsEnabledRef = useRef(true)
  const phaseKindRef = useRef<VoiceHudPhase['kind']>('hidden')

  const getRecorder = useCallback((): VoiceRecorder => {
    if (!recorderRef.current) {
      const recorder = new VoiceRecorder()
      recorder.onLevel = (level) => {
        setLevels((current) => [...current.slice(1), level])
      }
      recorder.onInterrupted = () => {
        // Input device gone for good: hand over what we have, like Wispelker.
        window.desktopBridge?.voiceHud?.clickStop()
      }
      recorder.onTestClipEnded = () => {
        window.desktopBridge?.voiceHud?.testClipEnded()
      }
      recorderRef.current = recorder
    }
    return recorderRef.current
  }, [])

  useEffect(() => {
    const bridge = window.desktopBridge?.voiceHud
    if (!bridge) return

    const sounds = new VoiceSoundPlayer()
    soundsRef.current = sounds
    void sounds.load()

    const unsubscribers = [
      bridge.onState((state: VoiceHudState) => {
        soundsEnabledRef.current = state.sounds
        // The state is re-sent while recording (each live transcript update),
        // so only a new recording resets the bars.
        const startsRecording =
          state.phase.kind === 'recording' && phaseKindRef.current !== 'recording'
        phaseKindRef.current = state.phase.kind
        setPhase((previous) => {
          if (state.phase.kind === 'recording' && previous.kind !== 'recording') {
            setRecordingSince(Date.now())
          }
          return state.phase
        })
        if (startsRecording) setLevels(EMPTY_LEVELS)
        setTranscript(state.transcript ?? '')
      }),
      bridge.onSound((name) => {
        if (!soundsEnabledRef.current) return
        soundsRef.current?.play(name)
      }),
      bridge.onCaptureStart((options) => {
        const recorder = getRecorder()
        setLevels(EMPTY_LEVELS)
        // Streaming speech model: hand each chunk to main as it is recorded,
        // numbered so main can tell a gap or a repeat. Otherwise only at stop.
        const streamId = options?.streamId
        if (typeof streamId === 'number') {
          let seq = 0
          recorder.onChunk = (samples, sampleRate) => {
            bridge.streamAudio({ streamId, seq: seq++, samples, sampleRate })
          }
        } else {
          recorder.onChunk = null
        }
        recorder
          .start(options)
          .then(() => bridge.captureStarted())
          .catch((error: unknown) => {
            const message =
              error instanceof Error ? `${error.name}: ${error.message}` : String(error)
            bridge.captureError(message)
          })
      }),
      bridge.onCaptureStop(() => {
        const recorder = getRecorder()
        const streaming = recorder.onChunk
        const startedAt = performance.now()
        recorder
          .stop()
          .then((audio) => {
            // The flushed last chunk went out before stop() resolved, so main
            // has every streamed chunk before the clip below.
            if (recorder.onChunk === streaming) recorder.onChunk = null
            return bridge.submitAudio({
              samples: audio.samples,
              sampleRate: audio.sampleRate,
              durationMs: Math.round(performance.now() - startedAt)
            })
          })
          .catch((error: unknown) => {
            bridge.captureError(error instanceof Error ? error.message : String(error))
          })
      }),
      bridge.onCaptureCancel(() => {
        const recorder = recorderRef.current
        if (!recorder) return
        recorder.cancel()
        recorder.onChunk = null
      })
    ]

    bridge.ready()
    return () => {
      for (const off of unsubscribers) off()
      recorderRef.current?.cancel()
    }
  }, [getRecorder])

  useClickThrough(phase.kind !== 'hidden')

  // Never let a click steal focus from the text field being dictated into.
  const preventFocus = (event: React.MouseEvent): void => {
    event.preventDefault()
  }

  if (phase.kind === 'hidden') return null

  const bridge = window.desktopBridge?.voiceHud

  // Nothing above the pill until the first words; never with a notice.
  const preview =
    phase.kind !== 'notice' && transcript ? <TranscriptPreview text={transcript} /> : null
  const layout = (pill: React.JSX.Element): React.JSX.Element => (
    <div className="voice-hud-root">
      {preview}
      <div className="voice-pill-slot">{pill}</div>
    </div>
  )

  if (phase.kind === 'recording') {
    return layout(
      <div
        className="voice-pill voice-pill--clickable"
        title="Click to stop · Esc to cancel"
        onMouseDown={preventFocus}
        onClick={() => bridge?.clickStop()}
        data-testid="voice-hud-recording"
        {...hit}
      >
        <RecordingBars levels={levels} />
        <RecordingTimer since={recordingSince} />
      </div>
    )
  }

  if (phase.kind === 'enhancing') {
    // Polishing (VOICE-08): the final text is shown above; Skip, Escape or the
    // hotkey paste exactly that text now instead of waiting for the AI.
    return layout(
      <div
        className="voice-pill"
        title="Polishing… Esc or the hotkey to skip"
        onMouseDown={preventFocus}
        data-testid="voice-hud-processing"
        {...hit}
      >
        <ProcessingWave />
        <span className="voice-text" data-testid="voice-hud-polishing">
          Polishing…
        </span>
        <span className="voice-text voice-hint">Esc to skip</span>
        <button
          type="button"
          className="voice-skip"
          tabIndex={-1}
          title="Paste the text as shown"
          onMouseDown={preventFocus}
          onClick={() => bridge?.clickSkip()}
          data-testid="voice-hud-skip"
        >
          Skip
        </button>
      </div>
    )
  }

  if (phase.kind === 'transcribing' || phase.kind === 'enhancing') {
    const showPercent = phase.showsProgress && phase.progress !== null
    return layout(
      <div
        className="voice-pill"
        title={phase.kind === 'enhancing' ? 'Polishing…' : 'Transcribing…'}
        onMouseDown={preventFocus}
        data-testid="voice-hud-processing"
        {...hit}
      >
        <ProcessingWave />
        {showPercent && (
          <span className="voice-text voice-percent">
            {Math.round((phase.progress ?? 0) * 100)}%
          </span>
        )}
      </div>
    )
  }

  return layout(
    <div
      className="voice-pill voice-pill--clickable"
      onMouseDown={preventFocus}
      onClick={() => bridge?.clickCancel()}
      data-testid="voice-hud-notice"
      {...hit}
    >
      <span className="voice-text voice-text--notice" title={phase.text}>
        {phase.text}
      </span>
    </div>
  )
}
