import { useEffect, useState } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  Loader2,
  MinusCircle,
  PlusCircle,
  Trash2
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { VoiceCleanupModelPicker } from '@/components/voice/VoiceCleanupModelPicker'
import { isMac } from '@/lib/platform'
import { cn } from '@/lib/utils'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { getVoiceBridge, isVoiceAvailable, useVoiceStore } from '@/stores/useVoiceStore'
import {
  findVoiceSpeechModel,
  VOICE_CLEANUP_TIMEOUT_MAX_SECONDS,
  VOICE_CLEANUP_TIMEOUT_MIN_SECONDS,
  VOICE_RESTORE_CLIPBOARD_MAX_MS,
  VOICE_RESTORE_CLIPBOARD_MIN_MS,
  VOICE_SPEECH_MODELS,
  type VoiceDictionaryEntry,
  type VoiceSettings,
  type VoiceSpeechModelId
} from '@shared/types/voice'
import { validateHotkey } from '@shared/voice/hotkey-spec'

function formatMb(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`
}

interface ToggleRowProps {
  label: string
  description: string
  checked: boolean
  onChange: (next: boolean) => void
  disabled?: boolean
  testId: string
}

function ToggleRow({
  label,
  description,
  checked,
  onChange,
  disabled,
  testId
}: ToggleRowProps): React.JSX.Element {
  return (
    <div className={cn('flex items-center justify-between gap-4', disabled && 'opacity-50')}>
      <div>
        <label className="text-sm font-medium">{label}</label>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <button
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          'relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors',
          checked ? 'bg-primary' : 'bg-muted',
          disabled && 'cursor-not-allowed'
        )}
        data-testid={testId}
      >
        <span
          className={cn(
            'pointer-events-none block h-4 w-4 rounded-full bg-background ring-0 transition-transform',
            checked ? 'translate-x-4' : 'translate-x-0'
          )}
        />
      </button>
    </div>
  )
}

interface DictRow {
  id: number
  word: string
  aliases: string
  caseSensitive: boolean
}

let nextRowId = 1

function rowsFromEntries(entries: VoiceDictionaryEntry[]): DictRow[] {
  return entries.map((entry) => ({
    id: nextRowId++,
    word: entry.word,
    aliases: entry.soundsLike.join(', '),
    caseSensitive: entry.caseSensitive
  }))
}

function entriesFromRows(rows: DictRow[]): VoiceDictionaryEntry[] {
  return rows
    .map((row) => ({
      word: row.word.trim(),
      soundsLike: row.aliases
        .split(',')
        .map((alias) => alias.trim())
        .filter(Boolean),
      caseSensitive: row.caseSensitive
    }))
    .filter((entry) => entry.word.length > 0)
}

export function SettingsVoice(): React.JSX.Element {
  const voice = useSettingsStore((s) => s.voice)
  const updateSetting = useSettingsStore((s) => s.updateSetting)
  const status = useVoiceStore((s) => s.status)
  const refreshStatus = useVoiceStore((s) => s.refreshStatus)
  const available = isVoiceAvailable()

  const update = (partial: Partial<VoiceSettings>): void => {
    void updateSetting('voice', { ...voice, ...partial })
  }
  const updateCleanup = (partial: Partial<VoiceSettings['cleanup']>): void => {
    update({ cleanup: { ...voice.cleanup, ...partial } })
  }

  // Hotkey: edit a local draft, commit on blur / Enter once it parses.
  const [hotkeyDraft, setHotkeyDraft] = useState(voice.hotkey)
  useEffect(() => setHotkeyDraft(voice.hotkey), [voice.hotkey])
  const hotkeyValidation = validateHotkey(hotkeyDraft, { platform: isMac() ? 'darwin' : 'other' })
  const commitHotkey = (): void => {
    if (hotkeyValidation.error || hotkeyDraft === voice.hotkey) return
    update({ hotkey: hotkeyDraft.trim().toLowerCase() })
  }

  // Dictionary rows: local editor state, persisted on every edit.
  const [rows, setRows] = useState<DictRow[]>(() => rowsFromEntries(voice.dictionary))
  const commitRows = (next: DictRow[]): void => {
    setRows(next)
    update({ dictionary: entriesFromRows(next) })
  }
  const dictionaryError = rows.some((row) => !row.word.trim() && row.aliases.trim())
    ? 'A dictionary row has “sounds like” text but no word.'
    : null

  useEffect(() => {
    if (voice.enabled) void refreshStatus()
  }, [voice.enabled, refreshStatus])

  const model = status?.model
  const selectedModelInfo = findVoiceSpeechModel(voice.speechModel)
  const bridge = getVoiceBridge()
  const micPermission = status?.micPermission ?? 'unknown'

  const modelStatusBlock = (): React.JSX.Element | null => {
    if (!model) return null
    switch (model.status) {
      case 'ready':
        return (
          <div className="flex items-center justify-between gap-3">
            <span className="flex items-center gap-1.5 text-xs text-emerald-500">
              <CheckCircle2 className="h-3.5 w-3.5" />
              Downloaded and ready
              {status?.engineLoaded ? ' · loaded in memory' : ''}
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground hover:text-destructive"
              onClick={() => void bridge?.deleteModel(voice.speechModel)}
              data-testid="voice-model-delete"
            >
              <Trash2 className="h-3.5 w-3.5 mr-1" />
              Delete
            </Button>
          </div>
        )
      case 'downloading': {
        const total = model.totalBytes ?? selectedModelInfo.downloadBytes
        const fraction = total > 0 ? Math.min(1, model.receivedBytes / total) : 0
        const label =
          model.phase === 'download'
            ? `Downloading… ${Math.round(fraction * 100)}% of ${formatMb(total)}`
            : model.phase === 'extract'
              ? 'Unpacking…'
              : 'Verifying…'
        return (
          <div className="space-y-2" data-testid="voice-model-downloading">
            <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {label}
              </span>
              <button
                type="button"
                className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                onClick={() => void bridge?.cancelDownload(voice.speechModel)}
              >
                Cancel
              </button>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-foreground/8">
              <div
                className={cn(
                  'h-full rounded-full bg-blue-500 transition-all duration-300',
                  model.phase !== 'download' && 'animate-pulse'
                )}
                style={{
                  width: `${model.phase === 'download' ? Math.round(fraction * 100) : 100}%`
                }}
              />
            </div>
          </div>
        )
      }
      case 'failed':
        return (
          <div className="space-y-2">
            <div className="flex items-start gap-2 p-2.5 rounded-md bg-destructive/10 border border-destructive/30 text-xs">
              <AlertTriangle className="h-3.5 w-3.5 text-destructive shrink-0 mt-0.5" />
              <span>{model.message}</span>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void bridge?.downloadModel(voice.speechModel)}
              data-testid="voice-model-retry"
            >
              <Download className="h-3.5 w-3.5 mr-1" />
              Retry download
            </Button>
          </div>
        )
      case 'not-downloaded':
        return (
          <Button
            variant="outline"
            size="sm"
            onClick={() => void bridge?.downloadModel(voice.speechModel)}
            data-testid="voice-model-download"
          >
            <Download className="h-3.5 w-3.5 mr-1" />
            Download model ({formatMb(selectedModelInfo.downloadBytes)})
          </Button>
        )
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-base font-medium mb-1">Voice dictation</h3>
        <p className="text-sm text-muted-foreground">
          Press a hotkey, speak, and the transcript is typed into whatever you were editing. Speech
          is transcribed on this machine; the optional cleanup pass runs through one of your own
          providers.
        </p>
      </div>

      {!available && (
        <div className="flex items-start gap-2 p-3 rounded-md bg-muted/30 border border-border text-xs text-muted-foreground">
          <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
          Voice dictation needs the desktop app (microphone and hotkey access).
        </div>
      )}

      <ToggleRow
        label="Enable voice dictation"
        description="Downloads the speech model the first time it is turned on."
        checked={voice.enabled}
        onChange={(enabled) => update({ enabled })}
        disabled={!available}
        testId="voice-enabled-toggle"
      />

      {voice.enabled && (
        <>
          <div className="border-t pt-4" />

          {/* Speech model */}
          <div className="space-y-3">
            <div>
              <label className="text-sm font-medium">Speech model</label>
              <p className="text-xs text-muted-foreground">
                Runs locally with sherpa-onnx. Switching models downloads the other one.
              </p>
            </div>
            <div className="space-y-1">
              {VOICE_SPEECH_MODELS.map((option) => {
                const selected = voice.speechModel === option.id
                return (
                  <button
                    key={option.id}
                    onClick={() => update({ speechModel: option.id as VoiceSpeechModelId })}
                    className={cn(
                      'w-full flex items-start justify-between px-3 py-2.5 rounded-md text-sm transition-colors text-left',
                      selected
                        ? 'bg-accent border border-border'
                        : 'hover:bg-accent/50 border border-transparent'
                    )}
                    data-testid={`voice-speech-model-${option.id}`}
                  >
                    <div className="flex-1">
                      <span>{option.name}</span>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {option.description} {formatMb(option.downloadBytes)} download.
                      </p>
                    </div>
                    {selected && (
                      <CheckCircle2 className="h-4 w-4 text-foreground mt-0.5 shrink-0" />
                    )}
                  </button>
                )
              })}
            </div>
            <div className="rounded-lg border p-3" data-testid="voice-model-status">
              {modelStatusBlock() ?? (
                <span className="text-xs text-muted-foreground">Checking model…</span>
              )}
            </div>
          </div>

          <div className="border-t pt-4" />

          {/* Hotkey */}
          <div className="space-y-2">
            <label className="text-sm font-medium">Hotkey</label>
            <Input
              value={hotkeyDraft}
              onChange={(event) => setHotkeyDraft(event.target.value)}
              onBlur={commitHotkey}
              onKeyDown={(event) => {
                if (event.key === 'Enter') commitHotkey()
              }}
              placeholder="option+space"
              className="font-mono text-sm max-w-xs"
              data-testid="voice-hotkey-input"
            />
            {hotkeyValidation.error ? (
              <p className="text-xs text-destructive">{hotkeyValidation.error}</p>
            ) : status?.hotkeyProblem ? (
              <p className="text-xs text-destructive">{status.hotkeyProblem}</p>
            ) : (
              <p className="text-xs text-muted-foreground">
                Press {hotkeyValidation.spec?.display} anywhere in the app to start or stop
                dictation. Esc cancels. Modifiers: cmd, option, ctrl, shift; keys: letters, digits,
                space, f1–f20.
              </p>
            )}
          </div>

          <ToggleRow
            label="Feedback sounds"
            description="Play a sound when recording starts and stops."
            checked={voice.sounds}
            onChange={(sounds) => update({ sounds })}
            testId="voice-sounds-toggle"
          />

          <ToggleRow
            label="Pause media while recording"
            description={
              isMac()
                ? 'Pause music or video while you speak and resume it afterwards — only if it was playing and you did not resume it yourself.'
                : 'Available on macOS only.'
            }
            checked={voice.pauseMediaWhileRecording}
            onChange={(pauseMediaWhileRecording) => update({ pauseMediaWhileRecording })}
            disabled={!isMac()}
            testId="voice-pause-media-toggle"
          />

          <div className="border-t pt-4" />

          {/* AI cleanup */}
          <div className="space-y-4">
            <ToggleRow
              label="Clean up transcripts with AI"
              description="Fixes misheard technical terms, punctuation, spoken code references and fillers — never rewrites what you said. Off pastes the raw local transcript."
              checked={voice.cleanup.enabled}
              onChange={(enabled) => updateCleanup({ enabled })}
              testId="voice-cleanup-toggle"
            />
            <div
              className={cn(
                'space-y-4 pl-4',
                !voice.cleanup.enabled && 'opacity-50 pointer-events-none'
              )}
            >
              <div className="space-y-2">
                <label className="text-sm font-medium">Provider, model and effort</label>
                <p className="text-xs text-muted-foreground">
                  One of your providers, like the Models section. Leave on App default for the
                  cheapest available model.
                </p>
                <VoiceCleanupModelPicker
                  value={{
                    model: voice.cleanup.model,
                    customProviderId: voice.cleanup.customProviderId
                  }}
                  onChange={(next) =>
                    updateCleanup({ model: next.model, customProviderId: next.customProviderId })
                  }
                  disabled={!voice.cleanup.enabled}
                />
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="text-sm font-medium">Timeout</label>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {voice.cleanup.timeoutSeconds}s
                  </span>
                </div>
                <input
                  type="range"
                  min={VOICE_CLEANUP_TIMEOUT_MIN_SECONDS}
                  max={VOICE_CLEANUP_TIMEOUT_MAX_SECONDS}
                  step={1}
                  value={voice.cleanup.timeoutSeconds}
                  onChange={(event) =>
                    updateCleanup({ timeoutSeconds: Number.parseInt(event.target.value, 10) })
                  }
                  className="w-full accent-primary"
                  data-testid="voice-cleanup-timeout"
                />
                <p className="text-xs text-muted-foreground">
                  Longer dictations get extra time automatically. If the provider is slower than
                  this, the raw transcript is pasted instead.
                </p>
              </div>

              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">
                  Custom system prompt (leave empty for the built-in coding prompt)
                </label>
                <Textarea
                  value={voice.cleanup.systemPrompt}
                  onChange={(event) => updateCleanup({ systemPrompt: event.target.value })}
                  className="font-mono text-xs min-h-[70px]"
                  data-testid="voice-cleanup-prompt"
                />
              </div>
            </div>
          </div>

          <div className="border-t pt-4" />

          {/* Dictionary */}
          <div className="space-y-3">
            <div>
              <label className="text-sm font-medium">Dictionary</label>
              <p className="text-xs text-muted-foreground">
                Words always land with this exact spelling. Comma-separated “sounds like”
                mishearings are rewritten to the word — even with AI cleanup off.
              </p>
            </div>
            <div className="space-y-2">
              {rows.map((row) => (
                <div
                  key={row.id}
                  className="flex items-center gap-2"
                  data-testid="voice-dictionary-row"
                >
                  <Input
                    value={row.word}
                    placeholder="Claude"
                    onChange={(event) =>
                      commitRows(
                        rows.map((r) => (r.id === row.id ? { ...r, word: event.target.value } : r))
                      )
                    }
                    className="w-[140px] h-8"
                    aria-label="Word"
                  />
                  <Input
                    value={row.aliases}
                    placeholder="misheard as… (optional)"
                    onChange={(event) =>
                      commitRows(
                        rows.map((r) =>
                          r.id === row.id ? { ...r, aliases: event.target.value } : r
                        )
                      )
                    }
                    className="flex-1 h-8"
                    aria-label="Sounds like"
                  />
                  <label
                    className="flex items-center gap-1 text-[11px] text-muted-foreground shrink-0"
                    title="Only match this exact spelling (don't recase ordinary words)"
                  >
                    <input
                      type="checkbox"
                      className="h-3.5 w-3.5 accent-primary"
                      checked={row.caseSensitive}
                      onChange={(event) =>
                        commitRows(
                          rows.map((r) =>
                            r.id === row.id ? { ...r, caseSensitive: event.target.checked } : r
                          )
                        )
                      }
                    />
                    Aa
                  </label>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-muted-foreground hover:text-destructive shrink-0"
                    onClick={() => commitRows(rows.filter((r) => r.id !== row.id))}
                    aria-label="Remove word"
                  >
                    <MinusCircle className="h-4 w-4" />
                  </Button>
                </div>
              ))}
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  setRows([
                    ...rows,
                    { id: nextRowId++, word: '', aliases: '', caseSensitive: false }
                  ])
                }
                data-testid="voice-dictionary-add"
              >
                <PlusCircle className="h-4 w-4 mr-1" />
                Add word
              </Button>
              {dictionaryError && <p className="text-xs text-destructive">{dictionaryError}</p>}
            </div>
          </div>

          <div className="border-t pt-4" />

          {/* Advanced */}
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-4">
              <div>
                <label className="text-sm font-medium">Unload speech model when idle</label>
                <p className="text-xs text-muted-foreground">
                  The loaded model uses about 1.4 GB of memory; it reloads in under a second.
                </p>
              </div>
              <select
                value={voice.unloadModelAfterMinutes}
                onChange={(event) =>
                  update({ unloadModelAfterMinutes: Number.parseInt(event.target.value, 10) })
                }
                className="h-8 rounded-md border border-input bg-background px-2 text-sm"
                data-testid="voice-unload-select"
              >
                <option value={0}>Keep loaded</option>
                <option value={5}>After 5 minutes</option>
                <option value={10}>After 10 minutes</option>
                <option value={30}>After 30 minutes</option>
                <option value={60}>After 1 hour</option>
              </select>
            </div>

            <div className="flex items-center justify-between gap-4">
              <div>
                <label className="text-sm font-medium">Restore clipboard after</label>
                <p className="text-xs text-muted-foreground">
                  Terminals receive the text through the clipboard; the previous contents come back
                  after this delay.
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <Input
                  type="number"
                  min={VOICE_RESTORE_CLIPBOARD_MIN_MS}
                  max={VOICE_RESTORE_CLIPBOARD_MAX_MS}
                  step={50}
                  value={voice.restoreClipboardDelayMs}
                  onChange={(event) => {
                    const value = Number.parseInt(event.target.value, 10)
                    if (
                      !Number.isNaN(value) &&
                      value >= VOICE_RESTORE_CLIPBOARD_MIN_MS &&
                      value <= VOICE_RESTORE_CLIPBOARD_MAX_MS
                    ) {
                      update({ restoreClipboardDelayMs: value })
                    }
                  }}
                  className="w-24 font-mono text-sm"
                  data-testid="voice-restore-delay"
                />
                <span className="text-xs text-muted-foreground">ms</span>
              </div>
            </div>
          </div>

          <div className="border-t pt-4" />

          {/* Permissions */}
          <div className="space-y-2">
            <label className="text-sm font-medium">Permissions</label>
            <div className="flex items-center justify-between rounded-lg border p-3">
              <span className="flex items-center gap-2 text-sm">
                {micPermission === 'granted' ? (
                  <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                ) : (
                  <AlertTriangle className="h-4 w-4 text-amber-500" />
                )}
                Microphone
                <span className="text-xs text-muted-foreground">
                  {micPermission === 'granted'
                    ? 'granted'
                    : micPermission === 'not-determined'
                      ? 'not asked yet'
                      : micPermission === 'unknown'
                        ? ''
                        : micPermission}
                </span>
              </span>
              {micPermission === 'not-determined' || micPermission === 'unknown' ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void bridge?.requestMicrophoneAccess()}
                  data-testid="voice-mic-request"
                >
                  Request access
                </Button>
              ) : micPermission !== 'granted' ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void bridge?.openMicrophoneSettings()}
                  data-testid="voice-mic-settings"
                >
                  Open System Settings
                </Button>
              ) : null}
            </div>
          </div>

          <p className="text-[11px] text-muted-foreground/70">
            Speech recognition by sherpa-onnx (Apache-2.0) using NVIDIA Parakeet TDT (CC-BY-4.0).
            Media pause via mediaremote-adapter (BSD-3-Clause).
          </p>
        </>
      )}
    </div>
  )
}
