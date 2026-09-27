import { clipboard, type BrowserWindow, type NativeImage } from 'electron'
import { VOICE_RESTORE_CLIPBOARD_MAX_MS, VOICE_RESTORE_CLIPBOARD_MIN_MS } from '@shared/types/voice'
import { ghosttyService } from '../services/ghostty-service'
import { emitEditPaste } from '../services/edit-events'
import { createLogger } from '../services/logger'

const log = createLogger({ component: 'VoicePaste' })

export type VoiceDelivery = 'pasted' | 'copied'

/**
 * Where the dictated text goes:
 * - `ghostty`: a native Ghostty surface is first responder → its paste API.
 * - `xterm`: an xterm.js terminal → clipboard + a real paste event, so the
 *   terminal applies bracketed paste and multi-line text does not submit early.
 * - `editable`: a text field / contenteditable / CodeMirror / Monaco → the IME
 *   commit path (`webContents.insertText`), which never touches the clipboard.
 * - `edit-paste`: stale native focus with live Ghostty surfaces → hive's own
 *   'edit:paste' routing in the renderer.
 * - `none`: nothing editable is focused → the text stays on the clipboard.
 */
type PasteTarget = 'ghostty' | 'xterm' | 'editable' | 'edit-paste' | 'none'

interface SavedClipboard {
  readonly text: string
  readonly html: string
  readonly rtf: string
  readonly image: NativeImage
  readonly bookmark: { title: string; url: string }
}

let pendingRestore: { timer: NodeJS.Timeout; saved: SavedClipboard; ours: string } | null = null

/**
 * Probe the focused element in the main window's page. Runs in the page's
 * main world from the main process; sandboxed renderers still allow this.
 * Terminals are checked before generic editables because xterm focuses a
 * hidden textarea of its own. For plain text fields it also reports whether
 * the character before the caret needs a separating space.
 */
const FOCUS_PROBE = `(() => {
  const el = document.activeElement
  if (!el || el === document.body) return JSON.stringify({ kind: 'none' })
  if (typeof el.closest === 'function' && (el.closest('.xterm') || el.closest('[data-testid="terminal-view"]'))) {
    return JSON.stringify({ kind: 'terminal' })
  }
  const tag = el.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA') {
    let needsSpace = false
    try {
      const value = el.value || ''
      const caret = typeof el.selectionStart === 'number' ? el.selectionStart : value.length
      const before = caret > 0 ? value[caret - 1] : ''
      needsSpace = !!before && !/[\\s(\\[{"'\`]/.test(before)
    } catch {}
    return JSON.stringify({ kind: 'editable', needsSpace })
  }
  if (el.isContentEditable) return JSON.stringify({ kind: 'editable', needsSpace: false })
  if (typeof el.closest === 'function' && el.closest('.monaco-editor, .cm-editor')) {
    return JSON.stringify({ kind: 'editable', needsSpace: false })
  }
  return JSON.stringify({ kind: 'none' })
})()`

interface ProbeResult {
  readonly target: PasteTarget
  readonly needsSpace: boolean
}

async function detectTarget(mainWindow: BrowserWindow): Promise<ProbeResult> {
  if (ghosttyService.focusedSurfaceId() > 0) return { target: 'ghostty', needsSpace: false }
  const contents = mainWindow.webContents
  if (contents.isFocused()) {
    try {
      const raw = (await contents.executeJavaScript(FOCUS_PROBE, true)) as unknown
      const parsed = JSON.parse(String(raw)) as { kind?: string; needsSpace?: boolean }
      if (parsed.kind === 'terminal') return { target: 'xterm', needsSpace: false }
      if (parsed.kind === 'editable') {
        return { target: 'editable', needsSpace: parsed.needsSpace === true }
      }
      return { target: 'none', needsSpace: false }
    } catch (error) {
      log.warn('focus probe failed; assuming editable', { error: String(error) })
      return { target: 'editable', needsSpace: false }
    }
  }
  if (ghosttyService.hasSurfaces()) return { target: 'edit-paste', needsSpace: false }
  return { target: 'none', needsSpace: false }
}

/** Dictating twice in a row must not glue sentences together ("bug.Fix the"). */
function withSmartSpacing(text: string, needsSpace: boolean): string {
  if (!needsSpace) return text
  const first = Array.from(text)[0]
  if (!first || /[\s.,;:!?)\]}]/.test(first)) return text
  return ` ${text}`
}

function saveClipboard(): SavedClipboard {
  return {
    text: clipboard.readText(),
    html: clipboard.readHTML(),
    rtf: clipboard.readRTF(),
    image: clipboard.readImage(),
    bookmark: clipboard.readBookmark()
  }
}

function restoreClipboard(saved: SavedClipboard): void {
  const data: Electron.Data = {}
  if (saved.text) data.text = saved.text
  if (saved.html) data.html = saved.html
  if (saved.rtf) data.rtf = saved.rtf
  if (!saved.image.isEmpty()) data.image = saved.image
  if (saved.bookmark.url) {
    // Electron writes a bookmark as (text = url, bookmark = title).
    data.text ??= saved.bookmark.url
    data.bookmark = saved.bookmark.title
  }
  if (Object.keys(data).length === 0) {
    clipboard.clear()
    return
  }
  clipboard.write(data)
}

function cancelPendingRestore(): void {
  if (pendingRestore) {
    clearTimeout(pendingRestore.timer)
    pendingRestore = null
  }
}

/** Clipboard-backed paste (xterm needs a real paste event for bracketed paste). */
function pasteViaClipboard(mainWindow: BrowserWindow, text: string, restoreDelayMs: number): void {
  // A previous dictation's restore may still be pending: the clipboard then
  // holds our own text, so adopt the clipboard it saved instead of saving ours.
  const saved = pendingRestore ? pendingRestore.saved : saveClipboard()
  cancelPendingRestore()

  clipboard.writeText(text)
  mainWindow.webContents.paste()

  const delay = Math.min(
    VOICE_RESTORE_CLIPBOARD_MAX_MS,
    Math.max(VOICE_RESTORE_CLIPBOARD_MIN_MS, restoreDelayMs)
  )
  const timer = setTimeout(() => {
    pendingRestore = null
    // Someone else wrote the clipboard since — it is theirs now.
    if (clipboard.readText() !== text) return
    try {
      restoreClipboard(saved)
    } catch (error) {
      log.warn('clipboard restore failed', { error: String(error) })
    }
  }, delay)
  pendingRestore = { timer, saved, ours: text }
}

/**
 * Deliver dictated text where the user is typing. Returns 'copied' when no
 * editable target was focused: the text is then left on the clipboard (and
 * in history) so it is never lost.
 */
export async function deliverVoiceText(
  mainWindow: BrowserWindow | null,
  text: string,
  restoreDelayMs: number
): Promise<VoiceDelivery> {
  if (!mainWindow || mainWindow.isDestroyed()) {
    cancelPendingRestore()
    clipboard.writeText(text)
    return 'copied'
  }

  const { target, needsSpace } = await detectTarget(mainWindow)
  switch (target) {
    case 'ghostty':
      ghosttyService.pasteToFocusedSurface(text)
      break
    case 'xterm':
      pasteViaClipboard(mainWindow, text, restoreDelayMs)
      break
    case 'editable':
      mainWindow.webContents
        .insertText(withSmartSpacing(text, needsSpace))
        .catch((error: unknown) => {
          log.warn('insertText failed', { error: String(error) })
        })
      break
    case 'edit-paste':
      emitEditPaste(text)
      break
    case 'none':
      cancelPendingRestore()
      clipboard.writeText(text)
      log.info('No editable target focused; left text on clipboard')
      return 'copied'
  }

  log.info('Delivered dictation', { target, chars: text.length })
  return 'pasted'
}

/** Test seam: forget any pending clipboard restore. */
export function resetVoicePasteStateForTests(): void {
  cancelPendingRestore()
}
