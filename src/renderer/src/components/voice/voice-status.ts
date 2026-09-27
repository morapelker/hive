import type { VoiceStatus } from '@shared/types/voice'

function formatBytes(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`
}

/** The header icon's tooltip doubles as Wispelker's status line. */
export function describeVoiceStatus(status: VoiceStatus | null): string {
  if (!status) return 'Voice dictation'
  if (status.hotkeyProblem) return `Voice dictation — ⚠︎ ${status.hotkeyProblem}`
  switch (status.state) {
    case 'recording':
      return `Recording… press ${status.hotkeyDisplay ?? 'the hotkey'} or click the pill to stop, Esc to cancel`
    case 'processing':
      return 'Transcribing…'
    case 'idle':
      return `Voice dictation — ${status.hotkeyDisplay ?? 'hotkey not set'} · AI: ${status.cleanupLabel}`
    case 'unavailable': {
      const model = status.model
      if (model.status === 'downloading') {
        const total = model.totalBytes ?? 0
        const pct = total > 0 ? Math.round((model.receivedBytes / total) * 100) : 0
        return model.phase === 'download'
          ? `Downloading speech model… ${pct}% of ${formatBytes(total)}`
          : model.phase === 'extract'
            ? 'Unpacking speech model…'
            : 'Verifying speech model…'
      }
      if (model.status === 'failed') return `⚠︎ ${model.message}`
      if (model.status === 'not-downloaded') {
        return 'Speech model not downloaded — open Settings › Voice'
      }
      return 'Speech model not ready yet'
    }
  }
}
