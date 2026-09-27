import { clipboardToast } from '@/lib/toast'

/** Copy a dictation transcript to the clipboard and say so. */
export async function copyVoiceTranscript(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    clipboardToast.copied('Transcript')
  } catch {
    clipboardToast.failed()
  }
}
