import { useCallback, useEffect, useRef, useState } from 'react'
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

export function VoiceHudApp(): React.JSX.Element | null {
  const [phase, setPhase] = useState<VoiceHudPhase>({ kind: 'hidden' })
  const [levels, setLevels] = useState<number[]>(EMPTY_LEVELS)
  const [recordingSince, setRecordingSince] = useState(0)
  const recorderRef = useRef<VoiceRecorder | null>(null)
  const soundsRef = useRef<VoiceSoundPlayer | null>(null)
  const soundsEnabledRef = useRef(true)

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
        setPhase((previous) => {
          if (state.phase.kind === 'recording' && previous.kind !== 'recording') {
            setRecordingSince(Date.now())
          }
          return state.phase
        })
        if (state.phase.kind === 'recording') setLevels(EMPTY_LEVELS)
      }),
      bridge.onSound((name) => {
        if (!soundsEnabledRef.current) return
        soundsRef.current?.play(name)
      }),
      bridge.onCaptureStart(() => {
        const recorder = getRecorder()
        setLevels(EMPTY_LEVELS)
        recorder
          .start()
          .then(() => bridge.captureStarted())
          .catch((error: unknown) => {
            const message =
              error instanceof Error ? `${error.name}: ${error.message}` : String(error)
            bridge.captureError(message)
          })
      }),
      bridge.onCaptureStop(() => {
        const recorder = getRecorder()
        const startedAt = performance.now()
        recorder
          .stop()
          .then((audio) =>
            bridge.submitAudio({
              samples: audio.samples,
              sampleRate: audio.sampleRate,
              durationMs: Math.round(performance.now() - startedAt)
            })
          )
          .catch((error: unknown) => {
            bridge.captureError(error instanceof Error ? error.message : String(error))
          })
      }),
      bridge.onCaptureCancel(() => {
        recorderRef.current?.cancel()
      })
    ]

    bridge.ready()
    return () => {
      for (const off of unsubscribers) off()
      recorderRef.current?.cancel()
    }
  }, [getRecorder])

  // Never let a click steal focus from the text field being dictated into.
  const preventFocus = (event: React.MouseEvent): void => {
    event.preventDefault()
  }

  if (phase.kind === 'hidden') return null

  const bridge = window.desktopBridge?.voiceHud

  if (phase.kind === 'recording') {
    return (
      <div className="voice-hud-root">
        <div
          className="voice-pill voice-pill--clickable"
          title="Click to stop · Esc to cancel"
          onMouseDown={preventFocus}
          onClick={() => bridge?.clickStop()}
          data-testid="voice-hud-recording"
        >
          <RecordingBars levels={levels} />
          <RecordingTimer since={recordingSince} />
        </div>
      </div>
    )
  }

  if (phase.kind === 'transcribing' || phase.kind === 'enhancing') {
    const showPercent = phase.showsProgress && phase.progress !== null
    return (
      <div className="voice-hud-root">
        <div
          className="voice-pill"
          title={phase.kind === 'enhancing' ? 'Polishing…' : 'Transcribing…'}
          onMouseDown={preventFocus}
          data-testid="voice-hud-processing"
        >
          <ProcessingWave />
          {showPercent && (
            <span className="voice-text voice-percent">
              {Math.round((phase.progress ?? 0) * 100)}%
            </span>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="voice-hud-root">
      <div
        className="voice-pill voice-pill--clickable"
        onMouseDown={preventFocus}
        onClick={() => bridge?.clickCancel()}
        data-testid="voice-hud-notice"
      >
        <span className="voice-text voice-text--notice" title={phase.text}>
          {phase.text}
        </span>
      </div>
    </div>
  )
}
