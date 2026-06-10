import { projectApi } from '@/api/project-api'

/**
 * Copy text to the clipboard, robust against environments where the async
 * Clipboard API (`navigator.clipboard`) is unavailable or silently rejects —
 * notably some Linux/Wayland and containerized desktop setups.
 *
 * Strategy, in order:
 *  1. `navigator.clipboard.writeText` — works in a secure, focused context.
 *  2. Electron's main-process clipboard via `projectApi.copyToClipboard` —
 *     reliable inside the desktop app even when the renderer's Clipboard API
 *     is blocked. This mirrors the paste path in XtermBackend, which already
 *     falls back to `projectApi.readFromClipboard` for the same reason.
 *  3. Legacy `document.execCommand('copy')` — last resort.
 *
 * @returns true if any strategy reported success.
 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  // 1) Async Clipboard API.
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // Permission denied / insecure context / not focused — fall through.
  }

  // 2) Electron main-process clipboard.
  try {
    await projectApi.copyToClipboard(text)
    return true
  } catch {
    // RPC unavailable or main-process write failed — fall through.
  }

  // 3) Legacy execCommand fallback.
  try {
    const textarea = document.createElement('textarea')
    textarea.value = text
    textarea.setAttribute('readonly', '')
    textarea.style.position = 'fixed'
    textarea.style.top = '0'
    textarea.style.left = '0'
    textarea.style.opacity = '0'
    textarea.style.pointerEvents = 'none'
    document.body.appendChild(textarea)
    textarea.focus()
    textarea.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(textarea)
    if (ok) return true
  } catch {
    // Nothing more to try.
  }

  return false
}
