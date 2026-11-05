// Settings › Voice (VOICE-09): the speech-model picker recommends the streaming model for
// English with a "Live preview" badge and lists it first, explains live preview in one line,
// says the Parakeet models have none, and offers Parakeet v2 users a dismissible switch that
// shows the download size. The AI cleanup and hotkey copy say polishing can be skipped.

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useVoiceStore } from '@/stores/useVoiceStore'
import { DEFAULT_VOICE_SETTINGS, type VoiceSettings, type VoiceStatus } from '@shared/types/voice'
import { SettingsVoice } from './SettingsVoice'

vi.mock('@/components/voice/VoiceCleanupModelPicker', () => ({
  VoiceCleanupModelPicker: () => <div data-testid="voice-cleanup-model-picker" />
}))

const STATUS: VoiceStatus = {
  enabled: true,
  state: 'idle',
  model: { status: 'ready' },
  speechModel: 'parakeet-tdt-0.6b-v2',
  engineLoaded: false,
  hotkeyDisplay: '⌥Space',
  hotkeyProblem: null,
  cleanupLabel: 'Haiku',
  micPermission: 'granted',
  lastError: null,
  notice: null
}

const initialSettings = useSettingsStore.getState()
const updateSetting = vi.fn()

function renderWith(voice: Partial<VoiceSettings>): void {
  useSettingsStore.setState({
    voice: { ...DEFAULT_VOICE_SETTINGS, enabled: true, ...voice },
    updateSetting: updateSetting as never
  })
  render(<SettingsVoice />)
}

/** The voice settings the component asked to save last. */
function lastSaved(): VoiceSettings {
  const call = updateSetting.mock.calls.at(-1)
  expect(call?.[0]).toBe('voice')
  return call?.[1] as VoiceSettings
}

beforeEach(() => {
  updateSetting.mockReset()
  // Save like the real store does, so the page re-renders with the new value.
  updateSetting.mockImplementation(async (key: string, value: unknown) => {
    useSettingsStore.setState({ [key]: value } as never)
  })
  Object.defineProperty(window, 'desktopBridge', {
    configurable: true,
    value: { voice: { getStatus: vi.fn(async () => STATUS), downloadModel: vi.fn() } }
  })
  useVoiceStore.setState({ status: STATUS })
})

afterEach(() => {
  cleanup()
  useSettingsStore.setState(initialSettings, true)
  useVoiceStore.setState({ status: null })
  Object.defineProperty(window, 'desktopBridge', { configurable: true, value: undefined })
})

describe('Settings › Voice › speech model', () => {
  it('lists the streaming model first, recommended for English, with a Live preview badge', () => {
    renderWith({})
    const rows = screen.getAllByTestId(/^voice-speech-model-(parakeet|nemotron)/)
    expect(rows.map((row) => row.dataset.testid)).toEqual([
      'voice-speech-model-nemotron-speech-streaming-en-0.6b',
      'voice-speech-model-parakeet-tdt-0.6b-v2',
      'voice-speech-model-parakeet-tdt-0.6b-v3'
    ])
    const streaming = within(rows[0])
    expect(streaming.getByTestId('voice-speech-model-recommended')).toHaveTextContent(
      'Recommended for English'
    )
    expect(streaming.getByTestId('voice-speech-model-live-preview')).toHaveTextContent(
      'Live preview'
    )
    expect(rows[0]).not.toHaveTextContent('No live preview')
    // Only the streaming model carries either badge.
    expect(screen.getAllByTestId('voice-speech-model-recommended')).toHaveLength(1)
    expect(screen.getAllByTestId('voice-speech-model-live-preview')).toHaveLength(1)
  })

  it('says the Parakeet models have no live preview, and explains live preview in one line', () => {
    renderWith({})
    expect(screen.getByTestId('voice-speech-model-parakeet-tdt-0.6b-v2')).toHaveTextContent(
      'No live preview. 460 MB download.'
    )
    expect(screen.getByTestId('voice-speech-model-parakeet-tdt-0.6b-v3')).toHaveTextContent(
      'No live preview.'
    )
    expect(screen.getByTestId('voice-live-preview-hint')).toHaveTextContent(
      'Live preview shows your words above the pill as you speak; nothing is typed until you stop.'
    )
  })

  it('selects the streaming model for a new setup', () => {
    renderWith({})
    const streaming = screen.getByTestId('voice-speech-model-nemotron-speech-streaming-en-0.6b')
    expect(streaming).toHaveClass('bg-accent')
  })
})

describe('Settings › Voice › switch suggestion for Parakeet v2', () => {
  it('suggests the streaming model with its download size', () => {
    renderWith({ speechModel: 'parakeet-tdt-0.6b-v2' })
    expect(screen.getByTestId('voice-streaming-suggestion')).toHaveTextContent(
      'Switch to Nemotron Speech Streaming 0.6B to see your words while you speak. English only, 442 MB download.'
    )
  })

  it('is not shown on other models, once dismissed, or with voice off', () => {
    renderWith({ speechModel: 'parakeet-tdt-0.6b-v3' })
    expect(screen.queryByTestId('voice-streaming-suggestion')).toBeNull()
    cleanup()
    renderWith({ speechModel: 'nemotron-speech-streaming-en-0.6b' })
    expect(screen.queryByTestId('voice-streaming-suggestion')).toBeNull()
    cleanup()
    renderWith({ speechModel: 'parakeet-tdt-0.6b-v2', streamingSuggestionDismissed: true })
    expect(screen.queryByTestId('voice-streaming-suggestion')).toBeNull()
    cleanup()
    renderWith({ speechModel: 'parakeet-tdt-0.6b-v2', enabled: false })
    expect(screen.queryByTestId('voice-streaming-suggestion')).toBeNull()
  })

  it('dismissing saves it in the voice settings and keeps the model', () => {
    renderWith({ speechModel: 'parakeet-tdt-0.6b-v2' })
    fireEvent.click(screen.getByTestId('voice-streaming-suggestion-dismiss'))
    expect(lastSaved()).toMatchObject({
      speechModel: 'parakeet-tdt-0.6b-v2',
      streamingSuggestionDismissed: true
    })
    expect(screen.queryByTestId('voice-streaming-suggestion')).toBeNull()
  })

  it('Switch selects the streaming model and does not suggest again', () => {
    renderWith({ speechModel: 'parakeet-tdt-0.6b-v2' })
    fireEvent.click(screen.getByTestId('voice-streaming-suggestion-switch'))
    expect(lastSaved()).toMatchObject({
      speechModel: 'nemotron-speech-streaming-en-0.6b',
      streamingSuggestionDismissed: true
    })
    expect(screen.queryByTestId('voice-streaming-suggestion')).toBeNull()
  })
})

describe('Settings › Voice › skipping polishing', () => {
  it('says the transcript is shown while polishing and how to skip it', () => {
    renderWith({})
    expect(screen.getByTestId('voice-cleanup-skip-hint')).toHaveTextContent(
      'While it polishes, the transcript stays on screen above the pill. Press Esc, the hotkey or Skip to paste it as is, without waiting for the AI.'
    )
  })

  it('no longer says Esc cancels during processing', () => {
    renderWith({})
    const hint = screen.getByText(/anywhere in the app to start or stop dictation/)
    expect(hint).toHaveTextContent(
      'Esc cancels while recording; while polishing, Esc or the hotkey skips the AI.'
    )
    expect(hint).not.toHaveTextContent(/Esc cancels\./)
  })
})
